// controllers/paymentController.js - Laclarc Enterprise Payment Controller
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const jwt = require('jsonwebtoken'); 
const pool = require('../db'); // ✨ استخدام الـ Pool الموحد حصراً
const { fulfillCJOrder } = require('../services/cjService');
const { prepareSecureItems } = require('../utils/secureCheckout');
const { applyCouponToTotal } = require('../utils/couponHelper'); // ✨ زدنا: Helper الكوبون الموحد
const logger = require('../logger'); 

// إعداد Cloudinary لتخزين إيصالات بريدي موب
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'neo_store_receipts',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp']
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET;

// ✨ زدنا: كاش ديال Stripe Coupons — مانصاوبوش كوبون جديد فكل checkout (Litter فالـ Dashboard)
const stripeCouponCache = new Map();
async function getOrCreateStripeCoupon(couponData) {
  const key = JSON.stringify(couponData);
  if (stripeCouponCache.has(key)) return stripeCouponCache.get(key);
  const sc = await stripe.coupons.create(couponData);
  stripeCouponCache.set(key, sc.id);
  if (stripeCouponCache.size > 200) {
    stripeCouponCache.delete(stripeCouponCache.keys().next().value);
  }
  return sc.id;
}

// ✨ زدنا: سعر الصرف الرسمي (Configurable من Render Env بدون Redeploy)
const USD_TO_DZD = Number(process.env.USD_TO_DZD_RATE) || 255;

const ALL_WORLD_COUNTRIES = ['AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ'];

// ==========================================
// دوال الإيميل الموحدة
// ==========================================
async function sendEmail({ to, subject, html }) {
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Laclarc Support', email: process.env.BREVO_USER },
      to: [{ email: to }],
      subject,
      htmlContent: html
    }, {
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
    console.log(`📧 Email sent via Brevo to ${to}`);
    return;
  } catch (brevoErr) {
    logger.logError('Send Email (Brevo API)', brevoErr.response?.data || brevoErr.message);
  }

  try {
    await axios.post('https://api.resend.com/emails', {
      from: process.env.RESEND_FROM_EMAIL || 'Laclarc <onboarding@resend.dev>',
      to: [to],
      subject,
      html
    }, {
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }
    });
    console.log(`📧 Email sent via Resend (fallback) to ${to}`);
  } catch (resendErr) {
    logger.logError('Send Email (Resend fallback)', resendErr.response?.data || resendErr.message);
  }
}

async function sendOrderConfirmationEmail(email, orderId, total, items = []) {
  try {
    const itemsHtml = items.map(item => `
      <tr>
        <td style="padding: 15px 0; border-bottom: 1px solid #eee; display: flex; align-items: center;">
          <img src="${item.image_url || 'https://via.placeholder.com/50'}" alt="${item.title || 'Product'}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 8px; margin-right: 15px;">
          <span style="color: #1D1E3C; font-weight: bold; font-size: 14px;">${item.title || 'Product'} (Qty: ${item.quantity})</span>
        </td>
        <td style="padding: 15px 0; border-bottom: 1px solid #eee; text-align: right; color: #FF6B9D; font-weight: bold; font-size: 14px;">
          $${Number(item.price_at_purchase || item.price || 0).toFixed(2)}
        </td>
      </tr>
    `).join('');

    const htmlContent = `
      <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: 0 auto; background-color: #f4f3f8; border-radius: 15px; overflow: hidden; border: 1px solid #ddd;">
        <div style="background: linear-gradient(135deg, #1D1E3C 0%, #8B78C6 100%); padding: 30px; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 28px; letter-spacing: 1px;">Laclarc</h1>
        </div>
        <div style="padding: 30px;">
          <h2 style="color: #1D1E3C; margin-top: 0;">Order Confirmed Successfully! 🎉</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Thank you for your purchase from Laclarc. Your order <strong style="color: #8B78C6;">#${orderId}</strong> is currently being processed and will be shipped soon.
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 25px 0;">
            <thead>
              <tr style="border-bottom: 2px solid #8B78C6;">
                <th style="text-align: left; padding-bottom: 10px; color: #1D1E3C;">Product</th>
                <th style="text-align: right; padding-bottom: 10px; color: #1D1E3C;">Price</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div style="text-align: right; margin-top: 20px; border-top: 2px dashed #eee; padding-top: 20px;">
            <span style="font-size: 18px; color: #1D1E3C; font-weight: bold;">Total Paid:</span>
            <span style="font-size: 22px; color: #FF6B9D; font-weight: bold; margin-left: 10px;">$${Number(total).toFixed(2)}</span>
          </div>
          <div style="background-color: #f9f9f9; border-left: 4px solid #8B78C6; padding: 15px; margin-top: 30px; border-radius: 5px;">
            <p style="margin: 0; color: #1D1E3C; font-weight: bold; font-size: 14px;">Shipping & Tracking Information:</p>
            <p style="margin: 5px 0 0 0; color: #777; font-size: 13px;">
              Once CJ Dropshipping ships your order, we will send you the tracking number. You can track your shipment directly through the "Track My Order" page on our website.
            </p>
          </div>
          <div style="text-align: center; margin-top: 40px;">
            <a href="${process.env.FRONTEND_URL || 'https://laclarc.com'}" style="background-color: #FF6B9D; color: #fff; text-decoration: none; padding: 12px 30px; border-radius: 25px; font-weight: bold; display: inline-block;">
              Continue Shopping
            </a>
          </div>
        </div>
        <div style="background-color: #1D1E3C; padding: 20px; text-align: center; color: #888; font-size: 12px;">
          &copy; ${new Date().getFullYear()} Laclarc. All rights reserved.
        </div>
      </div>
    `;

    await sendEmail({ to: email, subject: `Order Confirmation #${orderId} - Laclarc`, html: htmlContent });
    console.log(`📧 Professional confirmation email sent to ${email}`);
  } catch (err) {
    logger.logError('Send Order Email', err);
  }
}

