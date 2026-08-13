const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const jwt = require('jsonwebtoken'); // ✨ لاستخراج user_id
const { Pool } = require('pg');
const { fulfillCJOrder } = require('../services/cjService');
const logger = require('../logger'); // ✨ لتسجيل الأخطاء

// إعداد قاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // ✨ مهم لـ Render
});

// إعداد Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `receipt-${Date.now()}.png`)
});
const upload = multer({ storage });

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const PAYSERA_PROJECT_ID = process.env.PAYSERA_PROJECT_ID;
const PAYSERA_PASSWORD = process.env.PAYSERA_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

// ==========================================
// ✨ دوال الإيميل (Brevo + Resend Fallback)
// ==========================================
async function sendEmail({ to, subject, html }) {
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'NEO Store Support', email: process.env.BREVO_USER },
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
      from: process.env.RESEND_FROM_EMAIL || 'NEO Store <onboarding@resend.dev>',
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
          <img src="${item.image_url || item.image || 'https://via.placeholder.com/50'}" alt="${item.title || item.name}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 8px; margin-right: 15px;">
          <span style="color: #1D1E3C; font-weight: bold; font-size: 14px;">${item.title || item.name} (Qty: ${item.quantity})</span>
        </td>
        <td style="padding: 15px 0; border-bottom: 1px solid #eee; text-align: right; color: #FF6B9D; font-weight: bold; font-size: 14px;">
          $${Number(item.price_at_purchase || item.price).toFixed(2)}
        </td>
      </tr>
    `).join('');

    const htmlContent = `
      <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: 0 auto; background-color: #f4f3f8; border-radius: 15px; overflow: hidden; border: 1px solid #ddd;">
        <div style="background: linear-gradient(135deg, #1D1E3C 0%, #8B78C6 100%); padding: 30px; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 28px; letter-spacing: 1px;">NEO STORE</h1>
        </div>
        <div style="padding: 30px;">
          <h2 style="color: #1D1E3C; margin-top: 0;">Order Confirmed Successfully! 🎉</h2>
          <p style="color: #555; font-size: 16px; line-height: 1.6;">
            Thank you for your purchase from NEO Store. Your order <strong style="color: #8B78C6;">#${orderId}</strong> is currently being processed and will be shipped soon.
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
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="background-color: #FF6B9D; color: #fff; text-decoration: none; padding: 12px 30px; border-radius: 25px; font-weight: bold; display: inline-block;">
              Continue Shopping
            </a>
          </div>
        </div>
        <div style="background-color: #1D1E3C; padding: 20px; text-align: center; color: #888; font-size: 12px;">
          &copy; ${new Date().getFullYear()} NEO Store. All rights reserved.<br>
          This is an automated message, please do not reply.
        </div>
      </div>
    `;

    await sendEmail({ to: email, subject: `Order Confirmation #${orderId} - NEO Store`, html: htmlContent });
    console.log(`📧 Professional confirmation email sent to ${email}`);
  } catch (err) {
    logger.logError('Send Order Email', err);
  }
}

