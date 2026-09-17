// services/cjService.js - Laclarc Enterprise Dropshipping Engine (v2.1 FINAL)
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
let tokenRefreshPromise = null; // ✨ حماية ضد تسابق التوكن (Mutex Lock)

// ==========================================
// 1. نظام إدارة وتجديد التوكن المحصن (Thread-Safe)
// ==========================================
async function getCJToken(forceRefresh = false) {
  if (!forceRefresh && cachedCjToken && cachedCjTokenExpiry && Date.now() < cachedCjTokenExpiry) {
    return cachedCjToken;
  }

  if (tokenRefreshPromise) {
    return await tokenRefreshPromise;
  }

  tokenRefreshPromise = (async () => {
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
      tokenRefreshPromise = null;
    }
  })();

  return await tokenRefreshPromise;
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
// 🔧 Helpers على مستوى الملف — مصدر واحد للحقيقة (مستعملين من fulfillCJOrder + probeOrderStatus)
// ==========================================
const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

// 🆕 Fix#4 — الحالات الميتة: الرقم محتجز لقمامة → ترقية إجبارية
const DEAD_CJ_STATUSES = ['TRASH', 'CANCELLED', 'CLOSED', 'INTERCEPTED'];

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

// 🆕 Fix#4 — فحص حيوية الطلب الموجود عند CJ (مستعمل في معالجي 1603003)
async function probeOrderStatus(targetOrderNumber, tag) {
  try {
    await new Promise(r => setTimeout(r, 1200));
    const detail = await cjRequest((token) =>
      axios.get(`${CJ_API}/shopping/order/getOrderDetail`, {
        params: { orderId: targetOrderNumber },
        headers: { 'CJ-Access-Token': token },
      })
    );
    const dd = detail.data?.data || {};
    sampleOnce(tag, dd);
    const realCj = extractCjNumber(dd) || extractCjNumber(dd.orderInfo);
    return { status: String(dd.orderStatus || '').toUpperCase(), realCj };
  } catch (e) {
    console.warn(`⚠️ [CJ] probe (${tag}) فشل لـ ${targetOrderNumber}:`, e.response?.data?.message || e.message);
    return { status: 'UNKNOWN', realCj: null };
  }
}
// 📋 auditEvent — كل قرار آلي يترك أثراً دائماً (الشفافية للنظام الذاتي)
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
// 🏦 financialGate — العقود المالي المطلق (Tenet مؤسس)
// "قبل ما يبعث لـ CJ — الدراهم مؤكدة في الحساب. مهما كان المسار، مهما كان متى."
// نقطة تفتيش مالية واحدة: كل نداء fulfillCJOrder (webhook/JIT/cron/self-heal)
// يعيد التحقق المباشر من مصدر الدفع نفسه — لا ثقة في DB ولا في الحالة الوسطى.
// fail-closed: أي فشل/شذوذ = رفض + لوج. (Tenet #14: كل فشل يكلّم)
// ═══════════════════════════════════════════════════════════════