function getOptionalUser(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// ==========================================
// 1. Stripe Checkout
// ==========================================
router.post('/stripe', async (req, res) => {
  try {
    const { items: clientItems, origin, couponCode } = req.body;
    let baseUrl = origin && origin.startsWith('http') ? origin : (process.env.FRONTEND_URL || 'https://laclarc.com');
    baseUrl = baseUrl.replace(/\/+$/, '');

    const optionalUser = getOptionalUser(req);
    const { secureItems, serverTotal } = await prepareSecureItems(pool, clientItems);

    // ✨ تصادق وتطبيق الكوبون server-side أولاً
    const { total: chargeTotal, applied: couponApplied, discount: couponDiscount, clamped, coupon: couponRow } =
      await applyCouponToTotal(pool, couponCode, serverTotal);

    // ✨ تسجيل chargeTotal (المبلغ بعد الكوبون) ليتطابق مع Paysera و Crypto
    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id) VALUES ($1, $2, $3, $4, $5, 'Stripe', $6) RETURNING id",
      ['Pending Customer', 'pending@laclarc.com', 'Pending', chargeTotal, 'pending', optionalUser ? optionalUser.id : null]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of secureItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, item.price, item.vid]
      );
    }

    let stripeDiscounts = [];
    if (couponApplied) {
      const useNativePercent = couponRow.discount_type === 'percentage' && !clamped && Number(couponRow.discount_value) < 100;
      const couponData = useNativePercent
        ? { percent_off: parseFloat(couponRow.discount_value), duration: 'once' }
        : { amount_off: Math.round(couponDiscount * 100), currency: 'usd', duration: 'once' };
      stripeDiscounts = [{ coupon: await getOrCreateStripeCoupon(couponData) }];
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: secureItems.map(item => {
        const hasValidImage = item.image_url && typeof item.image_url === 'string' && item.image_url.startsWith('http');
        return {
          price_data: {
            currency: 'usd',
            product_data: { name: item.title, images: hasValidImage ? [item.image_url] : [] },
            unit_amount: Math.round(item.price * 100),
          },
          quantity: item.quantity,
        };
      }),
      mode: 'payment',
      shipping_address_collection: { allowed_countries: ALL_WORLD_COUNTRIES },
      phone_number_collection: { enabled: true },
      discounts: stripeDiscounts,
      shipping_options: [
        { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'usd' }, display_name: 'Standard Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 15 }, maximum: { unit: 'business_day', value: 35 } } } },
        { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 1500, currency: 'usd' }, display_name: 'Worldwide Express Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 7 }, maximum: { unit: 'business_day', value: 15 } } } }
      ],
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cancel`,
      metadata: {
        orderId: orderId.toString(),
        couponCode: couponApplied ? String(couponCode).toUpperCase() : ''
      },
    });

    await pool.query("UPDATE orders SET stripe_session_id = $1 WHERE id = $2", [session.id, orderId]);
    res.json({ url: session.url });
  } catch (error) {
    logger.logError('Stripe Checkout Error', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. Paysera Checkout & Callback
// ==========================================
router.post('/paysera', async (req, res) => {
  try {
    const { items: clientItems, couponCode } = req.body; // ✨ زدنا couponCode
    const optionalUser = getOptionalUser(req);

    const { secureItems, serverTotal } = await prepareSecureItems(pool, clientItems);

    // ✨ تطبيق الكوبون server-side — المبلغ النهائي من السيرفر
    const { total: chargeTotal } = await applyCouponToTotal(pool, couponCode, serverTotal);

    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id) VALUES ($1, $2, $3, $4, $5, 'Paysera', $6) RETURNING id",
      ['Pending Paysera', 'pending@laclarc.com', 'Pending', chargeTotal, 'pending', optionalUser ? optionalUser.id : null]
      //                                                           ✨ ^^^^^^^^^^^ بعد الكوبون
    );
    const orderId = orderResult.rows[0].id;

    for (const item of secureItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, item.price, item.vid]
      );
    }

    const data = {
      projectid: process.env.PAYSERA_PROJECT_ID,
      orderid: orderId,
      amount: Math.round(chargeTotal * 100), // ✨ المبلغ المخفض — ماشي serverTotal
      currency: 'USD',
      accepturl: `${process.env.FRONTEND_URL}/success?method=paysera`,
      cancelurl: `${process.env.FRONTEND_URL}/cart`,
      callbackurl: `${process.env.BACKEND_URL}/api/payment/paysera/callback`,
      test: process.env.NODE_ENV === 'production' ? 0 : 1, 
    };

    const encodedData = Buffer.from(
      Object.entries(data).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    ).toString('base64');

    const sign = crypto.createHash('md5')
      .update(encodedData + process.env.PAYSERA_PASSWORD)
      .digest('hex');

    const payseraUrl = `https://www.paysera.com/pay/?data=${encodedData}&sign=${sign}`;
    res.json({ url: payseraUrl });
  } catch (error) {
    logger.logError('Paysera Error', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/paysera/callback', async (req, res) => {
  try {
    const { data, ss1 } = req.query;
    if (!data || !ss1) return res.status(400).send('Bad parameters');

    const expectedSign = crypto.createHash('md5')
      .update(data + process.env.PAYSERA_PASSWORD)
      .digest('hex');

    if (expectedSign !== ss1) return res.status(400).send('Bad signature');

    const decodedStr = Buffer.from(data, 'base64').toString('utf8');
    const params = new URLSearchParams(decodedStr);
    const orderId = params.get('orderid');
    const status = params.get('status');

    if (status === '1') {
      const updateRes = await pool.query(
        "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING *", 
        [orderId]
      );

      if (updateRes.rows.length > 0) {
        const order = updateRes.rows[0];
        res.send('OK'); // الرد الفوري لمنع مهلة Paysera

        (async () => {
          try {
            const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [orderId]);
            const items = itemsRes.rows;

            const cjResponse = await fulfillCJOrder(orderId, order.customer_name, {
              address: { line1: order.shipping_address || 'Online Store Purchase', country: 'US' }
            }, items);

            // ✨ تحديث حالة الطلب إلى completed بعد نجاح الـ Fulfillment
            if (cjResponse && cjResponse.success) {
              await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
            }

            if (order.customer_email) {
              await sendOrderConfirmationEmail(order.customer_email, orderId, order.total_amount, items);
            }
          } catch (bgErr) {
            logger.logError('Paysera Fulfillment (Background)', bgErr);
          }
        })();
        return;
      }
    }
    res.send('OK');
  } catch (error) {
    logger.logError('Paysera Callback Error', error);
    res.status(500).send('Error');
  }
});

