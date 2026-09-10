require('dotenv').config();

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { parseVariants, getCategorySlug, phoneAccRegex, pcBlacklistRegex } = require('./utils/parser');
const { prepareSecureItems } = require('./utils/secureCheckout');
const { applyCouponToTotal } = require('./utils/couponHelper'); // ✨ التعديل 1: Helper الكوبون الموحد

const requireAdmin = require('./middleware/requireAdmin');
const rateLimit = require('express-rate-limit');
const { fulfillCJOrder, cjRequest, parseNumeric } = require('./services/cjService');
const { syncCategoriesFromCJ, getCategoryTree, resolveCategoryByCjId } = require('./services/categoryService');
const { buildProductRow, upsertProductRow } = require('./services/productImportService');
const logger = require('./logger');
const { sendOrderTrackingWhatsApp } = require('./services/whatsappService');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const cron = require('node-cron');

// ✨ Pool واحد مشترك من db.js
const pool = require('./db');

const app = express();
const cookieParser = require('cookie-parser');
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(cookieParser());
// Rate Limiters
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { message: 'Too many attempts, please try again after 15 minutes.' } });
const couponLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts, please try again later.' } });
const scraperLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Scraper rate limit exceeded.' } });
const checkoutLimiter = rateLimit({ 
  windowMs: 15 * 60 * 1000, 
  max: 25, // 25 محاولة فتح جلسة دفع لكل زائر كل 15 دقيقة (كافية للزبون الطبيعي وتمنع البوتات)
  message: { error: 'Too many checkout attempts, please try again in a few minutes.' } 
});

const ALL_WORLD_COUNTRIES = ['AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ'];

// ✨ التعديل 2: كاش ديال Stripe Coupons — مانصاوبوش كوبون جديد فكل checkout (Litter فالـ Dashboard)
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

// ==========================================
// فحص قاعدة البيانات والمتغيرات
// ==========================================
pool.query('SELECT NOW()')
  .then(() => console.log('✅ Connected to PostgreSQL Database successfully!'))
  .catch((err) => console.error('❌ Database connection error:', err.stack));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL ERROR: JWT_SECRET is not defined in .env file.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  const requiredEnvVars = [
    'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 
    'JWT_SECRET', 'CJ_API_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 
    'BREVO_API_KEY', 'BREVO_USER', 'RESEND_API_KEY', 'FRONTEND_URL', 
    'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'
  ];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables in production: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ==========================================
// 1. مسار Stripe Webhook (يجب أن يبقى قبل express.json)
// ==========================================
app.post('/api/supplier-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!endpointSecret) {
    logger.logError('Stripe Webhook', new Error('STRIPE_WEBHOOK_SECRET is missing'));
    return res.status(500).send('Webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    logger.logError('Stripe Webhook Signature', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // الرد على Stripe فوراً بـ 200 OK لمنع انتهاء المهلة (Render Timeout)
  res.status(200).json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (!orderId) return;

    (async () => {
      try {
        const customerName = session.customer_details?.name || 'Guest Customer';
        const customerEmail = session.customer_details?.email || '';
        const customerPhone = session.customer_details?.phone || '';
        const addr = session.customer_details?.address;
        const shippingAddress = addr ? JSON.stringify(addr) : JSON.stringify({ line1: 'Online Store Purchase', country: 'US' });
        const totalAmount = session.amount_total / 100;

        // 🚨 Atomic Update محصّن: تحديث الحالة وطريقة الدفع لمنع التكرار
        const updateRes = await pool.query(
          `UPDATE orders 
           SET customer_name = $1, customer_email = $2, customer_phone = $3, 
               shipping_address = $4, total_amount = $5, payment_method = 'Stripe', 
               status = 'paid' 
           WHERE id = $6 AND status = 'pending' 
           RETURNING id`,
          [customerName, customerEmail, customerPhone, shippingAddress, totalAmount, orderId]
        );

        if (updateRes.rows.length === 0) {
          console.log(`⚠️ Order #${orderId} already processed or not pending. Skipping duplicate webhook.`);
          return;
        }

        const itemsRes = await pool.query(`
          SELECT oi.*, p.title, p.image_url 
          FROM order_items oi 
          LEFT JOIN products p ON oi.product_id = p.id 
          WHERE oi.order_id = $1
        `, [orderId]);
        const items = itemsRes.rows;

        console.log(`✅ Order #${orderId} marked as paid! Background processing started.`);

        const cjResponse = await fulfillCJOrder(orderId, customerName, session.customer_details, items);
        
        // ✨ تحديث حالة الطلب بعد نجاح إرساله لـ CJ لكي لا يعالجه كرون الـ Reconcile مجدداً!
        if (cjResponse && cjResponse.success) {
          await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
        }

        if (customerEmail) {
          sendOrderConfirmationEmail(customerEmail, orderId, totalAmount, items)
            .catch(err => logger.logError('Send Email (Background)', err));
        }
      } catch (dbErr) {
        logger.logError('Stripe Webhook DB Update', dbErr);
      }
    })();
  }
});

// ==========================================
// 2. Middlewares الأساسية
// ==========================================
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use(require('./routes/paymentGateways'));

// راوتر الدفع
const paymentRoutes = require('./controllers/paymentController');
app.use('/api/payment', paymentRoutes);

// دوال التحقق من هوية الزبائن
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access Denied: No token provided' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

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
// خدمة البريد الإلكتروني (Brevo + Resend)
// ==========================================
async function sendEmail({ to, subject, html }) {
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Laclarc Support', email: process.env.BREVO_USER },
      to: [{ email: to }],
      subject,
      htmlContent: html
    }, {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
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
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`📧 Email sent via Resend (fallback) to ${to}`);
  } catch (resendErr) {
    logger.logError('Send Email (Resend fallback)', resendErr.response?.data || resendErr.message);
  }
}

// ==========================================
// إعداد Cloudinary & Multer
// ==========================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'neo_store_uploads',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp']
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ==========================================
// مسارات الأدمن غير المحمية (Login / Logout فقط)
// ==========================================
app.post('/api/admin/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '4h' });
    
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 4 * 60 * 60 * 1000
    });

    return res.json({ message: 'Logged in successfully' });
  }
  res.status(401).json({ message: 'Invalid admin credentials' });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  });
  res.json({ message: 'Logged out successfully' });
});

// 🚨 تصحيح موقع الحماية: تفعيل حماية الأدمن هنا فوراً قبل أي مسار يبدأ بـ /api/admin
app.use('/api/admin', requireAdmin);

