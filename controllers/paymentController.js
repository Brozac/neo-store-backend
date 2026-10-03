// controllers/paymentController.js - Laclarc Enterprise Payment Controller (hardened)
// 🩹 Audit 2026-10-02 applied:
//   • REMOVED /api/payment/stripe (dead — all 4 frontend callers use /api/create-checkout-session)
//   • REMOVED /api/payment/gateways (dead — PaymentModal uses paymentGateways router)
//   • NOWPAYMENTS 503-gate (crypto route fails loud & clean when key missing)
//   • Paysera callback: amount verification + timingSafeEqual
//   • Crypto callback: address-guard (paid without shipping address → manual, never ships to N/A)
//   • checkoutLimiter on all payment entry routes
//   • coupon cache DB-backed (FIX#12 — matches server.js)
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db'); // ✨ الـ Pool الموحد حصراً
const { fulfillCJOrder, auditEvent } = require('../services/cjService'); // 🩹 + auditEvent
const { prepareSecureItems } = require('../utils/secureCheckout');
const { applyCouponToTotal } = require('../utils/couponHelper'); // ✨ Helper الكوبون الموحد
const logger = require('../logger');
// 🆕 FILE 4: خدمة الـ Conversions API — تخزين سياق المتصفح (IP/UA) للـ Dedup matching
const { setConversionContext } = require('../services/conversionService');

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

// 🩹 FIX — checkoutLimiter على كل مسارات الدفع (كانت الخمسة مفتوحة بلا حدود)
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  message: { error: 'Too many checkout attempts, please try again in a few minutes.' }
});

// ✨ دالة مساعدة لاستخراج وتنقية بيانات تتبع الإعلانات بأمان
function extractUtm(body) {
  let utm = body.utm || {};
  if (typeof utm === 'string') {
    try { utm = JSON.parse(utm); } catch (e) { utm = {}; }
  }
  return {
    source: utm.utm_source ? String(utm.utm_source).slice(0, 100) : 'organic',
    medium: utm.utm_medium ? String(utm.utm_medium).slice(0, 100) : 'direct',
    campaign: utm.utm_campaign ? String(utm.utm_campaign).slice(0, 150) : null,
    clickId: utm.click_id ? String(utm.click_id).slice(0, 255) : null
  };
}

// ✨ كاش Stripe Coupons — 🩹 FIX#12: DB-backed (تطابق server.js — الكوبونات لا تتيم عند كل deploy)
const stripeCouponCache = new Map();
async function getOrCreateStripeCoupon(couponData) {
  const key = JSON.stringify(couponData);
  if (stripeCouponCache.has(key)) return stripeCouponCache.get(key);
  try {
    const persisted = await pool.query('SELECT value FROM store_settings WHERE key = $1', ['stripe_coupon_' + key]);
    if (persisted.rows[0]?.value) {
      stripeCouponCache.set(key, persisted.rows[0].value);
      return persisted.rows[0].value;
    }
  } catch (e) { console.warn('⚠️ [CouponCache] read failed: ' + e.message); }
  const sc = await stripe.coupons.create(couponData);
  stripeCouponCache.set(key, sc.id);
  if (stripeCouponCache.size > 200) {
    stripeCouponCache.delete(stripeCouponCache.keys().next().value);
  }
  await pool.query(
    "INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
    ['stripe_coupon_' + key, sc.id]
  ).catch((e) => console.warn('⚠️ [CouponCache] persist failed: ' + e.message));
  return sc.id;
}

// ✨ سعر الصرف الرسمي (Configurable من Render Env بدون Redeploy)
const USD_TO_DZD = Number(process.env.USD_TO_DZD_RATE) || 255;

const ALL_WORLD_COUNTRIES = ['AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ'];

