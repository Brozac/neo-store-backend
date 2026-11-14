// services/reconService.js
/**
 * 🔍 F#79 — Reconciliation Suite — الحقيقة المالية والتشغيلية ديال CJ
 * ============================================================
 * جوج قراءات أوتوماتيكية (read-only على CJ — صفر كتابة خطرة):
 *
 * 1) Wallet Recon (دوك shopping 2.4 billingHistory):
 *    فواتير المحفظة مقابل DB — كل "Order Payment" ناجح ما عندوش طلب معروف
 *    = خصم بلا طلب (اختطاف محتمل) · نفس الطلب تخلص مرتين = دفع مزدوج ·
 *    سلسلة afterTransactionMoney مقطوعة = معاملات مخفاية. تنبيه أدمن.
 *
 * 2) Orphan Sweep (دوك shopping 1.6 listOrder):
 *    أوامر موجودة فCJ ما عندهاش حتى صف فDB (عكس الزومبي — خصم محتمل
 *    ولا نداء خارج سجلاتنا) + تضارب الحالات (CJ CANCELLED وDB paid).
 *
 * الجدول cj_recon_reports كيت.ensureا ذاتياً — الكرون ما يرميش relation error.
 * Kill-switches: WALLET_RECON_CRON='0' · ORPHAN_SWEEP_CRON='0'
 */
const axios = require('axios');
const pool = require('../db');
const { cjRequest, getCJToken, auditEvent, sendAdminAlert } = require('./cjService');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

