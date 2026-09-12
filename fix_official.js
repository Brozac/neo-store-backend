'use strict';
// fix_official.js — [1] الحالات الرسمية + [2] كرون التتبع v3 (Batch: طلب واحد لـ 50!)
const fs = require('fs'), vm = require('vm');
const CW = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjWebhookService.js';
const S  = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\server.js';
let cw = fs.readFileSync(CW, 'utf8');
let sv = fs.readFileSync(S, 'utf8');
const cwB = cw, svB = sv;
const problems = [];

// ===== [1] خريطة الحالات الرسمية =====
{
  const start = cw.indexOf('const CJ_ORDER_STATUS_MAP = {');
  const end = start === -1 ? -1 : cw.indexOf('};', start);
  if (start === -1 || end === -1) { console.log('FAIL [1] map anchors'); problems.push('map'); }
  else {
    const NEW = `const CJ_ORDER_STATUS_MAP = {
  // ⭐ الحالات الرسمية (Order Status docs — مؤكدة 2026):
  CREATED: 'paid', IN_CART: 'paid', UNPAID: 'paid',        // معلومات — الزبون دفع عندنا أصلاً
  PENDING: 'paid', PROCESSING: 'paid', UNSHIPPED: 'paid',  // aggregate + sub-status — معلومات فقط
  SHIPPED: 'fulfilled',
  DELIVERED: 'completed',
  CANCELLED: 'manual',
  // 🛡️ احتياط (أسماء قديمة/غير رسمية — ما تضرش):
  IN_STOCK: 'paid', IN_PROGRESS: 'paid', DISPATCHED: 'fulfilled',
  COMPLETED: 'completed', CLOSED: 'manual', REFUND_COMPLETE: 'manual', INTERCEPT: 'manual',
};`;
    cw = cw.slice(0, start) + NEW + cw.slice(end + 2);
    console.log('OK   [1] CJ_ORDER_STATUS_MAP -> الحالات الرسمية');
  }
}

// ===== brace-aware extractor (من check_laclarc.js — مثبت) =====
function extractBlock(txt, s){
  let i = txt.indexOf('{', s); if(i===-1) return null;
  let depth=0;
  for(let j=i; j<txt.length; j++){
    const c=txt[j];
    if(c==='\''||c==='"'||c==='`'){ const q=c; j++;
      while(j<txt.length){ if(txt[j]==='\\'){j+=2;continue;} if(txt[j]===q)break; j++; } continue; }
    if(c==='/'&&txt[j+1]==='/'){ while(j<txt.length&&txt[j]!=='\n')j++; continue; }
    if(c==='/'&&txt[j+1]==='*'){ const e=txt.indexOf('*/',j+2); if(e===-1)break; j=e+1; continue; }
    if(c==='{')depth++;
    else if(c==='}'){ depth--;
      if(depth===0){ let k=j+1; while(k<txt.length&&/\s/.test(txt[k]))k++;
        if(txt[k]===')'){k++; while(k<txt.length&&/\s/.test(txt[k]))k++; if(txt[k]===';')k++;}
        return txt.slice(s,k); } }
  }
  return null;
}

