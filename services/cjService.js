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
// 3. محرك الـ Fulfillment والتقسيم الآلي المحصن
// ==========================================
async function fulfillCJOrder(orderId, customerName, customerDetails, items) {
  try {
    const addr = customerDetails?.address || {};
    const isSandbox = process.env.CJ_SANDBOX_MODE === 'true' ? 1 : 0;

    // تنظيف اسم الزبون لضمان قبوله في CJ (CJ تطلب اسماً من كلمتين على الأقل)
    let safeCustomerName = (customerName || '').trim();
    if (!safeCustomerName || safeCustomerName.toLowerCase() === 'guest customer' || !safeCustomerName.includes(' ')) {
      safeCustomerName = safeCustomerName ? `${safeCustomerName} Customer` : 'Valued Customer';
    }

    // استخراج الـ vid المؤكد
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
        cjProducts.push({ vid, quantity: item.quantity || 1 });
      }
    }

    if (cjProducts.length === 0) {
      console.warn(`⚠️ Order #${orderId} contains no valid CJ variants. Marked as manual.`);
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
      return { success: false, reason: 'NO_CJ_VARIANTS' };
    }

    // استعلام أفضل وأرخص شركات الشحن
    let logisticsToTry = [];
    try {
      const freightRes = await cjRequest((token) =>
        axios.post('https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate', {
          startCountryCode: 'CN',
          endCountryCode: addr.country || 'US',
          products: cjProducts.map(p => ({ vid: p.vid, quantity: p.quantity }))
        }, { headers: { 'CJ-Access-Token': token } })
      );
      if (freightRes.data.code === 200 && freightRes.data.data?.length > 0) {
        logisticsToTry = freightRes.data.data.sort((a, b) => a.logisticPrice - b.logisticPrice).map(l => l.logisticName);
      }
    } catch (e) {}

    logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Sensitive', 'CJPacket Ordinary', 'CJPacket', 'YunExpress', '4PX'])];

    let orderSuccess = false;
    let lastError = null;
    let needsSplitting = false;
    let successfulCJOrderNumber = null;

    // تنظيف العنوان لمنع أخطاء التنسيق في CJ
    let safeLine1 = (addr.line1 || 'Main Street 1').trim();
    if (!/\d/.test(safeLine1)) safeLine1 += ' 1';

    const basePayload = {
      shippingCustomerName: safeCustomerName,
      shippingCountry: addr.country || 'US',
      shippingCountryCode: addr.country || 'US',
      shippingProvince: addr.state || addr.city || 'State',
      shippingCity: addr.city || 'City',
      shippingAddress: safeLine1,
      shippingAddress2: addr.line2 || '',
      shippingZip: addr.postal_code || '10001',
      shippingPhone: customerDetails?.phone || '1234567890',
      fromCountryCode: 'CN',
      orderFlow: 1, // إنشاء ودفع تلقائي من رصيد محفظة CJ
      payType: 2,   // الدفع عبر رصيد الحساب (CJ Balance)
      isSandbox: isSandbox
    };

    // 1. محاولة إرسال الطلب مجمعاً كشحنة واحدة
    for (const logisticName of logisticsToTry) {
      const targetOrderNumber = `STORE-${orderId}`;
      const cjOrderPayload = {
        ...basePayload,
        orderNumber: targetOrderNumber,
        logisticName: logisticName,
        products: cjProducts
      };

      try {
        await new Promise(r => setTimeout(r, 1200)); // احترام QPS
        const cjResponse = await cjRequest((token) =>
          axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrderV2',
            cjOrderPayload,
            { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
          )
        );

        if (cjResponse.data.code === 200) {
          console.log(`🚀 Order #${orderId} Auto-Paid & Sent to CJ successfully via ${logisticName}!`);
          orderSuccess = true;
          successfulCJOrderNumber = cjResponse.data.data?.orderNumber || targetOrderNumber;
          break;
        } else {
          lastError = cjResponse.data;

          // خطأ تعدد المستودعات (Warehouse Conflict)
          if (lastError.code === 1603000 || lastError.message?.includes('100230')) {
            console.log(`⚠️ Order #${orderId} products reside in different warehouses. Initiating Auto-Split...`);
            needsSplitting = true;
            break;
          }

          if (lastError.code === 1600200 || lastError.code === 1605001) {
            break;
          }
        }
      } catch (err) {
        lastError = err.response?.data || err.message;
      }
    }

    // 2. منطق التقسيم الذكي المحصن (Bulletproof Auto-Split)
    if (!orderSuccess && needsSplitting) {
      console.log(`📦 Executing Auto-Split for Order #${orderId} (${cjProducts.length} items)...`);
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
              axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrderV2',
                splitPayload,
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
              )
            );

            if (splitRes.data.code === 200) {
              console.log(`✅ Split [${i + 1}/${cjProducts.length}] sent successfully via ${logisticName}!`);
              itemSuccess = true;
              successfulSplits++;
              splitOrdersCreated.push(splitOrderNum);
              break;
            }
          } catch (err) {}
        }
      }

      // التحقق من نتيجة التقسيم
      if (successfulSplits === cjProducts.length) {
        console.log(`🎉 All ${successfulSplits} split shipments succeeded for Order #${orderId}!`);
        orderSuccess = true;
        successfulCJOrderNumber = splitOrdersCreated.join(', ');
      } else if (successfulSplits > 0) {
        // حماية أموالك: إذا نجح جزء وفشل جزء، لا تعيد الطلب بالكامل
        console.error(`🚨 Partial fulfillment on Order #${orderId}: ${successfulSplits}/${cjProducts.length} shipped.`);
        await pool.query(
          "UPDATE orders SET status = 'manual', shipping_address = $1 WHERE id = $2",
          [`PARTIAL SUCCESS (${successfulSplits}/${cjProducts.length} items shipped). Check: ${splitOrdersCreated.join(', ')}`, orderId]
        );
        return { success: false, partial: true, error: 'Partial fulfillment' };
      }
    }

    // ✨ 3. النتيجة وتحديث قاعدة البيانات وإرجاع الرد الحقيقي
    if (orderSuccess) {
      // تحديث الحالة إلى fulfilled
      await pool.query("UPDATE orders SET status = 'fulfilled' WHERE id = $1", [orderId]);
      return { 
        success: true, 
        orderNumber: successfulCJOrderNumber 
      };
    } else {
      console.error(`❌ CJ Order Fulfillment Failed for #${orderId}. Reason:`, lastError);
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
      return { 
        success: false, 
        error: lastError 
      };
    }
  } catch (err) {
    logger.logError(`CJ Fulfillment Fatal Error #${orderId}`, err);
    await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
    return { 
      success: false, 
      error: err.message 
    };
  }
}

module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric };