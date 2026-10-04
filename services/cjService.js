// services/cjService.js - Laclarc Enterprise Dropshipping Engine (v3 FINAL)
// 🩹 Hardened 2026-10-02 — full audit applied:
//   • exports: + probeOrderStatus/classifyDuplicate (cjWebhookService P0-20 يعتمدهما)
//   • attemptRefulfill: IN_FLIGHT لا يحرق محاولة SelfHeal (FIX#16)
//   • fatal-path: zt.halted ينتشر (لا alert مكرر) (FIX#17)
//   • resolveSplitDup: alive → يحفظ realCj الحقيقي (FIX#إ3)
require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const logger = require('../logger');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sendPurchaseConversion } = require('./conversionService');



let cachedCjToken = null;
let cachedCjTokenExpiry = null;
let cachedCjRefreshToken = null;
let tokenRefreshPromise = null; // ✨ Mutex — حماية ضد تسابق التوكن

// ==========================================
// 1. نظام إدارة وتجديد التوكن المحصن (Thread-Safe)
// 🩹 v3 — الـ finally القديم كان يُنفّذ قبل تعيين الـ promise (throw متزامن =
//    rejected promise مخزّن للأبد). الآن: التعيين خارج الـ IIFE + تنظيف شرطي.
// ==========================================
async function getCJToken(forceRefresh = false) {
  if (!forceRefresh && cachedCjToken && cachedCjTokenExpiry && Date.now() < cachedCjTokenExpiry) {
    return cachedCjToken;
  }

  if (tokenRefreshPromise) {
    return await tokenRefreshPromise;
  }

  const refreshJob = (async () => {
    const apiKey = process.env.CJ_API_KEY;
    if (!apiKey) throw new Error("CJ_API_KEY is missing in environment variables");

    try {
      if (cachedCjRefreshToken && !forceRefresh) {
        try {
          const refreshRes = await axios.post('https://developers.cjdropshipping.com/api2.0/v1/authentication/refreshAccessToken', {
            refreshToken: cachedCjRefreshToken
          }, { timeout: 15000 });

          if (refreshRes.data.code === 200 && refreshRes.data.data?.accessToken) {
            cachedCjToken = refreshRes.data.data.accessToken;
            cachedCjRefreshToken = refreshRes.data.data.refreshToken;
            const expiryDateStr = refreshRes.data.data.accessTokenExpiryDate;
            cachedCjTokenExpiry = expiryDateStr ? new Date(expiryDateStr).getTime() - 10 * 60 * 1000 : Date.now() + 12 * 60 * 60 * 1000;
            return cachedCjToken;
          }
        } catch (e) {
          cachedCjRefreshToken = null;
        }
      }

      const authRes = await axios.post('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
        apiKey: apiKey
      }, { timeout: 15000 });

      if (authRes.data.code === 200 && authRes.data.data?.accessToken) {
        cachedCjToken = authRes.data.data.accessToken;
        cachedCjRefreshToken = authRes.data.data.refreshToken;
        const expiryDateStr = authRes.data.data.accessTokenExpiryDate;
        cachedCjTokenExpiry = expiryDateStr ? new Date(expiryDateStr).getTime() - 10 * 60 * 1000 : Date.now() + 12 * 60 * 60 * 1000;
        return cachedCjToken;
      } else {
        throw new Error(`CJ Authentication failed: ${authRes.data.message || 'Unknown error'}`);
      }
    } finally {
      // cleanup happens outside (below) — a synchronous throw would run this block BEFORE the promise is assigned,
      // leaving a rejected promise cached forever
    }
  })();

  tokenRefreshPromise = refreshJob;
  refreshJob.then(() => {}, () => {}).finally(() => {
    if (tokenRefreshPromise === refreshJob) tokenRefreshPromise = null;
  });

  return await refreshJob;
}

// ==========================================
// 2. بوابة QPS عالمية
// ==========================================
const CJ_MIN_GAP_MS = 1100;
let cjChain = Promise.resolve();
let cjLastAt = 0;
function cjPace() {
  const job = cjChain.then(async () => {
    const wait = Math.max(0, cjLastAt + CJ_MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    cjLastAt = Date.now();
  });
  cjChain = job.then(() => {}, () => {});
  return job;
}

async function cjRequest(requestFn, retryCount = 0) {
  try {
    const token = await getCJToken();
    const config = { timeout: 45000 };
    await cjPace();
    return await requestFn(token, config);
  } catch (err) {
    const status = err.response?.status;
    const cjCode = err.response?.data?.code;
    const isAuthError = status === 401 || cjCode === 401 || cjCode === 1600001;

    if (cjCode === 1600200 || status === 429) {
      if (retryCount < 3) {
        const backoffTime = (retryCount + 1) * 1500;
        console.warn(`⚠️ CJ QPS Limit hit. Retrying in ${backoffTime}ms (Attempt ${retryCount + 1}/3)...`);
        await new Promise(r => setTimeout(r, backoffTime));
        return cjRequest(requestFn, retryCount + 1);
      }
      throw err;
    }

    if (isAuthError && retryCount < 1) {
      console.log('⚠️ CJ token expired during request. Refreshing now...');
      const freshToken = await getCJToken(true);
      await cjPace();
      return await requestFn(freshToken, { timeout: 45000 });
    }
    throw err;
  }
}

const parseNumeric = (val) => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const match = String(val).match(/[-+]?\d*\.?\d+/);
  return match ? parseFloat(match[0]) : 0;
};

// ==========================================
// 🔧 Helpers — مستوى الملف
// ==========================================
const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

const DEAD_CJ_STATUSES = ['TRASH', 'CANCELLED', 'CLOSED', 'INTERCEPTED'];

// 🔢 CJ يحتجز رقم الطلب للأبد حتى بعد الحذف (TRASH) → 1603003 دائماً.
// الترقيم حتمي (deterministic): STORE-77, STORE-77-R2, STORE-77-R3 ... ويستأنف من آخر رقم *مؤكد الموت*
// (ذاكرة + system_events) بدل ما يعاود من الصفر كل استدعاء ويحرق الـ carriers على أرقام ميتة (سبب حلقة #77).
// حتمي = idempotent: لو CJ قبل الطلب ولم يُحفظ رقمه عندنا، المحاولة التالية تلقاه (1603003 + probe حي) ولا تنشئ نسخة ثانية.
const MAX_NUMBER_BUMPS = 12;   // سقف الأرقام المحروقة في استدعاء واحد (كل رقم ≈ 5 ثواني)
const MAX_SPLIT_BUMPS = 6;
const burnedBump = new Map();           // base -> أعلى bump مؤكد الموت
const fulfillInFlight = new Set();      // orderId — fulfillment واحد فقط لكل طلب في نفس الوقت
const capiSent = new Set();             // orderId — Purchase مرة واحدة لكل عملية

const numberFor = (base, bump) => (bump <= 1 ? base : `${base}-R${bump}`);

async function loadBurnedBump(base, orderId) {
  let max = burnedBump.get(base) || 0;
  try {
    const { rows } = await pool.query(
      `SELECT details FROM system_events WHERE order_id = $1 AND event_type = 'CJ_NUMBER_BURNED' ORDER BY created_at DESC LIMIT 200`,
      [orderId]
    );
    for (const r of rows) {
      let d = r.details;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { continue; } }
      if (d && d.base === base && Number.isInteger(d.bump) && d.bump > max) max = d.bump;
    }
  } catch (e) {
    console.warn(`⚠️ [CJ] loadBurnedBump #${orderId} failed (${e.message}) — using in-memory state`);
  }
  if (max > 0) burnedBump.set(base, max);
  return max;
}

async function markBurned(base, bump, orderId, reason) {
  if (bump > (burnedBump.get(base) || 0)) burnedBump.set(base, bump);
  await auditEvent('CJ_NUMBER_BURNED', orderId, { base, bump, number: numberFor(base, bump), reason }, 'info');
}

// 1603003 = "الرقم موجود" — نجاح منطقي فقط إذا أثبت الـ probe أنه حي *ولنفس الرقم*
//   alive → نجاح | dead → رقم محروق (نرقّي) | ambiguous → لا ننشئ نسخة ثانية ولا نعلن نجاحاً (halt)
function classifyDuplicate(probe) {
  if (!probe || !probe.status || probe.status === 'UNKNOWN') return 'ambiguous';
  if (!probe.matched) return 'ambiguous';
  if (DEAD_CJ_STATUSES.includes(probe.status)) return 'dead';
  return 'alive';
}

async function getSavedCjNumber(orderId) {
  try {
    const r = await pool.query('SELECT cj_order_number FROM orders WHERE id = $1', [orderId]);
    return r.rows[0]?.cj_order_number || null;
  } catch (e) {
    return null;
  }
}

// 🛑 توقف لا يحله إعادة المحاولة → manual + alert مفصّل (القرار البشري: refund/إصلاح) — لا S1/S2/refund آلي
async function haltOrderManual(orderId, info, lastErr) {
  try {
    await pool.query(
      "UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1 AND status IN ('paid','pending','processing')",
      [orderId]
    );
  } catch (e) {
    console.warn(`⚠️ [CJ] haltOrderManual #${orderId} status update failed: ${e.message}`);
  }
  let errStr = '';
  try { errStr = typeof lastErr === 'string' ? lastErr : JSON.stringify(lastErr || {}); } catch (e) { errStr = String(lastErr); }
  await auditEvent('CJ_ORDER_HALTED', orderId, { ...info, lastError: errStr.slice(0, 500) }, 'critical');
  console.error(`🛑 [CJ] #${orderId} HALTED (${info.reason}) → manual. ${JSON.stringify(info)}`);
  sendAdminAlert(
    `🛑 CJ order #${orderId} متوقف — ${info.reason}`,
    `<p>الـ fulfillment توقف لأن إعادة المحاولة لن تحل المشكل (وS1/S2 كانا سيعيدان نفس الفشل + إيميل جديد للزبون).</p>
     <p><b>السبب:</b> <code>${info.reason}</code></p>
     <pre style="background:#f5f5f5;padding:10px;border-radius:6px">${JSON.stringify(info, null, 2)}</pre>
     <p><b>آخر رد من CJ:</b> <code>${errStr.slice(0, 400).replace(/</g, '&lt;')}</code></p>
     <p>الحالة → manual. افحص الطلب في CJ Dashboard (هل موجود فعلاً؟) ثم قرّر: إعادة إرسال يدوية أو refund.</p>`
  ).catch(e => console.warn(`📧 [CJ] halt admin-alert FAILED #${orderId}: ${e.message}`));
}

function extractCjNumber(dataObj) {
  const d = dataObj || {};
  const isOurEcho = (v) => typeof v === 'string' && /^STORE-/i.test(v);
  if (d.cjOrderCode) return d.cjOrderCode;
  if (d.orderId && !isOurEcho(d.orderId)) return d.orderId;
  if (d.orderNumber && !isOurEcho(d.orderNumber)) return d.orderNumber;
  return d.cjOrderId || d.cjOrderNumber || null;
}

function sampleOnce(tag, obj) {
  const key = `_cjSample_${tag}`;
  if (!global[key]) {
    global[key] = true;
    console.log(`🔬 [Sample ${tag}]`, JSON.stringify(obj || {}).slice(0, 600));
  }
}

