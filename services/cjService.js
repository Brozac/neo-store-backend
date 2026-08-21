require('dotenv').config();
const axios = require('axios');
// ✨ Pool مشترك بدل new Pool() محلي — يتفادى تكاثر الاتصالات (شوف db.js)
const pool = require('../db');

let cachedCjToken = null;
let cachedCjTokenExpiry = null;
let cachedCjRefreshToken = null;

async function getCJToken(forceRefresh = false) {
  if (!forceRefresh && cachedCjToken && cachedCjTokenExpiry && Date.now() < cachedCjTokenExpiry) {
    return cachedCjToken;
  }

  const apiKey = process.env.CJ_API_KEY;
  if (!apiKey) throw new Error("CJ_API_KEY is missing in .env");

  try {
    if (cachedCjRefreshToken) {
      const refreshRes = await axios.post('https://developers.cjdropshipping.com/api2.0/v1/authentication/refreshAccessToken', {
        refreshToken: cachedCjRefreshToken
      });

      if (refreshRes.data.code === 200 && refreshRes.data.data?.accessToken) {
        cachedCjToken = refreshRes.data.data.accessToken;
        cachedCjRefreshToken = refreshRes.data.data.refreshToken;
        const expiryDateStr = refreshRes.data.data.accessTokenExpiryDate;
        cachedCjTokenExpiry = expiryDateStr ? new Date(expiryDateStr).getTime() - 5 * 60 * 1000 : Date.now() + 12 * 60 * 60 * 1000;
        return cachedCjToken;
      }
    }

    const authRes = await axios.post('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
      apiKey: apiKey
    });

    if (authRes.data.code === 200 && authRes.data.data?.accessToken) {
      cachedCjToken = authRes.data.data.accessToken;
      cachedCjRefreshToken = authRes.data.data.refreshToken;
      const expiryDateStr = authRes.data.data.accessTokenExpiryDate;
      cachedCjTokenExpiry = expiryDateStr ? new Date(expiryDateStr).getTime() - 5 * 60 * 1000 : Date.now() + 12 * 60 * 60 * 1000;
      return cachedCjToken;
    } else {
      throw new Error('Failed to authenticate with CJ: ' + authRes.data.message);
    }
  } catch (err) {
    if (err.response?.data?.code === 1600003) {
      cachedCjRefreshToken = null;
      const authRes = await axios.post('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', { apiKey: apiKey });
      if (authRes.data.code === 200 && authRes.data.data?.accessToken) {
        cachedCjToken = authRes.data.data.accessToken;
        cachedCjRefreshToken = authRes.data.data.refreshToken;
        const expiryDateStr = authRes.data.data.accessTokenExpiryDate;
        cachedCjTokenExpiry = expiryDateStr ? new Date(expiryDateStr).getTime() - 5 * 60 * 1000 : Date.now() + 12 * 60 * 60 * 1000;
        return cachedCjToken;
      }
    }
    throw err;
  }
}