async function financialGate(orderId) {
  try {
    const r = await pool.query(
      'SELECT payment_method, payment_ref, total_amount, stripe_session_id, payment_status FROM orders WHERE id = $1',
      [orderId]
    );
    const o = r.rows[0];
    if (!o) return { allow: false, reason: 'order_not_found' };

    const expectedUsd = Number(o.total_amount);
    const method = String(o.payment_method || '').toLowerCase();

    // ─── Crypto / NowPayments: استجواب مباشر — الأصل المثبت ───
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
      const ok = (st === 'finished' || st === 'confirmed') && paidUsd + 0.01 >= expectedUsd;
      console.log(`[FinGate] #${orderId} CRYPTO status=${st} paid_usd=${paidUsd} total=${expectedUsd} => ${ok ? 'ALLOW' : 'DENY'}`);
      if (!ok) await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'crypto', status: st, paidUsd, expectedUsd }, 'warning');
      return ok ? { allow: true } : { allow: false, reason: `crypto_${st}_${paidUsd}` };
    }

    // ─── Stripe: استجواب الجلسة مباشرة + فحص الـ dispute (وحش أقصى) ───
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
      // مطابقة المبلغ بالسنت — حماية ضد أي تعديل DB خارجي
      if (Math.abs(paidUsd - expectedUsd) > 0.011) {
        await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'stripe', reason: 'amount_mismatch', stripeAmt: paidUsd, dbAmt: expectedUsd }, 'critical');
        console.error(`[FinGate] #${orderId} STRIPE amount mismatch: stripe=${paidUsd} db=${expectedUsd} => DENY`);
        return { allow: false, reason: `stripe_amount_mismatch_${paidUsd}` };
      }
      // فحص dispute على الـ charge الأحدث (وحش أقصى — chargeback قبل الشحن)
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
        // فحص الـ dispute تحسيني — فشله لا يمنع (paid من Stripe يكفي)، بصق يُسجل (Tenet #14)
        console.warn(`[FinGate] #${orderId} dispute-check skipped: ${dispErr.message}`);
      }
      console.log(`[FinGate] #${orderId} STRIPE paid=${paidUsd} => ALLOW`);
      return { allow: true };
    }

    // ─── Paysera: التأكيد الموثق = callback الموقّع (md5 signature) المسجل في DB ───
    if (/paysera/i.test(method)) {
      const ok = o.payment_status === 'paid' || String(o.status) === 'paid';
      console.log(`[FinGate] #${orderId} PAYSERA db_status=${o.status}/${o.payment_status} => ${ok ? 'ALLOW (callback-signed)' : 'DENY'}`);
      if (!ok) await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'paysera', dbStatus: o.status, payStatus: o.payment_status }, 'warning');
      return ok ? { allow: true } : { allow: false, reason: 'paysera_not_paid' };
    }

    // ─── BaridiMob: approval بشري موثق (dossier مُدقق) هو التوقيع المالي ───
    if (/baridi|manual/i.test(method)) {
      const approved = /paid|approved/i.test(String(o.payment_status || '')) || String(o.status) === 'paid';
      console.log(`[FinGate] #${orderId} BARIDIMOB payment_status=${o.payment_status} => ${approved ? 'ALLOW (admin-approved)' : 'DENY'}`);
      if (!approved) await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: 'baridimob', payStatus: o.payment_status }, 'warning');
      return approved ? { allow: true } : { allow: false, reason: 'baridimob_not_approved' };
    }

    // ─── طريقة غير معروفة: رفض صارم (fail-closed — لا مسارات مجهولة للمال) ───
    await auditEvent('FINANCIAL_GATE_DENY', orderId, { method: o.payment_method, reason: 'unknown_method' }, 'critical');
    console.error(`[FinGate] #${orderId} UNKNOWN payment_method="${o.payment_method}" => DENY`);
    return { allow: false, reason: `unknown_method_${o.payment_method}` };

  } catch (e) {
    logger.logError(`financialGate #${orderId}`, e);
    await auditEvent('FINANCIAL_GATE_ERROR', orderId, { error: e.message }, 'critical');
    return { allow: false, reason: 'gate_error' }; // فشل التحقق = رفض. دوماً.
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


async function fulfillCJOrder(orderId, customerName, customerDetails, items, orderNumberOverride = null, forcedLogisticName = null) {
  let cjCreated = false;
  // 🏦 financialGate — العقود المالي المطلق: كل المسارات، كل الأزمنة (Tenet مؤسس)
  const _gate = await financialGate(orderId);
  if (!_gate.allow) {
    console.error('[FinGate] رفض إرسال #' + orderId + ' لـ CJ: ' + _gate.reason);
    return { success: false, reason: 'PAYMENT_NOT_CONFIRMED', detail: _gate.reason };
  }
  try {
    const addr = customerDetails?.address || {};
    const isSandbox = (process.env.CJ_SANDBOX_MODE === 'true' && process.env.NODE_ENV !== 'production') ? 1 : 0;
    if (isSandbox) console.warn('🧪 [SANDBOX] طلب #' + orderId + ' كيتخلق sandbox — ما غاديش يشحن!');

    let safeCustomerName = (customerName || '').trim();
    if (!safeCustomerName || safeCustomerName.toLowerCase() === 'guest customer' || !safeCustomerName.includes(' ')) {
      safeCustomerName = safeCustomerName ? `${safeCustomerName} Customer` : 'Valued Customer';
    }

    const safeEmail = (customerDetails?.email || '').trim() || 'orders@laclarc.com';

    // ═══ CAPI Purchase — Fire-and-Forget (Tenet #3) ═══
    (async () => {
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
          // 🆕 Mission #12: الإسناد يسافر مع الحدث
          utmSource:    order.utm_source,
          utmCampaign:  order.utm_campaign,
          clickId:      order.click_id,
        })
          .then((s) => console.log(`[CAPI] purch_${orderId} dispatched ✓`, JSON.stringify(s)))
          .catch((e) => console.warn(`[CAPI] purch_${orderId} non-fatal: ${e.message}`));
      } catch (e) {
        console.warn(`[CAPI] purch_${orderId} context-guard: ${e.message}`);
      }
    })();

    // استخراج الـ vid المؤكد + storeLineItemId
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
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
      return { success: false, reason: 'NO_CJ_VARIANTS' };
    }

    // استعلام أفضل شركات الشحن
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
    // 🆕 Patch 4 (درس #69): لا فرض جغرافي — freightCalculate المرتب بالسعر هو الأصدق لكل SKU
    else logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Ordinary', 'CJPacket Sensitive', 'YunExpress', '4PX'])];

    let orderSuccess = false;
    let lastError = null;
    let needsSplitting = false;
    let successfulCJOrderNumber = null;

    // 🆕 Fix#4: رقم قابل للترقية — القمامة تحتجز STORE-{id} (درس #69)
    let orderNumberSeed = orderNumberOverride || `STORE-${orderId}`;
    let numberBump = 1;

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

    // 1. محاولة الإرسال المجمّع
    for (const logisticName of logisticsToTry) {
      const targetOrderNumber = orderNumberSeed; // 🆕 Fix#4: من الـ seed القابل للترقية
      const cjOrderPayload = {
        ...basePayload,
        orderNumber: targetOrderNumber,
        logisticName: logisticName,
        products: cjProducts
      };

      try {
        await new Promise(r => setTimeout(r, 1200)); // invariant #6 — QPS=1
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

          if (cjResponse.data?.data?.logisticsMiss === true) {
            // 🤖 logisticsMiss=true = "نجاح زائف" — بروتوكول:
            // repair → فشل؟ delete + ترقية → carrier الموالي → فشل الحذف؟ قبول + إنذار
            console.warn(`[CJ] #${orderId} logisticsMiss=true (${logisticName}) — repair attempt...`);
            const rep = await autoRepairLogistics(successfulCJOrderNumber);
            if (rep.repaired) {
              console.log(`[CJ] #${orderId} logistics bound: ${rep.logisticsName} ($${rep.postage})`);
              await saveCjNumber(successfulCJOrderNumber);
              break; // ✅ نجاح حقيقي
            }

            console.warn(`[CJ] #${orderId} auto-repair failed: ${rep.reason} — zombie risk. delete → next carrier...`);
            const del = await deleteCJOrder(successfulCJOrderNumber, targetOrderNumber);
            if (del.ok) {
              // 🆕 Fix#4: رقم جديد — STORE-{id} محتجز للقمامة (درس #69)
              console.log(`🧹 [CJ] #${orderId} zombie (${successfulCJOrderNumber}) deleted — bumping number → next carrier`);
              cjCreated = false;
              orderSuccess = false;
              successfulCJOrderNumber = null;
              orderNumberSeed = `STORE-${orderId}-R${++numberBump}`;
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
          break; // ✅ نجاح عادي — logisticsMiss=false
        }

        lastError = cjResponse.data;

        if (lastError.code === 1603000 || lastError.message?.includes('100230')) {
          console.log(`⚠️ Order #${orderId} needs Auto-Split (different warehouses)...`);
          needsSplitting = true;
          break;
        }

        // ✨ 1603003 = موجود أصلاً — 🆕 Fix#4: نجاح منطقي فقط إلا كان حياً
        if (lastError.code === 1603003) {
          const probe = await probeOrderStatus(targetOrderNumber, 'OrderDetail');

          if (DEAD_CJ_STATUSES.includes(probe.status)) {
            console.warn(`🧟 [CJ] #${orderId} 1603003 لكن الموجود DEAD (${probe.status}) — رقم محتجز. ترقية → STORE-${orderId}-R${numberBump + 1}`);
            orderNumberSeed = `STORE-${orderId}-R${++numberBump}`;
            orderSuccess = false;
            continue;
          }

          console.log(`ℹ️ [CJ] Order #${orderId} already exists (${probe.status}) — logical success.`);
          orderSuccess = true;
          cjCreated = true;
          successfulCJOrderNumber = probe.realCj || targetOrderNumber;
          if (probe.realCj && probe.realCj !== targetOrderNumber) {
            console.log(`🔗 [CJ] #${orderId} → رقم CJ الحقيقي: ${probe.realCj}`);
          }
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }

        // 💰 1605001 = محفظة فارغة → orderFlow:0
        if (lastError.code === 1605001) {
          console.warn(`💰 [CJ] #${orderId} محفظة فارغة — محاولة orderFlow:0 (انتظار الداع فالـ dashboard)...`);
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
          } catch (e) { /* كنطيحو للفشل العادي تحت */ }
          break;
        }

        if (lastError.code === 1600200) break; // QPS — backoff موجود أصلاً فـ cjRequest
      } catch (err) {
        // ✨ 1603003 كـ HTTP exception — 🆕 Fix#4: نفس فحص الموت
        if (err.response?.data?.code === 1603003) {
          const probe = await probeOrderStatus(targetOrderNumber, 'OrderDetail');

          if (DEAD_CJ_STATUSES.includes(probe.status)) {
            console.warn(`🧟 [CJ] #${orderId} 1603003(exception) الموجود DEAD (${probe.status}) — ترقية الرقم + carrier موالي`);
            orderNumberSeed = `STORE-${orderId}-R${++numberBump}`;
            orderSuccess = false;
            continue;
          }

          console.log(`ℹ️ [CJ] Order #${orderId} already exists (exception, ${probe.status}) — success.`);
          orderSuccess = true;
          cjCreated = true;
          successfulCJOrderNumber = probe.realCj || targetOrderNumber;
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }
        lastError = err.response?.data || err.message;
      }
    }

    // 2. Auto-Split (V3)
    if (!orderSuccess && needsSplitting) {
      console.log(`📦 Executing Auto-Split V3 for Order #${orderId}...`);
      let successfulSplits = 0;
      const splitOrdersCreated = [];

      for (let i = 0; i < cjProducts.length; i++) {
        const product = cjProducts[i];
        let itemSuccess = false;

        for (const logisticName of logisticsToTry) {
          const splitOrderNum = `STORE-${orderId}-S${i + 1}`;
          const splitPayload = {
            ...basePayload,
            orderNumber: splitOrderNum,
            logisticName: logisticName,
            products: [product]
          };

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
              itemSuccess = true;
              successfulSplits++;
              splitOrdersCreated.push(splitOrderNum);
              cjCreated = true;
              const splitCj = extractCjNumber(splitRes.data?.data);
              if (splitCj && splitCj !== splitOrderNum) await saveCjNumber(splitCj);
              break;
            }
            if (splitRes.data.code === 1603003) {
              console.log(`ℹ️ [CJ Split] ${splitOrderNum} already exists (body).`);
              itemSuccess = true;
              successfulSplits++;
              splitOrdersCreated.push(splitOrderNum);
              cjCreated = true;
              break;
            }
          } catch (err) {
            if (err.response?.data?.code === 1603003) {
              console.log(`ℹ️ [CJ Split] ${splitOrderNum} already exists (exception).`);
              itemSuccess = true;
              successfulSplits++;
              splitOrdersCreated.push(splitOrderNum);
              cjCreated = true;
              break;
            }
          }
        }
      }

      if (successfulSplits === cjProducts.length) {
        console.log(`🎉 All ${successfulSplits} split shipments succeeded for Order #${orderId}!`);
        orderSuccess = true;
        successfulCJOrderNumber = splitOrdersCreated.join(', ');
      } else if (successfulSplits > 0) {
        console.error(`🚨 Partial fulfillment on Order #${orderId}: ${successfulSplits}/${cjProducts.length} shipped.`);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
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
    await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
    return { success: false, error: lastError };

  } catch (err) {
    logger.logError(`CJ Fulfillment Fatal Error #${orderId}`, err);
    if (!cjCreated) {
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]).catch((e) => console.warn('⚠️ [CJ] manual-mark failed for #' + orderId + ': ' + e.message));
    }
    return { success: false, error: err.message };
  }
}
// ═══════════════════════════════════════════════════════════════
// ⚖️ checkStripeDispute — فحص مستقل للاعتراضات (chargebacks)
// قابل للاستدعاء من: Watchdog cron + SHIPPED guard + أي مسار مستقبلي
// Return: { disputed, reason?, chargeId? } — fail-open للـ network فقط
// عند فحص الـ watchdog (الطلب ما يتعطلش لأن Stripe تعبت)، fail-closed
// عند الحارس الأخير (SHIPPED — الشحن قرار لا رجعة فيه)
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

    // الجلسة → PaymentIntent → latest_charge (مع expand)
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
        const dv = typeof charge.dispute === 'object' && charge.dispute
          ? charge.dispute
          : null;
        console.error(`⚖️ [DisputeWatch] #${orderId} DISPUTED! charge=${charge.id} status=${dv?.status || '?'}`);
        return { disputed: true, reason: `dispute_${dv?.status || 'open'}`, chargeId: charge.id };
      }
      return { disputed: false, chargeId: charge.id };
    }

    // لا charge قابل للفحص — حسب الصرامة
    return strict
      ? { disputed: true, reason: 'charge_unverifiable_strict' }  // الحارس الأخير: لا مجازفة
      : { disputed: false, reason: 'no_charge_object' };          // الـ watchdog: تسامح

  } catch (e) {
    logger.logError(`checkStripeDispute #${orderId}`, e);
    return strict
      ? { disputed: true, reason: 'check_failed_strict' }  // فشل الفحص وقت الشحن = لا شحن
      : { disputed: false, reason: 'check_failed' };       // فشل في المراقبة = دورة قادمة
  }
}
// ═══════════════════════════════════════════════════════════════
// 🩺 selfHealStuckOrders — محرك الإنقاذ الذاتي (Zero-Touch)
// يكتشف الطلبات المدفوعة عندنا العالقة عند CJ (CREATED غير مدفوع/زومبي)
// ويعالجها آلياً عبر 3 طبقات — القرار البشري فقط للمستحيل:
//   L1: حذف الزومبي → إعادة fulfillment (المحرك المجرب كامل)
//   L2: payBalance (الدراهم مستحقة أصلاً — بلا سقف: COGS مستحق)
//   L3: manual + إيميل (فقط لما تنفد كل الحلول الآلية)
// حالات خاصة: نفاد محفظة CJ → إيميل تشغيلي (تزويد مورد — الحل الوحيد بشري)
// ═══════════════════════════════════════════════════════════════
const healAttempts = new Map();   // orderId → { count, lastAt }
const HEAL_MAX_ATTEMPTS = 3;