async function probeOrderStatus(targetOrderNumber, tag) {
  try {
    await new Promise(r => setTimeout(r, 1200));
    const detail = await cjRequest((token) =>
      axios.get(`${CJ_API}/shopping/order/getOrderDetail`, {
        params: { orderId: targetOrderNumber },
        headers: { 'CJ-Access-Token': token },
      })
    );
    // ⚠️ code != 200 (طلب غير موجود/خطأ) = غير معروف — ماشي "حي" (كان يمر كنجاح منطقي كاذب)
    const body = detail.data || {};
    const okBody = body.code === 200 || (body.code === undefined && body.data);
    if (!okBody) {
      console.warn(`⚠️ [CJ] probe (${tag}) ${targetOrderNumber}: code=${body.code} message=${body.message}`);
      return { status: 'UNKNOWN', realCj: null, orderNum: '', matched: false };
    }
    const dd = body.data || {};
    sampleOnce(tag, dd);
    const realCj = extractCjNumber(dd) || extractCjNumber(dd.orderInfo);
    const status = String(dd.orderStatus || '').toUpperCase() || 'UNKNOWN';
    // 🔍 هل الطلب المرجّع هو *نفس* الرقم المسؤول عنه؟ (CJ قد يرجّع طلباً آخر)
    const orderNum = String(dd.orderNum || '').trim();
    const t = String(targetOrderNumber || '').trim().toLowerCase();
    const same = (v) => String(v || '').trim().toLowerCase() === t;
    // ⓘ متساهل عمداً: رد بلا orderNum يُعتبر مطابقاً (يفادي halts كاذبة) — العينات تثبت orderNum دائماً حاضر
    const matched = !orderNum || same(orderNum) || same(dd.cjOrderCode) || same(dd.orderId);
    return { status, realCj, orderNum, matched };
  } catch (e) {
    console.warn(`⚠️ [CJ] probe (${tag}) فشل لـ ${targetOrderNumber}:`, e.response?.data?.message || e.message);
    return { status: 'UNKNOWN', realCj: null, orderNum: '', matched: false };
  }
}

// 📋 auditEvent — كل قرار آلي يترك أثراً دائماً
// ⚠️ TODO (backlog): مركزية عبر lib/audit بعد توحيد CJS/ESM — النسخة المحلية مؤقتاً
async function auditEvent(eventType, orderId, details = {}, severity = 'info') {
  try {
    await pool.query(
      `INSERT INTO system_events (event_type, order_id, details, severity) VALUES ($1, $2, $3, $4)`,
      [eventType, orderId || null, JSON.stringify(details), severity]
    );
  } catch (e) {
    console.warn(`⚠️ [Audit] فشل تسجيل ${eventType}#${orderId}: ${e.message}`); // Tenet #14
  }
}

// ═══════════════════════════════════════════════════════════════
// 🏦 financialGate — العقد المالي المطلق (Tenet #15)
// ═══════════════════════════════════════════════════════════════

async function financialGate(orderId) {
  try {
    const r = await pool.query(
      'SELECT status, payment_method, payment_ref, total_amount, stripe_session_id, payment_status FROM orders WHERE id = $1',
      [orderId]
    );
    const o = r.rows[0];
    if (!o) return { allow: false, reason: 'order_not_found' };

    const expectedUsd = Number(o.total_amount);
    const method = String(o.payment_method || '').toLowerCase();

        // ─── Crypto / NowPayments — Stablecoins only (USDT/USDC على TRC-20 + BEP-20) ───
    if (/crypto|nowpayments/i.test(method)) {
      if (!o.payment_ref) {
        await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'crypto', reason: 'no_payment_ref' }, 'warning');
        console.warn(`[FinGate] #${orderId} crypto بلا payment_ref — رفض احتياطي`);
        return { allow: false, reason: 'no_payment_ref' };
      }
      const key = process.env.NOWPAYMENTS_API_KEY;
      if (!key) {
        await auditEvent('FINANCIAL_GATE_ERROR', orderId, { method: 'crypto', reason: 'no_api_key' }, 'critical');
        console.error(`[FinGate] #${orderId} NOWPAYMENTS_API_KEY ناقص`);
        return { allow: false, reason: 'no_api_key' };
      }
      const res = await axios.get(`https://api.nowpayments.io/v1/payment/${o.payment_ref}`, {
        headers: { 'x-api-key': key }, timeout: 15000
      });
      const p = res.data || {};
      const paidUsd = Number(p.actually_paid_usd ?? 0);
      const st = String(p.payment_status || '');

      // 🆕 Mission #19 — whitelist العملات والشبكات المسموحة فقط
      const payCurrency = String(p.pay_currency || '').toLowerCase();          // usdt / usdc
      const payNetwork = String(p.network || p.network_id || '').toLowerCase(); // trc20 / bsc-bep20
      const ALLOWED_CRYPTO = ['usdt', 'usdc'];
      const ALLOWED_NETWORKS = ['trc20', 'tron', 'bsc', 'bep20', 'bnb'];

      const isAllowedCoin = ALLOWED_CRYPTO.includes(payCurrency);
      const isAllowedNetwork = ALLOWED_NETWORKS.some(n => payNetwork.includes(n)) || !payNetwork;

      if (!isAllowedCoin || !isAllowedNetwork) {
        await auditEvent('FINANCIAL_GATE_DENY', orderId, {
          method: 'crypto', reason: 'unsupported_currency_network',
          payCurrency, payNetwork
        }, 'warning');
        console.warn(`[FinGate] #${orderId} crypto "${payCurrency}/${payNetwork}" خارج القائمة المسموحة => DENY`);
        return { allow: false, reason: `crypto_unsupported_${payCurrency}_${payNetwork}` };
      }

      const ok = (st === 'finished' || st === 'confirmed') && paidUsd + 0.01 >= expectedUsd;
      console.log(`[FinGate] #${orderId} CRYPTO ${payCurrency}/${payNetwork} status=${st} paid_usd=${paidUsd} total=${expectedUsd} => ${ok ? 'ALLOW' : 'DENY'}`);
      if (!ok) await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'crypto', status: st, paidUsd, expectedUsd }, 'warning');
      return ok ? { allow: true } : { allow: false, reason: `crypto_${st}_${paidUsd}` };
    }

    // ─── Stripe ───
    if (/stripe/i.test(method)) {
      if (!o.stripe_session_id) {
        await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'stripe', reason: 'no_session_id' }, 'warning');
        console.warn(`[FinGate] #${orderId} stripe بلا session_id — رفض احتياطي`);
        return { allow: false, reason: 'no_session_id' };
      }
      const session = await stripe.checkout.sessions.retrieve(o.stripe_session_id);
      if (!session || session.payment_status !== 'paid') {
        await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'stripe', reason: session?.payment_status || 'missing' }, 'warning');
        console.warn(`[FinGate] #${orderId} STRIPE payment_status=${session?.payment_status} => DENY`);
        return { allow: false, reason: `stripe_${session?.payment_status || 'missing'}` };
      }
      const paidUsd = session.amount_total / 100;
      if (Math.abs(paidUsd - expectedUsd) > 0.011) {
        await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'stripe', reason: 'amount_mismatch', stripeAmt: paidUsd, dbAmt: expectedUsd }, 'critical');
        console.error(`[FinGate] #${orderId} STRIPE amount mismatch: stripe=${paidUsd} db=${expectedUsd} => DENY`);
        return { allow: false, reason: `stripe_amount_mismatch_${paidUsd}` };
      }
      try {
        const pi = typeof session.payment_intent === 'string'
          ? await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] })
          : session.payment_intent;
        const charge = pi?.latest_charge;
        if (charge && typeof charge === 'object' && charge.disputed) {
          await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'stripe', reason: 'disputed', chargeId: charge.id }, 'critical');
          console.error(`[FinGate] #${orderId} STRIPE DISPUTED charge => DENY`);
          return { allow: false, reason: 'stripe_disputed' };
        }
      } catch (dispErr) {
        console.warn(`[FinGate] #${orderId} dispute-check skipped: ${dispErr.message}`);
      }
      console.log(`[FinGate] #${orderId} STRIPE paid=${paidUsd} => ALLOW`);
      return { allow: true };
    }

    // ─── Paysera ───
    if (/paysera/i.test(method)) {
      const ok = o.payment_status === 'paid' || String(o.status) === 'paid';
      console.log(`[FinGate] #${orderId} PAYSERA db_status=${o.status}/${o.payment_status} => ${ok ? 'ALLOW (callback-signed)' : 'DENY'}`);
      if (!ok) await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'paysera', dbStatus: o.status, payStatus: o.payment_status }, 'warning');
      return ok ? { allow: true } : { allow: false, reason: 'paysera_not_paid' };
    }

    // ─── BaridiMob ───
    if (/baridi|manual/i.test(method)) {
      const approved = /paid|approved/i.test(String(o.payment_status || '')) || String(o.status) === 'paid';
      console.log(`[FinGate] #${orderId} BARIDIMOB payment_status=${o.payment_status} => ${approved ? 'ALLOW (admin-approved)' : 'DENY'}`);
      if (!approved) await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'baridimob', payStatus: o.payment_status }, 'warning');
      return approved ? { allow: true } : { allow: false, reason: 'baridimob_not_approved' };
    }

    // ─── Unknown ───
    await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: o.payment_method, reason: 'unknown_method' }, 'critical');
    console.error(`[FinGate] #${orderId} UNKNOWN payment_method="${o.payment_method}" => DENY`);
    return { allow: false, reason: `unknown_method_${o.payment_method}` };

  } catch (e) {
    logger.logError(`financialGate #${orderId}`, e);
    await auditEvent('FINANCIAL_GATE_ERROR', orderId, { error: e.message }, 'critical');
    return { allow: false, reason: 'gate_error' };
  }
}

// 📧 تنبيه الأدمن — مكتفٍ ذاتياً
async function sendAdminAlert(subject, html) {
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Laclarc Support', email: process.env.BREVO_USER },
      to: [{ email: process.env.BREVO_USER }],
      subject: subject,
      htmlContent: html
    }, { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' } });
    console.log('[admin-alert] sent: ' + subject);
  } catch (e) {
    logger.logError('Admin Alert (Brevo)', (e.response && e.response.data) || e.message);
  }
}

// 💰 جلب مبلغ الطلب (للـ ZeroTouch refund paths)
async function getOrderTotalAmount(orderId) {
  try {
    const r = await pool.query('SELECT total_amount FROM orders WHERE id = $1', [orderId]);
    return r.rows[0]?.total_amount || '0';
  } catch (e) {
    console.warn(`⚠️ [ZeroTouch] getOrderTotalAmount #${orderId} failed: ${e.message}`); // Tenet #14
    return '0';
  }
}