// ==========================================
// 3. Crypto (NowPayments) Checkout & IPN
// ==========================================
router.post('/crypto', async (req, res) => {
  try {
    const { items: clientItems, couponCode } = req.body; // ✨ زدنا couponCode
    const optionalUser = getOptionalUser(req);

    const { secureItems, serverTotal } = await prepareSecureItems(pool, clientItems);

    // ✨ تطبيق الكوبون server-side — المبلغ النهائي من السيرفر
    const { total: chargeTotal } = await applyCouponToTotal(pool, couponCode, serverTotal);

    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id) VALUES ($1, $2, $3, $4, $5, 'Crypto', $6) RETURNING id",
      ['Pending Crypto', 'pending@laclarc.com', 'Pending', chargeTotal, 'pending', optionalUser ? optionalUser.id : null]
      //                                                          ✨ ^^^^^^^^^^^ بعد الكوبون
    );
    const orderId = orderResult.rows[0].id;

    for (const item of secureItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, item.price, item.vid]
      );
    }

    // نمرر order_id في رابط النجاح لكي تقرأه صفحة /success لحظياً
    const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
      price_amount: chargeTotal, // ✨ المبلغ المخفض — ماشي serverTotal
      price_currency: 'usd',
      order_id: orderId.toString(), 
      order_description: `Laclarc Order #${orderId}`,
      ipn_callback_url: `${process.env.BACKEND_URL}/api/payment/crypto/callback`,
      success_url: `${process.env.FRONTEND_URL}/success?method=crypto&order_id=${orderId}`,
      cancel_url: `${process.env.FRONTEND_URL}/cart`,
    }, {
      headers: { 
        'x-api-key': process.env.NOWPAYMENTS_API_KEY, 
        'Content-Type': 'application/json' 
      }
    });
    
    // حفظ معرف الجلسة/الفاتورة
    if (response.data.id) {
      await pool.query("UPDATE orders SET receipt_url = $1 WHERE id = $2", [response.data.id.toString(), orderId]);
    }
    
    res.json({ url: response.data.invoice_url }); // ✨ أصلحنا: كان مكرر جوج مرات → ERR_HTTP_HEADERS_SENT
  } catch (error) {
    logger.logError('Crypto Checkout Error', error.response?.data || error);
    res.status(500).json({ error: error.response?.data?.message || error.message });
  }
});