// ✨ استخراج user_id إذا كان الزبون مسجل الدخول
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
    const { items, totalAmount } = req.body;
    const optionalUser = getOptionalUser(req); // ✨

    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      ['Pending Customer', 'pending@neo.com', 'Pending', totalAmount, 'pending', 'Stripe', optionalUser ? optionalUser.id : null]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]
      );
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: items.map(item => ({
        price_data: {
          currency: 'usd',
          product_data: { name: item.name },
          unit_amount: Math.round(Number(item.price) * 100),
        },
        quantity: item.quantity,
      })),
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success?method=stripe`,
      cancel_url: `${process.env.FRONTEND_URL}/cart`,
      metadata: { orderId: orderId.toString() },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. Paysera Checkout
// ==========================================
router.post('/paysera', async (req, res) => {
  try {
    const { items, totalAmount } = req.body;
    const optionalUser = getOptionalUser(req); // ✨

    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      ['Pending Paysera', 'pending@neo.com', 'Pending', totalAmount, 'pending', 'Paysera', optionalUser ? optionalUser.id : null]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]
      );
    }

    const data = {
      projectid: process.env.PAYSERA_PROJECT_ID,
      orderid: orderId,
      amount: Math.round(totalAmount * 100),
      currency: 'USD',
      accepturl: `${process.env.FRONTEND_URL}/success?method=paysera`,
      cancelurl: `${process.env.FRONTEND_URL}/cart`,
      callbackurl: `${process.env.BACKEND_URL}/api/payment/paysera/callback`,
      test: 1, 
    };

    const encodedData = Buffer.from(
      Object.entries(data).map(([k, v]) => `${k}=${v}`).join('&')
    ).toString('base64');

    const sign = crypto.createHash('md5')
      .update(encodedData + process.env.PAYSERA_PASSWORD)
      .digest('hex');

    const payseraUrl = `https://www.paysera.com/pay/?data=${encodedData}&sign=${sign}`;
    res.json({ url: payseraUrl });

  } catch (error) {
    console.error('Paysera Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✨ Webhook الخاص بـ Paysera
router.get('/paysera/callback', async (req, res) => {
  try {
    const { data, ss1 } = req.query;
    const expectedSign = crypto.createHash('md5')
      .update(data + process.env.PAYSERA_PASSWORD)
      .digest('hex');

    if (expectedSign !== ss1) return res.status(400).send('Bad signature');

    const decodedStr = Buffer.from(data, 'base64').toString('utf8');
    const params = new URLSearchParams(decodedStr);
    const orderId = params.get('orderid');
    const status = params.get('status');

    if (status === '1') {
      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (orderRes.rows.length > 0 && orderRes.rows[0].status === 'pending') {
        
        await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
        const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [orderId]);
        const items = itemsRes.rows;

        await fulfillCJOrder(orderId, orderRes.rows[0].customer_name, {
          address: { line1: orderRes.rows[0].shipping_address, country: 'US' }
        }, items);

        // ✨ إرسال الإيميل الاحترافي
        if (orderRes.rows[0].customer_email) {
          await sendOrderConfirmationEmail(orderRes.rows[0].customer_email, orderId, orderRes.rows[0].total_amount, items);
        }
      }
    }
    res.send('OK');
  } catch (error) {
    console.error('Paysera Callback Error:', error);
    res.status(500).send('Error');
  }
});

// ==========================================
// 3. Crypto (NowPayments) - ✨ تم إصلاح الخلل هنا
// ==========================================
router.post('/crypto', async (req, res) => {
  try {
    const { items, totalAmount } = req.body;
    const optionalUser = getOptionalUser(req); // ✨

    // 1. حفظ الطلب في قاعدة البيانات أولاً (كان غير موجود وماكانش يربط الطلب)
    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      ['Pending Crypto', 'pending@neo.com', 'Pending', totalAmount, 'pending', 'Crypto', optionalUser ? optionalUser.id : null]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]
      );
    }

    const apiUrl = 'https://api.nowpayments.io/v1/invoice'; 
    const response = await axios.post(apiUrl, {
      price_amount: totalAmount,
      price_currency: 'usd',
      order_id: orderId.toString(), // ✨ ربط الطلب
      order_description: 'NEO Store Purchase',
      ipn_callback_url: `${process.env.BACKEND_URL}/api/payment/crypto/callback`,
      success_url: `${process.env.FRONTEND_URL}/success?method=crypto`,
      cancel_url: `${process.env.FRONTEND_URL}/cart`,
    }, {
      headers: { 
        'x-api-key': process.env.NOWPAYMENTS_API_KEY, 
        'Content-Type': 'application/json' 
      }
    });
    
    res.json({ url: response.data.invoice_url });
    
  } catch (error) {
    console.error('Crypto Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.message || error.message });
  }
});