// 🔒 fulfillment واحد لكل طلب في نفس الوقت (Reconcile / JIT / webhook / retry / exchange / SelfHeal كلهم يصلون هنا)
// استدعاءات ZeroTouch S1 الداخلية (_nested) تمر لأنها تحت قفل المستدعي الأب
async function fulfillCJOrder(orderId, customerName, customerDetails, items, orderNumberOverride = null, forcedLogisticName = null, flags = {}) {
  const nested = !!(flags && flags._nested === true);
  const lockKey = String(orderId);
  if (!nested) {
    if (fulfillInFlight.has(lockKey)) {
      console.warn(`⏭️ [CJ] #${orderId} fulfillment already in flight — skipped (no side effects)`);
      return { success: false, reason: 'IN_FLIGHT' };
    }
    fulfillInFlight.add(lockKey);
  }
  try {
    return await fulfillCJOrderImpl(orderId, customerName, customerDetails, items, orderNumberOverride, forcedLogisticName, flags || {});
  } finally {
    if (!nested) fulfillInFlight.delete(lockKey);
  }
}
async function fulfillCJOrderImpl(orderId, customerName, customerDetails, items, orderNumberOverride = null, forcedLogisticName = null, flags = {}) {
  let cjCreated = false;
  // 🏦 financialGate — Tenet #15
  const _gate = await financialGate(orderId);
  if (!_gate.allow) {
    console.error('[FinGate] رفض إرسال #' + orderId + ' لـ CJ: ' + _gate.reason);
    return { success: false, reason: 'PAYMENT_NOT_CONFIRMED', detail: _gate.reason };
  }
  try {
    const addr = customerDetails?.address || {};
    const isSandbox = (process.env.CJ_SANDBOX_MODE === 'true' && process.env.NODE_ENV !== 'production') ? 1 : 0;
    if (isSandbox) console.warn('🧪 [SANDBOX] طلب #' + orderId + ' كيتخلق sandbox — ما غاديش يشحن!');

    // 🩹 FIX-B v2 (inner shield) — الطلب الموقوف سابقاً (HALTED) لا يُعاد إرساله تلقائياً
    //    CJ dedup يرفض نفس الزبون+المنتجات بغض النظر عن الرقم — مثبت 13+ ترقية كلها TRASH
    //    v2: صلاحية 7 أيام — بعد ذلك يُفترض أن الأدمن تدخل (CJ Dashboard / refund) ويُسمح بمحاولة جديدة
    //    force_bypass_halt: خيار يدوي مستقبلي (admin override عبر flags)
    try {
      const haltCheck = await pool.query(
        `SELECT details, created_at FROM system_events
         WHERE order_id = $1 AND event_type = 'CJ_ORDER_HALTED'
         ORDER BY created_at DESC LIMIT 1`,
        [orderId]
      );
      const halt = haltCheck.rows[0];
      const haltAgeHours = halt ? (Date.now() - new Date(halt.created_at).getTime()) / (1000 * 60 * 60) : 0;
      const isFreshHalt = halt && haltAgeHours < 168; // 7 أيام

      if (isFreshHalt && !flags._nested && !flags.force_bypass_halt) {
        console.warn(`🛑 [CJ] #${orderId} HALTED ${Math.floor(haltAgeHours)}h ago — refusing re-fulfill (CJ dedup active)`);
        return {
          success: false,
          halted: true,
          reason: 'PREVIOUSLY_HALTED',
          detail: halt.details,
          haltAgeHours: Math.floor(haltAgeHours),
        };
      }
      if (halt && !isFreshHalt) {
        console.log(`ℹ️ [CJ] #${orderId} HALTED expired (${Math.floor(haltAgeHours)}h > 168h) — allowing fresh attempt (assume admin resolved in CJ)`);
      }
    } catch (e) {
      console.warn(`🩹 [CJ] halt-check #${orderId} failed: ${e.message}`); // fail-open (لا نحجب الطلبات السليمة بسبب خطأ فحص)
    }

    let safeCustomerName = (customerName || '').trim();
    if (!safeCustomerName || safeCustomerName.toLowerCase() === 'guest customer' || !safeCustomerName.includes(' ')) {
      safeCustomerName = safeCustomerName ? `${safeCustomerName} Customer` : 'Valued Customer';
    }

    const safeEmail = (customerDetails?.email || '').trim() || 'orders@laclarc.com';

    // ═══ CAPI Purchase — Fire-and-Forget (Tenet #3) ═══
    // 🛡️ مرة واحدة لكل طلب لكل عملية — S1/retries كانت تبعث Purchase جديد في كل محاولة (20+ لـ #77)
    (async () => {
      if (capiSent.has(orderId)) return;
      capiSent.add(orderId);
      if (capiSent.size > 5000) capiSent.delete(capiSent.values().next().value);
      try {
        const { rows } = await pool.query(
          'SELECT total_amount, customer_email, customer_phone, customer_name, customer_city, utm_source, utm_campaign, click_id FROM orders WHERE id = $1',
          [orderId]
        );
        const order = rows[0];
        if (!order) { console.warn(`[CAPI] purch_${orderId} skip: order row not found`); return; }

        const capiItems = Array.isArray(items)
          ? items.map(it => ({
              productId: it.product_id ?? it.productId,
              quantity:  it.quantity   ?? 1,
              price:     it.price_at_purchase ?? it.price,
            }))
          : [];

        sendPurchaseConversion({
          orderId,
          value: parseFloat(order.total_amount),
          items: capiItems,
          email:        order.customer_email,
          phone:        order.customer_phone,
          customerName: order.customer_name,
          city:         order.customer_city,
          utmSource:    order.utm_source,
          utmCampaign:  order.utm_campaign,
          clickId:      order.click_id,
        })
          .then((s) => console.log(`[CAPI] purch_${orderId} dispatched ✓`, JSON.stringify(s)))
          .catch((e) => { capiSent.delete(orderId); console.warn(`[CAPI] purch_${orderId} non-fatal: ${e.message}`); });
      } catch (e) {
        capiSent.delete(orderId); // فشل قبل الإرسال — نسمح بمحاولة لاحقة
        console.warn(`[CAPI] purch_${orderId} context-guard: ${e.message}`);
      }
    })();

    // استخراج الـ vid + storeLineItemId
    const cjProducts = [];
    for (const item of items) {
      let vid = item.vid;
      if (!vid && item.product_id) {
        const res = await pool.query('SELECT variants FROM products WHERE id = $1', [item.product_id]);
        if (res.rows.length > 0 && res.rows[0].variants) {
          const variants = typeof res.rows[0].variants === 'string' ? JSON.parse(res.rows[0].variants) : res.rows[0].variants;
          if (Array.isArray(variants) && variants.length > 0) vid = variants[0].vid;
        }
      }
      if (vid) {
        cjProducts.push({
          vid,
          quantity: item.quantity || 1,
          storeLineItemId: item.id ? String(item.id) : `item-${orderId}-${cjProducts.length}`,
        });
      }
    }

    if (cjProducts.length === 0) {
      console.warn(`⚠️ Order #${orderId} contains no valid CJ variants. Marked as manual.`);
      await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1", [orderId]);
      return { success: false, reason: 'NO_CJ_VARIANTS' };
    }

    // استعلام شركات الشحن
    let logisticsToTry = [];
    try {
      const freightRes = await cjRequest((token) =>
        axios.post(`${CJ_API}/logistic/freightCalculate`, {
          startCountryCode: 'CN',
          endCountryCode: addr.country || 'US',
          products: cjProducts.map(p => ({ vid: p.vid, quantity: p.quantity }))
        }, { headers: { 'CJ-Access-Token': token } })
      );
      if (freightRes.data.code === 200 && freightRes.data.data?.length > 0) {
        logisticsToTry = freightRes.data.data.sort((a, b) => a.logisticPrice - b.logisticPrice).map(l => l.logisticName);
      }
    } catch (e) { console.warn("⚠️ [Fulfill] freightCalculate failed #" + orderId + ": " + e.message); }

    if (forcedLogisticName) logisticsToTry = [forcedLogisticName];
    else logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Ordinary', 'CJPacket Sensitive', 'YunExpress', '4PX'])];

    let orderSuccess = false;
    let lastError = null;
    let needsSplitting = false;
    let successfulCJOrderNumber = null;

    const baseNumber = orderNumberOverride || `STORE-${orderId}`;
    let numberBump = orderNumberOverride ? 1 : (await loadBurnedBump(baseNumber, orderId)) + 1;
    let orderNumberSeed = numberFor(baseNumber, numberBump);
    let bumpsThisCall = 0;
    let halted = null; // { reason, ... } — توقف لا تحله إعادة المحاولة → manual + alert (ماشي S1/S2/refund)
    let logisticsMissCount = 0;   // 🩹 M#28 — عدّاد الشحن المرفوض (شحن مرفوض ×3 = منتج محظور)

    let safeLine1 = (addr.line1 || 'Main Street 1').trim();
    if (!/\d/.test(safeLine1)) safeLine1 += ' 1';

    const basePayload = {
      shippingCustomerName: safeCustomerName,
      shippingCountry: addr.country || 'United States',
      shippingCountryCode: addr.country || 'US',
      shippingProvince: addr.state || addr.city || 'State',
      shippingCity: addr.city || 'City',
      shippingAddress: safeLine1,
      shippingAddress2: addr.line2 || '',
      shippingZip: addr.postal_code || '10001',
      shippingPhone: customerDetails?.phone || '1234567890',
      email: safeEmail,
      platform: 'others',
      fromCountryCode: 'CN',
      orderFlow: 1,
      shopLogisticsType: 3,
      isSandbox: isSandbox,
    };

    // 🔧 حفظ آمن — COALESCE pattern
    async function saveCjNumber(num) {
      if (!num) return;
      await pool.query(
        `UPDATE orders SET cj_order_number = COALESCE(NULLIF(cj_order_number,''), NULLIF($1,'')) WHERE id = $2`,
        [String(num), orderId]
      ).catch((e) => console.warn('⚠️ [CJ] saveCjNumber failed for #' + orderId + ' (' + num + '): ' + e.message));
    }

    // يحرق الرقم الحالي (يسجله) ثم ينتقل للتالي — false إذا تجاوزنا السقف
    const advanceNumber = async (reason) => {
      if (!orderNumberOverride) await markBurned(baseNumber, numberBump, orderId, reason);
      if (++bumpsThisCall > MAX_NUMBER_BUMPS) return false;
      numberBump += 1;
      orderNumberSeed = numberFor(baseNumber, numberBump);
      return true;
    };

    // 'success' (حي ونفس الرقم) | 'retry' (محروق → رقم جديد + نفس الـ carrier) | 'halt' (غير مؤكد/سقف)
    const handleDuplicate = async (targetOrderNumber) => {
      const probe = await probeOrderStatus(targetOrderNumber, 'OrderDetail');
      const kind = classifyDuplicate(probe);

      if (kind === 'alive') {
        console.log(`ℹ️ [CJ] Order #${orderId} already exists (${probe.status}) — logical success.`);
        orderSuccess = true;
        cjCreated = true;
        successfulCJOrderNumber = probe.realCj || targetOrderNumber;
        if (probe.realCj && probe.realCj !== targetOrderNumber) {
          console.log(`🔗 [CJ] #${orderId} → رقم CJ الحقيقي: ${probe.realCj}`);
        }
        await saveCjNumber(successfulCJOrderNumber);
        return 'success';
      }

      if (kind === 'dead') {
        console.warn(`🧟 [CJ] #${orderId} 1603003 لكن ${targetOrderNumber} DEAD (${probe.status}) — رقم محتجز. ترقية → ${numberFor(baseNumber, numberBump + 1)}`);
        orderSuccess = false;
        if (!(await advanceNumber(`probe_dead_${probe.status}`))) {
          halted = { reason: 'number_walk_cap', number: targetOrderNumber, probeStatus: probe.status, bumps: bumpsThisCall };
          return 'halt';
        }
        return 'retry';
      }

      // ambiguous — لا نعلن نجاحاً ولا نرقّي: الرقم قد يكون حياً فعلاً (إنشاء نسخة ثانية = شحنة مزدوجة)
      // أو CJ يرفض بسبب المحتوى (نفس الزبون/العنوان) لا بسبب الرقم
      halted = {
        reason: 'duplicate_unverifiable',
        number: targetOrderNumber,
        probeStatus: probe.status,
        probeOrderNum: probe.orderNum || null,
        probeMatched: probe.matched,
      };
      return 'halt';
    };

    // ═══ 🩹 M#32 — CreateOrderV2 أولاً (payType=2 balance payment) ═══
    //    V2 + payType=2 → دفع مباشر من المحفظة → ربط شحن فوري → لا logisticsMiss
    //    V3 يبقى fallback للـ multi-warehouse (Auto-Split) أو لو V2 فشل
    if (!orderNumberOverride || orderNumberOverride === baseNumber) {
      try {
        await new Promise(r => setTimeout(r, 1200)); // Tenet #6
        const v2Response = await cjRequest((token, config) =>
          axios.post(`${CJ_API}/shopping/order/createOrderV2`,
            {
              orderNumber: orderNumberSeed,
              shippingZip: addr.postal_code || '10001',
              shippingCountry: addr.country || 'United States',
              shippingCountryCode: addr.country || 'US',
              shippingProvince: addr.state || addr.city || 'State',
              shippingCity: addr.city || 'City',
              shippingPhone: customerDetails?.phone || '1234567890',
              shippingCustomerName: safeCustomerName,
              shippingAddress: safeLine1,
              shippingAddress2: addr.line2 || '',
              email: safeEmail,
              payType: 2,                    // ⬅️ balance payment — ربط فوري
              logisticName: logisticsToTry[0] || 'CJPacket Ordinary',
              fromCountryCode: 'CN',
              platform: 'others',
              shopLogisticsType: 3,
              orderFlow: 1,
              isSandbox: isSandbox,
              products: cjProducts.map(p => ({ vid: p.vid, quantity: p.quantity })),
            },
            { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
          )
        );

        if (v2Response.data?.code === 200) {
          console.log(`🚀 [V2] Order #${orderId} created + paid from balance — no logisticsMiss path!`);
          orderSuccess = true;
          cjCreated = true;
          successfulCJOrderNumber = extractCjNumber(v2Response.data?.data) || orderNumberSeed;
          await saveCjNumber(successfulCJOrderNumber);
        } else {
          console.warn(`⚠️ [V2] #${orderId} code=${v2Response.data?.code} — falling back to V3`);
          lastError = v2Response.data;
        }
      } catch (v2Err) {
        console.warn(`⚠️ [V2] failed: ${v2Err.message} — falling back to V3`);
        lastError = v2Err.message;
      }
    }

    // ═══ V3 gauntlet (fallback) — يُنفذ فقط إذا V2 فشل ═══
    // 1. محاولة الإرسال المجمّع
    for (let li = 0; li < logisticsToTry.length; li++) {
      const logisticName = logisticsToTry[li];
      const targetOrderNumber = orderNumberSeed;
      const cjOrderPayload = {
        ...basePayload,
        orderNumber: targetOrderNumber,
        logisticName: logisticName,
        products: cjProducts
      };

      try {
        await new Promise(r => setTimeout(r, 1200)); // Tenet #6
        const cjResponse = await cjRequest((token) =>
          axios.post(`${CJ_API}/shopping/order/createOrderV3`,
            cjOrderPayload,
            { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
          )
        );

        if (cjResponse.data.code === 200) {
          console.log(`🚀 Order #${orderId} sent to CJ via V3 API (logistic: ${logisticName})!`);
          orderSuccess = true;
          cjCreated = true;

          sampleOnce('V3-Create', cjResponse.data?.data);

          successfulCJOrderNumber = extractCjNumber(cjResponse.data?.data) || targetOrderNumber;

            // 🩹 M#31 — interceptOrderReasons: السبب الرسمي من CJ لرفض الربط
            //    كان logisticsMiss=true لغزاً مظلماً — الآن CJ يشرح نفسه في الحقل المخصص
            const intercepts = cjResponse.data?.data?.interceptOrderReasons || [];
            if (intercepts.length > 0) {
              console.warn(`🛑 [CJ] #${orderId} interceptOrderReasons:`);
              intercepts.forEach(i => console.warn(`   → code=${i.code}: ${i.message}`));
              await auditEvent('CJ_INTERCEPT_REASON', orderId, { intercepts, carrier: logisticName }, 'critical');
            }
          if (cjResponse.data?.data?.logisticsMiss === true) {
            console.warn(`[CJ] #${orderId} logisticsMiss=true (${logisticName}) — repair attempt...`);
              logisticsMissCount++;   // 🩹 M#28 — عدّاد المرفوض
            const rep = await autoRepairLogistics(successfulCJOrderNumber);
            if (rep.repaired) {
              console.log(`[CJ] #${orderId} logistics bound: ${rep.logisticsName} ($${rep.postage})`);
              await saveCjNumber(successfulCJOrderNumber);
              await auditEvent('SELFHEAL_LOGISTICS_BOUND', orderId, { carrier: rep.logisticsName, postage: rep.postage }, 'info');
              break;
            }

            console.warn(`[CJ] #${orderId} auto-repair failed: ${rep.reason} — zombie risk. delete → next carrier...`);
            const del = await deleteCJOrder(successfulCJOrderNumber, targetOrderNumber);
            if (del.ok) {
              console.log(`🧹 [CJ] #${orderId} zombie (${successfulCJOrderNumber}) deleted — bumping number → next carrier`);
              cjCreated = false;
              orderSuccess = false;
              successfulCJOrderNumber = null;
              if (!(await advanceNumber('zombie_deleted'))) {
                halted = { reason: 'number_walk_cap', number: targetOrderNumber, bumps: bumpsThisCall };
                break;
              }
              continue;
            }

            console.error(`[CJ] #${orderId} zombie delete failed — accepting + admin alert`);
            await saveCjNumber(successfulCJOrderNumber);
            sendAdminAlert(
              `⚠️ CJ Zombie Order #${orderId} (${successfulCJOrderNumber}) — logisticsMiss unresolved`,
              `<p>الطلب منشئ عند CJ بلا شحن والحذف فشل (CJ بدا المعالجة).</p>
               <p>الـ carrier الفاشل: <code>${logisticName}</code> — راجعه يدوياً من CJ Dashboard.</p>`
            );
            break;
          }
          
          await saveCjNumber(successfulCJOrderNumber);
          break; // ✅ نجاح عادي
        }
        

        lastError = cjResponse.data;

        if (lastError.code === 1603000 || lastError.message?.includes('100230')) {
          console.log(`⚠️ Order #${orderId} needs Auto-Split (different warehouses)...`);
          needsSplitting = true;
          break;
        }

        // ✨ 1603003 — نجاح منطقي فقط إذا أثبت الـ probe أنه حي ولنفس الرقم (انظر handleDuplicate)
        if (lastError.code === 1603003) {
          const act = await handleDuplicate(targetOrderNumber);
          if (act === 'retry') { li--; continue; } // نفس الـ carrier برقم جديد — لا نحرق carrier على رقم ميت
          break; // success | halt
        }

        // 💰 1605001 — محفظة فارغة → orderFlow:0
        if (lastError.code === 1605001) {
          console.warn(`💰 [CJ] #${orderId} محفظة فارغة — محاولة orderFlow:0...`);
          try {
            await new Promise(r => setTimeout(r, 1200));
            const retry = await cjRequest((token) =>
              axios.post(`${CJ_API}/shopping/order/createOrderV3`,
                { ...cjOrderPayload, orderFlow: 0 },
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
              )
            );
            if (retry.data.code === 200) {
              orderSuccess = true;
              cjCreated = true;
              successfulCJOrderNumber = extractCjNumber(retry.data?.data) || targetOrderNumber;
              await saveCjNumber(successfulCJOrderNumber);
              console.log(`✅ [CJ] #${orderId} تسجل بـ orderFlow=0 — عمّر المحفظة باش يمشي للشحن`);
            }
          } catch (e) { console.warn(`⚠️ [CJ] #${orderId} orderFlow:0 retry failed: ${e.message} — falling through`); }
          break;
        }

        if (lastError.code === 1600200) break;
      } catch (err) {
        if (err.response?.data?.code === 1603003) {
          lastError = err.response.data;
          const act = await handleDuplicate(targetOrderNumber);
          if (act === 'retry') { li--; continue; }
          break; // success | halt
        }
        lastError = err.response?.data || err.message;
      }
    }
        // 🩹 M#28 — Shipping-Blocked flag: إذا ≥3 ناقلين رفضوا الربط
    //    المنتج مسموم شحنياً — احظره من الشراء المستقبلي (يُمنع في prepareSecureItems)
    if (logisticsMissCount >= 3) {
      const prodRes = await pool.query(`
        SELECT p.id FROM products p
        JOIN order_items oi ON oi.product_id = p.id
        WHERE oi.order_id = $1 LIMIT 1`, [orderId]);
      const prodId = prodRes.rows[0]?.id;
      if (prodId) {
        await pool.query('UPDATE products SET shipping_blocked = true WHERE id = $1', [prodId]);
        await auditEvent('SHIPPING_BLOCKED_FLAG', prodId, { orderId, reason: 'logisticsMiss_x3', bumps: bumpsThisCall }, 'warning');
        console.warn(`🚫 [Shipping-Block] product #${prodId} blocked (order #${orderId}) — M#28`);
      }
    }
    

    // 2. Auto-Split (V3)
    if (!orderSuccess && needsSplitting) {
      console.log(`📦 Executing Auto-Split V3 for Order #${orderId}...`);
      let successfulSplits = 0;
      const splitOrdersCreated = [];

      for (let i = 0; i < cjProducts.length; i++) {
        const product = cjProducts[i];
        const splitBase = `STORE-${orderId}-S${i + 1}`;
        let splitBump = (await loadBurnedBump(splitBase, orderId)) + 1;
        let splitWalks = 0;
        let itemDone = false;

        // 'success' | 'retry' | 'halt' — نفس منطق الطلب الكامل (كان يعتبر أي 1603003 نجاحاً حتى لو TRASH)
        // 🩹 FIX#إ3 — يرجع أيضاً realCj الحقيقي (كان يُخسى: نجاح منطقي كان يدفع رقمنا الوهمي للـ DB
        //    بينما CJ يعرف الطلب برقم SD مختلف — tracking batch كان يلتقطه بالـ dual-key صدفةً)
        const resolveSplitDup = async (num) => {
          const probe = await probeOrderStatus(num, 'SplitDetail');
          const kind = classifyDuplicate(probe);
          if (kind === 'alive') return { act: 'success', realCj: probe.realCj || num };
          if (kind === 'dead') {
            await markBurned(splitBase, splitBump, orderId, `probe_dead_${probe.status}`);
            if (++splitWalks > MAX_SPLIT_BUMPS) {
              halted = halted || { reason: 'split_number_walk_cap', number: num };
              return { act: 'halt' };
            }
            splitBump += 1;
            return { act: 'retry' };
          }
          halted = halted || { reason: 'split_duplicate_unverifiable', number: num, probeStatus: probe.status };
          return { act: 'halt' };
        };

        for (let li = 0; li < logisticsToTry.length && !itemDone; li++) {
          const logisticName = logisticsToTry[li];
          const splitOrderNum = numberFor(splitBase, splitBump);
          const splitPayload = {
            ...basePayload,
            orderNumber: splitOrderNum,
            logisticName: logisticName,
            products: [product]
          };

          let dup = false;
          try {
            await new Promise(r => setTimeout(r, 1200));
            const splitRes = await cjRequest((token) =>
              axios.post(`${CJ_API}/shopping/order/createOrderV3`,
                splitPayload,
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
              )
            );

            if (splitRes.data.code === 200) {
              console.log(`✅ Split [${i + 1}/${cjProducts.length}] sent via ${logisticName}!`);
              itemDone = true;
              successfulSplits++;
              splitOrdersCreated.push(splitOrderNum);
              cjCreated = true;
              const splitCj = extractCjNumber(splitRes.data?.data);
              if (splitCj && splitCj !== splitOrderNum) await saveCjNumber(splitCj);
              break;
            }
            if (splitRes.data.code === 1603003) dup = true;
          } catch (err) {
            if (err.response?.data?.code === 1603003) dup = true;
          }

          if (dup) {
            const res = await resolveSplitDup(splitOrderNum);
            if (res.act === 'success') {
              console.log(`ℹ️ [CJ Split] ${res.realCj} already exists (alive) — logical success.`);
              itemDone = true;
              successfulSplits++;
              splitOrdersCreated.push(res.realCj);   // 🩹 FIX#إ3 — الرقم الحقيقي لا الوهمي
              cjCreated = true;
              break;
            }
            if (res.act === 'retry') { li--; continue; }
            break; // halt — هذا العنصر لا يُحل بإعادة المحاولة
          }
        }
      }

      if (successfulSplits === cjProducts.length) {
        console.log(`🎉 All ${successfulSplits} split shipments succeeded for Order #${orderId}!`);
        orderSuccess = true;
        successfulCJOrderNumber = splitOrdersCreated.join(', ');
                // 🔒 persist split order number IMMEDIATELY — the gap between
        // "CJ accepted the split" and "number saved in DB" is where the
        // Stripe Reconcile loop lived (2026-10-02): it saw "paid, no cj_order_number"
        // and re-fired the full gauntlet every 15min (~40 attempts + email spam).
        // A dropped connection right here previously widened that gap to forever.
        // Same atomic guard as financialGate — never overwrite a live number.
        await pool.query(
          `UPDATE orders
           SET cj_order_number = $2
           WHERE id = $1 AND (cj_order_number IS NULL OR cj_order_number = '')`,
          [orderId, successfulCJOrderNumber]
        );
        console.log(`💾 [CJ Split] #${orderId} order number persisted: ${successfulCJOrderNumber}`);
      } else if (successfulSplits > 0) {
        console.error(`🚨 Partial fulfillment on Order #${orderId}: ${successfulSplits}/${cjProducts.length} shipped.`);
        await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1", [orderId]);
        sendAdminAlert(
          `🚨 CJ Partial Fulfillment — Order #${orderId} (${successfulSplits}/${cjProducts.length})`,
          `<p>Splits الناجحين: <code>${splitOrdersCreated.join(', ')}</code></p>
           <p>راجع CJ dashboard وأكمل العناصر الناقصة يدوياً — العميل مستنى!</p>`
        );
        return { success: false, partial: true, error: 'Partial fulfillment' };
      }
    }

    // 3. النتيجة النهائية
    if (orderSuccess) {
      await pool.query(
        "UPDATE orders SET status = 'paid' WHERE id = $1 AND status IN ('pending','processing')",
        [orderId]
      );
      console.log(`📤 [CJ] #${orderId} مقبول (${successfulCJOrderNumber}) — ننتظر ORDER/SHIPPED webhook للإشعار اللحظي`);
      return { success: true, orderNumber: successfulCJOrderNumber };
    }

    console.error(`❌ CJ Order Fulfillment Failed for #${orderId}. Reason:`, lastError);

    // 🛑 توقف لا تحله إعادة المحاولة (1603003 غير مؤكد / سقف الترقيم) — S1/S2 ينشئان طلبات عند CJ
    // فيعيدان نفس الفشل + إيميل جديد للزبون (الحلقة الأصلية). المسار الصادق: manual + alert بالتفاصيل.
    if (halted) {
      if (!flags._nested) await haltOrderManual(orderId, halted, lastError); // الاستدعاءات الداخلية لا تنبّه — الأب يفعل مرة واحدة
      return { success: false, halted: true, reason: 'CJ_DUPLICATE_BLOCKED', detail: halted, error: lastError };
    }

    // 🤖 Mission #16 — Zero-Touch recovery بدل manual
    // 🆕 Mission #17 — skipZeroTouch: من الحلقات الذاتية (inner S1 attempts)
    if (!flags.skipZeroTouch) {
      try {
        const vids = cjProducts.map(p => ({ vid: p.vid, quantity: p.quantity }));
        const zt = await zeroTouchRecovery(orderId, {
          country: addr.country || 'US',
          vids,
          totalAmount: parseFloat(await getOrderTotalAmount(orderId)),
          customerEmail: safeEmail,
          customerPhone: basePayload.shippingPhone,
          customerName: safeCustomerName,
        });
        // ✅ S1 نجح فعلاً → الطلب عند CJ: لا نرجّع فشلاً كاذباً (كان يُفعّل manual/alerts خاطئة عند المستدعين)
        if (zt && zt.recovered) {
          return { success: true, orderNumber: await getSavedCjNumber(orderId), via: `zerotouch_${zt.strategy}` };
        }
        if (zt && zt.halted) {
          return { success: false, halted: true, reason: 'CJ_DUPLICATE_BLOCKED', detail: zt.detail, error: lastError };
        }
      } catch (ztErr) {
        console.warn(`🤖 [ZeroTouch] #${orderId} recovery exception: ${ztErr.message}`);
        await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1", [orderId]);
      }
    } else {
      console.warn(`🤖 [ZeroTouch] #${orderId} skipped (inner S1 attempt)`);
    }
    return { success: false, error: lastError };

  } catch (err) {
    logger.logError(`CJ Fulfillment Fatal Error #${orderId}`, err);
    if (!cjCreated) {
      // 🤖 Mission #16 + #17 — Zero-Touch في الفشل الفادح (مع loop-guard عبر flags)
      if (!flags.skipZeroTouch) {
        try {
          const vids = (items || []).map(it => ({ vid: it.vid || '', quantity: it.quantity || 1 })).filter(v => v.vid);
          const zt = await zeroTouchRecovery(orderId, {
            country: 'US',
            vids,
            totalAmount: parseFloat(await getOrderTotalAmount(orderId)),
            customerEmail: customerDetails?.email || '',
            customerPhone: customerDetails?.phone || '',
            customerName: customerName || '',
          });
          if (zt && zt.recovered) {
            return { success: true, orderNumber: await getSavedCjNumber(orderId), via: `zerotouch_${zt.strategy}` };
          }
          // 🩹 FIX#17 — halted في الفادح ينتشر (كان يسقط لرد عام → alert مكرر عند المستدعي)
          if (zt && zt.halted) {
            return { success: false, halted: true, reason: 'CJ_DUPLICATE_BLOCKED', detail: zt.detail, error: err.message };
          }
        } catch (ztErr) {
          console.warn(`🤖 [ZeroTouch] fatal-path failed: ${ztErr.message}`);
          await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1", [orderId]).catch(e => console.warn(`⚠️ [CJ] #${orderId} manual update failed: ${e.message}`));
        }
      } else {
        await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1", [orderId]).catch(e => console.warn(`⚠️ [CJ] #${orderId} manual update failed: ${e.message}`));
      }
    }
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// ⚖️ checkStripeDispute
// ═══════════════════════════════════════════════════════════════
async function checkStripeDispute(orderId, { strict = false } = {}) {
  try {
    const r = await pool.query(
      `SELECT payment_method, stripe_session_id, status FROM orders WHERE id = $1`,
      [orderId]
    );
    const o = r.rows[0];
    if (!o) return { disputed: false, reason: 'order_not_found' };
    if (!/stripe/i.test(String(o.payment_method || ''))) return { disputed: false, reason: 'not_stripe' };
    if (!o.stripe_session_id) return { disputed: false, reason: 'no_session' };

    const session = await stripe.checkout.sessions.retrieve(o.stripe_session_id);
    if (!session || session.payment_status !== 'paid') {
      return { disputed: false, reason: `not_paid_${session?.payment_status || 'missing'}` };
    }
    const pi = typeof session.payment_intent === 'string'
      ? await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] })
      : session.payment_intent;
    const charge = pi?.latest_charge;

    if (charge && typeof charge === 'object') {
      if (charge.disputed) {
        const dv = typeof charge.dispute === 'object' && charge.dispute ? charge.dispute : null;
        console.error(`⚖️ [DisputeWatch] #${orderId} DISPUTED! charge=${charge.id} status=${dv?.status || '?'}`);
        return { disputed: true, reason: `dispute_${dv?.status || 'open'}`, chargeId: charge.id };
      }
      return { disputed: false, chargeId: charge.id };
    }

    return strict
      ? { disputed: true, reason: 'charge_unverifiable_strict' }
      : { disputed: false, reason: 'no_charge_object' };

  } catch (e) {
    logger.logError(`checkStripeDispute #${orderId}`, e);
    return strict
      ? { disputed: true, reason: 'check_failed_strict' }
      : { disputed: false, reason: 'check_failed' };
  }
}

// ═══════════════════════════════════════════════════════════════
// ═══ 📧 مُرسل زبون (Brevo — نفس نمط cjWebhookService) ═══
async function sendCustomerExchangeEmail(to, subject, html) {
  if (!to) return;
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'Laclarc Support', email: process.env.BREVO_USER },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    timeout: 8000,
  });
}