async function cjRequest(requestFn, retryCount = 0) {
  try {
    const token = await getCJToken();
    const config = { timeout: 60000 };
    return await requestFn(token, config);
  } catch (err) {
    const status = err.response?.status;
    const cjCode = err.response?.data?.code;
    const isAuthError = status === 401 || cjCode === 401 || cjCode === 1600001;

    // ✨ إذا كان الخطأ هو تجاوز معدل الطلبات (Too Many Requests)
    if (cjCode === 1600200) {
      if (retryCount < 3) { // الحد الأقصى لإعادة المحاولة هو 3
        console.log(`⚠️ CJ API rate limit hit (QPS=1). Waiting 1.5s and retrying (Attempt ${retryCount + 1}/3)...`);
        await new Promise(r => setTimeout(r, 1500)); // انتظار 1.5 ثانية لضمان عدم التداخل
        return cjRequest(requestFn, retryCount + 1); // إعادة المحاولة بنفس الطلب
      } else {
        console.error('❌ CJ API rate limit exceeded after 3 retries.');
        throw err; // رمي الخطأ بعد فشل 3 محاولات
      }
    }

    if (isAuthError) {
      console.log('⚠️ CJ token expired or invalid, refreshing and retrying once...');
      const freshToken = await getCJToken(true);
      return await requestFn(freshToken, { timeout: 60000 });
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

async function fulfillCJOrder(orderId, customerName, customerDetails, items) {
  try {
    const addr = customerDetails?.address || {};
    const isSandbox = process.env.CJ_SANDBOX_MODE === 'true' ? 1 : 0;

    // ✨ ملاحظة: هاذ الدالة دابا كتُستعمل غير كـ fallback نادر — منذ إصلاح
    // secureCheckout.js، الـ vid الصحيح كيتسجل ديما فـ order_items وقت الشراء
    // (item.vid). هادي كتبقى فقط لطلبات قديمة قبل الإصلاح أو منتجات بلا vid مسجل.
    const getVidFromDB = async (productId) => {
      const res = await pool.query('SELECT variants FROM products WHERE id = $1', [productId]);
      if (res.rows.length > 0 && res.rows[0].variants) {
        try {
          const variants = typeof res.rows[0].variants === 'string' ? JSON.parse(res.rows[0].variants) : res.rows[0].variants;
          if (Array.isArray(variants) && variants.length > 0 && variants[0].vid) return variants[0].vid;
        } catch (e) {}
      }
      return null;
    };

    const cjProducts = [];
    for (const item of items) {
      let vid = item.vid;
      if (!vid && item.product_id) vid = await getVidFromDB(item.product_id);
      if (vid) cjProducts.push({ vid, quantity: item.quantity });
    }

    if (cjProducts.length === 0) {
      console.log(`⚠️ Order #${orderId} has no CJ products. Skipping.`);
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
      return;
    }

    let logisticsToTry = [];
    try {
      const freightRes = await cjRequest((token) =>
        axios.post('https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate', {
          startCountryCode: 'CN', endCountryCode: addr.country || 'US',
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
    let needsSplitting = false; // ✨ علم لتقسيم الطلب

    const basePayload = {
      shippingCustomerName: customerName || 'Customer',
      shippingCountry: addr.country || 'US',
      shippingCountryCode: addr.country || 'US',
      shippingProvince: addr.state || addr.city || 'N/A',
      shippingCity: addr.city || 'N/A',
      shippingAddress: `${addr.line1 || 'N/A'}${addr.line1 && !/\d/.test(addr.line1) ? ' 1' : ''}`,
      shippingAddress2: addr.line2 || '',
      shippingZip: addr.postal_code || '00000',
      shippingPhone: customerDetails?.phone || '0000000000',
      fromCountryCode: 'CN',
      orderFlow: 1,
      payType: 2,
      isSandbox: isSandbox
    };

    // 1. محاولة إرسال الطلب كامل
    for (const logisticName of logisticsToTry) {
      const cjOrderPayload = {
        ...basePayload,
        orderNumber: `STORE-${orderId}`,
        logisticName: logisticName,
        products: cjProducts
      };

      try {
        await new Promise(r => setTimeout(r, 1500));
        const cjResponse = await cjRequest((token) =>
          axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrderV2',
            cjOrderPayload,
            { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
          )
        );

        if (cjResponse.data.code === 200) {
          console.log(`🚀 Order #${orderId} Auto-Paid & Sent to CJ successfully using ${logisticName}!`);
          await pool.query("UPDATE orders SET status = 'fulfilled' WHERE id = $1", [orderId]);
          orderSuccess = true;
          break;
        } else {
          lastError = cjResponse.data;

          // ✨ التقاط خطأ "منتجات في مستودعات مختلفة"
          if (lastError.code === 1603000 || lastError.message?.includes('100230')) {
            console.log(`⚠️ Order #${orderId} has products in different warehouses. Will attempt to split...`);
            needsSplitting = true;
            break; // نخرج من حلقة الشحن لأن التقسيم هو الحل الوحيد
          }

          // إيقاف محاولات الشحن إذا تجاوزنا الحد
          if (lastError.code === 1600200 || lastError.code === 1605001) {
            console.log(`⚠️ CJ blocked the request (Code: ${lastError.code}). Stopping shipping attempts.`);
            break;
          }
        }
      } catch (err) {
        lastError = err.response?.data || err.message;
        if (lastError.code === 1600200) await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 2. ✨ منطق التقسيم الآلي (Split Order)
    if (!orderSuccess && needsSplitting) {
      console.log(`📦 Splitting Order #${orderId} into individual shipments...`);
      let allSplitsSuccessful = true;
      let splitIndex = 1;

      for (const product of cjProducts) {
        let splitSuccess = false;
        // نجرب شركات الشحن لكل منتج على حدة
        for (const logisticName of logisticsToTry) {
          const splitPayload = {
            ...basePayload,
            orderNumber: `STORE-${orderId}-SPLIT-${splitIndex}`, // رقم طلب فريد للمنتج المفرد
            logisticName: logisticName,
            products: [product] // منتج واحد فقط
          };

          try {
            await new Promise(r => setTimeout(r, 1500));
            const splitResponse = await cjRequest((token) =>
              axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrderV2',
                splitPayload,
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
              )
            );

            if (splitResponse.data.code === 200) {
              console.log(`✅ Split item ${splitIndex} (VID: ${product.vid}) shipped successfully using ${logisticName}!`);
              splitSuccess = true;
              break; // نجح، اخرجي لتجربة المنتج التالي
            } else {
              // إذا فشل المنتج المفرد أيضاً، سجلي الخطأ
              console.log(`Failed to split item ${splitIndex} with ${logisticName}: ${splitResponse.data.message}`);
            }
          } catch (err) {
            console.log(`Error splitting item ${splitIndex}:`, err.response?.data?.message || err.message);
          }
        }

        if (!splitSuccess) {
          allSplitsSuccessful = false;
        }
        splitIndex++;
      }

      if (allSplitsSuccessful) {
        console.log(`🚀 Order #${orderId} successfully Auto-Split and Sent to CJ!`);
        await pool.query("UPDATE orders SET status = 'fulfilled' WHERE id = $1", [orderId]);
        orderSuccess = true;
      } else {
        console.error(`❌ Some items in Order #${orderId} could not be split and shipped.`);
      }
    }

    if (!orderSuccess) {
      console.error(`❌ CJ Order Failed for #${orderId}. CJ Error:`, JSON.stringify(lastError, null, 2));
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
    }
  } catch (err) {
    console.error('CJ Fulfillment Error:', err.response?.data || err.message);
    await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
  }
}

module.exports = { fulfillCJOrder, getCJToken, cjRequest, parseNumeric };