async function selfHealStuckOrders() {
  console.log('🩺 [SelfHeal] Stuck-orders audit started...');
  let scanned = 0, healed1 = 0, healed2 = 0, manualized = 0, walletAlerted = false;

  try {
    // 1. الاصطياد: مدفوع عندنا + مُسنَد لـ CJ + عمره > 24h (القديم أولاً)
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

    // 2. فحص الحالة عند CJ — batch (1 نداء/50) مع fallback فردي
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

    // 3. المعالجة حسب الحالة
    for (const cand of candidates) {
      scanned++;
      const oid = cand.id;
      const code = cand.cj_order_number;

      // عدّاد المحاولات — الحارس ضد الحلقات اللانهائية
      const att = healAttempts.get(oid) || { count: 0, lastAt: 0 };
      if (att.count >= HEAL_MAX_ATTEMPTS) {
        // L3: المستحيل — استنفد كل شيء
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1 AND status = 'paid'", [oid]);
        manualized++;
        console.error(`🩺 [SelfHeal] #${oid} exhausted ${HEAL_MAX_ATTEMPTS} attempts → manual + admin alert`);
        sendAdminAlert(
          `🚨 SelfHeal exhausted — Order #${oid} (${code})`,
          `<p>استنفد ${HEAL_MAX_ATTEMPTS} محاولات إنقاذ آلية. تدخل بشري مطلوب.</p>
           <p>العميل: ${cand.customer_name} — ${cand.total_amount} USD — SD: ${code}</p>`
        );
        continue;
      }

      // جلب التفاصيل (batch أو فردي)
      let info = detailsMap.get(String(code));
      if (!info) {
        try {
          const probe = await probeOrderStatus(code, 'SelfHeal');
          info = { orderStatus: probe.status, cjOrderCode: probe.realCj || code, paymentDate: null };
          // probeOrderStatus لا يجيب paymentDate — نستكمله بنداء مفصل فقط عند الحاجة (Layer 2)
        } catch (e) {
          console.warn(`🩺 [SelfHeal] #${oid} probe failed: ${e.message} — skipped this cycle`);
          continue;
        }
      }

      const cjStatus = String(info.orderStatus || '').toUpperCase();
      const isAlive = !DEAD_CJ_STATUSES.includes(cjStatus) && cjStatus !== 'CREATED_UNPAID';
      const paymentDate = info.paymentDate ?? null;

      // ✅ حي ومتحرك (فوق CREATED) — سكت. لا ضجيج.
      if (cjStatus && cjStatus !== 'CREATED' && !DEAD_CJ_STATUSES.includes(cjStatus)) {
        healAttempts.delete(oid); // نشاط حي = عداد reset
        continue;
      }

      // 🔴 ميت (TRASH/CANCELLED...) — مصيره مختلف عن الزومبي: تصحيح حالة + إعادة fulfillment نظيفة
      if (DEAD_CJ_STATUSES.includes(cjStatus)) {
        console.warn(`🩺 [SelfHeal] #${oid} DEAD at CJ (${cjStatus}) — clearing code, re-fulfilling fresh...`);
        await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [oid]);
        await attemptRefulfill(oid, cand, 'dead-order');
        att.count++; healAttempts.set(oid, att);
        continue;
      }

      // 🧟 زومبي (CREATED فقط) — الفرع الرئيسي
      // L1: حذف الزومبي → إعادة fulfillment بالمحرك المجرب
      console.log(`🩺 [SelfHeal] #${oid} zombie CREATED (${code}) — L1: delete → re-fulfill (attempt ${att.count + 1}/${HEAL_MAX_ATTEMPTS})`);
      const del = await deleteCJOrder(code, `STORE-${oid}`);
      if (del.ok) {
        console.log(`🧹 [SelfHeal] #${oid} zombie deleted — re-fulfilling...`);
        await auditEvent('SELFHEAL_MANUALIZED', oid, { code, attempts: att.count }, 'critical');
        await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [oid]);
        const ok = await attemptRefulfill(oid, cand, 'zombie-recreate');
        if (ok) { healed1++; att.count++; healAttempts.set(oid, att); continue; }
      }

      // L2: الحذف فشل (CJ بدا يحرك) أو الـ re-fulfill فشل → payBalance (الدراهم مستحقة — بلا سقف)
      console.log(`🩺 [SelfHeal] #${oid} L2: payBalance route (${code})...`);
      // فحص paymentDate مباشر قبل الدفع (حماية مزدوجة الدفع)
      let pd = null;
      try {
        const tk = await getCJToken();
        const det = await axios.get(`${CJ_API}/shopping/order/getOrderDetail`, {
          params: { orderId: code }, headers: { 'CJ-Access-Token': tk }, timeout: 20000 });
        const ii = det.data?.data?.orderInfo || det.data?.data || {};
        pd = ii.paymentDate || null;
        if (String(ii.orderStatus || '').toUpperCase() === 'TRASH') {
          console.warn(`🩺 [SelfHeal] #${oid} is TRASH at detail-level — clearing + re-fulfill`);
          await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [oid]);
          await attemptRefulfill(oid, cand, 'trash-recreate');
          att.count++; healAttempts.set(oid, att);
          continue;
        }
      } catch (e) { console.warn(`🩺 [SelfHeal] #${oid} detail-probe failed: ${e.message}`); }

      if (pd) {
        console.log(`✅ [SelfHeal] #${oid} already paid at CJ (paymentDate=${pd}) — CJ سيكمل عادي، لا دفع مزدوج`);
        healAttempts.delete(oid);
        continue;
      }

      const pay = await payCJOrderBalance(code, `STORE-${oid}`);
      if (pay.ok) {
        healed2++;
        await auditEvent('SELFHEAL_PAYBALANCE', oid, { code, amount: cand.total_amount }, 'warning');
        console.log(`💳 [SelfHeal] #${oid} payBalance OK — CJ سيكمل → SHIPPED webhook قادم`);
        att.count++; healAttempts.set(oid, att);
        continue;
      }

      // 💸 فشل الدفع — نفاد المحفظة هو الاحتمال الأكبر → إشعار تشغيلي وحيد
      if (!walletAlerted) {
        sendAdminAlert(
          '💳 CJ Wallet — Top-up required (SelfHeal)',
          `<p>النظام يحاول إنقاذ طلبات عالقة بالدفع الذاتي لكن المحفظة لا تكفي.</p>
           <p>الطلبات المنتظرة: ${candidates.filter(c => c.status === 'paid').length}</p>
           <p>الأفعال الوحيدة البشرية المطلوبة: عمّر المحفظة — النظام يكمل الباقي أوتوماتيكياً.</p>`
        );
        walletAlerted = true; // مرة واحدة لكل دورة — لا إيميلات متتالية
        await auditEvent('WALLET_EMPTY', null, { pending: candidates.filter(c => c.status === 'paid').length }, 'warning');
      }
      console.warn(`🩺 [SelfHeal] #${oid} payBalance failed: ${pay.reason} — retried next cycle`);
      att.count++; healAttempts.set(oid, att);
    }

    console.log(`🩺 [SelfHeal] done — scanned=${scanned} L1=${healed1} L2=${healed2} manual=${manualized}`);
  } catch (err) {
    logger.logError('SelfHeal Cron', err); // Tenet #14
  }
}