// ═══ 💸 executeS3 — المصدر الوحيد لمنطق الاسترداد بعد 72h ═══
// يستدعيه المسار الرئيسي (hoursStuck>=72) ومسار الـ sweep (vids فارغة + 72h+)
async function executeS3(orderId, { totalAmount, customerEmail }) {
  const ord2 = await pool.query('SELECT stripe_session_id, payment_method FROM orders WHERE id = $1', [orderId]);
  const pm = ord2.rows[0]?.payment_method || '';

  if (ord2.rows[0]?.stripe_session_id && /stripe/i.test(pm)) {
    // ⚖️ dispute gate (strict): أي شك أو فشل فحص = manual — الـ chargeback هو الاسترداد
    const d = await checkStripeDispute(orderId, { strict: true });
    if (d.disputed) {
      const manz = await pool.query(
        "UPDATE orders SET status = 'manual' WHERE id = $1 AND status = 'awaiting_exchange' RETURNING id",
        [orderId]
      );
      if (manz.rowCount) {
        await auditEvent('DISPUTE_FOUND', orderId, { stage: 'S3', reason: d.reason }, 'warning');
        sendAdminAlert(`⚖️ S3 — Order #${orderId}: chargeback مفتوح — manual`,
          `<p>الاسترداد سيرد عبر الـ chargeback نفسه — لا refund يدوي. (${d.reason})</p>`);
        return { recovered: false, strategy: 'S3_dispute_manualized' };
      }
      console.log(`🤖 [ZeroTouch] #${orderId} S3 lost race (disputed) — fulfillment gates تتابع`);
      return { recovered: false, strategy: 'S3_lost_race' };
    }

    // 🔒 قفل ذري ضد سباق الاختيار — S3 يفوز أو يتنازل للزبون، لا الاثنان
    const lock = await pool.query(
      "UPDATE orders SET status = 'manual' WHERE id = $1 AND status = 'awaiting_exchange' RETURNING id",
      [orderId]
    );
    if (!lock.rowCount) {
      console.log(`🤖 [ZeroTouch] #${orderId} S3 lost race — customer just picked`);
      return { recovered: false, strategy: 'S3_customer_picked' };
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(ord2.rows[0].stripe_session_id);
      const pi = typeof session.payment_intent === 'string'
        ? await stripe.paymentIntents.retrieve(session.payment_intent)
        : session.payment_intent;
      if (!pi?.latest_charge) throw new Error('no latest_charge — لا شهادة دفع قابلة للاسترداد');
      // 🛡️ idempotencyKey — حتى لو نفّذ الجسم مرتين (سباق نظري)، Stripe يدمجهما
      await stripe.refunds.create({ charge: pi.latest_charge }, { idempotencyKey: `refund-order-${orderId}` });
      await pool.query("UPDATE orders SET status = 'refunded' WHERE id = $1", [orderId]);
      await auditEvent('ZEROTOUCH_S3_REFUNDED', orderId, { amount: totalAmount }, 'warning');
      sendAdminAlert(`💰 ZeroTouch S3 — Order #${orderId} auto-refunded ($${totalAmount})`,
        `<p>72 ساعة بلا قرار زبون. استرداد آلي نُفّذ.</p>`);
      sendCustomerExchangeEmail(
        customerEmail,
        `طلبك #${orderId} — تم استرداد مبلغك 💰`,
        `<div style="direction:rtl;text-align:right;font-family:Arial,sans-serif"><p>نعتذر — انتهت مهلة اختيار البديل ونُفّذ الاسترداد الكامل ($${totalAmount}). المبلغ يظهر حسب جهة الدفع خلال أيام.</p></div>`
      ).catch(e => console.error(`📧 S3 email FAILED #${orderId}: ${e.message}`));
      console.log(`💰 [ZeroTouch] #${orderId} refund done — Zero-Touch complete`);
      return { recovered: true, strategy: 'S3_refund' };
    } catch (refundErr) {
      await auditEvent('ZEROTOUCH_S3_FAILED', orderId, { error: refundErr.message }, 'error');
      sendAdminAlert(`🚨 S3 refund FAILED — Order #${orderId}`, `<p>${refundErr.message}</p>`);
      return { recovered: false, strategy: 'S3_refund_failed_manual' };
    }
  }

  // NowPayments/Paysera/BaridiMob — لا refund API مربوط → fail-closed يدوي موثق
  const manz = await pool.query(
    "UPDATE orders SET status = 'manual' WHERE id = $1 AND status = 'awaiting_exchange' RETURNING id",
    [orderId]
  );
  if (manz.rowCount) {
    await auditEvent('ZEROTOUCH_S3_GATEWAY_UNSUPPORTED', orderId, { gateway: pm || 'unknown' }, 'warning');
    sendAdminAlert(`💰 S3 — Order #${orderId}: استرداد يدوي إلزامي (${pm || 'gateway?'})`,
      `<p>انتهت 72 ساعة بلا اختيار. البوابة ${pm} بلا مسار استرداد آلي — dossier يدوي.</p>`);
    sendCustomerExchangeEmail(
      customerEmail,
      `طلبك #${orderId} — استردادك قيد التنفيذ`,
      `<div style="direction:rtl;text-align:right;font-family:Arial,sans-serif"><p>انتهت مهلة اختيار البديل. استردادك ($${totalAmount}) قيد المعالجة — سنتواصل معك لتأكيد تفاصيل التحويل.</p></div>`
    ).catch(e => console.warn(`📧 [CJ] S3 gateway email FAILED #${orderId}: ${e.message}`));
  }
  return { recovered: false, strategy: 'S3_manual_gateway' };
}
// 🤖 zeroTouchRecovery — Mission #16 (S1→S2→S3) — محصّن ضد الحلقات
// ═══════════════════════════════════════════════════════════════
const zeroTouchGuard = new Set(); // 🆕 Mission #17 — loop guard

