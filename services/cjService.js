// services/cjService.js - Laclarc Enterprise Dropshipping Engine
require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const logger = require('../logger');

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

  // إذا كان هناك طلب تجديد جارٍ بالفعل، ننتظره جميعاً بدلاً من إرسال طلب مكرر
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
// 2. محرك الطلبات الذكي مع الحماية من الـ Rate Limit
// ==========================================
async function cjRequest(requestFn, retryCount = 0) {
  try {
    const token = await getCJToken();
    const config = { timeout: 45000 };
    return await requestFn(token, config);
  } catch (err) {
    const status = err.response?.status;
    const cjCode = err.response?.data?.code;
    const isAuthError = status === 401 || cjCode === 401 || cjCode === 1600001;

    // خطأ تجاوز حد الطلبات في الثانية (QPS=1)
    if (cjCode === 1600200) {
      if (retryCount < 3) {
        const backoffTime = (retryCount + 1) * 1500;
        console.warn(`⚠️ CJ QPS Limit hit. Retrying in ${backoffTime}ms (Attempt ${retryCount + 1}/3)...`);
        await new Promise(r => setTimeout(r, backoffTime));
        return cjRequest(requestFn, retryCount + 1);
      }
      throw err;
    }

    // انتهاء صلاحية التوكن المفاجئ
    if (isAuthError && retryCount < 1) {
      console.log('⚠️ CJ token expired during request. Refreshing now...');
      const freshToken = await getCJToken(true);
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
// 3. محرك الـ Fulfillment المحصّن (V3 API — 2025) — v2 متكامل مع الويب هوك
// ⚠️ القاعدة الذهبية: 'fulfilled' عندنا = SHIPPED فعلي من CJ (الويب هوك فقط!)
//    القبول عند CJ = الطلب يبقى 'paid' — والويب هوك هو اللي كيرفع الحالة
// ==========================================
const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

async function fulfillCJOrder(orderId, customerName, customerDetails, items) {
  let cjCreated = false; // 🛡️ واقي الـ catch الفادح — لا manual إلا إلا ما وصل حتى إرسال لـ CJ
  try {
    const addr = customerDetails?.address || {};
    const isSandbox = process.env.CJ_SANDBOX_MODE === 'true' ? 1 : 0;

    // تنظيف اسم الزبون (CJ يطلب اسماً من كلمتين على الأقل)
    let safeCustomerName = (customerName || '').trim();
    if (!safeCustomerName || safeCustomerName.toLowerCase() === 'guest customer' || !safeCustomerName.includes(' ')) {
      safeCustomerName = safeCustomerName ? `${safeCustomerName} Customer` : 'Valued Customer';
    }

    // ✨ V3 كيطلب إيميل صالح — الطلبات بلا إيميل (هاتف فقط) نعطيوه عنواناً مؤسسياً
    const safeEmail = (customerDetails?.email || '').trim() || 'orders@laclarc.com';

    // استخراج الـ vid المؤكد + storeLineItemId (معرّف العنصر فـ DB)
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
          storeLineItemId: item.id ? String(item.id) : `item-${orderId}-${cjProducts.length}`,  // ✨ V3
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

    logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Ordinary', 'CJPacket Sensitive', 'YunExpress', '4PX'])];

    let orderSuccess = false;
    let lastError = null;
    let needsSplitting = false;
    let successfulCJOrderNumber = null;

    let safeLine1 = (addr.line1 || 'Main Street 1').trim();
    if (!/\d/.test(safeLine1)) safeLine1 += ' 1';

    // ✨ V3 Base Payload
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
      email: safeEmail,                    // ✨ V3 — ديما إيميل صالح
      fromCountryCode: 'CN',
      orderFlow: 1,
      shopLogisticsType: 3,               // ✨ V3 — CJ يختار المستودع الأمثل
      isSandbox: isSandbox,
    };

    // 🔧 استخراج رقم CJ (BT...) من أي response — الأسماء ما مؤكدينش، نجربو المست slaughtered_shuffle كلهم
    //    + 🔬 عينة أول نجاح (نفس منهجية الويب هوك — اللوج هو ground truth)
    function extractCjNumber(dataObj) {
      const d = dataObj || {};
      return d.orderNumber || d.cjOrderId || d.orderId || d.cjOrderNumber || null;
    }
    function sampleOnce(tag, obj) {
      const key = `_cjSample_${tag}`;
      if (!global[key]) {
        global[key] = true;
        console.log(`🔬 [Sample ${tag}]`, JSON.stringify(obj || {}).slice(0, 600));
      }
    }

    // 🔧 حفظ آمن — COALESCE pattern ديال الويب هوك: عمرو ما كيطمش BT موجود بـ STORE-x
    async function saveCjNumber(num) {
      if (!num) return;
      await pool.query(
        `UPDATE orders SET cj_order_number = COALESCE(NULLIF(cj_order_number,''), NULLIF($1,'')) WHERE id = $2`,
        [String(num), orderId]
      ).catch(() => {});
    }

    // 1. محاولة الإرسال المجمّع
    for (const logisticName of logisticsToTry) {
      const targetOrderNumber = `STORE-${orderId}`;
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

          // 🔬 عينة أول نجاح — نأكدو اسم حقل رقم CJ فالـ response (/store/ STORE-x ولا BT...؟)
          sampleOnce('V3-Create', cjResponse.data?.data);

          successfulCJOrderNumber = extractCjNumber(cjResponse.data?.data) || targetOrderNumber;
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }

        lastError = cjResponse.data;

        // 1603000 = Warehouse split needed
        if (lastError.code === 1603000 || lastError.message?.includes('100230')) {
          console.log(`⚠️ Order #${orderId} needs Auto-Split (different warehouses)...`);
          needsSplitting = true;
          break;
        }

        // ✨ 1603003 = موجود أصلاً — نجاح منطقي + 🔄 استرجاع رقم CJ الحقيقي (BT...)
        if (lastError.code === 1603003) {
          console.log(`ℹ️ [CJ] Order #${orderId} already exists — logical success.`);
          orderSuccess = true;
          cjCreated = true;
          successfulCJOrderNumber = targetOrderNumber;

          // 🔄 GET ماشي POST (16900202 مؤكدة بالتجربة) — نجيبو BT الحقيقي
          try {
            await new Promise(r => setTimeout(r, 1200));
            const detail = await cjRequest((token) =>
              axios.get(`${CJ_API}/shopping/order/getOrderDetail`, {
                params: { orderNumber: targetOrderNumber },
                headers: { 'CJ-Access-Token': token },
              })
            );
            const dd = detail.data?.data || {};
            sampleOnce('OrderDetail', dd);
            const realCj = extractCjNumber(dd) || extractCjNumber(dd.orderInfo);
            if (realCj && realCj !== targetOrderNumber) {
              successfulCJOrderNumber = realCj;
              console.log(`🔗 [CJ] #${orderId} → رقم CJ الحقيقي: ${realCj}`);
            }
          } catch (e) {
            console.warn(`⚠️ [CJ] ما قدرناش نجيبو رقم CJ الحقيقي لـ #${orderId}:`, e.response?.data?.message || e.message);
          }
          await saveCjNumber(successfulCJOrderNumber); // COALESCE: ما كيطمش BT قديم
          break;
        }

        // 💰 1605001 = محفظة فارغة → orderFlow:0 (الطلب كيبقى فـ CJ dashboard ينتظر الدفع اليدوي)
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
        // ✨ 1603003 يمكن يجي كـ HTTP exception
        if (err.response?.data?.code === 1603003) {
          console.log(`ℹ️ [CJ] Order #${orderId} already exists (exception) — success.`);
          orderSuccess = true;
          cjCreated = true;
          successfulCJOrderNumber = targetOrderNumber;
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
              // 🔗 رقم CJ الحقيقي لكل split — LOGISTIC كيلاقيه من بعد
              const splitCj = extractCjNumber(splitRes.data?.data);
              if (splitCj && splitCj !== splitOrderNum) await saveCjNumber(splitCj);
              break;
            }
            // ✨ 1603003 كجسم الـ response (النسخة القديمة معالجاة غير كـ exception!)
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
        // 🚨 جزئي — ⚠️ v2: عمرو ما كنكتبوش فـ shipping_address (كان كيدمر عنوان العميل)!
        console.error(`🚨 Partial fulfillment on Order #${orderId}: ${successfulSplits}/${cjProducts.length} shipped.`);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
        const { sendEmail } = require('../controllers/paymentController');
        sendEmail({
          to: process.env.BREVO_USER,
          subject: `🚨 CJ Partial Fulfillment — Order #${orderId} (${successfulSplits}/${cjProducts.length})`,
          html: `<p>Splits الناجحين: <code>${splitOrdersCreated.join(', ')}</code></p>
                 <p>راجع CJ dashboard وأكمل العناصر الناقصة يدوياً — العميل مستنى!</p>`
        }).catch(() => {});
        return { success: false, partial: true, error: 'Partial fulfillment' };
      }
    }

    // 3. النتيجة النهائية
    if (orderSuccess) {
      // ✅ v2 — الإصلاح الحاسم: 'fulfilled' هنا كان BUG كيبلوكي الويب هوك!
      // forward-only guard: fulfilled(2) >= SHIPPED→fulfilled(2) → SHIPPED كان كيتطنش
      // → بلا tracking، بلا واتساب، بلا إيميل. الطلب يبقى 'paid' — الويب هوك هو اللي كيرفع.
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
    // 🛡️ إلا الطلب ديجا تسال فـ CJ — لا manual (كيوقع دبل fulfillment محتمل)
    if (!cjCreated) {
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]).catch(() => {});
    }
    return { success: false, error: err.message };
  }
}

module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric };