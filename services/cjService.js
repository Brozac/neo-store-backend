// services/cjService.js - Laclarc Enterprise Dropshipping Engine (v2.1 FINAL)
require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const logger = require('../logger');
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

// ==========================================
// 3. محرك الـ Fulfillment المحصّن (V3 API) — v2.1
// ==========================================

// 🛡️ cryptoPaymentGuard — fail-closed
async function cryptoPaymentGuard(orderId) {
  try {
    const r = await pool.query('SELECT payment_method, payment_ref, total_amount FROM orders WHERE id = $1', [orderId]);
    const o = r.rows[0];
    if (!o) return { allow: false, reason: 'order_not_found' };
    if (!/crypto|nowpayments/i.test(o.payment_method || '')) return { allow: true, reason: 'not_crypto' };
    if (!o.payment_ref) { console.warn('[NP-Guard] #' + orderId + ' بلا payment_ref — رفض احتياطي'); return { allow: false, reason: 'no_payment_ref' }; }
    const key = process.env.NOWPAYMENTS_API_KEY;
    if (!key) { console.error('[NP-Guard] NOWPAYMENTS_API_KEY ناقص'); return { allow: false, reason: 'no_api_key' }; }
    const res = await axios.get('https://api.nowpayments.io/v1/payment/' + o.payment_ref, {
      headers: { 'x-api-key': key }, timeout: 15000
    });
    const p = res.data || {};
    const paidUsd = Number(p.actually_paid_usd ?? 0);
    const status = String(p.payment_status || '');
    const ok = (status === 'finished' || status === 'confirmed') && paidUsd + 0.01 >= Number(o.total_amount);
    console.log('[NP-Guard] #' + orderId + ' status=' + status + ' paid_usd=' + paidUsd + ' total=' + o.total_amount + ' => ' + (ok ? 'ALLOW' : 'DENY'));
    return ok ? { allow: true } : { allow: false, reason: 'payment_' + status + '_' + paidUsd };
  } catch (e) {
    logger.logError('cryptoPaymentGuard #' + orderId, e);
    return { allow: false, reason: 'guard_error' };
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
  const _guard = await cryptoPaymentGuard(orderId);
  if (!_guard.allow) {
    console.error('[NP-Guard] رفض إرسال #' + orderId + ' لـ CJ: ' + _guard.reason);
    return { success: false, reason: 'PAYMENT_NOT_CONFIRMED', detail: _guard.reason };
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
          'SELECT total_amount, customer_email, customer_phone, customer_name, customer_city FROM orders WHERE id = $1',
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
    } catch (e) {}

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
      ).catch(() => {});
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
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]).catch(() => {});
    }
    return { success: false, error: err.message };
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
module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert, deleteCJOrder, payCJOrderBalance };