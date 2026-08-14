require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

// إعداد قاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

await new Promise(r => setTimeout(r, 1500)); // ✨ تأخير 1.5 ثانية قبل كل محاولة شحن

    for (const logisticName of logisticsToTry) {
      const cjOrderPayload = {
        orderNumber: `STORE-${orderId}`,
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
        logisticName: logisticName,
        orderFlow: 1,
        payType: 2, 
        isSandbox: isSandbox, 
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
          if (cjResponse.data.code !== 1605001 && cjResponse.data.code !== 1600200) break;
        }
      } catch (err) {
        lastError = err.response?.data || err.message;
        if (lastError.code === 1600200) await new Promise(r => setTimeout(r, 1000));
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