async function zeroTouchRecovery(orderId, { country, vids, totalAmount, customerEmail, customerPhone, customerName }) {
  // 🆕 SWEEP GUARD — vids فارغة + 72h+ → S3 مباشرة (مسار L0 sweep)
  // الطلبات الطازجة بلا vids تسلك المسار الأصلي — سلوك اليوم unchanged
  if (!Array.isArray(vids) || vids.length === 0) {
    try {
      const { rows: ageChk } = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(manual_since, created_at))) / 3600 AS hours FROM orders WHERE id = $1`,
        [orderId]
      );
      if ((ageChk[0]?.hours || 0) >= 72) {
        console.log(`🤖 [ZeroTouch] #${orderId} sweep path — no vids + 72h+ → direct S3`);
        return await executeS3(orderId, { totalAmount, customerEmail, via: 'sweep' });
      }
    } catch (gErr) {
      console.warn(`🤖 [ZeroTouch] #${orderId} sweep-guard failed: ${gErr.message}`);
    }
  }

  // 🛡️ حلقة استدعاء ذاتية: recovery → fulfillCJOrder → recovery = ∞ — ممنوعة
  if (zeroTouchGuard.has(orderId)) {
    console.warn(`🤖 [ZeroTouch] #${orderId} already in recovery cycle — skipped (loop guard)`);
    return { recovered: false, strategy: 'loop_guard' };
  }
  zeroTouchGuard.add(orderId);

  try {
    console.log(`🤖 [ZeroTouch] #${orderId} starting recovery protocol...`);

    // ─── S1: كل خيارات الشحن (حتى المكلفة) ───
    let s1Options = [];
    try {
      const fr = await cjRequest((token) =>
        axios.post(`${CJ_API}/logistic/freightCalculate`, {
          startCountryCode: 'CN',
          endCountryCode: country,
          products: vids.map(v => ({ vid: v.vid, quantity: v.quantity || 1 })),
        }, { headers: { 'CJ-Access-Token': token } })
      );
      if (fr.data?.code === 200) s1Options = fr.data.data || [];
    } catch (e) { console.warn(`🤖 [ZeroTouch] S1 freight failed: ${e.message}`); }

    let haltedInner = null;
    if (s1Options.length > 0) {
      console.log(`🤖 [ZeroTouch] #${orderId} S1: ${s1Options.length} freight options — retrying with each...`);
      for (const opt of s1Options) {
        // نحتاج العناصر الكاملة من DB — attemptRefulfill-style لكن بفرض carrier
        try {
          const itemsRes = await pool.query(`
            SELECT oi.*, p.title, p.image_url
            FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = $1`, [orderId]);
          const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
          const ord = orderRes.rows[0];
          if (!ord) continue;

          const customerDetails = {
            email: customerEmail || ord.customer_email || undefined,
            phone: customerPhone || ord.customer_phone || undefined,
            address: (() => {
              try { return JSON.parse(ord.shipping_address || '{}'); }
              catch { return { line1: ord.shipping_address || 'N/A', country }; }
            })(),
          };

          const res = await fulfillCJOrder(
            orderId, customerName || ord.customer_name,
            customerDetails,
            itemsRes.rows,
            null,
            opt.logisticName,
            { skipZeroTouch: true, _nested: true }   // 🆕 #17 — لا استدعاء ذاتي | _nested = تحت قفل الأب
          );
          if (res.success) {
            await auditEvent('ZEROTOUCH_S1_SUCCESS', orderId, { carrier: opt.logisticName, cost: opt.logisticPrice }, 'info');
            console.log(`✅ [ZeroTouch] #${orderId} S1 SUCCESS via ${opt.logisticName} ($${opt.logisticPrice})`);
            return { recovered: true, strategy: 'S1_force_carrier' };
          }
          // 🩹 halt داخلي → كسر الحلقة — الـ halt اليدوي الوحيد يقع هنا (لا مكرر)
          if (res.halted) { haltedInner = res.detail || { reason: 'duplicate_unverifiable' }; break; }
        } catch (e) {
          console.warn(`🤖 [ZeroTouch] #${orderId} S1 attempt (${opt.logisticName}) failed: ${e.message}`);
        }
      }
    }

    // 🛑 S1 اصطدم بـ 1603003 غير قابل للحل → S2 سيعيد نفس الفشل + إيميل للزبون: manual + alert بدلاً منه
    if (haltedInner) {
      await haltOrderManual(orderId, haltedInner, null);
      return { recovered: false, strategy: 'halted', halted: true, detail: haltedInner };
    }

    // ─── S2: بديل آلي — نفس الفئة، سعر ±30% ───
    console.log(`🤖 [ZeroTouch] #${orderId} S2: finding auto-substitute...`);
    try {
      const { rows: subs } = await pool.query(`
        SELECT p.id, p.title, p.price, p.image_url
        FROM products p
        WHERE p.stock_status = true
          AND p.id != (SELECT product_id FROM order_items WHERE order_id = $1 LIMIT 1)
          AND p.price BETWEEN
            (SELECT price * 0.7 FROM order_items WHERE order_id = $1 LIMIT 1) AND
            (SELECT price * 1.3 FROM order_items WHERE order_id = $1 LIMIT 1)
  AND COALESCE(p.shipping_blocked, false) = false
          AND p.category = (SELECT category FROM products WHERE id = (SELECT product_id FROM order_items WHERE order_id = $1 LIMIT 1))
        ORDER BY p.created_at DESC
        LIMIT 3
      `, [orderId]);

      if (subs.length > 0) {
        // 🛡️ rowCount guard — زيارة sweep على طلب معروض أصلًا: لا إعادة عرض، لا سبام
        const upd = await pool.query(
          `UPDATE orders SET status = 'awaiting_exchange', exchange_options = $2, manual_since = NOW()
           WHERE id = $1 AND status IN ('manual', 'paid')
           RETURNING exchange_token`,
          [orderId, JSON.stringify(subs)]
        );
        if (upd.rowCount > 0) {
          await auditEvent('ZEROTOUCH_S2_OFFERED', orderId, { substitutes: subs.length, options: subs.map(s => s.id) }, 'warning');

          // 🔑 capability token — بلا هذا الرابط مفتوح (IDOR write-capable)
          const exchangeUrl = `https://laclarc.com/exchange/${orderId}?t=${upd.rows[0].exchange_token}`;

          // 📧 الزبون — كان الرابط يذهب للأدمن فقط — fire-and-forget (Tenet #4)
          sendCustomerExchangeEmail(
            customerEmail,
            `طلبك #${orderId} — اختر بديلك المجاني`,
            `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;direction:rtl;text-align:right">
              <h2 style="color:#1D1E3C">مرحباً ${customerName || ''} 👋</h2>
              <p>نعتذر — المنتج في طلبك <b>#${orderId}</b> غير متوفر حالياً للشحن إلى بلدك.</p>
              <p>اخترنا لك <b>${subs.length} بديلاً مجانياً</b> من نفس الفئة بنفس القيمة:</p>
              ${subs.map(s => `<p style="margin:4px 0">• ${s.title} — $${Number(s.price).toFixed(2)}</p>`).join('')}
              <p style="margin:24px 0;text-align:center">
                <a href="${exchangeUrl}" style="background:#8B78C6;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:bold">اختر بديلك الآن →</a>
              </p>
              <p style="color:#666;font-size:13px">⏳ لديك 72 ساعة للاختيار — بعدها يُنفَّذ الاسترداد الكامل تلقائياً دون أي إجراء منك.</p>
              <p style="color:#999;font-size:12px">إذا لم تكن أنت صاحب هذا الطلب، تجاهل هذه الرسالة.</p>
            </div>`
          ).catch(e => console.error(`📧 [ZeroTouch] customer email FAILED #${orderId}: ${e.message}`));

          const optsHtml = subs.map((s, i) => `
            <div style="margin:10px 0;padding:12px;border:1px solid #ddd;border-radius:8px;">
              <b>${i + 1}. ${s.title}</b><br/>
              Price: $${Number(s.price).toFixed(2)}<br/>
              <a href="${exchangeUrl}" style="color:#8B78C6;font-weight:bold;">Choose your replacement →</a>
            </div>`).join('');
          sendAdminAlert(`🤖 ZeroTouch S2 — Order #${orderId} substitutes offered`,
            `<p>الزبون: ${customerName} — $${totalAmount}</p>${optsHtml}`);
          console.log(`📧 [ZeroTouch] #${orderId} S2: ${subs.length} substitutes offered + customer emailed`);
          return { recovered: false, strategy: 'S2_customer_choice', substitutes: subs.length };
        }
        // rowCount = 0 → معروضة أصلًا (زيارة sweep) → يسقط لفحص S3 أدناه
      }
    } catch (e) {
      console.warn(`🤖 [ZeroTouch] #${orderId} S2 failed: ${e.message}`);
    }

    // ─── S3: بعد 72 ساعة بلا قرار — refund آلي ───
    const { rows: ageRows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(manual_since, created_at))) / 3600 as hours FROM orders WHERE id = $1`,
      [orderId]
    );
    const hoursStuck = ageRows[0]?.hours || 0;

    if (hoursStuck >= 72) {
      console.log(`🤖 [ZeroTouch] #${orderId} S3: 72h+ no decision — auto-refund path...`);
      return await executeS3(orderId, { totalAmount, customerEmail, via: 'main' });
    }

    await auditEvent('ZEROTOUCH_PENDING', orderId, { strategy_tried: 'S1+S2', hours_stuck: hoursStuck }, 'info');
    return { recovered: false, strategy: 'pending' };
  } finally {
    zeroTouchGuard.delete(orderId); // 🛡️ دائماً — نظافة الحارس
  }
}