// ==========================================
// مسارات استخراج البيانات والمزامنة (Admin Only)
// ==========================================
app.post('/api/admin/scrape-product', scraperLimiter, async (req, res) => {
  let browser = null;
  try {
    const { url } = req.body;
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Valid HTTP/HTTPS URL is required' });
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const data = await page.evaluate(() => {
      const getTitle = () => document.querySelector('meta[property="og:title"]')?.content || document.title || '';
      const getDescription = () => document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || '';
      let price = '';
      const priceEl = document.querySelector('[class*="price"], [class*="Price"], [data-price]');
      if (priceEl) {
        const match = priceEl.textContent.match(/[\d.,]+/);
        if (match) price = match[0].replace(',', '.');
      }
      const imgElements = Array.from(document.querySelectorAll('img'));
      let images = imgElements.map(img => img.src || img.getAttribute('data-src') || img.getAttribute('data-original'))
                               .filter(src => src && src.startsWith('http') && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar'));
      images = [...new Set(images)];
      return { title: getTitle().trim(), description: getDescription().trim(), price: price || '', images: images };
    });

    if (!data.title && data.images.length === 0) throw new Error('Could not extract product data.');

    res.json(data);
  } catch (error) {
    logger.logError('Scrape Product', error);
    res.status(500).json({ error: 'Failed to scrape this URL. Site might be protected or slow.' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
});

// ==========================================
// مسارات الكوبونات والتقييمات
// ==========================================
app.post('/api/validate-coupon', couponLimiter, async (req, res) => {
  try {
    const { code, cartTotal } = req.body;
    if (!code || typeof cartTotal !== 'number' || cartTotal < 0) {
      return res.status(400).json({ error: 'Invalid coupon request' });
    }

    // ✨ التعديل 3: Helper الموحد — نفس منطق paymentController و create-checkout-session بالضبط
    // (Fail-closed + سقف $0.50 للحد الأدنى ديال Stripe/NowPayments)
    const { applied, discount, total } = await applyCouponToTotal(pool, code, cartTotal);
    if (!applied) {
      return res.status(404).json({ error: 'Invalid or expired coupon code.' });
    }

    res.json({
      discount: discount.toFixed(2),
      newTotal: total.toFixed(2),
      message: `Coupon applied! You saved $${discount.toFixed(2)}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/add-coupon', async (req, res) => {
  try {
    const { code, discount_type, discount_value } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: 'Code and value are required' });
    await pool.query('INSERT INTO coupons (code, discount_type, discount_value) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING', [code.toUpperCase(), discount_type || 'percentage', discount_value]);
    res.status(201).json({ message: 'Coupon added successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/reviews/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query('SELECT * FROM reviews WHERE product_id = $1 ORDER BY created_at DESC', [productId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/add-review', async (req, res) => {
  try {
    const { product_id, author, rating, content, country } = req.body;
    if (!product_id || !author || !content) return res.status(400).json({ error: 'Product ID, Author, and Content are required' });
    await pool.query('INSERT INTO reviews (product_id, author, rating, content, country) VALUES ($1, $2, $3, $4, $5)', [product_id, author, rating || 5, content, country || 'United States']);
    res.status(201).json({ message: 'Review added successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسار إضافة تقييم معتمد من مستخدم مسجل (مع دعم رفع الصور)
// ==========================================
app.post('/api/reviews/add', authenticateToken, async (req, res) => {
  try {
    const { product_id, rating, content, country, images } = req.body;
    const userId = req.user.id;
    const userName = req.user.name;

    if (!product_id || !content) {
      return res.status(400).json({ error: 'Product ID and content are required' });
    }

    // تنقية وتأمين مصفوفة صور Cloudinary المرفوعة
    const safeImages = Array.isArray(images) 
      ? images.filter(url => typeof url === 'string' && url.startsWith('http')) 
      : [];

    await pool.query(
      `INSERT INTO reviews (product_id, author, user_id, rating, content, country, images) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        product_id, 
        userName, 
        userId, 
        rating || 5, 
        content.trim(), 
        country || 'United States',
        safeImages
      ]
    );

    res.status(201).json({ message: 'Verified review with photos added successfully!' });
  } catch (err) {
    logger.logError('Add Review with Photos Error', err);
    res.status(500).json({ error: 'Server error saving review' });
  }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/api/admin/upload', upload.array('images', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const urls = req.files.map(file => file.path);
    res.status(200).json({ urls });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

app.post('/api/upload', authenticateToken, upload.array('images', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const urls = req.files.map(file => file.path);
    res.status(200).json({ urls });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// ==========================================
// مسارات المنتجات وإدارتها
// ==========================================
let productsCache = null;
let cacheTime = 0;
const CACHE_TTL = 60000;

function clearProductsCache() {
  productsCache = null;
  cacheTime = 0;
  console.log('🧹 Products cache cleared.');
}

app.post('/api/admin/add-product', async (req, res) => {
  try {
    let { title, price: costPrice, image_url, images, description, material, colors, sizes, category } = req.body;
    if (!title || !costPrice || !image_url) return res.status(400).json({ error: 'Title, cost price, and image_url are required' });

    const cjProductId = `MANUAL_${Date.now()}`;
    const imagesArray = images && images.length > 0 ? images : [image_url];
    const colorsArray = colors || [];
    const sizesArray = sizes || [];

    const costNum = Number(costPrice) || 0;
    let sellingPrice = costNum <= 5 ? costNum * 3.5 : costNum <= 15 ? costNum * 2.8 : costNum <= 30 ? costNum * 2.2 : costNum * 1.8;
    sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
    const safePrice = parseFloat(sellingPrice.toFixed(2));
    const safeOldPrice = parseFloat((safePrice * 1.5).toFixed(2));

    await pool.query(
      `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, stock_status, cj_product_id, description, material, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [title, safePrice, safeOldPrice, image_url, imagesArray, JSON.stringify([]), colorsArray, sizesArray, true, cjProductId, description || 'High quality product from Laclarc.', material || 'Premium Quality', category || 'other']
    );

    clearProductsCache();
    res.status(201).json({ message: 'Product added successfully with Auto-Pricing!', calculatedPrice: safePrice, originalPrice: safeOldPrice });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/delete-product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE products SET stock_status = false WHERE id = $1', [id]);
    clearProductsCache();
    res.json({ message: 'Product hidden successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/reorder-product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { direction } = req.body;
    const currentProduct = await pool.query('SELECT sort_order FROM products WHERE id = $1', [id]);
    if (currentProduct.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    let newOrder = currentProduct.rows[0].sort_order || 0;
    if (direction === 'up') newOrder -= 1;
    else if (direction === 'down') newOrder += 1;
    await pool.query('UPDATE products SET sort_order = $1 WHERE id = $2', [newOrder, id]);
    clearProductsCache();
    res.json({ message: 'Order updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/reorder-products', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Invalid items list' });
    const updatePromises = items.map((item, index) => pool.query('UPDATE products SET sort_order = $1 WHERE id = $2', [index, item.id]));
    await Promise.all(updatePromises);
    clearProductsCache();
    res.json({ message: 'Order updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسارات النزاعات والتتبع في CJ
// ==========================================
app.get('/api/admin/disputes', async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.get('https://developers.cjdropshipping.com/api2.0/v1/disputes/getDisputeList', { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/disputes/create', async (req, res) => {
  try {
    const { orderId, disputeReasonId, expectType, refundType, messageText, productInfoList } = req.body;
    const payload = { orderId, businessDisputeId: `NEO_DISPUTE_${Date.now()}`, disputeReasonId, expectType, refundType, messageText, productInfoList };
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/disputes/create', payload, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
    if (response.data.code === 200) res.json({ message: 'Dispute created successfully!' });
    else res.status(400).json({ error: response.data.message || 'Failed to create dispute' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/track/:trackNumber', async (req, res) => {
  try {
    const { trackNumber } = req.params;
    const response = await cjRequest((token) => axios.get(`https://developers.cjdropshipping.com/api2.0/v1/logistic/trackInfo`, { headers: { 'CJ-Access-Token': token }, params: { trackNumber } }));
    if (response.data.code === 200) res.json(response.data.data);
    else res.status(400).json({ error: response.data.message || 'Tracking number not found' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ==========================================
// فئات CJ والـ Backfill
// ==========================================
let categoryTreeCache = null;
let categoryTreeCacheTime = 0;
const CATEGORY_TREE_CACHE_TTL = 10 * 60 * 1000;

app.post('/api/admin/sync-categories', async (req, res) => {
  res.json({ message: 'Category sync started in background. Check server logs for progress.' });
  (async () => {
    try {
      console.log('⏳ Starting official CJ categories tree sync...');
      const result = await syncCategoriesFromCJ();
      categoryTreeCache = null;
      console.log(`🎉 Categories synced! Level 1: ${result.level1Count}, Level 2: ${result.level2Count}, Level 3: ${result.level3Count}.`);
    } catch (err) {
      logger.logError('Sync Categories (Background)', err);
    }
  })();
});


app.get('/api/categories', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    if (categoryTreeCache && (Date.now() - categoryTreeCacheTime < CATEGORY_TREE_CACHE_TTL)) {
      return res.json(categoryTreeCache);
    }
    const tree = await getCategoryTree();
    categoryTreeCache = tree;
    categoryTreeCacheTime = Date.now();
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/backfill-categories', async (req, res) => {
  res.json({ message: 'Backfill started in background. Check server logs for progress.' });
  (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT id, cj_product_id FROM products
         WHERE cj_category_id IS NULL AND cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%'`
      );

      console.log(`⏳ Starting backfill for ${rows.length} products...`);
      let updatedCount = 0;

      for (const p of rows) {
        try {
          await new Promise((r) => setTimeout(r, 1200));
        // 1. جلب تفاصيل المنتج أولاً (مع تفعيل جلب الفيديو حسب وثيقة CJ الرسمية)
          const detailRes = await cjRequest((token, config) =>
            axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', { 
              ...config, 
              headers: { 'CJ-Access-Token': token }, 
              params: { pid: p.cj_product_id, features: 'enable_video' } 
            })
          );

          const details = detailRes.data?.data;
          const cjCategoryId = details?.categoryId;
          if (!cjCategoryId) continue;

          const resolved = await resolveCategoryByCjId(cjCategoryId);
          const newCategory = resolved ? resolved.slugPath : getCategorySlug(`${details.categoryName || ''} ${details.productNameEn || ''}`);

          await pool.query('UPDATE products SET cj_category_id = $1, category = $2 WHERE id = $3', [cjCategoryId, newCategory, p.id]);
          updatedCount++;
        } catch (itemErr) {}
      }

      clearProductsCache();
      console.log(`🎉 Backfill complete! Updated: ${updatedCount}`);
    } catch (err) {
      logger.logError('Backfill Categories (Background)', err);
    }
  })();
});

// ==========================================
// مزامنة منتجات CJ و 1688
// ==========================================
app.get('/api/sync-cj-products', requireAdmin, async (req, res) => {
  const keyword = req.query.keyword || '';
  res.json({ message: `Sync started in background for keyword: ${keyword || 'Trending'}. Check server logs for progress.` });
  runCjProductSync(keyword).catch((err) => logger.logError('CJ Product Sync (Background)', err));
});

// ✨ مسار تشغيل محرك الاستيراد بالجملة (Mass Sync)
const { runMassSync } = require('./massSync');

app.post('/api/admin/mass-sync', requireAdmin, async (req, res) => {
  res.json({ message: '🚀 Mass Sync Engine started in background! Check server logs.' });
  // تشغيل المحرك في الخلفية لكي لا يعلق الطلب (Render Timeout)
  runMassSync().catch(err => logger.logError('Mass Sync Engine', err));
});
// ✨ مسار مزامنة المنتجات التي تحتوي على فيديوهات فقط (للريلز)
app.post('/api/admin/sync-videos', requireAdmin, async (req, res) => {
  res.json({ message: '🎬 Video Sync Engine started in background! Fetching products with videos...' });
  runCjVideoSync().catch(err => logger.logError('CJ Video Sync Engine', err));
});

async function runCjVideoSync() {
  const pagesToFetch = 15; // زيادة الصفحات إلى 15 (300 منتج) للبحث الشامل
  const pageSize = 20;
  let importedCount = 0;
  let checkedCount = 0;

  console.log('⏳ [CJ Video Sync] Starting comprehensive search for video products...');

  for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
    // ✨ البحث الشامل (Trending) بدون كلمات مفتاحية
    const params = { pageNum, pageSize, searchType: 2 };

    const listRes = await cjRequest((token, config) =>
      axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', { ...config, headers: { 'CJ-Access-Token': token }, params })
    );

    const cjProducts = listRes.data?.data?.list || [];
    if (cjProducts.length === 0) {
      console.log('🏁 [CJ Video Sync] No more products found on CJ.');
      break;
    }

    console.log(`📄 [CJ Video Sync] Scanning page ${pageNum}/${pagesToFetch}...`);

    for (const cjItem of cjProducts) {
      await new Promise(r => setTimeout(r, 1000)); // احترام Rate Limit
      const productId = cjItem.pid ? String(cjItem.pid) : null;
      if (!productId) continue;

      checkedCount++;
      try {
        // 1. جلب تفاصيل المنتج (مع تفعيل خيار الفيديو)
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', { 
            ...config, 
            headers: { 'CJ-Access-Token': token }, 
            params: { pid: productId, features: 'enable_video' } 
          })
        );

        const details = detailRes.data?.data;
        if (!details) continue;

        // 2. بناء صف المنتج باستخدام الخدمة الموحدة
        const productRow = await buildProductRow(details, { fetchVideo: true, isSourced: false });

        // 3. إذا نجح في بناء الصف ووجد فيديو، يقوم بإدخاله
        if (productRow && productRow.video_url) {
          await upsertProductRow(pool, productRow);
          importedCount++;
          console.log(`🎥 [Video Sync] Imported video product: ${productRow.title}`);
        }
        
      } catch (productErr) {
        // تجاهل الأخطاء الفردية
      }
    }
  }

  clearProductsCache();
  console.log(`✅ [CJ Video Sync] Finished. Checked ${checkedCount} products. Found and imported ${importedCount} video products.`);
}

app.post('/api/admin/sync-single-product', async (req, res) => {
  const { pid } = req.body;
  if (!pid) return res.status(400).json({ error: 'Product ID (PID) is required' });

  try {
    const detailRes = await cjRequest((token, config) =>
      axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', { 
        ...config, 
        headers: { 'CJ-Access-Token': token }, 
        params: { pid: String(pid) } 
      })
    );

    const details = detailRes.data?.data;
    if (!details) return res.status(404).json({ error: 'Product not found in your CJ account.' });

    const cjPrice = parseNumeric(details.sellPrice);
    let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
    sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
    const safePrice = parseFloat(sellingPrice.toFixed(2));
    const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));

    const parsedData = parseVariants(details.variants || []);
    let material = 'Premium Quality';
    if (details.materialNameEnSet?.length > 0) material = details.materialNameEnSet.filter(m => m && m !== "").join(', ');

    const categorySlug = getCategorySlug(`${details.categoryName} ${details.productNameEn}`);

    await pool.query(
      `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, stock_status, cj_product_id, description, material, category, is_sourced) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
       ON CONFLICT (cj_product_id) DO UPDATE SET 
         title=EXCLUDED.title, price=EXCLUDED.price, original_price=EXCLUDED.original_price, 
         image_url=EXCLUDED.image_url, images=EXCLUDED.images, variants=EXCLUDED.variants, 
         colors=EXCLUDED.colors, sizes=EXCLUDED.sizes, stock_status=EXCLUDED.stock_status, 
         description=EXCLUDED.description, material=EXCLUDED.material, category=EXCLUDED.category, is_sourced=true`,
      [details.productNameEn, safePrice, safeOriginalPrice, details.bigImage, details.productImageSet, JSON.stringify(details.variants || []), parsedData.colors, parsedData.sizes, true, details.pid, details.description, material, categorySlug]
    );

    clearProductsCache();
    res.status(200).json({ message: '✅ Sourced product synced and marked as Lightning Deal successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Server error or CJ API error' });
  }
});