// ===== [2] كرون التتبع v3 — Batch =====
{
  const s = sv.indexOf("cron.schedule('30 * * * *'");
  if (s === -1) { console.log('FAIL [2] cron anchor'); problems.push('cron'); }
  else {
    const block = extractBlock(sv, s);
    if (!block) { console.log('FAIL [2] extract'); problems.push('cron'); }
    else {
      const EOL = sv.includes('\r\n') ? '\r\n' : '\n';
      const NEW = [
"cron.schedule('30 * * * *', async () => {",
"  console.log('\\u23f3 [CJ Logistics v3] Batch tracking (1 call / up to 50 orders)...');",
"  try {",
"    const { rows: pendingTrackingOrders } = await pool.query(`",
"      SELECT id, status, customer_name, customer_email, customer_phone, total_amount, cj_order_number",
"      FROM orders",
"      WHERE status IN ('paid', 'fulfilled')",
"        AND (tracking_number IS NULL OR tracking_number = '')",
"        AND created_at >= NOW() - INTERVAL '15 days'",
"      LIMIT 50;",
"    `);",
"    if (pendingTrackingOrders.length === 0) return;",
"",
"    // \\u2b50 1.16 \\u0642\\u064a\\u0628\\u0644: \\u0631\\u0642\\u0645 CJ (SD...) / \\u0631\\u0642\\u0645 \\u0627\\u0644\\u0645\\u062a\\u062c\\u0631 (STORE-x) / order id",
"    const keys = pendingTrackingOrders.map(o => {",
"      const stored = String(o.cj_order_number || '').trim();",
"      const key = stored && !/^STORE-/i.test(stored) ? stored : `STORE-${o.id}`;",
"      return { order: o, key };",
"    });",
"",
"    const batchRes = await cjRequest((token) =>",
"      axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetailBatch',",
"        { orderIds: keys.map(k => k.key) },",
"        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }",
"      )",
"    );",
"",
"    if (batchRes.data?.code !== 200) {",
"      // 1600000 = retry later (\\u0645\\u0627\\u0634\\u064a \"\\u0645\\u0627\\u0643\\u0627\\u0645\\u0643\\u0634\") — \\u0627\\u0644\\u062f\\u0648\\u0631\\u0629 \\u0627\\u0644\\u062c\\u0627\\u064a\\u0629 \\u062a\\u0639\\u0627\\u0648\\u062f",
"      console.warn(`\\u26a0\\ufe0f [Tracking] Batch: ${batchRes.data?.message} (code: ${batchRes.data?.code})`);",
"      return;",
"    }",
"    const list = Array.isArray(batchRes.data?.data) ? batchRes.data.data : [];",
"",
"    // \\ud83d\\udd2c \\u0639\\u064a\\u0646\\u0629 \\u0623\\u0648\\u0644 \\u0642\\u0631\\u0627\\u0621\\u0629 Batch — \\u0622\\u062e\\u0631 \\u0639\\u064a\\u0646\\u0629 \\u0641\\u0627\\u0644\\u0645\\u0634\\u0631\\u0648\\u0639",
"    if (!global._cjSample_OrderDetailBatch) {",
"      global._cjSample_OrderDetailBatch = true;",
"      console.log('[Sample OrderDetailBatch]', JSON.stringify(list[0] || {}).slice(0, 1000));",
"    }",
"",
"    // \\u0641\\u0647\\u0631\\u0633\\u0629 \\u0628\\u0627\\u0644\\u062c\\u0648\\u062c \\u0627\\u0644\\u0645\\u0641\\u0627\\u062a\\u064a\\u062d (orderNum = STORE-x | cjOrderCode = SD...)",
"    const byKey = new Map();",
"    for (const d of list) {",
"      if (d.orderNum) byKey.set(String(d.orderNum).toLowerCase(), d);",
"      if (d.cjOrderCode) byKey.set(String(d.cjOrderCode).toLowerCase(), d);",
"    }",
"",
"    for (const { order, key } of keys) {",
"      const d = byKey.get(key.toLowerCase());",
"      if (!d) continue; // CJ \\u062a\\u062e\\u0637\\u0627\\u0647 \\u0628\\u0635\\u0645\\u062a — \\u0646\\u0633\\u062a\\u0646\\u0648 \\u0627\\u0644\\u062f\\u0648\\u0631\\u0629 \\u0627\\u0644\\u062c\\u0627\\u064a\\u0629",
"",
"      const status = String(d.orderStatus || '').toUpperCase();",
"      const track = String(d.trackNumber || '').trim();",
"",
"      if (status === 'SHIPPED' && track.length > 3) {",
"        const upd = await pool.query(",
"          `UPDATE orders",
"             SET tracking_number = $1, status = 'fulfilled',",
"                 cj_order_number = COALESCE(NULLIF(cj_order_number,''), $3)",
"           WHERE id = $2 AND status = 'paid'",
"             AND (tracking_number IS NULL OR tracking_number = '')",
"           RETURNING id`,",
"          [track, order.id, d.cjOrderCode || key]",
"        );",
"        if (upd.rows.length) {",
"          console.log(`\\ud83d\\ude80 [CJ Dispatched] #${order.id}: ${track} (${d.logisticName || '?'})`);",
"          await notifyShipment(order, track, d.logisticName);",
"        }",
"      } else if (status === 'DELIVERED') {",
"        if (order.status === 'paid' && track.length > 3) {",
"          // \\ud83d\\udea8 \\u0641\\u0627\\u062a\\u0646\\u0627 SHIPPED (\\u0648\\u064a\\u0628 \\u0647\\u0648\\u0643 \\u0636\\u0627\\u064a\\u0639) — \\u0625\\u0634\\u0639\\u0627\\u0631 \\u0645\\u062a\\u0623\\u062e\\u0631 \\u062e\\u064a\\u0631 \\u0645\\u0646 \\u0648\\u0627\\u0644\\u0648",
"          const upd = await pool.query(",
"            `UPDATE orders SET tracking_number = $1, status = 'fulfilled'",
"             WHERE id = $2 AND status = 'paid' AND (tracking_number IS NULL OR tracking_number = '') RETURNING id`,",
"            [track, order.id]",
"          );",
"          if (upd.rows.length) {",
"            console.log(`[CJ] #${order.id} DELIVERED (SHIPPED \\u0641\\u0627\\u062a) — \\u0625\\u0634\\u0639\\u0627\\u0631 \\u0645\\u062a\\u0623\\u062e\\u0631`);",
"            await notifyShipment(order, track, d.logisticName);",
"          }",
"        } else if (order.status === 'fulfilled') {",
"          const upd = await pool.query(",
"            \"UPDATE orders SET status = 'completed' WHERE id = $1 AND status = 'fulfilled' RETURNING id\",",
"            [order.id]",
"          );",
"          if (upd.rows.length) console.log(`[CJ] #${order.id} DELIVERED -> completed`);",
"        }",
"      }",
"    }",
"  } catch (err) {",
"    logger.logError('CJ Logistics Cron', err);",
"  }",
"});"
      ].join(EOL);
      sv = sv.slice(0, s) + NEW + sv.slice(s + block.length);
      console.log('OK   [2] tracking cron v3 (Batch) — EOL=' + (EOL === '\r\n' ? 'CRLF' : 'LF'));
    }
  }
}

fs.writeFileSync(CW, cw, 'utf8');
fs.writeFileSync(S, sv, 'utf8');

console.log('\n[syntax]:');
try { new vm.Script(cw, { filename: 'cjWebhookService.js' }); console.log('  OK   cjWebhookService.js'); }
catch (e) { console.log('  BAD  ' + e.message); fs.writeFileSync(CW, cwB, 'utf8'); problems.push('syntax-cw'); }
try { new vm.Script(sv, { filename: 'server.js' }); console.log('  OK   server.js'); }
catch (e) { console.log('  BAD  ' + e.message); fs.writeFileSync(S, svB, 'utf8'); problems.push('syntax-sv'); }

console.log('\n========== RESULT ==========');
console.log(problems.length ? '⚠️ PROBLEMS: ' + problems.join(' | ') + ' — صيفط الـ output' : '✅ FIXED — commit & push');