// ═══════════════════════════════════════════════════════════════
// 🩺 selfHealStuckOrders — محصّن (لا مسح بلا شهادة موت — Tenet #18)
// ═══════════════════════════════════════════════════════════════
const healAttempts = new Map();
const HEAL_MAX_ATTEMPTS = 3;

async function selfHealStuckOrders() {
  console.log('🩺 [SelfHeal] Stuck-orders audit started...');
  let scanned = 0, healed1 = 0, healed2 = 0, manualized = 0, walletAlerted = false;

  try {
    // ─── L0 🆕 — Exchange sweep: S3 كانت unreachable — لا شيء يعيد زيارة awaiting_exchange ───
    // vids:[] مقصود — sweep-guard داخل zeroTouchRecovery يوجّه مباشرة إلى executeS3
    try {
      const { rows: expired } = await pool.query(`
        SELECT id, total_amount, customer_email, customer_phone, customer_name, shipping_address
        FROM orders
        WHERE status = 'awaiting_exchange'
          AND manual_since < NOW() - INTERVAL '72 hours'
        ORDER BY manual_since ASC
        LIMIT 20
      `);
      for (const o of expired) {
        if (zeroTouchGuard.has(o.id)) continue;
        try {
          let country = 'DZ';
          try { country = JSON.parse(o.shipping_address)?.country || 'DZ'; } catch { country = 'DZ'; }
          await zeroTouchRecovery(o.id, {
            country,
            vids: [],
            totalAmount: parseFloat(o.total_amount),
            customerEmail: o.customer_email,
            customerPhone: o.customer_phone,
            customerName: o.customer_name,
          });
        } catch (e) {
          console.error(`🩺 [SelfHeal] L0 sweep #${o.id} failed: ${e.message}`);
        }
      }
      if (expired.length) console.log(`🩺 [SelfHeal] L0: ${expired.length} expired exchange(s) → recovery`);
    } catch (e) {
      console.error(`🩺 [SelfHeal] L0 error: ${e.message}`);
    }

    const { rows: candidates } = await pool.query(`
      SELECT id, cj_order_number, total_amount, customer_name, customer_email, created_at
      FROM orders
      WHERE status = 'paid'
        AND cj_order_number IS NOT NULL AND cj_order_number != ''
        AND created_at < NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
      LIMIT 20
    `);
    if (candidates.length === 0) { console.log('🩺 [SelfHeal] clean — no candidates.'); return; }

    let detailsMap = new Map();
    const codes = candidates.map(c => c.cj_order_number);
    try {
      const batch = await cjRequest((token) =>
        axios.post(`${CJ_API}/shopping/order/getOrderDetailBatch`, { orderIds: codes },
          { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
      );
      if (batch.data?.code === 200) {
        for (const d of (batch.data.data?.list || batch.data.data || [])) {
          const key = d.cjOrderCode || d.orderId || d.orderNumber;
          if (key) detailsMap.set(String(key), d);
        }
      }
    } catch (batchErr) {
      console.warn(`🩺 [SelfHeal] batch failed (${batchErr.message}) — falling back to individual probes`);
    }

    for (const cand of candidates) {
      scanned++;
      const oid = cand.id;
      const code = cand.cj_order_number;

      const att = healAttempts.get(oid) || { count: 0, lastAt: Date.now() };
      if (att.count >= HEAL_MAX_ATTEMPTS) {
        await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1 AND status = 'paid'", [oid]);
        manualized++;
        await auditEvent('SELFHEAL_MANUALIZED', oid, { code, attempts: att.count }, 'critical');
        console.error(`🩺 [SelfHeal] #${oid} exhausted ${HEAL_MAX_ATTEMPTS} attempts → manual + admin alert`);
        sendAdminAlert(
          `🚨 SelfHeal exhausted — Order #${oid} (${code})`,
          `<p>استنفد ${HEAL_MAX_ATTEMPTS} محاولات إنقاذ آلية. تدخل بشري مطلوب.</p>
           <p>العميل: ${cand.customer_name} — ${cand.total_amount} USD — SD: ${code}</p>`
        );
        continue;
      }

      let info = detailsMap.get(String(code));
      if (!info) {
        try {
          const probe = await probeOrderStatus(code, 'SelfHeal');
          info = { orderStatus: probe.status, cjOrderCode: probe.realCj || code, paymentDate: null };
        } catch (e) {
          console.warn(`🩺 [SelfHeal] #${oid} probe failed: ${e.message} — skipped this cycle`);
          continue;
        }
      }

      const cjStatus = String(info.orderStatus || '').toUpperCase();
      const paymentDate = info.paymentDate ?? null;

      // 🛡️ Tenet #18 — probe UNKNOWN ≠ زومبي: skip بلا مسح
      if (!cjStatus || cjStatus === 'UNKNOWN') {
        console.warn(`🩺 [SelfHeal] #${oid} probe UNKNOWN — skip cycle (no destruction)`);
        continue;
      }

      // ✅ حي ومتحرك — سكت
      if (cjStatus !== 'CREATED' && !DEAD_CJ_STATUSES.includes(cjStatus)) {
        healAttempts.delete(oid);
        continue;
      }

      // 🔴 DEAD مؤكد — تصحيح + إعادة fulfillment نظيفة
      if (DEAD_CJ_STATUSES.includes(cjStatus)) {
        console.warn(`🩺 [SelfHeal] #${oid} DEAD at CJ (${cjStatus}) — clearing code, re-fulfilling fresh...`);
        await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [oid]);
        const r1 = await attemptRefulfill(oid, cand, 'dead-order');
        if (r1 !== false) { att.count++; att.lastAt = Date.now(); healAttempts.set(oid, att); } // 🩹 FIX#16
        continue;
      }

      // 🧟 زومبي CREATED مؤكد — L1
      console.log(`🩺 [SelfHeal] #${oid} zombie CREATED (${code}) — L1: delete → re-fulfill (attempt ${att.count + 1}/${HEAL_MAX_ATTEMPTS})`);
      const del = await deleteCJOrder(code, `STORE-${oid}`);
      if (del.ok) {
        console.log(`🧹 [SelfHeal] #${oid} zombie deleted — re-fulfilling...`);
        await auditEvent('SELFHEAL_DELETE', oid, { code }, 'info');
        await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [oid]);
        const r = await attemptRefulfill(oid, cand, 'zombie-recreate');
        if (r === true) { healed1++; att.count++; att.lastAt = Date.now(); healAttempts.set(oid, att); continue; }
        // 🩹 FIX#16 — r === null يعني IN_FLIGHT (webhook/JIT ماسك الطلب) — لا يُحرق كمحاولة
      }

      // L2 — payBalance
      console.log(`🩺 [SelfHeal] #${oid} L2: payBalance route (${code})...`);
      let pd = null;
      try {
        const tk = await getCJToken();
        const det = await axios.get(`${CJ_API}/shopping/order/getOrderDetail`, {
          params: { orderId: code }, headers: { 'CJ-Access-Token': tk }, timeout: 20000 });
        const ii = det.data?.data?.orderInfo || det.data?.data || {};
        pd = ii.paymentDate || null;
        const detailStatus = String(ii.orderStatus || '').toUpperCase();
        if (DEAD_CJ_STATUSES.includes(detailStatus)) {
          console.warn(`🩺 [SelfHeal] #${oid} is ${detailStatus} at detail-level — clearing + re-fulfill`);
          await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [oid]);
          const r2 = await attemptRefulfill(oid, cand, 'dead-detail-recreate');
          if (r2 === true) { att.count++; att.lastAt = Date.now(); healAttempts.set(oid, att); }
          continue;
        }
      } catch (e) { console.warn(`🩺 [SelfHeal] #${oid} detail-probe failed: ${e.message}`); }

      if (pd) {
        console.log(`✅ [SelfHeal] #${oid} already paid at CJ (paymentDate=${pd}) — لا دفع مزدوج`);
        healAttempts.delete(oid);
        continue;
      }

      const pay = await payCJOrderBalance(code, `STORE-${oid}`);
      if (pay.ok) {
        healed2++;
        await auditEvent('SELFHEAL_PAYBALANCE', oid, { code, amount: cand.total_amount }, 'warning');
        console.log(`💳 [SelfHeal] #${oid} payBalance OK — SHIPPED webhook قادم`);
        att.count++; att.lastAt = Date.now(); healAttempts.set(oid, att);
        continue;
      }

      if (!walletAlerted) {
        sendAdminAlert(
          '💳 CJ Wallet — Top-up required (SelfHeal)',
          `<p>النظام يحاول إنقاذ طلبات عالقة بالدفع الذاتي لكن المحفظة لا تكفي.</p>
           <p>الطلبات المنتظرة: ${candidates.length}</p>
           <p>الإجراء البشري الوحيد: عمّر المحفظة — النظام يكمل الباقي أوتوماتيكياً.</p>`
        );
        walletAlerted = true;
        await auditEvent('WALLET_EMPTY', null, { pending: candidates.length }, 'warning');
      }
      console.warn(`🩺 [SelfHeal] #${oid} payBalance failed: ${pay.reason} — retried next cycle`);
      att.count++; att.lastAt = Date.now(); healAttempts.set(oid, att);
    }

    console.log(`🩺 [SelfHeal] done — scanned=${scanned} L1=${healed1} L2=${healed2} manual=${manualized}`);
  } catch (err) {
    logger.logError('SelfHeal Cron', err);
  }
}