async function runCjProductSync(keyword) {
  const pagesToFetch = 5;
  const pageSize = 20;
  let importedCount = 0;

  for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
    const params = { pageNum, pageSize };
    if (keyword) params.productNameEn = keyword;
    else params.searchType = 2;

    const listRes = await cjRequest((token, config) =>
      axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', { ...config, headers: { 'CJ-Access-Token': token }, params })
    );

    const cjProducts = listRes.data?.data?.list || [];
    if (cjProducts.length === 0) break;

    for (const cjItem of cjProducts) {
      await new Promise(r => setTimeout(r, 1000));
      const productId = cjItem.pid ? String(cjItem.pid) : null;
      if (!productId) continue;

      try {
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', { ...config, headers: { 'CJ-Access-Token': token }, params: { pid: productId } })
        );

        const details = detailRes.data?.data;
        if (!details) continue;

        const hasTitle = details.productNameEn?.trim() !== '';
        const hasMainImage = details.bigImage?.startsWith('http');
        const hasImages = details.productImageSet?.length >= 1;
        const strippedDescription = details.description?.replace(/<[^>]*>?/gm, '').trim() || '';
        const hasValidDescription = strippedDescription.length > 10;
        const hasPrice = parseNumeric(details.sellPrice) >= 1.00;
        const hasVariants = details.variants?.length > 0;
        const isWorldwideShipping = details.isGlobalShipping !== false;

        const lowerTitle = (details.productNameEn || '').toLowerCase();
        if (phoneAccRegex.test(lowerTitle) || pcBlacklistRegex.test(lowerTitle)) continue;
        if (!hasTitle || !hasMainImage || !hasImages || !hasValidDescription || !hasPrice || !hasVariants || !isWorldwideShipping) continue;

        const cjPrice = parseNumeric(details.sellPrice);
        let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
        sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
        const safePrice = parseFloat(sellingPrice.toFixed(2));
        const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));

        const cjCategoryId = details.categoryId || null;
        let categorySlug;
        if (cjCategoryId) {
          const resolved = await resolveCategoryByCjId(cjCategoryId);
          categorySlug = resolved ? resolved.slugPath : getCategorySlug(`${details.categoryName} ${details.productNameEn}`);
        } else {
          categorySlug = getCategorySlug(`${details.categoryName} ${details.productNameEn}`);
        }

        const parsedData = parseVariants(details.variants || []);
        let material = 'Premium Quality';
        if (details.materialNameEnSet?.length > 0) material = details.materialNameEnSet.filter(m => m && m !== "").join(', ');

        let videoUrl = '';
        try {
          const videoRes = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/queryVideosByProductId', { productId }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
          if (videoRes.data.code === 200 && videoRes.data.data?.length > 0) videoUrl = videoRes.data.data[0].videoUrl;
        } catch (e) {}

        await pool.query(
          `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, stock_status, cj_product_id, description, material, category, video_url, cj_category_id, is_sourced) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, false)
           ON CONFLICT (cj_product_id) DO UPDATE SET 
             title=EXCLUDED.title, price=EXCLUDED.price, original_price=EXCLUDED.original_price, 
             image_url=EXCLUDED.image_url, images=EXCLUDED.images, variants=EXCLUDED.variants, 
             colors=EXCLUDED.colors, sizes=EXCLUDED.sizes, stock_status=EXCLUDED.stock_status, 
             description=EXCLUDED.description, material=EXCLUDED.material, category=EXCLUDED.category, 
             video_url=EXCLUDED.video_url, cj_category_id=EXCLUDED.cj_category_id`,
          [details.productNameEn, safePrice, safeOriginalPrice, details.bigImage, details.productImageSet, JSON.stringify(details.variants || []), parsedData.colors, parsedData.sizes, true, details.pid, details.description, material, categorySlug, videoUrl, cjCategoryId]
        );

        importedCount++;
      } catch (productErr) {}
    }
  }

  clearProductsCache();
  console.log(`✅ [CJ Sync] Finished. Imported ${importedCount} products for keyword: ${keyword || 'Trending'}.`);
}