// 🔄 إعادة fulfillment عبر المحرك المجرب كامل — لا محرك جديد
async function attemptRefulfill(oid, cand, tag) {
  try {
    const itemsRes = await pool.query(`
      SELECT oi.*, p.title, p.image_url
      FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1`, [oid]);
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [oid]);
    const ord = orderRes.rows[0];
    if (!ord) return false;

    // 🏦 العقد المالي: حتى الإنقاذ يمر عبر البوابة — الدراهم مؤكدة قبل أي إرسال
    // (مزدوج متعمد مع فحص fulfillCJOrder الداخلي — belt-and-suspenders على العقود المالي:
    //  الـ self-heal يرفض مبكراً بلوج أوضح، و fulfillCJOrder يحفظ استقلاليته لكل متصل آخر)
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

    const resp = await fulfillCJOrder(oid, ord.customer_name, customerDetails, itemsRes.rows);
    console.log(`🩺 [SelfHeal] #${oid} re-fulfill (${tag}) => ${resp.success ? '✅ ' + (resp.orderNumber || '') : '❌ ' + (resp.reason || resp.error || 'unknown')}`);
    return !!resp.success;
  } catch (e) {
    console.warn(`🩺 [SelfHeal] #${oid} re-fulfill exception: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// ⚖️ disputeWatchdogCron — مراقبة مستمرة للاعتراضات (كل 6 ساعات)
// النافذة: كل طلبات Stripe غير المشحونة بعمر ≤ 60 يوم (نافذة الـ dispute)
// الهدف: كشف الـ chargeback قبل الشحن (إيقاف) أو بعده مباشرة (وعي)
// ═══════════════════════════════════════════════════════════════
async function disputeWatchdogCron() {
  console.log('⚖️ [DisputeWatch] scan started...');
  let scanned = 0, disputesFound = 0;

  try {
    const { rows } = await pool.query(`
      SELECT id, stripe_session_id, total_amount, customer_name, customer_email, cj_order_number
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
        // 🛑 غير مشحون + اعتراض → إيقاف فوري: manual + محاولة اعتراض CJ
        console.error(`⚖️ [DisputeWatch] #${o.id} DISPUTED & UNSHIPPED → manual + CJ intercept attempt`);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1 AND status = 'paid'", [o.id]);

        // ⚖️ اعتراض فعلي: إن كانت الشحنة عند CJ مازالت CREATED — نمسحها (لا نرسل بضاعة لاحتيال)
        if (o.cj_order_number) {
          const icpt = await deleteCJOrder(o.cj_order_number);
          console.log(`⚖️ [DisputeWatch] #${o.id} CJ intercept => ${icpt.ok ? '✅ deleted' : 'ℹ️ not deletable (moved past CREATED) — Dashboard manual'}`);
          await auditEvent('DISPUTE_INTERCEPT', o.id, { code: o.cj_order_number, deleted: icpt.ok }, 'warning');
        }
        await auditEvent('DISPUTE_FOUND', o.id, { charge: res.chargeId, shipped: false, amount: o.total_amount }, 'critical');
        sendAdminAlert(
          `⚖️ STRIPE DISPUTE — Order #${o.id} (${o.total_amount} USD) — fulfillment STOPPED`,
          `<h3 style="color:#FF6B9D;">Chargeback مفتوح قبل الشحن!</h3>
           <p><b>Order:</b> #${o.id} — <b>Client:</b> ${o.customer_name} (${o.customer_email})</p>
           <p><b>Amount:</b> $${o.total_amount} — <b>Charge:</b> ${res.chargeId || 'n/a'}</p>
           <p><b>Action taken:</b> الحالة → manual. الـ fulfillment متوقف.</p>
           <p><b>Next:</b> استجب للـ dispute في Stripe Dashboard (evidence: order, shipping, comms) — 
           أو اقبل الخسارة إذا كان احتيالاً مؤكداً. CJ order إن وُجد: intercept يدوياً من Dashboard.</p>`
        );
      } else {
        // 📦 مشحون + اعتراض → وعي (لا رجعة في الشحن — لكن نجهز evidence)
        console.error(`⚖️ [DisputeWatch] #${o.id} DISPUTED & ALREADY SHIPPED → evidence-prep alert`);
        await auditEvent('DISPUTE_FOUND', o.id, { charge: res.chargeId, shipped: true, amount: o.total_amount }, 'warning');
        sendAdminAlert(
          `⚖️ STRIPE DISPUTE (SHIPPED) — Order #${o.id} — evidence needed`,
          `<p>اعتراض على طلب <b>مشحون فعلاً</b> — الخسارة المالية واردة، بصق الـ evidence قوي:</p>
           <p>Order #${o.id} — ${o.customer_name} — $${o.total_amount} — Charge: ${res.chargeId || 'n/a'}</p>
           <p><b>جهّز فوراً:</b> رقم التتبع + إثبات التسليم (carrier proof) + مراسلات الزبون + 
           توثيق العنوان الموثق من Stripe. ارفعهم في Stripe Dashboard خلال المهلة.</p>`
        );
      }
    }

    console.log(`⚖️ [DisputeWatch] done — scanned=${scanned} disputes=${disputesFound}`);
  } catch (err) {
    logger.logError('DisputeWatch Cron', err); // Tenet #14
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
// 🗑️ deleteCJOrder - 1.8: DELETE (CREATED/IN_CART only, per docs)
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
// 💳 payCJOrderBalance - 2.2
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
// 🧹 GC: تنظيف عدّادات المحاولات القديمة (memory-leak defense — نفس نمط ctxMap)
setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // أقدم من 7 أيام
  for (const [k, v] of healAttempts) {
    if (v.lastAt < cutoff) healAttempts.delete(k);
  }
}, 60 * 60 * 1000).unref(); // ⚠️ unref() — ما يمنعش process.exit
module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert, deleteCJOrder, payCJOrderBalance, financialGate, selfHealStuckOrders, checkStripeDispute, disputeWatchdogCron ,auditEvent};