// 🔄 إعادة fulfillment — عبر financialGate (belt-and-suspenders)
// 🩹 FIX#16 — return ثلاثي: true نجح · false فشل حقيقي (يحرق محاولة) · null IN_FLIGHT (لا يحرق)
async function attemptRefulfill(oid, cand, tag) {
  try {
    const itemsRes = await pool.query(`
      SELECT oi.*, p.title, p.image_url
      FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1`, [oid]);
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [oid]);
    const ord = orderRes.rows[0];
    if (!ord) return false;

    const gate = await financialGate(oid);
    if (!gate.allow) {
      console.error(`🩺 [SelfHeal] #${oid} re-fulfill DENIED by financialGate: ${gate.reason}`);
      return false;
    }

    const customerDetails = {
      email: ord.customer_email || undefined,
      phone: ord.customer_phone || undefined,
      address: (() => {
        try { return JSON.parse(ord.shipping_address || '{}'); }
        catch { return { line1: ord.shipping_address || 'N/A', country: 'DZ' }; }
      })(),
    };

    const resp = await fulfillCJOrder(
      oid, ord.customer_name, customerDetails, itemsRes.rows,
      null, null,
      { skipZeroTouch: true }  // 🆕 #17 — recovery داخلي بالفعل، لا استدعاء ذاتي
    );
    console.log(`🩺 [SelfHeal] #${oid} re-fulfill (${tag}) => ${resp.success ? '✅ ' + (resp.orderNumber || '') : '❌ ' + (resp.reason || resp.error || 'unknown')}`);

    // 🩹 FIX#16 — fulfillment آخر (webhook/JIT/exchange) ماسك الطلب = هو المسؤول — لا تحرق محاولة SelfHeal عليه
    if (!resp.success && resp.reason === 'IN_FLIGHT') return null;

    return !!resp.success;
  } catch (e) {
    console.warn(`🩺 [SelfHeal] #${oid} re-fulfill exception: ${e.message}`);
    return false;
  }
}