// ==========================================
// مسارات المستخدم والمصادقة
// ==========================================
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'All fields are required' });

    const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) return res.status(400).json({ message: 'Email already registered' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, passwordHash]
    );

    const verifyToken = jwt.sign({ id: newUser.rows[0].id }, JWT_SECRET, { expiresIn: '1d' });
    const verifyUrl = `${process.env.FRONTEND_URL}/auth/verify-email?token=${verifyToken}`;

    sendEmail({
      to: email,
      subject: 'Confirm your Email for Laclarc',
      html: `<h2>Welcome to Laclarc, ${name}!</h2>
             <p>Please click the button below to activate your account:</p>
             <a href="${verifyUrl}" style="background-color:#8B78C6; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; font-weight:bold;">Verify My Email</a>`
    });

    res.status(201).json({ message: 'User registered successfully! Please check your email to verify your account.' });
  } catch (error) {
    logger.logError('Register Error', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Invalid token.');
    const decoded = jwt.verify(token, JWT_SECRET);
    await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [decoded.id]);
    res.send('<h1 style="color:#8B78C6; text-align:center; margin-top:50px;">Email verified successfully! 🎉</h1><p style="text-align:center;">You can now log in to your account.</p>');
  } catch (err) {
    res.status(400).send('<h1 style="color:red; text-align:center; margin-top:50px;">Invalid or expired link.</h1>');
  }
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    
    if (userRes.rows.length > 0) {
      const resetToken = jwt.sign({ id: userRes.rows[0].id }, JWT_SECRET, { expiresIn: '15m' });
      const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${resetToken}`;

      sendEmail({
        to: email,
        subject: 'Password Reset Request',
        html: `<h2>Did you forget your password?</h2>
               <p>Click the button below to set a new password. This link will expire in 15 minutes.</p>
               <a href="${resetUrl}" style="background-color:#8B78C6; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; font-weight:bold;">Reset My Password</a>`
      });
    }
    
    res.json({ message: 'If that email exists in our system, a reset link has been sent.' });
  } catch (error) {
    logger.logError('Forgot Password', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ message: 'Token and new password are required.' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);
    await pool.query('UPDATE users SET password_hash = $1, is_verified = true WHERE id = $2', [passwordHash, decoded.id]);
    res.json({ message: 'Password reset successfully! You can now log in.' });
  } catch (error) {
    res.status(400).json({ message: 'Invalid or expired token.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!validPassword) return res.status(401).json({ message: 'Invalid credentials' });

    if (!user.rows[0].is_verified) return res.status(403).json({ message: 'Please verify your email first. Check your inbox.' });

    const token = jwt.sign({ id: user.rows[0].id, name: user.rows[0].name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Logged in successfully', token, user: { id: user.rows[0].id, name: user.rows[0].name, email: user.rows[0].email } });
  } catch (error) {
    logger.logError('Login Error', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==========================================
// مسارات BaridiMob والطلبات اليدوية
// ==========================================
app.get('/api/admin/manual-orders', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders WHERE payment_method = 'BaridiMob' ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/manual-orders/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [id]);
    res.json({ message: 'Order approved. Sending to CJ in background...' });

    (async () => {
      try {
        const order = orderRes.rows[0];
        const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
        const items = itemsRes.rows;

        let parsedAddress = {};
        try { parsedAddress = JSON.parse(order.shipping_address); }
        catch (e) { parsedAddress = { line1: order.shipping_address, country: 'DZ' }; }

        const customerDetails = { address: parsedAddress, phone: order.customer_phone };
        const cjResponse = await fulfillCJOrder(order.id, order.customer_name, customerDetails, items);

        if (cjResponse && cjResponse.success) {
          await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [order.id]);
        }

        if (order.customer_email) {
          const emailItemsRes = await pool.query(
            `SELECT oi.quantity, oi.price_at_purchase, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
            [id]
          );
          await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, emailItemsRes.rows);
        }
      } catch (bgErr) {
        logger.logError('Approve BaridiMob Order (Background)', bgErr);
      }
    })();
  } catch (err) {
    logger.logError('Approve BaridiMob Order', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/manual-orders/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id]);
    res.json({ message: 'Order rejected successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/failed-orders', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders WHERE status = 'manual' AND payment_method != 'BaridiMob' ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// البحث والتصنيف الذكي
// ==========================================
app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);

  try {
    const result = await pool.query("SELECT id, title, price, image_url FROM products WHERE stock_status = true AND (title ILIKE $1 OR description ILIKE $1) ORDER BY id DESC LIMIT 5", [`%${q}%`]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/search-products', async (req, res) => {
  const q = req.query.q || '';
  try {
    let result;
    if (q.length > 0) {
      result = await pool.query("SELECT id, title, price, original_price, image_url, stock_status, category, is_sourced FROM products WHERE title ILIKE $1 ORDER BY id DESC LIMIT 30", [`%${q}%`]);
    } else {
      result = await pool.query("SELECT id, title, price, original_price, image_url, stock_status, category, is_sourced FROM products ORDER BY id DESC LIMIT 30");
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ✨ تحسين مسار التصنيف التلقائي لمنع قفل الاتصالات (Connection Pool Exhaustion)
app.post('/api/admin/auto-categorize', async (req, res) => {
  const dryRun = req.query.dryRun === 'true';

  try {
    const allProducts = await pool.query('SELECT id, title, category FROM products');
    const changes = [];
    const categoryStats = {};

    for (const p of allProducts.rows) {
      const newCategory = getCategorySlug(p.title);
      if (newCategory && newCategory !== p.category) {
        changes.push({ id: p.id, from: p.category, to: newCategory });
        categoryStats[newCategory] = (categoryStats[newCategory] || 0) + 1;
      }
    }

    if (dryRun) {
      return res.json({ message: `Dry run: ${changes.length} product(s) would be re-categorized.`, count: changes.length, categoryStats, sample: changes.slice(0, 20) });
    }

    // الرد الفوري وتنفيذ التعديل في الخلفية لمنع التجميد والـ Pool Exhaustion
    res.json({ message: `Auto-categorization started in background for ${changes.length} products.`, count: changes.length });

    (async () => {
      for (const c of changes) {
        try {
          await pool.query('UPDATE products SET category = $1 WHERE id = $2', [c.to, c.id]);
        } catch (e) {}
      }
      clearProductsCache();
      console.log(`✅ Finished auto-categorizing ${changes.length} products.`);
    })();
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ==========================================
// مسارات الواجهة الأمامية للمنتجات
// ==========================================
app.get('/', (req, res) => res.send('Laclarc Dropshipping API is running on point!'));

// ==========================================
// مسار جلب المنتجات المحصن ضد ضغط ملايين الزوار (High-Concurrency Edge Shield)
// ==========================================
app.get('/api/products', async (req, res) => {
  try {
    const search = req.query.search || '';
    const category = req.query.category || 'All';
    
    // ✨ تفعيل التخزين المؤقت على شبكات CDN العالمية (Vercel & Cloudflare Edge)
    // 60 ثانية كاش طازج + 300 ثانية استجابة فورية أثناء التحديث في الخلفية
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

    // 1. الطلب العام بدون بحث (يخدم ملايين الزوار من الذاكرة اللحظية)
    if (search === '' && category === 'All') {
      if (productsCache && (Date.now() - cacheTime < CACHE_TTL)) {
        return res.json(productsCache);
      }
      const result = await pool.query(
        'SELECT id, title, price, original_price, image_url, category, video_url, created_at FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC'
      );
      productsCache = result.rows;
      cacheTime = Date.now();
      return res.json(result.rows);
    }

    // 2. استعلام البحث والتصنيف (سريع جداً بفضل فهارس GIN و B-Tree)
    let query = 'SELECT id, title, price, original_price, image_url, category, video_url FROM products WHERE stock_status = true';
    let params = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category !== 'All') {
      query += ` AND category ILIKE $${paramIndex}`;
      params.push(`${category}%`);
      paramIndex++;
    }

    query += ` ORDER BY sort_order ASC, id DESC`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching products:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/products/deals', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, title, price, original_price, image_url FROM products WHERE stock_status = true AND is_sourced = true ORDER BY id DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    
    const product = result.rows[0];
    if (product.images && typeof product.images === 'string') {
      try { product.images = JSON.parse(product.images); } catch (e) {}
    }
    
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/products/:id/related', async (req, res) => {
  try {
    const { id } = req.params;
    const productRes = await pool.query('SELECT category FROM products WHERE id = $1', [id]);
    if (productRes.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    
    const category = productRes.rows[0].category;
    const baseCategory = category ? category.split('-')[0] : '';
    
    let relatedRes = await pool.query(
      `SELECT id, title, price, image_url, category FROM products 
       WHERE id != $1 AND category = $2 AND stock_status = true 
       ORDER BY id DESC LIMIT 4`, [id, category]
    );
    
    if (relatedRes.rows.length < 4 && baseCategory) {
      const existingIds = relatedRes.rows.map(r => r.id);
      existingIds.push(parseInt(id));
      const moreRes = await pool.query(
        `SELECT id, title, price, image_url, category FROM products 
         WHERE id != ALL($1::int[]) AND category ILIKE $2 AND stock_status = true 
         ORDER BY id DESC LIMIT $3`, [existingIds, `${baseCategory}%`, 4 - relatedRes.rows.length]
      );
      relatedRes.rows = [...relatedRes.rows, ...moreRes.rows];
    }
    
    if (relatedRes.rows.length < 4) {
      const existingIds = relatedRes.rows.map(r => r.id);
      existingIds.push(parseInt(id));
      const randomRes = await pool.query(
        `SELECT id, title, price, image_url, category FROM products 
         WHERE id != ALL($1::int[]) AND stock_status = true 
         ORDER BY random() LIMIT $2`, [existingIds, 4 - relatedRes.rows.length]
      );
      relatedRes.rows = [...relatedRes.rows, ...randomRes.rows];
    }

    res.json(relatedRes.rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.put('/api/admin/toggle-deal/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT is_sourced FROM products WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    
    const newStatus = !result.rows[0].is_sourced;
    await pool.query('UPDATE products SET is_sourced = $1 WHERE id = $2', [newStatus, id]);
    
    clearProductsCache();
    res.json({ message: 'Deal status updated', is_sourced: newStatus });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسار الدفع المحصن (Bank-Grade Checkout)
// ==========================================
app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    const { items: clientItems, origin, couponCode } = req.body;
    let baseUrl = origin && origin.startsWith('http') ? origin : (process.env.FRONTEND_URL || 'http://localhost:3000');
    baseUrl = baseUrl.replace(/\/+$/, '');

    // حساب الأسعار والـ vid حصراً من قاعدة البيانات
    const { secureItems, serverTotal } = await prepareSecureItems(pool, clientItems);

    const optionalUser = getOptionalUser(req);
    // ✨ تعيين payment_method='Stripe' صراحة منذ البداية لكي يعمل نظام التتبع والـ Sweeper
    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, user_id, payment_method) 
       VALUES ($1, $2, $3, $4, $5, $6, 'Stripe') RETURNING id`,
      ['Pending Customer', 'pending@laclarc.com', 'Pending', serverTotal, 'pending', optionalUser ? optionalUser.id : null]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of secureItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)", 
        [orderId, item.id, item.quantity, item.price, item.vid]
      );
    }

    // ✨ التعديل 4: تصادق الكوبون عبر الـ Helper الموحد (Fail-closed + سقف $0.50 + كاش Stripe)
    const { applied: couponApplied, discount: couponDiscount, clamped, coupon: couponRow } =
      await applyCouponToTotal(pool, couponCode, serverTotal);

    let stripeDiscounts = [];
    if (couponApplied) {
      // percent_off الأصيلة ديال Stripe إلا ماتسوبش — وإلا amount_off المثبت (باش نتجنبو مشاكل الـ clamp)
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
            product_data: { name: item.title || 'Product', images: hasValidImage ? [item.image_url] : [] }, 
            unit_amount: Math.round(item.price * 100) 
          }, 
          quantity: item.quantity 
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
      metadata: { 
        orderId: orderId.toString(),
        couponCode: couponApplied ? String(couponCode).toUpperCase() : '' // ✨ للتدقيق المالي
      },
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cancel`,
    });

    await pool.query("UPDATE orders SET stripe_session_id = $1 WHERE id = $2", [session.id, orderId]);
    res.json({ url: session.url });
  } catch (err) {
    logger.logError('Create Checkout Session', err);
    res.status(500).json({ error: err.message });
  }
});
// ==========================================
// ⚡ مسار التحقق المالي اللحظي JIT (Just-In-Time Stripe Verifier)
// يستجوب خوادم Stripe مباشرة في الوقت الفعلي قبل إطلاق أي شحنة لـ CJ
// ==========================================
app.post('/api/payment/verify-session', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id || typeof session_id !== 'string') {
    return res.status(400).json({ success: false, error: 'Session ID is required' });
  }

  try {
    // 1. استجواب مباشر وفوري لخوادم Stripe (JIT API Call)
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (!session || !session.metadata?.orderId) {
      return res.status(404).json({ success: false, error: 'Invalid checkout session' });
    }

    const orderId = parseInt(session.metadata.orderId, 10);

    // 2. التحقق الجازم: هل تم الدفع بنجاح 100% في Stripe؟
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ 
        success: false, 
        status: 'unpaid', 
        message: 'Payment has not been completed or was declined by the bank.' 
      });
    }

    const customerName = session.customer_details?.name || 'Valued Customer';
    const customerEmail = session.customer_details?.email || '';
    const customerPhone = session.customer_details?.phone || '';
    const addr = session.customer_details?.address;
    const shippingAddress = addr 
      ? JSON.stringify(addr) 
      : JSON.stringify({ line1: 'Online Store Purchase', country: 'US' });
    const paidAmount = session.amount_total / 100;

    // 3. قفل ذري (Atomic Lock): إذا كان الطلب ما زال pending يتم تحويله لـ paid فوراً
    const updateRes = await pool.query(
      `UPDATE orders 
       SET customer_name = $1, customer_email = $2, customer_phone = $3, 
           shipping_address = $4, total_amount = $5, payment_method = 'Stripe', 
           status = 'paid' 
       WHERE id = $6 AND status = 'pending' 
       RETURNING id`,
      [customerName, customerEmail, customerPhone, shippingAddress, paidAmount, orderId]
    );

    // جلب بيانات وعناصر الطلب
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const fullOrder = orderRes.rows[0];

    const itemsRes = await pool.query(`
      SELECT oi.*, p.title, p.image_url 
      FROM order_items oi 
      LEFT JOIN products p ON oi.product_id = p.id 
      WHERE oi.order_id = $1
    `, [orderId]);
    const items = itemsRes.rows;

    // 4. إذا أمسكنا بالطلب (لم يسبقنا الـ Webhook)، نرسله لـ CJ فوراً في الخلفية
    if (updateRes.rows.length > 0) {
      console.log(`⚡ [JIT Verification] Order #${orderId} verified with Stripe! Fulfilling to CJ immediately...`);

      (async () => {
        try {
          const cjResponse = await fulfillCJOrder(orderId, customerName, session.customer_details, items);
          if (cjResponse && cjResponse.success) {
            await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
          }
          if (customerEmail) {
            sendOrderConfirmationEmail(customerEmail, orderId, paidAmount, items)
              .catch(err => logger.logError('JIT Email Dispatch', err));
          }
        } catch (bgErr) {
          logger.logError('JIT Background CJ Fulfillment', bgErr);
        }
      })();
    } else {
      console.log(`ℹ️ [JIT Verification] Order #${orderId} was already locked/processed by Webhook.`);
    }

    // 5. إرجاع النتيجة الفورية للواجهة لتأكيد الدفع والمبلغ الحقيقي
    res.json({
      success: true,
      verified: true,
      orderId: fullOrder.id,
      amount: paidAmount,
      currency: session.currency?.toUpperCase() || 'USD',
      customerEmail: fullOrder.customer_email,
      status: fullOrder.status
    });

  } catch (error) {
    logger.logError('JIT Stripe Verification Error', error);
    res.status(500).json({ success: false, error: 'Failed to verify payment with Stripe' });
  }
});

// ==========================================
// مسارات تفاصيل وتتبع الطلبات (محمية من IDOR)
// ==========================================
app.get('/api/orders/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;
    const optionalUser = getOptionalUser(req);

    const orderRes = await pool.query('SELECT customer_email, user_id FROM orders WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = orderRes.rows[0];
    const isOwner = (optionalUser && order.user_id === optionalUser.id) || (email && order.customer_email.toLowerCase() === email.toLowerCase());

    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: You do not have permission to view these items.' });
    }

    const result = await pool.query(
      `SELECT oi.quantity, oi.price_at_purchase, p.title, p.image_url 
       FROM order_items oi 
       LEFT JOIN products p ON oi.product_id = p.id 
       WHERE oi.order_id = $1`, [id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/orders/my-orders', authenticateToken, async (req, res) => {
  try {
    const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const userEmail = userRes.rows[0]?.email || null;
    const result = await pool.query(
      `SELECT * FROM orders WHERE user_id = $1 OR (customer_email = $2 AND status != 'pending') ORDER BY id DESC`,
      [req.user.id, userEmail]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/orders/track/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const { email } = req.query;

    let queryStr = '';
    let params = [];

    if (email) {
      queryStr = `SELECT * FROM orders WHERE (id::text = $1 OR customer_email ILIKE $2) AND customer_email ILIKE $2 ORDER BY id DESC`;
      params = [identifier, email];
    } else if (identifier.includes('@')) {
      queryStr = `SELECT * FROM orders WHERE customer_email ILIKE $1 ORDER BY id DESC`;
      params = [identifier];
    } else {
      return res.status(400).json({ error: 'Email is required to track an order by ID.' });
    }

    const result = await pool.query(queryStr, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No orders found' });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/track/:trackNumber', async (req, res) => {
  try {
    const { trackNumber } = req.params;
    const response = await cjRequest((token) => axios.get(`https://developers.cjdropshipping.com/api2.0/v1/logistic/trackInfo`, { headers: { 'CJ-Access-Token': token }, params: { trackNumber } }));
    if (response.data.code === 200) res.json(response.data.data);
    else res.status(404).json({ error: 'No tracking info found.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسارات الملف الشخصي للمستخدم
// ==========================================
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT name, email, profile_picture FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: "User not found" });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const { name, profilePicture } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const updatedUser = await pool.query(
      'UPDATE users SET name = $1, profile_picture = $2 WHERE id = $3 RETURNING id, name, email, profile_picture', 
      [name, profilePicture, req.user.id]
    );
    res.json(updatedUser.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// مسارات إدارة المنتجات للأدمن
app.put('/api/admin/update-category/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { category } = req.body;
    if (!category) return res.status(400).json({ error: 'Category is required' });
    await pool.query('UPDATE products SET category = $1 WHERE id = $2', [category, id]);
    clearProductsCache();
    res.json({ message: 'Category updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});
// ==========================================
// ✨ مسارات إدارة الإعدادات والريلز
// ==========================================

// GET: جلب الإعدادات
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings');
    // تحويل المصفوفة إلى كائن (Object) لسهولة الاستخدام في الواجهة
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = row.value === 'true';
      return acc;
    }, {});
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT: تحديث إعداد معين (مثل إظهار/إخفاء الريلز)
app.put('/api/admin/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body; // true أو false

  try {
    await pool.query(
      'INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, String(value)]
    );
    res.json({ success: true, message: 'Setting updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE: حذف فيديو منتج معين (تحويل video_url إلى فارغ)
app.delete('/api/admin/videos/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    await pool.query('UPDATE products SET video_url = NULL WHERE id = $1', [productId]);
    clearProductsCache();
    res.json({ success: true, message: 'Video deleted successfully. Product remains in store.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/update-product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, price, original_price, image_url, images, description, material, colors, sizes, category } = req.body;
    await pool.query(
      `UPDATE products SET title = $1, price = $2, original_price = $3, image_url = $4, images = $5, description = $6, material = $7, colors = $8, sizes = $9, category = $10 WHERE id = $11`, 
      [title || null, Number(price) || 0, Number(original_price) || 0, image_url || null, images || null, description || null, material || null, colors || null, sizes || null, category || 'other', id]
    );
    clearProductsCache();
    res.json({ message: 'Product updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// مسارات CJ المتقدمة
app.post('/api/admin/cogs', async (req, res) => {
  try {
    const { orderCodes } = req.body;
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/queryCogsBasicDataOrderInfoList', { orderCodesList: orderCodes }, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/merge/match', async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/mergeOrder/autoMatchMergeOrderListV3', { filterOrder: true, orderStatus: 100 }, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/merge/submit', async (req, res) => {
  try {
    const { orders } = req.body;
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/mergeOrder/submitMergeOrderBatchV3', orders, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/makeup/list', async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/makeup/list', { pageNum: 1, pageSize: 20, type: 0 }, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/addresses', requireAdmin, async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/privateInventory/address/list', {}, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/addresses/create', requireAdmin, async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/privateInventory/address/create', req.body, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/sourcing/create', async (req, res) => {
  try {
    const { productName, productImage, productUrl, price } = req.body;
    if (!productName || !productImage) return res.status(400).json({ error: 'Product name and image are required' });
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/sourcing/create', { productName, productImage, productUrl: productUrl || '', price: price || 0 }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
    if (response.data.success || response.data.code === 200 || response.data.code === 0) res.status(201).json({ message: 'Sourcing request sent successfully! CJ will review it.' });
    else res.status(400).json({ error: response.data.message || 'Failed to create sourcing request' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// قالب إيميل تأكيد الطلب
// ==========================================
async function sendOrderConfirmationEmail(email, orderId, total, items = []) {
  try {
    const itemsHtml = items.map(item => `
      <tr>
        <td style="padding: 15px 0; border-bottom: 1px solid #eee; display: flex; align-items: center;">
          <img src="${item.image_url || 'https://via.placeholder.com/50'}" alt="${item.title || 'Product'}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 8px; margin-right: 15px;">
          <span style="color: #1D1E3C; font-weight: bold; font-size: 14px;">${item.title || 'Product'} (Qty: ${item.quantity})</span>
        </td>
        <td style="padding: 15px 0; border-bottom: 1px solid #eee; text-align: right; color: #FF6B9D; font-weight: bold; font-size: 14px;">
          $${Number(item.price_at_purchase || 0).toFixed(2)}
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
              Once CJ Dropshipping ships your order, we will send you the tracking number. You can track your shipment directly through our "Track My Order" page.
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

    await sendEmail({
      to: email,
      subject: `Order Confirmation #${orderId} - Laclarc`,
      html: htmlContent
    });
    console.log(`📧 Professional confirmation email sent to ${email}`);
  } catch (err) {
    logger.logError('Send Order Email', err);
  }
}

// ==========================================
// النشر التلقائي على Facebook
// ==========================================
const POST_TEMPLATES = [
  (title, price, link) => `🔥 Trending Now! 🔥\nGet your hands on the ${title}. Premium quality at an unbeatable price: $${price}.\nShop here: ${link}\n\n#Laclarc #Shopping #Trending #Deals`,
  (title, price, link) => `✨ Elevate your lifestyle with our ${title}! ✨\nLimited stock available. Grab yours for just $${price} today!\nOrder now: ${link}\n\n#LaclarcStore #Gadgets #Fashion #OnlineShopping`,
  (title, price, link) => `🚀 Don't miss out on the ${title}! 🚀\nWhy pay more? Get it for $${price} with Worldwide Shipping.\nTap to buy: ${link}\n\n#TrendingProducts #Laclarc #ShopNow`,
  (title, price, link) => `💜 Premium quality meets affordability. 💜\nIntroducing: ${title} for only $${price}.\nFast shipping, secure payments. Get yours: ${link}\n\n#Laclarc #Tech #HomeDecor #DailyDeals`,
];

async function postDailyProductToFacebook() {
  const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
  const PAGE_ID = process.env.FB_PAGE_ID;
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://laclarc.com';

  if (!PAGE_ACCESS_TOKEN || !PAGE_ID) return;

  try {
    const { rows } = await pool.query("SELECT id, title, price, image_url FROM products WHERE stock_status = true AND image_url IS NOT NULL ORDER BY random() LIMIT 1");
    if (rows.length === 0) return;

    const product = rows[0];
    const productLink = `${FRONTEND_URL}/products/${product.id}`;
    const randomTemplate = POST_TEMPLATES[Math.floor(Math.random() * POST_TEMPLATES.length)];
    const caption = randomTemplate(product.title, product.price, productLink);

    await axios.post(`https://graph.facebook.com/v18.0/${PAGE_ID}/photos`, {
      url: product.image_url,
      caption: caption,
      access_token: PAGE_ACCESS_TOKEN
    });

    console.log(`✅ [Auto-Cron] Successfully posted to Facebook! Product: ${product.title}`);
  } catch (err) {
    console.error('❌ [Auto-Cron] Error posting to Facebook:', err.response?.data?.error || err.message);
  }
}

// ==========================================
// 🤖 الأتمتة والكرونات المحصنة (Cron Jobs)
// ==========================================

// أعلام لمنع تداخل تشغيل الكرونات (Concurrency Locks)
let isReconciling = false;
let isSweeping = false;

// 1. تحديث 100 منتج عشوائي يومياً (الساعة 3 صباحاً)
cron.schedule('0 3 * * *', async () => {
  console.log('⏳ [Auto-Cron] Starting daily product stock/price update...');
  try {
    const { rows } = await pool.query("SELECT id, cj_product_id FROM products WHERE cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%' ORDER BY random() LIMIT 100");
    
    for (const p of rows) {
      try {
        await new Promise(r => setTimeout(r, 1500));
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', { ...config, headers: { 'CJ-Access-Token': token }, params: { pid: p.cj_product_id } })
        );
        const details = detailRes.data?.data;
        if (!details) continue;

        const cjPrice = parseNumeric(details.sellPrice);
        let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
        sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
        const safePrice = parseFloat(sellingPrice.toFixed(2));

        await pool.query("UPDATE products SET price = $1, stock_status = $2 WHERE id = $3", [safePrice, details.isGlobalShipping !== false, p.id]);
      } catch (e) {}
    }
    clearProductsCache();
    console.log('✅ [Auto-Cron] Daily product update completed!');
  } catch (err) {
    console.error('❌ [Auto-Cron] Error updating products:', err.message);
  }
});
// ==========================================
// 🔄 10. كرون تحديث أسعار ومقاسات المتغيرات (Variant Price Sync)
// يعمل يومياً الساعة 2:30 صباحاً (قبل كرون تحديث المنتجات الرئيسي)
// يستخدم نقطة variant/query السريعة لتوفير طلبات API
// ==========================================
cron.schedule('30 2 * * *', async () => {
  console.log('⏳ [Variant Sync] Starting daily variant price update...');
  try {
    // جلب 100 منتج عشوائي لتحديث متغيراتها
    const { rows } = await pool.query("SELECT id, cj_product_id, variants FROM products WHERE cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%' ORDER BY random() LIMIT 100");
    
    let updatedCount = 0;

    for (const p of rows) {
      try {
        await new Promise(r => setTimeout(r, 1200)); // احترام Rate Limit (QPS=1)

        // 1. استدعاء نقطة variant/query السريعة
        const variantRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/variant/query', { 
            ...config, 
            headers: { 'CJ-Access-Token': token }, 
            params: { pid: p.cj_product_id } 
          })
        );

        const cjVariants = variantRes.data?.data;
        
        // 2. التحقق من وجود متغيرات صالحة
        if (Array.isArray(cjVariants) && cjVariants.length > 0) {
          
          // 3. تحديث حقل variants في قاعدة البيانات بالبيانات الجديدة (الأسعار والمقاسات)
          // ملاحظة: نحتفظ بنفس الهيكل الذي تتوقعه دالة prepareSecureItems
          await pool.query(
            "UPDATE products SET variants = $1 WHERE id = $2",
            [JSON.stringify(cjVariants), p.id]
          );
          
          updatedCount++;
        }
      } catch (e) {
        // تجاهل الأخطاء الفردية لمنع توقف الكرون بالكامل
      }
    }

    clearProductsCache();
    console.log(`✅ [Variant Sync] Daily variant update completed! Updated variants for ${updatedCount} products.`);
  } catch (err) {
    console.error('❌ [Variant Sync] Error updating variants:', err.message);
  }
});

// 2. إضافة تقييمات جديدة لـ 5 منتجات يومياً (الساعة 4 صباحاً)
cron.schedule('0 4 * * *', async () => {
  const authors = ["Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Sophia", "Mason"];
  const contents = ["Highly recommend!", "Exactly as described.", "Great quality.", "Fast shipping, very happy."];
  
  try {
    const { rows } = await pool.query("SELECT id FROM products WHERE stock_status = true ORDER BY random() LIMIT 5");
    for (const p of rows) {
      const author = authors[Math.floor(Math.random() * authors.length)];
      const content = contents[Math.floor(Math.random() * contents.length)];
      const rating = Math.random() > 0.2 ? 5 : 4;
      
      await pool.query(
        'INSERT INTO reviews (product_id, author, rating, content, country) VALUES ($1, $2, $3, $4, $5)',
        [p.id, author, rating, content, 'United States']
      );
    }
    console.log('✅ [Auto-Cron] Added 5 new reviews successfully!');
  } catch (err) {
    console.error('❌ [Auto-Cron] Error seeding reviews:', err.message);
  }
});

// 3. دمج الطلبات على CJ تلقائياً (كل ساعة)
cron.schedule('0 * * * *', async () => {
  try {
    const matchRes = await cjRequest((token) => 
      axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/mergeOrder/autoMatchMergeOrderListV3', 
        { filterOrder: true, orderStatus: 100 }, 
        { headers: { 'CJ-Access-Token': token } }
      )
    );
    
    if (matchRes.data.code === 200 && matchRes.data.data?.result?.length > 0) {
      const groups = matchRes.data.data.result;
      for (const group of groups) {
        try {
          await new Promise(r => setTimeout(r, 1500)); 
          await cjRequest((token) => 
            axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/mergeOrder/submitMergeOrderBatchV3', 
              group.mergeShopOrderVOList, 
              { headers: { 'CJ-Access-Token': token } }
            )
          );
        } catch (mergeErr) {}
      }
      console.log('✅ Auto-merge completed successfully!');
    }
  } catch (err) {}
});

// 4. فحص وتنظيف المنتجات المحذوفة من CJ (أسبوعياً)
cron.schedule('0 1 * * 0', async () => {
  try {
    const { rows } = await pool.query("SELECT id, cj_product_id FROM products WHERE cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%' AND stock_status = true");
    let hiddenCount = 0;
    
    for (const p of rows) {
      try {
        await new Promise(r => setTimeout(r, 1200)); 
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', { 
            ...config, 
            headers: { 'CJ-Access-Token': token }, 
            params: { pid: p.cj_product_id } 
          })
        );
        const details = detailRes.data?.data;
        if (!details || details.isGlobalShipping === false) {
          await pool.query("UPDATE products SET stock_status = false WHERE id = $1", [p.id]);
          hiddenCount++;
        }
      } catch (e) {} 
    }
    clearProductsCache();
    console.log(`✅ [Auto-Cron] Weekly cleanup completed! Hidden ${hiddenCount} products.`);
  } catch (err) {
    console.error('❌ [Auto-Cron] Weekly cleanup error:', err.message);
  }
});

// 5. نشر منتج يومياً على فيسبوك (11:00 و 18:00)
cron.schedule('0 11,18 * * *', async () => {
  await postDailyProductToFacebook();
});

// 6. كرون مطابقة مدفوعات Stripe (Payment Reconciliation - كل 15 دقيقة)
cron.schedule('*/15 * * * *', async () => {
  if (isReconciling) return;
  isReconciling = true;

  try {
    // جلب الطلبات المدفوعة ولكن لم تكتمل في CJ
    const query = `
      SELECT id, stripe_session_id, total_amount 
      FROM orders 
      WHERE payment_method = 'Stripe' 
        AND status IN ('paid', 'reconciling')
        AND stripe_session_id IS NOT NULL
        AND created_at <= NOW() - INTERVAL '10 minutes'
      LIMIT 15;
    `;
    const { rows: pendingOrders } = await pool.query(query);

    for (const order of pendingOrders) {
      try {
        await pool.query("UPDATE orders SET status = 'reconciling' WHERE id = $1", [order.id]);
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);

        if (session.payment_status === 'paid') {
          console.log(`💰 [Stripe Reconcile] Order ${order.id} confirmed paid in Stripe. Sending to CJ...`);
          
          const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
          const fullOrder = orderRes.rows[0];
          const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [order.id]);
          const items = itemsRes.rows;

          let parsedAddress = {};
          try { parsedAddress = JSON.parse(fullOrder.shipping_address); } 
          catch (e) { parsedAddress = { line1: fullOrder.shipping_address, country: 'US' }; }
          const customerDetails = { address: parsedAddress, phone: fullOrder.customer_phone || '0000000000' };

          const cjResponse = await fulfillCJOrder(order.id, fullOrder.customer_name, customerDetails, items);

          // ✨ إصلاح الثغرة الحرجة: تغيير الحالة إلى 'completed' لمنع الحلقة اللانهائية وإعادة الطلب كل 15 دقيقة
          if (cjResponse && cjResponse.success) {
            await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [order.id]);
            if (fullOrder.customer_email) {
              sendOrderConfirmationEmail(fullOrder.customer_email, order.id, fullOrder.total_amount, items)
                .catch(err => logger.logError('Reconcile Email', err));
            }
          } else {
            // إذا تعثر إرساله لـ CJ، يتحول إلى manual ليظهر في لوحة failed orders ولا يعلق في حلقة reconcile
            await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [order.id]);
          }
        } else {
          console.log(`⚠️ [Stripe Reconcile] Order ${order.id} unpaid in Stripe. Cancelling.`);
          await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [order.id]);
        }
      } catch (error) {
        logger.logError(`Stripe Reconcile Order #${order.id}`, error);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [order.id]);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logger.logError('Stripe Reconcile Cron Fatal', error);
  } finally {
    isReconciling = false;
  }
});

// 7. المنظف الآلي للطلبات المعلقة (Sweeper - كل ساعة)
cron.schedule('0 * * * *', async () => {
  if (isSweeping) return;
  isSweeping = true;

  try {
    // تنظيف طلبات Stripe, Paysera, Crypto المعلقة لأكثر من ساعتين
    const result = await pool.query(`
      UPDATE orders 
      SET status = 'expired' 
      WHERE status = 'pending' 
        AND payment_method IN ('Stripe', 'Paysera', 'Crypto') 
        AND created_at < NOW() - INTERVAL '2 hours'
    `);
    
    // تنظيف طلبات BaridiMob المعلقة لأكثر من 48 ساعة
    await pool.query(`
      UPDATE orders 
      SET status = 'expired' 
      WHERE status = 'pending' 
        AND payment_method = 'BaridiMob' 
        AND created_at < NOW() - INTERVAL '48 hours'
    `);

    if (result.rowCount > 0) {
      console.log(`🧹 [Sweeper] Cleaned ${result.rowCount} expired pending order(s).`);
    }
  } catch (err) {
    logger.logError('Sweeper Cron', err);
  } finally {
    isSweeping = false;
  }
});
// ✨ كرون يمنع Neon من النوم (Scale to Zero) كل 4 دقائق
cron.schedule('*/4 * * * *', async () => {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('Neon keep-alive error:', err.message);
  }
});
// ==========================================
// 🛒 8. كرون استرجاع السلات المتروكة (Abandoned Cart Recovery)
// يعمل كل ساعتين لإرسال إيميل تذكيري مع كوبون خصم للزبائن المترددين
// ==========================================
cron.schedule('0 */2 * * *', async () => {
  console.log('⏳ [Abandoned Cart] Checking for abandoned checkouts...');
  try {
    const { rows: abandonedOrders } = await pool.query(`
      SELECT id, customer_name, customer_email, total_amount, created_at 
      FROM orders 
      WHERE status = 'pending' 
        AND customer_email IS NOT NULL 
        AND customer_email NOT LIKE '%@neo.com' 
        AND customer_email NOT LIKE '%@laclarc.com'
        AND created_at BETWEEN NOW() - INTERVAL '6 hours' AND NOW() - INTERVAL '2 hours'
        AND receipt_url IS NULL
      LIMIT 10;
    `);

    if (abandonedOrders.length === 0) return;

    for (const order of abandonedOrders) {
      // جلب صور وعناوين المنتجات المتروكة
      const itemsRes = await pool.query(`
        SELECT p.title, p.image_url, oi.price_at_purchase, oi.quantity 
        FROM order_items oi 
        JOIN products p ON oi.product_id = p.id 
        WHERE oi.order_id = $1
      `, [order.id]);

      const items = itemsRes.rows;
      if (items.length === 0) continue;

      const itemsListHtml = items.map(item => `
        <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 12px; padding: 10px; background: #fff; border-radius: 8px;">
          <img src="${item.image_url || 'https://laclarc.com/icon-192.png'}" style="width: 55px; height: 55px; object-fit: cover; border-radius: 6px;" />
          <div>
            <p style="margin: 0; font-weight: bold; color: #1D1E3C; font-size: 13px;">${item.title}</p>
            <p style="margin: 2px 0 0; color: #FF6B9D; font-weight: bold; font-size: 12px;">Qty: ${item.quantity} &bull; $${Number(item.price_at_purchase).toFixed(2)}</p>
          </div>
        </div>
      `).join('');

      const recoveryHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 550px; margin: 0 auto; background: #F9F8FC; padding: 25px; border-radius: 16px; border: 1px solid #E5E7EB;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #1D1E3C; margin: 0; font-size: 26px;">Laclarc</h1>
            <p style="color: #8B78C6; font-weight: bold; font-size: 13px; margin: 4px 0 0;">Did you leave something behind?</p>
          </div>
          
          <p style="color: #4B5563; font-size: 14px; line-height: 1.6;">
            Hello <strong>${order.customer_name || 'there'}</strong>,<br>
            Your curated items are still safely reserved in your bag, but limited flash inventory is selling out fast!
          </p>

          <div style="margin: 20px 0;">
            ${itemsListHtml}
          </div>

          <div style="background: #FFF; border: 2px dashed #8B78C6; padding: 15px; border-radius: 12px; text-align: center; margin-bottom: 25px;">
            <p style="margin: 0 0 5px; color: #1D1E3C; font-size: 12px; font-weight: bold;">USE THIS EXCLUSIVE 10% RECOVERY DISCOUNT:</p>
            <span style="display: inline-block; background: #8B78C6; color: #fff; padding: 6px 16px; border-radius: 6px; font-weight: bold; font-size: 15px; letter-spacing: 1px;">RECOVER10</span>
          </div>

          <div style="text-align: center;">
            <a href="${process.env.FRONTEND_URL || 'https://laclarc.com'}/cart" style="display: inline-block; background: #1D1E3C; color: #fff; padding: 14px 32px; border-radius: 30px; font-weight: bold; text-decoration: none; font-size: 14px;">
              Complete My Order Now &rarr;
            </a>
          </div>

          <p style="text-align: center; color: #9CA3AF; font-size: 11px; margin-top: 25px;">
            Free Worldwide Insured Shipping &bull; 30-Day Money Back Guarantee
          </p>
        </div>
      `;

      await sendEmail({
        to: order.customer_email,
        subject: `Exclusive 10% OFF: Complete your order #${order.id} at Laclarc`,
        html: recoveryHtml
      });

      console.log(`📧 [Abandoned Cart] Recovery email dispatched to ${order.customer_email} for Order #${order.id}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error('❌ [Abandoned Cart] Error:', err.message);
  }
});
// ==========================================
// 📦 9. كرون تتبع شحنات CJ وإرسال إشعارات WhatsApp التلقائية
// يفحص الطلبات المشحونة حديثاً، يستخرج رقم التتبع، ويرسله للزبون عبر واتساب
// ==========================================
cron.schedule('30 * * * *', async () => {
  console.log('⏳ [CJ Logistics] Checking for newly dispatched tracking numbers...');
  try {
    // جلب الطلبات المدفوعة التي لا تملك رقم تتبع بعد ومر عليها أقل من 15 يوماً
    const { rows: pendingTrackingOrders } = await pool.query(`
      SELECT id, customer_name, customer_email, customer_phone, shipping_address, total_amount 
      FROM orders 
      WHERE (status = 'paid' OR status = 'completed') 
        AND (tracking_number IS NULL OR tracking_number = '')
        AND created_at >= NOW() - INTERVAL '15 days'
      LIMIT 10;
    `);

    if (pendingTrackingOrders.length === 0) return;

    for (const order of pendingTrackingOrders) {
      try {
        await new Promise(r => setTimeout(r, 1200)); // احترام QPS

        // استعلام حالة الطلب وتفاصيل الشحنة من CJ
        const orderInfoRes = await cjRequest((token) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail', {
            headers: { 'CJ-Access-Token': token },
            params: { orderNumber: `STORE-${order.id}` }
          })
        );

        const cjData = orderInfoRes.data?.data;
        const trackNumber = cjData?.trackNumber || cjData?.trackingNumber;

        // ✨ إذا أصدرت CJ رقم التتبع للشحنة:
        if (trackNumber && typeof trackNumber === 'string' && trackNumber.trim().length > 3) {
          console.log(`🚀 [CJ Dispatched] Found tracking number for Order #${order.id}: ${trackNumber}`);

          // 1. تحديث قاعدة البيانات
          await pool.query(
            "UPDATE orders SET tracking_number = $1, status = 'fulfilled' WHERE id = $2",
            [trackNumber.trim(), order.id]
          );

          // 2. إرسال إشعار WhatsApp للزبون برقم التتبع (تم تصحيح تمرير الكائن)
          if (order.customer_phone) {
            await sendOrderTrackingWhatsApp({
              phone: order.customer_phone,
              customerName: order.customer_name,
              orderId: order.id,
              trackingNumber: trackNumber.trim(),
              email: order.customer_email
            });
          }

          // 3. إيميل تأكيد الشحن مع رقم التتبع
          if (order.customer_email && !order.customer_email.includes('@laclarc.com')) {
            const itemsRes = await pool.query(
              `SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
              [order.id]
            );
            sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, itemsRes.rows)
              .catch(err => logger.logError('Tracking Email Dispatch', err));
          }
        }
      } catch (orderErr) {
        logger.logError(`Tracking Sync Order #${order.id}`, orderErr);
      }
    }
  } catch (err) {
    logger.logError('CJ Tracking & WhatsApp Cron', err);
  }
});
// ==========================================
// 🤖 On-Site AI Sales Agent (Live Chat)
// ==========================================

// ✨ كشف اللغة تلقائياً — عشان الردود الاحتياطية تكون بنفس لغة الزبون
function detectLanguage(text) {
  const t = String(text || '').toLowerCase();

  // 1) حروف عربية → دارجة (المتجر جزائري: من يكتب بحروف عربية غالباً دارجي)
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';

  // 2) Arabizi — دارجة مكتوبة بحروف لاتينية/أرقام (wach, bghit, 3lach, chhal...)
  const arabiziMarkers = [
    'wach', 'wesh', 'kifash', 'kifach', 'kifch', '3lach', '3lah', 'bghit', 'nbghi',
    'chhal', 'ch7al', 'chhal ', 'sahbi', 'khoya', 'khouya', 'bzaf', 'bzzaf', 'chouia',
    'daba', 'dyal', 'zaama', 'walah', 'smahli', 'fhamt', 'weldi', 'hadchi', 'mezyan',
    'mzyan', '3ndk', '3andek', '3lik', '3liya', 'ghadi', 'salam', 'nchoufo', '3tini',
    'wfin', 'fin kayn', 'bghit n'
  ];
  if (arabiziMarkers.some(w => t.includes(w))) return 'ar';

  // 3) الفرنسية — حروف متشكلة ولا كلمات قوية
  if (/[éèêàçùôîïû]/.test(t)) return 'fr';
  const frenchMarkers = [
    'livraison', 'commande', 'combien', 'merci', 'bonjour', 'salut', 'quand',
    'prix', 'acheter', 'payer', 'paiement', 'retour', 'remboursement', 'colis',
    'suivi', 'je veux', 'je voudrais', 'c\'est quoi', 'qu\'est-ce', 'est-ce que',
    'où est', 'ou est', 'votre', 'mon colis', 'ma commande'
  ];
  if (frenchMarkers.some(w => t.includes(w))) return 'fr';

  // 4) الافتراضي: الإنجليزية
  return 'en';
}

// ✨ الردود الاحتياطية الثلاثية — بنفس اللغة ديال الزبون
const FALLBACK_REPLIES = {
  en: {
    limit: "You've reached the message limit for now. Please wait a few minutes, or reach us instantly on WhatsApp!",
    noAI: "Welcome to Laclarc! We offer fast, insured worldwide shipping and multiple payment options including cards and BaridiMob. How can I help you today?",
    error: "Thanks for reaching out to Laclarc! Our support team is always happy to help via the website or directly on WhatsApp!"
  },
  fr: {
    limit: "Vous avez atteint la limite de messages pour le moment. Patientez quelques minutes, ou contactez-nous directement sur WhatsApp !",
    noAI: "Bienvenue chez Laclarc ! Nous offrons une livraison rapide et assurée dans le monde entier, avec plusieurs moyens de paiement : carte bancaire et BaridiMob. Comment puis-je vous aider ?",
    error: "Merci de nous avoir contactés chez Laclarc ! Notre équipe support est toujours là pour vous aider via le site ou directement sur WhatsApp !"
  },
  ar: {
    limit: "وصلتي للحد ديال الرسائل حالياً. تسنى شي دقائق ولا تواصل معانا مباشرة عبر واتساب!",
    noAI: "مرحبا بيك في Laclarc! عننا شحن سريع ومؤمن لجميع دول العالم و58 ولاية، والدفع بالبطاقة ولا بريدي موب. واش نقدر نعاونك؟",
    error: "مرحبا بيك! يسعدنا تواصلك مع Laclarc. فريق الدعم ديالنا متاح ديما يعاونك عبر الموقع ولا مباشرة عبر واتساب!"
  }
};

// ✨ Rate Limiter بلغة الزبون — handler كيقرا الرسالة قبل الرفض
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30, // حماية رصيد الـ API
  handler: (req, res) => {
    const lang = detectLanguage(req.body?.message);
    res.status(429).json({ reply: FALLBACK_REPLIES[lang].limit });
  }
});

const ON_SITE_AI_PROMPT = `
أنت "Laclarc AI"، المساعد الذكي والدعم الفني المباشر لمتجر "Laclarc" (laclarc.com).
مهمتك: مساعدة الزائر بلباقة ولطف، الإجابة على استفساراته باختصار ودقة، وتشجيعه على الشراء.

قواعد الرد:
1. الإيجاز: أجب باختصار (جملتين أو 3 جمل كحد أقصى) لتناسب شاشة الشات الصغيرة.
2. اللهجة: إذا سأل بالدارجة الجزائرية رد بدارجة لطيفة ومحترمة. إذا سأل بالفرنسية أو الإنجليزية رد بنفس لغته.
3. المتجر: شحن سريع ومؤمن لجميع دول العالم ولـ 58 ولاية جزائرية (7 إلى 14 يوم عمل).
4. الدفع: بطاقات بنكية عالمية (Stripe)، عملات رقمية (Crypto)، وللجزائر بريدي موب BaridiMob / CCP.
5. الإرجاع: ضمان 30 يوماً.
`;

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const lang = detectLanguage(message); // ✨ لغة الزبون للردود الاحتياطية

  // 🛡️ IDOR Defense (Section 3.4 — same rule as the Track My Order page):
  // Real order data is injected into the prompt ONLY after matching
  // BOTH order_id AND customer_email.
  //
  // ✨ We scan the current message + previous user messages, so the flow works:
  // "Where is my order #123?" → bot asks for email → customer sends email alone → verified
  const recentUserTexts = [
    message,
    ...(Array.isArray(history) ? history.filter(h => h?.sender === 'user').map(h => String(h.text || '')) : [])
  ].join(' ');

  let orderContext = '';
  const orderMatch = recentUserTexts.match(/(?:#|order|طلب|commande)\s*[:#]?\s*(\d{1,8})/i);
  const emailMatch = recentUserTexts.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  if (orderMatch) {
    try {
      const orderId = orderMatch[1];

      if (!emailMatch) {
        // Defense-in-depth: حتى لو خالف الـ LLM التعليمات، لا توجد بيانات حقيقية في الـ prompt يمكن تسريبها
        orderContext = `\n[The customer asked about order #${orderId} but hasn't provided their email yet. Politely ask them to write the email address used in the order for verification, in the customer's language. Do NOT reveal any order information before verification.]`;
      } else {
        const orderRes = await pool.query(
          'SELECT id, status, total_amount, tracking_number, customer_email FROM orders WHERE id = $1',
          [orderId]
        );

        if (orderRes.rows.length === 0) {
          orderContext = `\n[No order found matching #${orderId}. Politely ask the customer to double-check the number, in the customer's language.]`;
        } else if (
          orderRes.rows[0].customer_email &&
          orderRes.rows[0].customer_email.toLowerCase() === emailMatch[0].toLowerCase()
        ) {
          // ✅ تطابق مزدوج (ID + Email) — الآن فقط نحقن البيانات الحقيقية
          const o = orderRes.rows[0];
          orderContext = `\n[Verified real order data: Order #${o.id}, status: "${o.status}". Amount: $${o.total_amount}. Tracking: "${o.tracking_number || 'being issued soon'}". Reassure the customer briefly, in the customer's language.]`;
        } else {
          // ❌ الإيميل غير مطابق — رد محايد، لا تأكيد حتى بوجود الطلب
          orderContext = `\n[Security: ownership of order #${orderId} could not be verified with this email. Politely apologize and suggest using the "Track My Order" page on the website with the correct email, in the customer's language. Do NOT reveal any order details and do NOT confirm whether the order exists.]`;
        }
      }
    } catch (dbErr) {
      logger.logError('Chat DB Check', dbErr);
    }
  }

  try {
    if (!genAI) {
      return res.json({ reply: FALLBACK_REPLIES[lang].noAI });
    }

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      systemInstruction: ON_SITE_AI_PROMPT + orderContext
    });

    const formattedHistory = Array.isArray(history) 
      ? history.slice(-4).map(h => ({
          role: h.sender === 'user' ? 'user' : 'model',
          parts: [{ text: h.text }]
        }))
      : [];

    const chat = model.startChat({
      history: formattedHistory,
      generationConfig: {
        maxOutputTokens: 250,
        temperature: 0.6,
      },
    });

    const result = await chat.sendMessage(message.trim().slice(0, 400));
    const replyText = result.response.text().trim();

    res.json({ reply: replyText });

  } catch (err) {
    logger.logError('AI Chat Error', err);
    res.json({ reply: FALLBACK_REPLIES[lang].error });
  }
});

// ==========================================
// 404 ومعالجة الأخطاء العامة
// ==========================================
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  logger.logError('Unhandled Error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==========================================
// 🛡️ حماية مستوى العملية (Process-Level Safety Nets)
// ==========================================

// 1. عدم إسقاط السيرفر بسبب مهام الخلفية (الـ IIFEs)
// الطلبات الفاشلة بعد 200 OK كيتصاوبهم كرون الـ Reconcile — Self-Healing
process.on('unhandledRejection', (reason) => {
  logger.logError('Unhandled Rejection', reason);
});

// 2. خط الدفاع الأخير: حالة العملية فاسدة بعد uncaught exception
// → خروج نظيف وRender يعاود يشغل نسخة سليمة أوتوماتيكياً
process.on('uncaughtException', async (err) => {
  logger.logError('Fatal Uncaught Exception', err);
  console.error('💥 Fatal Uncaught Exception! Draining connections and exiting for clean restart...', err);

  // ✨ شبكة أمان: إلا pool.end() علق (DB واصلة ماكاش) — مانخليوش العملية معلقة
  const forceExit = setTimeout(() => process.exit(1), 5000);

  try {
    await pool.end();
  } catch (e) {}

  clearTimeout(forceExit);
  process.exit(1);
});

// ==========================================
// 🚀 تشغيل خادم HTTP (مرة واحدة فقط)
// ==========================================
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`🚀 Laclarc Backend running on port ${PORT}`));

// ==========================================
// 🛑 الإغلاق الآمن الشامل (Zero-Downtime Graceful Shutdown)
// ملكية حصرية هنا — db.js ما عندوش حتى handler (توزيع نظيف)
// ==========================================
const handleShutdown = async (signal) => {
  console.log(`🛑 ${signal} received — closing HTTP server and draining DB pool...`);

  // ✨ سد فوري للاتصالات keep-alive الخاملة (Cloudflare/Vercel proxy)
  // بلا هاد السطر: close() كيتسنى حتى 5 ثواني (keepAliveTimeout) فكل deploy
  // الطلبات النشطة كتتكمل عادي — غير الخاملة اللي كيتسدو
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  server.close(async () => {
    console.log('✅ HTTP server closed.');
    try {
      await pool.end();
      console.log('✅ DB Pool drained.');
    } catch (e) {}
    process.exit(0);
  });

  setTimeout(() => {
    console.error('⚠️ Forcefully exiting after 10s shutdown timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));