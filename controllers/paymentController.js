const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const { Pool } = require('pg');
const nodemailer = require('nodemailer'); // ✅ تأكد من استيرادها
const { fulfillCJOrder } = require('../services/cjService');// ✅ أضف تعريف transporter هنا
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { 
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS 
  }
});

// إعداد قاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

// 1. Stripe Checkout
router.post('/stripe', async (req, res) => {
  try {
    const { items, totalAmount } = req.body;

    // 1. حفظ الطلب في قاعدة البيانات أولاً
    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      ['Pending Customer', 'pending@neo.com', 'Pending', totalAmount, 'pending', 'Stripe']
    );
    const orderId = orderResult.rows[0].id;

    // 2. حفظ منتجات الطلب في قاعدة البيانات
    for (const item of items) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]
      );
    }

    // 3. إنشاء جلسة Stripe
    // ملاحظة: نستخدم item.price المرسلة من الواجهة، و Stripe ستقوم بالتأكد من أن العميل دفع المبلغ الصحيح لهذه الأسعار.
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
      metadata: { orderId: orderId.toString() }, // ✅ ربط الطلب
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 2. Paysera Checkout
router.post('/paysera', async (req, res) => {
  try {
    const { items, totalAmount } = req.body;

    // 1. حفظ الطلب في قاعدة البيانات أولاً
    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, payment_method) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      ['Pending Paysera', 'pending@neo.com', 'Pending', totalAmount, 'pending', 'Paysera']
    );
    const orderId = orderResult.rows[0].id;

    // 2. حفظ منتجات الطلب
    for (const item of items) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]
      );
    }

    // 3. تجهيز بيانات Paysera
    const data = {
      projectid: process.env.PAYSERA_PROJECT_ID,
      orderid: orderId,
      amount: Math.round(totalAmount * 100), // بالسنتات
      currency: 'USD',
      accepturl: `${process.env.FRONTEND_URL}/success?method=paysera`,
      cancelurl: `${process.env.FRONTEND_URL}/cart`,
      callbackurl: `${process.env.BACKEND_URL}/api/payment/paysera/callback`,
      test: 1, // ✅ اجعلها 1 للتجربة (Sandbox)، و 0 للإنتاج الحقيقي
    };

    // 4. تشفير البيانات (Base16 + URL Encode) -> Base64
    const encodedData = Buffer.from(
      Object.entries(data).map(([k, v]) => `${k}=${v}`).join('&')
    ).toString('base64');

    // 5. إنشاء التوقيع (MD5)
    const sign = crypto.createHash('md5')
      .update(encodedData + process.env.PAYSERA_PASSWORD)
      .digest('hex');

    // 6. إرسال الرابط للواجهة
    const payseraUrl = `https://www.paysera.com/pay/?data=${encodedData}&sign=${sign}`;
    res.json({ url: payseraUrl });

  } catch (error) {
    console.error('Paysera Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✨ Webhook الخاص بـ Paysera (Callback)
router.get('/paysera/callback', async (req, res) => {
  try {
    const { data, ss1 } = req.query;

    // 1. التحقق من التوقيع
    const expectedSign = crypto.createHash('md5')
      .update(data + process.env.PAYSERA_PASSWORD)
      .digest('hex');

    if (expectedSign !== ss1) {
      console.error('❌ Paysera Callback: Invalid signature');
      return res.status(400).send('Bad signature');
    }

    // 2. فك تشفير البيانات
    const decodedStr = Buffer.from(data, 'base64').toString('utf8');
    const params = new URLSearchParams(decodedStr);
    const orderId = params.get('orderid');
    const status = params.get('status'); // 1 = نجح الدفع

    // 3. معالجة الطلب إذا كان الدفع ناجحاً
    if (status === '1') {
      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (orderRes.rows.length > 0 && orderRes.rows[0].status === 'pending') {
        
        await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
        const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
        const items = itemsRes.rows;

        await fulfillCJOrder(orderId, orderRes.rows[0].customer_name, {
          address: { line1: orderRes.rows[0].shipping_address, country: 'US' } // ضع الدولة الافتراضية
        }, items);

        console.log(`✅ Paysera Order #${orderId} paid and sent to CJ!`);
      }
    }

    // Paysera تتطلب رداً نصياً بـ "OK"
    res.send('OK');
    
  } catch (error) {
    console.error('Paysera Callback Error:', error);
    res.status(500).send('Error');
  }
});

// 3. Crypto (NowPayments)
router.post('/crypto', async (req, res) => {
  try {
    // نستخدم رابط التجربة (sandbox) إذا كنت تختبر
    const apiUrl = 'https://api.nowpayments.io/v1/invoice'; 
    // إذا كنت في وضع الإنتاج الحقيقي، استخدم: 'https://api.nowpayments.io/v1/invoice'

    const response = await axios.post(apiUrl, {
      price_amount: req.body.totalAmount,
      price_currency: 'usd',
      order_id: `order_${Date.now()}`,
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
    
    // NowPayments يرجع الرابط تحت اسم 'invoice_url'
    res.json({ url: response.data.invoice_url });
    
  } catch (error) {
    console.error('Crypto Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.message || error.message });
  }
});

// 4. BaridiMob / CCP (Manual Upload)
router.post('/manual', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'يرجى رفع صورة الإيصال' });

        const { totalAmount, items, customerName, customerPhone, customerAddress, customerEmail } = req.body;
    const receiptUrl = `${process.env.BACKEND_URL}/uploads/${req.file.filename}`;
    
    // العنوان يأتي كـ JSON string من الواجهة
    const fullShippingAddress = customerAddress || JSON.stringify({ line1: 'N/A', city: 'N/A', state: 'N/A', postal_code: '00000', country: 'DZ' });

    // 1. حفظ الطلب الأساسي
    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, customer_email, shipping_address, total_amount, status, payment_method, payment_status, receipt_url) 
       VALUES ($1, $2, $3, $4, $5, 'pending', 'BaridiMob', 'Pending Review', $6) RETURNING id`,
      [customerName, customerPhone, customerEmail || 'manual@neo.com', fullShippingAddress, totalAmount, receiptUrl]
    );

    const orderId = orderResult.rows[0].id;

    // 2. حفظ منتجات الطلب
    const parsedItems = JSON.parse(items);
    for (const item of parsedItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]
      );
    }

    // 3. ✨ إرسال إيميل للعميل بتأكيد استلام الطلب
    if (customerEmail && customerEmail !== 'manual@neo.com') {
      await transporter.sendMail({
        from: `"NEO Store" <${process.env.EMAIL_USER}>`,
        to: customerEmail,
        subject: `Order Received #${orderId} - Pending Verification`,
        html: `<h2>Thank you for your order, ${customerName}!</h2>
               <p>We have received your order and your payment receipt is under review.</p>
               <p>Once verified, your order will be processed and shipped immediately.</p>
               <p><strong>Order Total:</strong> ${totalAmount} DZD</p>`
      });
    }

    // 4. ✨ إرسال إيميل للأدمن لمراجعة الإيصال
    await transporter.sendMail({
      from: `"NEO Store System" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER, // يرسل الإيميل لنفس حساب المتجر (الأدمن)
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

// دالة مساعدة لترتيب مفاتيح الكائن (مطلوبة من NowPayments للتحقق من التوقيع)
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

// 5. NowPayments Webhook (IPN)
router.post('/crypto/callback', express.json(), async (req, res) => {
  try {
    const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
    const receivedSig = req.headers['x-nowpayments-sig'];

    if (!ipnSecret || !receivedSig) {
      console.error('❌ NowPayments IPN: Missing secret or signature');
      return res.status(400).send('Missing signature');
    }

    // 1. التحقق من التوقيع (HMAC SHA-512)
    const sortedParams = sortObject(req.body);
    const hmac = crypto.createHmac('sha512', ipnSecret);
    hmac.update(JSON.stringify(sortedParams));
    const expectedSig = hmac.digest('hex');

    if (expectedSig !== receivedSig) {
      console.error('❌ NowPayments IPN: Invalid signature');
      return res.status(400).send('Invalid signature');
    }

    console.log(`🔔 NowPayments IPN received for Order: ${req.body.order_id}`);

    // 2. التأكد من أن الدفع قد اكتمل بنجاح
    const paymentData = req.body;
    if (paymentData.payment_status === 'finished' || paymentData.payment_status === 'confirmed') {
      
      const orderId = paymentData.order_id.replace('order_', '');

      const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (orderRes.rows.length === 0) return res.status(404).send('Order not found');

      const order = orderRes.rows[0];

      // حماية من التكرار
      if (order.status === 'pending') {
        
        await pool.query(
          "UPDATE orders SET status='paid', customer_email=$1 WHERE id=$2",
          [paymentData.customer_email || order.customer_email, orderId]
        );

        const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
        const items = itemsRes.rows;

        const customerDetails = {
          address: {
            line1: order.shipping_address || 'N/A',
            city: order.customer_city || 'N/A',
            country: order.shipping_country || 'US',
            state: order.customer_city || 'N/A',
            postal_code: '00000'
          },
          phone: order.customer_phone || '0000000000'
        };

        // إرسال الطلب إلى CJ Dropshipping
        // تأكد من استيراد fulfillCJOrder في أعلى الملف
        await fulfillCJOrder(orderId, order.customer_name, customerDetails, items);

        await transporter.sendMail({
          from: `"NEO Store" <${process.env.EMAIL_USER}>`,
          to: order.customer_email,
          subject: `Order Confirmation #${orderId}`,
          text: `Thank you! Your crypto payment has been confirmed and your order is being processed.`
        });

        console.log(`✅ Crypto Order #${orderId} paid and sent to CJ!`);
      }
    }

    res.status(200).send('OK');
    
  } catch (error) {
    console.error('NowPayments IPN Error:', error);
    res.status(500).send('Error');
  }
});

module.exports = router;