// 🧹 GC واحد فقط — المكرر انمسح
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [k, v] of healAttempts) {
    if (v.lastAt < cutoff) healAttempts.delete(k);
  }
}, 60 * 60 * 1000).unref();

// ═══════════════════════════════════════════════════════════════
// ⚖️ disputeWatchdogCron
// ═══════════════════════════════════════════════════════════════
async function disputeWatchdogCron() {
  console.log('⚖️ [DisputeWatch] scan started...');
  let scanned = 0, disputesFound = 0;

  try {
    const { rows } = await pool.query(`
      SELECT id, status, stripe_session_id, total_amount, customer_name, customer_email, cj_order_number
      FROM orders
      WHERE status IN ('paid', 'pending', 'manual')
        AND payment_method = 'Stripe'
        AND stripe_session_id IS NOT NULL AND stripe_session_id != ''
        AND created_at > NOW() - INTERVAL '60 days'
      ORDER BY created_at DESC
      LIMIT 100
    `);
    if (rows.length === 0) { console.log('⚖️ [DisputeWatch] nothing to scan.'); return; }

    for (const o of rows) {
      scanned++;
      const res = await checkStripeDispute(o.id, { strict: false });
      if (!res.disputed) continue;

      disputesFound++;
      const shipped = ['fulfilled', 'completed'].includes(String(o.status));

      if (!shipped) {
        console.error(`⚖️ [DisputeWatch] #${o.id} DISPUTED & UNSHIPPED → manual + CJ intercept attempt`);
        await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1 AND status = 'paid'", [o.id]);

        if (o.cj_order_number) {
          // 🩹 hygiene — split-numbers ("SD1, SD2") لا يفهمها delete — نأخذ الأول (تحسين Backlog#15 الكامل)
          const firstCode = String(o.cj_order_number).split(',')[0].trim();
          const icpt = await deleteCJOrder(firstCode, `STORE-${o.id}`);
          console.log(`⚖️ [DisputeWatch] #${o.id} CJ intercept => ${icpt.ok ? '✅ deleted' : 'ℹ️ not deletable — Dashboard manual'}`);
          await auditEvent('DISPUTE_INTERCEPT', o.id, { code: o.cj_order_number, deleted: icpt.ok }, 'warning');
        }
        await auditEvent('DISPUTE_FOUND', o.id, { charge: res.chargeId, shipped: false, amount: o.total_amount }, 'critical');
        sendAdminAlert(
          `⚖️ STRIPE DISPUTE — Order #${o.id} (${o.total_amount} USD) — fulfillment STOPPED`,
          `<h3 style="color:#FF6B9D;">Chargeback مفتوح قبل الشحن!</h3>
           <p><b>Order:</b> #${o.id} — <b>Client:</b> ${o.customer_name} (${o.customer_email})</p>
           <p><b>Amount:</b> $${o.total_amount} — <b>Charge:</b> ${res.chargeId || 'n/a'}</p>
           <p><b>Action taken:</b> الحالة → manual. الـ fulfillment متوقف.</p>
           <p><b>Next:</b> استجب للـ dispute في Stripe Dashboard (evidence: order, shipping, comms).</p>`
        );
      } else {
        console.error(`⚖️ [DisputeWatch] #${o.id} DISPUTED & ALREADY SHIPPED → evidence-prep alert`);
        await auditEvent('DISPUTE_FOUND', o.id, { charge: res.chargeId, shipped: true, amount: o.total_amount }, 'warning');
        sendAdminAlert(
          `⚖️ STRIPE DISPUTE (SHIPPED) — Order #${o.id} — evidence needed`,
          `<p>اعتراض على طلب <b>مشحون فعلاً</b> — الخسارة المالية واردة، بصق الـ evidence قوي:</p>
           <p>Order #${o.id} — ${o.customer_name} — $${o.total_amount} — Charge: ${res.chargeId || 'n/a'}</p>
           <p><b>جهّز فوراً:</b> رقم التتبع + إثبات التسليم + مراسلات الزبون + العنوان الموثق.</p>`
        );
      }
    }

    console.log(`⚖️ [DisputeWatch] done — scanned=${scanned} disputes=${disputesFound}`);
  } catch (err) {
    logger.logError('DisputeWatch Cron', err);
  }
}

// ==========================================
// 🤖 autoRepairLogistics
// ==========================================
async function autoRepairLogistics(cjOrderCode) {
  try {
    if (!cjOrderCode) return { repaired: false, reason: 'no_order_code' };
    const opt = await cjRequest((token) =>
      axios.get(CJ_API + '/shopping/order/getOrderLogisticsInfo', {
        params: { orderCode: cjOrderCode },
        headers: { 'CJ-Access-Token': token },
      })
    );
    if (opt.data?.code !== 200) return { repaired: false, reason: 'query_' + opt.data?.code };
    const list = Array.isArray(opt.data.data) ? opt.data.data : [];
    if (!list.length) return { repaired: false, reason: 'no_options' };

    const eligible = list.filter(function (o) { return o.hasStock !== false; });
    if (!eligible.length) return { repaired: false, reason: 'no_stock_options' };
    const cheapest = eligible.slice().sort(function (a, b) { return a.postage - b.postage; })[0];

    const tryFrom = (from) => cjRequest((token) =>
      axios.post(CJ_API + '/shopping/order/updateLogistics',
        { id: cheapest.id, orderCode: cjOrderCode, logisticsName: cheapest.logisticsName, from: from },
        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
    );
    let mod = await tryFrom(1);
    if (mod.data?.code !== 200) mod = await tryFrom(0);
    if (mod.data?.code !== 200) return { repaired: false, reason: 'modify_' + mod.data?.code };
    return { repaired: true, logisticsName: cheapest.logisticsName, postage: cheapest.postage };
  } catch (e) {
    logger.logError('autoRepairLogistics', e);
    return { repaired: false, reason: e.message };
  }
}

// ==========================================
// 🗑️ deleteCJOrder
// ==========================================
async function deleteCJOrder(...candidates) {
  for (const v of candidates.filter(Boolean)) {
    try {
      const res = await cjRequest((token) =>
        axios.delete(CJ_API + '/shopping/order/deleteOrder', {
          params: { orderId: String(v) },
          headers: { 'CJ-Access-Token': token },
        })
      );
      if (res.data?.code === 200) return { ok: true };
    } catch (e) { /* next candidate */ }
  }
  return { ok: false, reason: 'delete_failed_all_candidates' };
}

// ==========================================
// 💳 payCJOrderBalance
// ==========================================
async function payCJOrderBalance(...candidates) {
  let lastReason = 'no_candidates';
  for (const v of candidates.filter(Boolean)) {
    try {
      const res = await cjRequest((token) =>
        axios.post(CJ_API + '/shopping/pay/payBalance',
          { orderId: String(v) },
          { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
        )
      );
      if (res.data?.code === 200) return { ok: true };
      lastReason = (res.data?.message || 'code_' + res.data?.code);
    } catch (e) {
      lastReason = (e.response && e.response.data && e.response.data.message) || e.message;
    }
  }
  return { ok: false, reason: lastReason };
}

// ==========================================
// 📤 التصديرات — 🩹 إجباري: probeOrderStatus + classifyDuplicate + auditEvent
//    cjWebhookService v2.1 (P0-20 anti-spoof) يعتمدهما — بلاهما أول webhook يرمي undefined
// ==========================================
module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert, deleteCJOrder, payCJOrderBalance, financialGate, selfHealStuckOrders, checkStripeDispute, disputeWatchdogCron, auditEvent, zeroTouchRecovery, probeOrderStatus, classifyDuplicate };