// ==========================================
// 4. BaridiMob / CCP (Manual Upload)
// ==========================================
router.post('/manual', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'يرجى رفع صورة الإيصال' });

    const { totalAmount, items, customerName, customerPhone, customerAddress, customerEmail } = req.body;
    const receiptUrl = `${process.env.BACKEND_URL}/uploads/${req.file.filename}`;
    const fullShippingAddress = customerAddress || JSON.stringify({ line1: 'N/A', city: 'N/A', state: 'N/A', postal_code: '00000', country: 'DZ' });
    
    const optionalUser = getOptionalUser(req); // ✨

    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, customer_email, shipping_address, total_amount, status, payment_method, payment_status, receipt_url, user_id) 
       VALUES ($1, $2, $3, $4, $5, 'pending', 'BaridiMob', 'Pending Review', $6, $7) RETURNING id`,
      [customerName, customerPhone, customerEmail || 'manual@neo.com', fullShippingAddress, totalAmount, receiptUrl, optionalUser ? optionalUser.id : null]
    );

    const orderId = orderResult.rows[0].id;

    const parsedItems = JSON.parse(items);
    for (const item of parsedItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]
      );
    }

    // ✨ إرسال إيميل للعميل بتأكيد استلام الطلب (احترافي)
    if (customerEmail && customerEmail !== 'manual@neo.com') {
      const itemsForEmail = parsedItems.map(it => ({ title: it.name, image_url: it.image_url, quantity: it.quantity, price_at_purchase: it.price }));
      await sendOrderConfirmationEmail(customerEmail, orderId, totalAmount, itemsForEmail);
    }

    // ✨ إرسال إيميل للأدمن لمراجعة الإيصال
    await sendEmail({
      to: process.env.BREVO_USER, // يرسل للأدمن
      subject: `🚨 New BaridiMob Order #${orderId} - Action Required`,
      html: `<h2>New Manual Payment Received</h2>
             <p>A new order has been placed and requires your verification.</p>
             <p><strong>Customer:</strong> ${customerName}</p>
             <p><strong>Phone:</strong> ${customerPhone}</p>
             <p><strong>Total:</strong> ${totalAmount} DZD</p>
             <p><a href="${receiptUrl}" target="_blank" style="background-color: #FF6B9D; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Receipt Image</a></p>
             <p>Please log in to your admin panel to approve or reject this order.</p>`
    });

    res.json({ success: true, message: 'تم استلام طلبك وجاري مراجعته', orderId: orderId });
  } catch (error) {
    console.error('Manual Order Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// دالة مساعدة لـ NowPayments
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

// ✨ Webhook الخاص بـ Crypto
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
      
      const orderId = paymentData.order_id; // ✨ أصبح مباشراً لأننا رسلناه كـ String

      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (orderRes.rows.length === 0) return res.status(404).send('Order not found');

      const order = orderRes.rows[0];

      if (order.status === 'pending') {
        await pool.query(
          "UPDATE orders SET status='paid', customer_email=$1 WHERE id=$2",
          [paymentData.customer_email || order.customer_email, orderId]
        );

        const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [orderId]);
        const items = itemsRes.rows;

        const customerDetails = {
          address: { line1: order.shipping_address || 'N/A', city: order.customer_city || 'N/A', country: 'US', state: 'N/A', postal_code: '00000' },
          phone: order.customer_phone || '0000000000'
        };

        await fulfillCJOrder(orderId, order.customer_name, customerDetails, items);

        // ✨ إرسال الإيميل الاحترافي
        const finalEmail = paymentData.customer_email || order.customer_email;
        if (finalEmail) {
          await sendOrderConfirmationEmail(finalEmail, orderId, order.total_amount, items);
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('NowPayments IPN Error:', error);
    res.status(500).send('Error');
  }
});

module.exports = router;