// ترتيب الكائنات المساعدة لمطابقة توقيع NowPayments بدقة
function sortObject(obj) {
  return Object.keys(obj).sort().reduce((result, key) => {
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      result[key] = sortObject(obj[key]);
    } else {
      result[key] = obj[key];
    }
    return result;
  }, {});
}

router.post('/crypto/callback', async (req, res) => {
  try {
    const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
    const receivedSig = req.headers['x-nowpayments-sig'];

    if (!ipnSecret || !receivedSig) return res.status(400).send('Missing signature');

    const sortedParams = sortObject(req.body);
    const hmac = crypto.createHmac('sha512', ipnSecret);
    hmac.update(JSON.stringify(sortedParams));
    const expectedSig = hmac.digest('hex');

    if (expectedSig !== receivedSig) return res.status(400).send('Invalid signature');

    const paymentData = req.body;
    if (paymentData.payment_status === 'finished' || paymentData.payment_status === 'confirmed') {
      const orderId = paymentData.order_id; 

      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (orderRes.rows.length === 0) return res.status(404).send('Order not found');

      const updateRes = await pool.query(
        "UPDATE orders SET status='paid', customer_email=COALESCE($1, customer_email) WHERE id=$2 AND status='pending' RETURNING *",
        [paymentData.customer_email || null, orderId]
      );

      if (updateRes.rows.length > 0) {
        const updatedOrder = updateRes.rows[0];
        res.status(200).send('OK');

        (async () => {
          try {
            const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [orderId]);
            const items = itemsRes.rows;

            const customerDetails = {
              address: { line1: updatedOrder.shipping_address || 'N/A', city: updatedOrder.customer_city || 'N/A', country: 'US', state: 'N/A', postal_code: '00000' },
              phone: updatedOrder.customer_phone || '0000000000'
            };

            const cjResponse = await fulfillCJOrder(orderId, updatedOrder.customer_name, customerDetails, items);

            if (cjResponse && cjResponse.success) {
              await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
            }

            const finalEmail = paymentData.customer_email || updatedOrder.customer_email;
            if (finalEmail && !finalEmail.includes('@laclarc.com') && !finalEmail.includes('@neo.com')) {
              await sendOrderConfirmationEmail(finalEmail, orderId, updatedOrder.total_amount, items);
            }
          } catch (bgErr) {
            logger.logError('Crypto Fulfillment (Background)', bgErr);
          }
        })();
        return;
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    logger.logError('NowPayments IPN Error', error);
    res.status(500).send('Error');
  }
});

// ==========================================
// 4. BaridiMob / CCP (Manual Upload - Algeria)
// ==========================================
router.post('/manual', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'يرجى رفع صورة الإيصال' });

    const { totalAmount, items, customerName, customerPhone, customerAddress, customerEmail } = req.body;
    const couponCode = req.body.couponCode || null; // ✨ زدنا: جاي من الـ FormData
    const receiptUrl = req.file.path;
    const fullShippingAddress = customerAddress || JSON.stringify({ line1: 'N/A', city: 'Algeria', state: 'N/A', postal_code: '00000', country: 'DZ' });
    
    const optionalUser = getOptionalUser(req); 

    let parsedItems = [];
    try {
      parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid items format' });
    }

    const { secureItems, serverTotal } = await prepareSecureItems(pool, parsedItems);

    // ✨ الإصلاح الأمني الأهم (Tenet #1):
    // المبلغ الرسمي كيتحسب هوني من السيرفر (سعر الصرف + الكوبون) — ماكانتوكلش أبداً على totalAmount ديال الـ client
    const { total: chargeTotal, applied: couponApplied, discount: couponDiscount } =
      await applyCouponToTotal(pool, couponCode, serverTotal);
    const authoritativeDZD = Math.round(chargeTotal * USD_TO_DZD);
    const declaredDZD = Number(totalAmount) || 0;

    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, customer_email, shipping_address, total_amount, status, payment_method, payment_status, receipt_url, user_id) 
       VALUES ($1, $2, $3, $4, $5, 'pending', 'BaridiMob', 'Pending Review', $6, $7) RETURNING id`,
      [customerName, customerPhone, customerEmail || 'manual@laclarc.com', fullShippingAddress, authoritativeDZD, receiptUrl, optionalUser ? optionalUser.id : null]
      //                                                                ✨ ^^^^^^^^^^^^^^^^ المبلغ الرسمي ديال السيرفر (DZD)
    );

    const orderId = orderResult.rows[0].id;

    for (const item of secureItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, item.price, item.vid]
      );
    }

    if (customerEmail && !customerEmail.includes('@laclarc.com')) {
      const itemsForEmail = secureItems.map(it => ({ title: it.title, image_url: it.image_url, quantity: it.quantity, price_at_purchase: it.price }));
      await sendOrderConfirmationEmail(customerEmail, orderId, chargeTotal, itemsForEmail);
      //                                                    ✨ ^^^^^^^^^^^ بعد الكوبون
    }

    // إشعار فوري للأدمن — بالمبلغين بجوج (Expected من السيرفر + Declared من العميل) للـ Verification Dossier
    await sendEmail({
      to: process.env.BREVO_USER, 
      subject: `🚨 New BaridiMob Order #${orderId} - Action Required`,
      html: `<h2>New Manual Payment Received</h2>
             <p>A new order has been placed via BaridiMob and requires verification.</p>
             <p><strong>Customer:</strong> ${customerName}</p>
             <p><strong>Phone:</strong> ${customerPhone}</p>
             <p><strong>Expected (Server):</strong> ${authoritativeDZD} DZD ${couponApplied ? `(Coupon −$${couponDiscount.toFixed(2)})` : ''}</p>
             <p><strong>Declared (Client):</strong> ${declaredDZD} DZD</p>
             <p><strong>DB Calculated (USD):</strong> $${chargeTotal}</p>
             ${declaredDZD !== authoritativeDZD ? '<p style="color:#FF6B9D;font-weight:bold;">⚠️ Declared ≠ Expected — review receipt carefully before approval!</p>' : ''}
             <p><a href="${receiptUrl}" target="_blank" style="background-color: #FF6B9D; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Receipt Image</a></p>
             <p>Please log in to your admin panel to approve or reject this order.</p>`
    });

    res.json({ success: true, message: 'تم استلام طلبك وجاري مراجعته', orderId: orderId });
  } catch (error) {
    logger.logError('Manual Order Error', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ⚡ مسار التحقق المالي اللحظي للكريبتو (JIT NowPayments Verifier)
// يستجوب خوادم NowPayments مباشرة لمعرفة حالة تأكيد البلوكتشين فوراً
// ==========================================
router.post('/crypto/verify', async (req, res) => {
  const { order_id } = req.body;

  if (!order_id) {
    return res.status(400).json({ success: false, error: 'Order ID is required' });
  }

  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const order = orderRes.rows[0];

    // إذا كان الطلب قد تمت معالجته بالفعل مسبقاً
    if (order.status === 'paid' || order.status === 'completed' || order.status === 'fulfilled') {
      return res.json({
        success: true,
        verified: true,
        orderId: order.id,
        amount: order.total_amount,
        status: order.status
      });
    }

    // 1. استجواب NowPayments مباشرة عبر الـ API بالـ order_id
    const npRes = await axios.get(`https://api.nowpayments.io/v1/payment/?order_id=${order_id}&limit=1`, {
      headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
    });

    const paymentData = npRes.data?.data?.[0];

    // 2. فحص حالة الدفع في البلوكتشين
    const isPaid = paymentData && (
      paymentData.payment_status === 'finished' || 
      paymentData.payment_status === 'confirmed' || 
      paymentData.payment_status === 'sending'
    );

    if (isPaid) {
      // 3. قفل ذري فوري للطلب
      const updateRes = await pool.query(
        "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING id",
        [order_id]
      );

      // 4. إرسال الطلب لـ CJ Dropshipping في نفس اللحظة
      if (updateRes.rows.length > 0) {
        console.log(`⚡ [Crypto JIT] Order #${order_id} verified via Blockchain! Fulfilling to CJ...`);

        (async () => {
          try {
            const itemsRes = await pool.query(`
              SELECT oi.*, p.title, p.image_url 
              FROM order_items oi 
              LEFT JOIN products p ON oi.product_id = p.id 
              WHERE oi.order_id = $1
            `, [order_id]);

            const customerDetails = {
              address: { line1: order.shipping_address || 'Online Purchase', country: 'US' },
              phone: order.customer_phone || '1234567890'
            };

            const cjResponse = await fulfillCJOrder(order.id, order.customer_name, customerDetails, itemsRes.rows);
            if (cjResponse && cjResponse.success) {
              await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [order.id]);
            }

            if (order.customer_email && !order.customer_email.includes('@laclarc.com')) {
              await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, itemsRes.rows);
            }
          } catch (bgErr) {
            logger.logError('Crypto JIT Fulfillment Error', bgErr);
          }
        })();
      }

      return res.json({
        success: true,
        verified: true,
        orderId: order.id,
        amount: order.total_amount,
        status: 'paid'
      });
    } else {
      // الدفع ما زال قيد انتظار تأكيدات الشبكة (Confirming)
      return res.json({
        success: true,
        verified: false,
        orderId: order.id,
        amount: order.total_amount,
        status: paymentData?.payment_status || 'waiting',
        message: 'Transaction detected on blockchain, awaiting network confirmations.'
      });
    }

  } catch (error) {
    logger.logError('Crypto JIT Error', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Failed to verify crypto payment' });
  }
});
// ==========================================
// 💳 مسار جلب بوابات الدفع المفعلة للمتجر
// ==========================================
router.get('/gateways', async (req, res) => {
  try {
    // جلب البوابات المفعلة من جدول الإعدادات، أو إرجاع الكل كإعداد افتراضي
    const { rows } = await pool.query("SELECT value FROM store_settings WHERE key = 'enabled_gateways'");
    if (rows.length > 0 && rows[0].value) {
      try {
        const enabled = JSON.parse(rows[0].value);
        if (Array.isArray(enabled)) return res.json({ enabled });
      } catch (e) {}
    }
    // الوضع الافتراضي: كل البوابات مفعلة
    res.json({ enabled: ['stripe', 'paysera', 'crypto', 'baridimob'] });
  } catch (err) {
    res.json({ enabled: ['stripe', 'paysera', 'crypto', 'baridimob'] });
  }
});

module.exports = router;