// 🩹 FIX#8 — email normalization (مشترك بين كل مسارات الدفع)
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

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
// 2. Paysera Checkout & Callback
// ==========================================
router.post('/paysera', checkoutLimiter, async (req, res) => {   // 🩹 FIX — limiter
  try {
    const { items: clientItems, couponCode } = req.body;
    const utm = extractUtm(req.body);
    const optionalUser = getOptionalUser(req);

    const { secureItems, serverTotal } = await prepareSecureItems(pool, clientItems);
    const { total: chargeTotal } = await applyCouponToTotal(pool, couponCode, serverTotal);

    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id, utm_source, utm_medium, utm_campaign, click_id)
       VALUES ($1, $2, $3, $4, $5, 'Paysera', $6, $7, $8, $9, $10) RETURNING id`,
      ['Pending Paysera', 'pending@laclarc.com', 'Pending', chargeTotal, 'pending', optionalUser ? optionalUser.id : null, utm.source, utm.medium, utm.campaign, utm.clickId]
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
      orderid: String(orderId),                                    // 🩹 FIX — Paysera يريد string
      amount: Math.round(chargeTotal * 100),
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
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

router.get('/paysera/callback', async (req, res) => {
  try {
    const { data, ss1 } = req.query;
    if (!data || !ss1) return res.status(400).send('Bad parameters');

    const expectedSign = crypto.createHash('md5')
      .update(data + process.env.PAYSERA_PASSWORD)
      .digest('hex');

    // 🩹 — timing-safe comparison (كان !== — نظرياً timing attack)
    const a = Buffer.from(expectedSign), b = Buffer.from(String(ss1));
    const signOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!signOk) return res.status(400).send('Bad signature');

    const decodedStr = Buffer.from(data, 'base64').toString('utf8');
    const params = new URLSearchParams(decodedStr);
    const orderId = params.get('orderid');
    const status = params.get('status');

    // 🩹 — جلب الطلب أولاً (لازم لتحقق المبلغ)
    const orderRowRes = await pool.query('SELECT total_amount FROM orders WHERE id = $1', [orderId]);
    const orderRow = orderRowRes.rows[0];
    if (!orderRow) { res.send('OK'); return; }

    if (status === '1') {
      // 🩹 FIX — تحقق المبلغ: التوقيع يضمن أن Paysera أرسل — لا أن المبلغ يطابق الطلب!
      //    (حوافز/تحويلات/اختلاف — بدون هذا الفحص أقل من المطلوب يعليم paid)
      const paidCents = parseInt(params.get('amount'), 10) || 0;
      const expectedCents = Math.round(Number(orderRow.total_amount) * 100);

      if (paidCents + 50 < expectedCents) {   // تسامح 50 cents
        await pool.query(
          "UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1 AND status = 'pending'",
          [orderId]
        );
        await auditEvent('PAYSERA_AMOUNT_MISMATCH', orderId, { paidCents, expectedCents }, 'critical');
        logger.logError('Paysera Callback: amount mismatch', new Error(`paid=${paidCents} expected=${expectedCents}`));
        res.send('OK');
        return;
      }

      const updateRes = await pool.query(
        "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING *",
        [orderId]
      );

      if (updateRes.rows.length > 0) {
        const order = updateRes.rows[0];
        res.send('OK');

        (async () => {
          try {
            const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [orderId]);
            const items = itemsRes.rows;

            const cjResponse = await fulfillCJOrder(orderId, order.customer_name, {
              address: { line1: order.shipping_address || 'Online Store Purchase', country: 'US' }
            }, items);

            if (cjResponse && cjResponse.success) {
              // 🧹 FIX: الوسم كان [Crypto] بالغلط — اللوجات هي الحقيقة المطلقة
              console.log(`📤 [Paysera] #${orderId} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
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
router.post('/crypto', checkoutLimiter, async (req, res) => {   // 🩹 FIX — limiter
  // 🩹 FIX — 503 gate: المفتاح غائب = رفض نظيف فوري (ماشي 500 مع تسريب بعد اختيار الزبون للدفع)
  if (!process.env.NOWPAYMENTS_API_KEY) {
    return res.status(503).json({ error: 'Crypto payments are temporarily unavailable.' });
  }

  try {
    const { items: clientItems, couponCode } = req.body;
    const utm = extractUtm(req.body);
    const optionalUser = getOptionalUser(req);

    const { secureItems, serverTotal } = await prepareSecureItems(pool, clientItems);
    const { total: chargeTotal } = await applyCouponToTotal(pool, couponCode, serverTotal);

    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id, utm_source, utm_medium, utm_campaign, click_id)
       VALUES ($1, $2, $3, $4, $5, 'Crypto', $6, $7, $8, $9, $10) RETURNING id`,
      ['Pending Crypto', 'pending@laclarc.com', 'Pending', chargeTotal, 'pending', optionalUser ? optionalUser.id : null, utm.source, utm.medium, utm.campaign, utm.clickId]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of secureItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, item.price, item.vid]
      );
    }

    const response = await axios.post('https://api.nowpayments.io/v1/invoice', {
      price_amount: chargeTotal,
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

    if (response.data.id) {
      await pool.query("UPDATE orders SET receipt_url = $1 WHERE id = $2", [response.data.id.toString(), orderId]);
    }

    res.json({ url: response.data.invoice_url });
  } catch (error) {
    // 🩹 FIX — قنّع الخطأ (كان error.response?.data?.message يسرّب تفاصيل NowPayments للعميل)
    logger.logError('Crypto Checkout Error', error.response?.data || error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

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

    // 🩹 — timing-safe comparison (كان !== — نظرياً timing attack)
    const a = Buffer.from(expectedSig), b = Buffer.from(String(receivedSig));
    const sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!sigOk) return res.status(400).send('Invalid signature');

    const paymentData = req.body;
    if (paymentData.payment_status === 'finished' || paymentData.payment_status === 'confirmed') {
      const orderId = paymentData.order_id;

      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (orderRes.rows.length === 0) return res.status(404).send('Order not found');

      const updateRes = await pool.query(
        "UPDATE orders SET status='paid', customer_email=COALESCE($1, customer_email), payment_ref=COALESCE($3, payment_ref) WHERE id=$2 AND status='pending' RETURNING *",
        [paymentData.customer_email || null, orderId, paymentData.payment_id || null]
      );

      if (updateRes.rows.length > 0) {
        const updatedOrder = updateRes.rows[0];
        res.status(200).send('OK');

        // 🩹 FIX — حارس العنوان (أهم إصلاح في هذا الملف):
        //    NowPayments invoice لا يجمع عنوان شحن — أول زبون crypto حقيقي كان:
        //    يدفع USDT حقيقي → paid → fulfillment لعنوان 'N/A' → بضاعة ضائعة.
        //    الآن: المال يُستقبل ✓ الزبون يُبلَّغ ✓ أنت تُنبَّه فوراً ✓ ولا شحن لعنوان وهمي ✓
        const rawAddr = String(updatedOrder.shipping_address || '').trim();
        const addrLooksFake = !rawAddr || rawAddr === 'Pending' || /N\/A/i.test(rawAddr);
        if (addrLooksFake) {
          await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1", [orderId]);
          await auditEvent('CRYPTO_NO_ADDRESS', orderId, { amount: updatedOrder.total_amount, paymentRef: updatedOrder.payment_ref }, 'critical');
          sendAdminAlert(`🚨 Crypto paid بلا عنوان شحن — #${orderId}`,
            `<p>عميل دفع <b>$${updatedOrder.total_amount}</b> عبر Crypto لكن <b>لا يوجد عنوان شحن</b> في الطلب.</p>
             <p><b>الإجراء:</b> تواصل مع الزبون لجمع العنوان، ثم fulfillment يدوي من retry-fulfillment.</p>
             <p>Email: ${updatedOrder.customer_email || '—'} · Payment ref: ${updatedOrder.payment_ref || '—'}</p>
             <p style="color:#FF6B9D;font-size:12px;">Backlog: خطوة جمع العنوان قبل فاتورة Crypto (شرط تفعيل Crypto الحقيقي).</p>`);
          return;
        }

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
              // 🐛 FIX #1 (سابق): كان #${order.id} — ReferenceError كان يقتل الإيميل بصمت
              console.log(`📤 [Crypto] #${updatedOrder.id} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
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
// ⚡ مسار التحقق المالي اللحظي للكريبتو (JIT NowPayments Verifier)
// ==========================================
router.post('/crypto/verify', checkoutLimiter, async (req, res) => {   // 🩹 FIX — limiter
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

    // 🆕 FILE 4-a + Mission #4: الزبون الحقيقي هو لي يزور /success
    setConversionContext(order.id, {
      clientIp: req.ip,
      userAgent: req.headers['user-agent'],
      fbp: typeof req.body?._fbp === 'string' ? req.body._fbp.slice(0, 200) : undefined,
      fbc: typeof req.body?._fbc === 'string' ? req.body._fbc.slice(0, 500) : undefined,
    });

    // 🆕 FILE 4-b: items مطلوبة فكل الردود (أساس event_id matching فالمتصفح)
    const itemsRes = await pool.query(`
      SELECT oi.*, p.title, p.image_url
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [order_id]);
    const items = itemsRes.rows;
    const pixelItems = items.map(i => ({ productId: i.product_id, quantity: i.quantity }));

    // 🐛 FIX #3: DECIMAL يرجع string من pg — بلا parseFloat البكسل يطلع $0.00
    const verifiedAmount = parseFloat(order.total_amount);

    // الفرع A: سبقنا الـ IPN webhook — الطلب مدفوع خلاص، رد كامل فوري
    if (order.status === 'paid' || order.status === 'completed' || order.status === 'fulfilled') {
      return res.json({
        success: true,
        verified: true,
        orderId: order.id,
        amount: verifiedAmount,
        currency: 'USD',
        status: order.status,
        items: pixelItems,
      });
    }

    // استجواب مباشر لـ NowPayments
    const npRes = await axios.get(`https://api.nowpayments.io/v1/payment/?order_id=${order_id}&limit=1`, {
      headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
    });

    const paymentData = npRes.data?.data?.[0];

    const isPaid = paymentData && (
      paymentData.payment_status === 'finished' ||
      paymentData.payment_status === 'confirmed' ||
      paymentData.payment_status === 'sending'
    );

    if (isPaid) {
      // قفل ذري: pending → paid — واحد برك يربح (JIT ولا IPN)
      const updateRes = await pool.query(
        "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING id",
        [order_id]
      );

      if (updateRes.rows.length > 0) {
        console.log(`⚡ [Crypto JIT] Order #${order.id} verified via Blockchain! Fulfilling to CJ...`);

        (async () => {
          try {
            // 🩹 FIX — نفس حارس العنوان (JIT يسبق IPN أحياناً — نفس الفجوة نفس الحل)
            const rawAddr = String(order.shipping_address || '').trim();
            const addrLooksFake = !rawAddr || rawAddr === 'Pending' || /N\/A/i.test(rawAddr);
            if (addrLooksFake) {
              await pool.query("UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1", [order.id]);
              await auditEvent('CRYPTO_NO_ADDRESS', order.id, { amount: verifiedAmount, via: 'jit' }, 'critical');
              sendAdminAlert(`🚨 Crypto paid بلا عنوان (JIT) — #${order.id}`,
                `<p>عميل دفع <b>$${verifiedAmount}</b> لكن لا عنوان شحن — تواصل معه ثم fulfillment يدوي.</p>
                 <p>Email: ${order.customer_email || '—'}</p>`);
              return;
            }

            const customerDetails = {
              address: { line1: order.shipping_address || 'Online Purchase', country: 'US' },
              phone: order.customer_phone || '1234567890'
            };

            const cjResponse = await fulfillCJOrder(order.id, order.customer_name, customerDetails, items);
            if (cjResponse && cjResponse.success) {
              // 🐛 FIX #2 (سابق): كان #${orderId} — ReferenceError كان يقتل الإيميل
              console.log(`📤 [Crypto] #${order.id} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
            }

            if (order.customer_email && !order.customer_email.includes('@laclarc.com')) {
              await sendOrderConfirmationEmail(order.customer_email, order.id, verifiedAmount, items);
            }
          } catch (bgErr) {
            logger.logError('Crypto JIT Fulfillment Error', bgErr);
          }
        })();
      } else {
        console.log(`ℹ️ [Crypto JIT] Order #${order.id} was already locked/processed by IPN webhook.`);
      }

      // 🆕 FILE 4-c: رد كامل فالفرعين (winner + loser) — الزبون يستحق البكسل فالحالتين
      return res.json({
        success: true,
        verified: true,
        orderId: order.id,
        amount: verifiedAmount,
        currency: 'USD',
        status: 'paid',
        items: pixelItems,
      });
    }

    // مازال ما تأكدش على البلوكتشين
    return res.status(400).json({
      success: false,
      status: 'unpaid',
      message: 'Payment has not been confirmed on the blockchain yet.'
    });

  } catch (error) {
    logger.logError('Crypto JIT Verification Error', error);
    res.status(500).json({ success: false, error: 'Failed to verify crypto payment' });
  }
});

// ==========================================
// 4. BaridiMob / CCP (Manual Upload - Algeria)
// ملاحظة معلّمة: حالياً معطّل من payment_gateways (قرار تشغيلي) —
// المسار كامل وجاهز، والإيميل هنا مؤقتاً "Confirmed" — يُصحح لـ "قيد المراجعة"
// عند تفعيل BaridiMob (Backlog — يُربط بمصير تفعيل البوابة)
// ==========================================
router.post('/manual', checkoutLimiter, upload.single('receipt'), async (req, res) => {   // 🩹 FIX — limiter
  try {
    if (!req.file) return res.status(400).json({ error: 'يرجى رفع صورة الإيصال' });

    const { totalAmount, items, customerName, customerPhone, customerAddress, customerEmail } = req.body;
    const couponCode = req.body.couponCode || null;
    const utm = extractUtm(req.body);
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

    const { total: chargeTotal, applied: couponApplied, discount: couponDiscount } =
      await applyCouponToTotal(pool, couponCode, serverTotal);
    const authoritativeDZD = Math.round(chargeTotal * USD_TO_DZD);
    const declaredDZD = Number(totalAmount) || 0;

    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, customer_email, shipping_address, total_amount, status, payment_method, payment_status, receipt_url, user_id, utm_source, utm_medium, utm_campaign, click_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', 'BaridiMob', 'Pending Review', $6, $7, $8, $9, $10, $11) RETURNING id`,
      [customerName, customerPhone, normalizeEmail(customerEmail) || 'manual@laclarc.com', fullShippingAddress, authoritativeDZD, receiptUrl, optionalUser ? optionalUser.id : null, utm.source, utm.medium, utm.campaign, utm.clickId]
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
    }

    await sendEmail({
      to: process.env.BREVO_USER,
      subject: `🚨 New BaridiMob Order #${orderId} - Action Required`,
      html: `<h2>New Manual Payment Received</h2>
             <p>A new order has been placed via BaridiMob and requires verification.</p>
             <p><strong>Customer:</strong> ${customerName}</p>
             <p><strong>Phone:</strong> ${customerPhone}</p>
             <p><strong>Source / Campaign:</strong> ${utm.source} / ${utm.campaign || 'direct'}</p>
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
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// ==========================================
// 💳 ⬇️ REMOVED — /api/payment/gateways (ميت بالبرهان):
//    PaymentModal يستعمل /api/payment/gateways تاع paymentGateways router
//    (الجدولي — fail-closed) — هذه النسخة كانت تقرأ store_settings القديم
// ==========================================

module.exports = router;