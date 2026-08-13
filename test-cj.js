require('dotenv').config();
const axios = require('axios');

async function testAddToMyProduct() {
  const apiKey = process.env.CJ_API_KEY;
  if (!apiKey) {
    console.error('❌ CJ_API_KEY is missing in .env');
    return;
  }

  try {
    // 1. الحصول على التوكن
    console.log('1. Getting Token...');
    const authRes = await axios.post('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
      apiKey: apiKey
    });

    if (authRes.data.code !== 200 || !authRes.data.data?.accessToken) {
      throw new Error('Failed to get token: ' + JSON.stringify(authRes.data));
    }
    const token = authRes.data.data.accessToken;
    console.log('✅ Token received!');

    // 2. إرسال طلب إضافة منتج (ضع رقم PID صحيح هنا)
    const productIdToAdd = '2607311155161618600'; // مثال: رقم منتج جلبناه سابقاً
    console.log(`2. Adding product ${productIdToAdd} to My Products...`);

    const addRes = await axios.post(
      'https://developers.cjdropshipping.com/api2.0/v1/product/addToMyProduct',
      { productId: productIdToAdd },
      {
        headers: {
          'CJ-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    // ✨ طباعة الرد الكامل من CJ
    console.log('✅ CJ Response:', JSON.stringify(addRes.data, null, 2));

  } catch (err) {
    console.error('❌ Error occurred!');
    if (err.response) {
      console.error('Response Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Message:', err.message);
    }
  }
}

testAddToMyProduct();