let reconTableEnsured = false;
async function ensureReconTable(db) {
  if (reconTableEnsured) return;
  await (db || pool).query(`
    CREATE TABLE IF NOT EXISTS cj_recon_reports (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,                    -- 'wallet' | 'orphan'
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      window_start TEXT,
      window_end TEXT,
      stats JSONB NOT NULL DEFAULT '{}'::jsonb,
      anomalies JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  reconTableEnsured = true;
}

// tradeType table — دوك 2.4 (الأنواع المهمة للrecon برك مسميين)
const TRADE_TYPES = {
  1: 'Order Payment', 2: 'Top-up', 7: 'Order Refund', 8: 'Order Refund: Sold Out',
  9: 'System Refund', 10: 'System Deduction', 13: 'CJ PRIME', 14: 'Order Payment-Shipping Cost',
  17: 'Freight Payment',
};
const PAYMENT_TYPES = new Set([1, 14, 17]);   // أنواع الخصم على الأوامر
const REFUND_TYPES = new Set([7, 8, 9]);

/**
 * 🧾 2.4 billingHistory — صفحات كامل حتى pageSize=100 · window ≤ 366 يوم
 * deps.query fn قابلة للحقن للاختبار.
 */
async function fetchBillingHistory({ startDay, endDay, maxPages = 5, deps = {} }) {
  const call = deps.call || (async (body) => {
    const res = await cjRequest((token) =>
      axios.post(`${CJ_API}/shopping/wallet/billingHistory`, body,
        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
    );
    return res.data || {};
  });
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const env = await call({ pageNum: page, pageSize: 100, startDay, endDay });
    if (env.code !== 200 || env.result === false) {
      throw new Error(`billingHistory envelope ${env.code}: ${env.message || 'unknown'}`);
    }
    const list = (env.data && Array.isArray(env.data.list)) ? env.data.list : [];
    rows.push(...list);
    const total = Number(env.data && env.data.total) || 0;
    if (page * 100 >= total) break;
  }
  return rows;
}

/**
 * 🔎 القلب التحليلي — pure fn (اختبار بلا شبكة):
 * rows = صفوف 2.4 · knownCjCodes = Set تاع الأكواد المعروفة فDB (طفل+أب، lowercase)
 * قواعد F#78:
 *   A. دفع أمر ناجح على كود ما معروفش → unknown_payment
 *   B. نفس الكود خلاص مرتين+ بنجاح → double_charge
 *   C. سلسلة afterTransactionMoney مقطوعة → chain_gap (معاملات مخفاية)
 */
function analyzeWalletRows(rows, knownCjCodes) {
  const anomalies = [];
  const stats = { total: rows.length, payments: 0, refunds: 0, unknown_payment: 0, double_charge: 0, chain_gap: 0 };
  const byCode = new Map();

  for (const r of rows) {
    const typeNum = Number(r.tradeType) || 0;
    const status = String(r.status || '');
    const code = String(r.cjOrderId || '').trim().toLowerCase();
    const money = Number(r.copeMoney) || 0;
    if (status !== '1') continue;               // Pending/Failed/Frozen — ماشي نجاح مالي
    if (PAYMENT_TYPES.has(typeNum)) {
      stats.payments++;
      if (code && !knownCjCodes.has(code)) {
        stats.unknown_payment++;
        anomalies.push({
          kind: 'unknown_payment', cjOrderId: r.cjOrderId, amount: money,
          typeDesc: r.typeDesc || TRADE_TYPES[typeNum] || String(typeNum),
          date: r.createDate || '', id: r.id || '',
          note: 'خصم نجح فالمحفظة على أمر ما كايناش فDB (لا طفل لا والد) — تحقق يدوي',
        });
      }
      if (code) {
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push({ amount: money, date: r.createDate || '', id: r.id || '' });
      }
    } else if (REFUND_TYPES.has(typeNum)) {
      stats.refunds++;
    }
  }

  for (const [code, pays] of byCode) {
    if (pays.length > 1) {
      stats.double_charge++;
      anomalies.push({
        kind: 'double_charge', cjOrderId: code, count: pays.length,
        amounts: pays.map((p) => p.amount), dates: pays.map((p) => p.date),
        note: 'نفس الأمر CJ تخلص ' + pays.length + ' مرات بنجاح — دفع مزدوج محتمل',
      });
    }
  }

  // سلسلة الرصيد: نرتبو بالوقت تصاعدياً ونتحققو after(n) ≈ after(n-1) ± amount(n)
  const chain = rows
    .filter((r) => String(r.status || '') === '1' && r.afterTransactionMoney != null && r.createDate)
    .sort((a, b) => String(a.createDate).localeCompare(String(b.createDate)));
  for (let i = 1; i < chain.length; i++) {
    const prevAfter = Number(chain[i - 1].afterTransactionMoney);
    const curAfter = Number(chain[i].afterTransactionMoney);
    const delta = Math.abs(Number(chain[i].copeMoney) || 0);
    if (!Number.isFinite(prevAfter) || !Number.isFinite(curAfter)) continue;
    // تسامح سنت واحد — الجولة (rounding) فعرض دولارات
    if (Math.abs(Math.abs(curAfter - prevAfter) - delta) > 0.011) {
      stats.chain_gap++;
      anomalies.push({
        kind: 'chain_gap', at: chain[i].createDate, cjOrderId: chain[i].cjOrderId || null,
        prevAfter: prevAfter, curAfter: curAfter, expectedDelta: delta, id: chain[i].id || '',
        note: 'سلسلة afterTransactionMoney مقطوعة — معاملة مخفية بين جوج سجلات متتاليين',
      });
    }
  }
  return { stats, anomalies };
}

/**
 * 💰 الكرون الأسبوعي — wallet recon كامل (قراءة CJ + مقارنة DB + تقرير + تنبيه)
 */
async function runWalletRecon({ days = 8, deps = {} } = {}) {
  const db = deps.pool || pool;
  const audit = deps.auditEvent || auditEvent;
  const alert = deps.sendAdminAlert || sendAdminAlert;
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // بالأمس — يوم كامل
  const result = { checked: 0, anomalies: 0, window: [start, end] };
  try {
    await ensureReconTable(db);
    const rows = await fetchBillingHistory({ startDay: start, endDay: end, deps });
    result.checked = rows.length;

    // الأكواد المعروفة: أطفال + أباء + split داخل نفس الخانة (comma-joined كيتفكك)
    const { rows: dbRows } = await db.query(`
      SELECT cj_order_number, cj_parent_order_number FROM orders
      WHERE cj_order_number IS NOT NULL AND cj_order_number != ''
        AND created_at >= NOW() - INTERVAL '400 days'
    `);
    const known = new Set();
    for (const r of dbRows) {
      for (const part of String(r.cj_order_number || '').split(',')) {
        const v = part.trim().toLowerCase();
        if (v && !/^store-/i.test(v)) known.add(v);
      }
      const p = String(r.cj_parent_order_number || '').trim().toLowerCase();
      if (p) known.add(p);
    }

    const { stats, anomalies } = analyzeWalletRows(rows, known);
    result.anomalies = anomalies.length;

    await db.query(
      `INSERT INTO cj_recon_reports (kind, window_start, window_end, stats, anomalies)
       VALUES ('wallet', $1, $2, $3, $4)`,
      [start, end, JSON.stringify(stats), JSON.stringify(anomalies.slice(0, 50))]
    );

    if (anomalies.length) {
      await audit('WALLET_RECON_ANOMALIES', null, { count: anomalies.length, window: [start, end] }, 'critical');
      const lines = anomalies.slice(0, 8).map((a) =>
        `<li><code>${a.kind}</code> — ${a.cjOrderId || a.at || '?'} — $${a.amount != null ? a.amount : '?'} — ${a.note}</li>`).join('');
      await alert(
        `🔍 [Laclarc] Wallet Recon — ${anomalies.length} شذوذ مالي (${start} → ${end})`,
        `<p>فحص ${rows.length} معاملة من فواتير CJ مقابل سجلاتنا.</p><ul>${lines}</ul>
         <p>التقرير كامل فجدول cj_recon_reports. هادي قراءة — ما تبديل حتى شي حاجة أوتوماتيكياً.</p>`
      ).catch(() => {});
      console.warn(`🔍 [WalletRecon] ${anomalies.length} anomalies — admin alerted`);
    } else {
      console.log(`✅ [WalletRecon] clean — ${rows.length} معاملة، صفر شذوذ (${start} → ${end})`);
    }
    return result;
  } catch (e) {
    console.warn(`🔍 [WalletRecon] failed: ${e.message}`);
    await audit('WALLET_RECON_FAILED', null, { error: String(e.message || e).slice(0, 300) }, 'warning').catch(() => {});
    return { ...result, error: e.message };
  }
}

/**
 * 🧟 1.6 listOrder — أطفال CJ اللي ما معروفينش فDB (عكس الزومبي)
 * window ≤ 90 يوم (دوك) — نستعملو 8 أيام للجولة الأسبوعية.
 */
async function fetchCjOrdersWindow({ startDay, endDay, maxPages = 5, deps = {} }) {
  const call = deps.call || (async (params) => {
    const res = await cjRequest((token) =>
      axios.get(`${CJ_API}/shopping/order/list`, {
        params,
        headers: { 'CJ-Access-Token': token },
      })
    );
    return res.data || {};
  });
  const from = new Date(startDay + 'T00:00:00Z').getTime();
  const to = new Date(endDay + 'T23:59:59Z').getTime();
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const env = await call({ pageNum: page, pageSize: 100, createDateFrom: from, createDateTo: to });
    if (env.code !== 200 || env.result === false) {
      throw new Error(`listOrder envelope ${env.code}: ${env.message || 'unknown'}`);
    }
    const list = (env.data && Array.isArray(env.data.list)) ? env.data.list : [];
    rows.push(...list);
    const total = Number(env.data && env.data.total) || 0;
    if (page * 100 >= total) break;
  }
  return rows;
}

/**
 * 🔎 pure — صف CJ مقابل الأكواد المعروفة + تضارب الحالات
 * dbIndex: Map من كود lowercase → { inDb: true, status } (طفل/أب/رقم متجر)
 */
function analyzeCjOrderRow(cjOrder, dbIndex) {
  const code = String(cjOrder.cjOrderId || '').trim().toLowerCase();
  const orderNum = String(cjOrder.orderNum || '').trim().toLowerCase();
  const hit = (code && dbIndex.has(code)) || (orderNum && dbIndex.has(orderNum));
  const anomalies = [];
  if (!hit) {
    anomalies.push({
      kind: 'orphan_cj_order', cjOrderId: cjOrder.cjOrderId, orderNum: cjOrder.orderNum,
      status: cjOrder.orderStatus, paymentDate: cjOrder.paymentDate || null,
      amount: cjOrder.orderAmount != null ? cjOrder.orderAmount : null,
      createDate: cjOrder.createDate || '',
      note: 'أمر كاين فCJ وما كايناش فDB — نداء خارج سجلاتنا ولا دفع خارج الموقع — تحقق يدوي',
    });
    return anomalies;
  }
  // تضارب الحالات — المعلومات فقط إلا خطرة
  const dbRow = dbIndex.get(code) || dbIndex.get(orderNum);
  const cjStatus = String(cjOrder.orderStatus || '').toUpperCase();
  if (cjStatus === 'CANCELLED' && dbRow && dbRow.status && ['paid', 'fulfilled'].includes(dbRow.status)) {
    anomalies.push({
      kind: 'status_conflict', cjOrderId: cjOrder.cjOrderId, orderNum: cjOrder.orderNum,
      cjStatus, dbStatus: dbRow.status,
      note: 'CJ لغا الأمر والموقع كيعدو paid/fulfilled — الزبون مستنى شي ما غايش جي',
    });
  }
  return anomalies;
}

/**
 * 🧟 الكرون — orphan sweep (قراءة CJ + مقارنة DB + تقرير + تنبيه)
 */
async function runOrphanSweep({ days = 8, deps = {} } = {}) {
  const db = deps.pool || pool;
  const audit = deps.auditEvent || auditEvent;
  const alert = deps.sendAdminAlert || sendAdminAlert;
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const result = { checked: 0, anomalies: 0, window: [start, end] };
  try {
    await ensureReconTable(db);
    const cjRows = await fetchCjOrdersWindow({ startDay: start, endDay: end, deps });
    result.checked = cjRows.length;

    // فهرسة DB: كل كود معروف → status (طفل/أب/متفكك من split)
    const { rows: dbRows } = await db.query(`
      SELECT id, cj_order_number, cj_parent_order_number, status
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '${Number(days) + 3} days'
    `);
    const dbIndex = new Map();
    const addKey = (k, status) => {
      const v = String(k || '').trim().toLowerCase();
      if (v && !dbIndex.has(v)) dbIndex.set(v, { status });
    };
    for (const r of dbRows) {
      for (const part of String(r.cj_order_number || '').split(',')) addKey(part, r.status);
      addKey(r.cj_parent_order_number, r.status);
      const m = String(r.cj_order_number || '').match(/^STORE-(\d+)/i);
      if (m) addKey(`store-${m[1]}`, r.status);
    }
    // STORE-id مباشر من id
    for (const r of dbRows) addKey(`store-${r.id}`, r.status);

    const anomalies = [];
    const stats = { cj_orders: cjRows.length, orphans: 0, status_conflicts: 0 };
    for (const o of cjRows) {
      const found = analyzeCjOrderRow(o, dbIndex);
      for (const a of found) {
        anomalies.push(a);
        if (a.kind === 'orphan_cj_order') stats.orphans++;
        if (a.kind === 'status_conflict') stats.status_conflicts++;
      }
    }
    result.anomalies = anomalies.length;

    await db.query(
      `INSERT INTO cj_recon_reports (kind, window_start, window_end, stats, anomalies)
       VALUES ('orphan', $1, $2, $3, $4)`,
      [start, end, JSON.stringify(stats), JSON.stringify(anomalies.slice(0, 50))]
    );

    if (anomalies.length) {
      await audit('ORPHAN_SWEEP_ANOMALIES', null, { count: anomalies.length, stats }, 'critical');
      const lines = anomalies.slice(0, 8).map((a) =>
        `<li><code>${a.kind}</code> — ${a.cjOrderId || '?'} (${a.orderNum || '—'}) — ${a.status || a.cjStatus || ''} — ${a.note}</li>`).join('');
      await alert(
        `🧟 [Laclarc] Orphan Sweep — ${anomalies.length} أمر مشكوك فيهم (${start} → ${end})`,
        `<p>CJ رجع ${cjRows.length} أمر فالنافذة. <ul>${lines}</ul>
         <p>التقرير فجدول cj_recon_reports (kind=orphan). قراءة فقط — القرار بشري.</p>`
      ).catch(() => {});
      console.warn(`🧟 [OrphanSweep] ${anomalies.length} anomalies — admin alerted`);
    } else {
      console.log(`✅ [OrphanSweep] clean — ${cjRows.length} أمر CJ، كلهم معروفين`);
    }
    return result;
  } catch (e) {
    console.warn(`🧟 [OrphanSweep] failed: ${e.message}`);
    await audit('ORPHAN_SWEEP_FAILED', null, { error: String(e.message || e).slice(0, 300) }, 'warning').catch(() => {});
    return { ...result, error: e.message };
  }
}

/** 📜 آخر التقارير — للأدمن */
async function recentReconReports(limit = 10, deps = {}) {
  const db = deps.pool || pool;
  await ensureReconTable(db);
  const { rows } = await db.query(
    `SELECT id, kind, ran_at, window_start, window_end, stats, anomalies
     FROM cj_recon_reports ORDER BY ran_at DESC LIMIT $1`, [limit]
  );
  return rows;
}

module.exports = {
  ensureReconTable,
  fetchBillingHistory,
  analyzeWalletRows,
  runWalletRecon,
  fetchCjOrdersWindow,
  analyzeCjOrderRow,
  runOrphanSweep,
  recentReconReports,
  TRADE_TYPES,
};
