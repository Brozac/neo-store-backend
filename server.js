require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { parseVariants, getCategorySlug, phoneAccRegex, pcBlacklistRegex } = require('./utils/parser');
const requireAdmin = require('./middleware/requireAdmin');
const rateLimit = require('express-rate-limit');
const { fulfillCJOrder, getCJToken, cjRequest, parseNumeric } = require('./services/cjService');
const { syncCategoriesFromCJ, getCategoryTree, resolveCategoryByCjId } = require('./services/categoryService');
const logger = require('./logger');

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');


const app = express();
const cookieParser = require('cookie-parser');
app.set('trust proxy', 1); // ✨ ضروري لعمل express-rate-limit على Render
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(cookieParser());

// ==========================================
// 1. الاتصال بقاعدة البيانات PostgreSQL
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()')
  .then(() => console.log('✅ Connected to PostgreSQL Database successfully!'))
  .catch((err) => console.error('❌ Database connection error:', err.stack));

// ==========================================
// تشغيل كل ساعة للتحقق من الطلبات المنتهية الصلاحية
// ==========================================
setInterval(async () => {
  try {
    await pool.query(`
      UPDATE orders 
      SET status = 'expired' 
      WHERE status = 'pending' AND payment_method = 'BaridiMob' 
      AND created_at < NOW() - INTERVAL '48 hours'
    `);
    console.log('✅ Expired pending BaridiMob orders checked.');
  } catch (err) {
    console.error('Cron job error:', err);
  }
}, 3600000);

// ✅ 1. Stripe Webhook (قبل express.json)
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

  // ✨ الرد على Stripe فوراً بـ 200 OK لمنع الـ Timeout!
  res.status(200).json({ received: true });

  // ✨ معالجة الطلب في الخلفية (بدون انتظار)
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (!orderId) return;

    try {
      const existingOrder = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      if (existingOrder.rows.length === 0) {
        logger.logError('Stripe Webhook', new Error(`Order #${orderId} not found`));
        return;
      }

      // منع المعالجة المكررة إذا أعاد Stripe المحاولة
      if (existingOrder.rows[0].status !== 'pending') {
        console.log(`⚠️ Order #${orderId} already processed. Skipping duplicate webhook.`);
        return;
      }

      const customerName = session.customer_details?.name || 'Guest Customer';
      const customerEmail = session.customer_details?.email || '';
      const addr = session.customer_details?.address;
      const shippingAddress = addr ? `${addr.line1 || ''}, ${addr.city || ''}, ${addr.country || ''}` : 'Online Store Purchase';
      const totalAmount = session.amount_total / 100;

      await pool.query(
        "UPDATE orders SET customer_name=$1, customer_email=$2, shipping_address=$3, total_amount=$4, status='paid' WHERE id=$5",
        [customerName, customerEmail, shippingAddress, totalAmount, orderId]
      );

      const itemsRes = await pool.query(`
        SELECT oi.*, p.title, p.image_url 
        FROM order_items oi 
        LEFT JOIN products p ON oi.product_id = p.id 
        WHERE oi.order_id = $1
      `, [orderId]);
      const items = itemsRes.rows;

      console.log(`✅ Order #${orderId} saved in database!`);

      // تنفيذ العمليات الثقيلة في الخلفية
      fulfillCJOrder(orderId, customerName, session.customer_details, items)
        .catch(err => logger.logError('CJ Fulfillment (Background)', err));

      if (customerEmail) {
        sendOrderConfirmationEmail(customerEmail, orderId, totalAmount, items)
          .catch(err => logger.logError('Send Email (Background)', err));
      }
    } catch (dbErr) {
      logger.logError('Stripe Webhook DB Update', dbErr);
    }
  }
});

// ✅ 2. express.json
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ✅ 3. راوتر الدفع المتعدد
const paymentRoutes = require('./controllers/paymentController');
app.use('/api/payment', paymentRoutes);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL ERROR: JWT_SECRET is not defined in .env file.');
  process.exit(1);
}

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

// ✨ نفس فكرة authenticateToken، بصح ماتوقفش الطلب إذا ماكانش توكن ولا كان خايب
// (نستعملوها فـ checkout باش نربطو الطلب بالحساب إذا الزبون رايح logged-in،
// وفـ نفس الوقت نخليو الـ guest checkout يخدم عادي بلا توكن)
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
// ✨ إرسال الإيميلات: Brevo (أساسي) + Resend (احتياطي تلقائي)
// السبب: Render يبلوكي outbound traffic على SMTP ports، فبعثنا بالـ HTTP API.
// وحيت حساب Brevo يحتاج تفعيل يدوي فـ البداية، زدنا Resend كـ fallback:
// إذا Brevo رجع خطأ (مهما كان السبب: ماهوش مفعّل، quota، ...)، نبعثو
// عبر Resend مباشرة بلا ما نوقفو تدفق التسجيل/الطلب.
//
// Env vars لازمين:
//   BREVO_API_KEY   → Brevo Dashboard → SMTP & API → API Keys
//   BREVO_USER      → الإيميل المرسل عندك فـ Brevo (موجود ديجا)
//   RESEND_API_KEY  → resend.com/api-keys (تفعيل فوري بلا مراجعة يدوية)
//   RESEND_FROM_EMAIL → اختياري، إيميل مرسل تحققت منه فـ Resend
//                        (إذا ماحطيتوش، نستعملو onboarding@resend.dev
//                        اللي يخدم للتجربة لكن يقيد الإرسال لإيميلك
//                        المسجل فـ Resend حتى توثق دومين)
// ==========================================
async function sendEmail({ to, subject, html }) {
  // 1) نجربو Brevo أولا (الحل الأساسي)
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'NEO Store Support', email: process.env.BREVO_USER },
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

  // 2) إذا فشل Brevo، نجربو Resend كـ fallback تلقائي
  try {
    await axios.post('https://api.resend.com/emails', {
      from: process.env.RESEND_FROM_EMAIL || 'NEO Store <onboarding@resend.dev>',
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
// إعداد مجلد رفع الصور و Multer
// ==========================================
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// ✨ إعداد Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ✨ إعداد Multer لاستخدام Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'neo_store_uploads', // اسم المجلد في Cloudinary
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp']
  }
});
const upload = multer({ storage: storage });

// ==========================================
// فحص متغيرات البيئة الأساسية في الإنتاج
// ==========================================
if (process.env.NODE_ENV === 'production') {
  const requiredEnvVars = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'JWT_SECRET', 'CJ_API_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'BREVO_API_KEY', 'BREVO_USER', 'RESEND_API_KEY'];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables in production: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ==========================================
// مسار تسجيل دخول الأدمن
// ==========================================
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
    
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 2 * 60 * 60 * 1000
    });

    return res.json({ message: 'Logged in successfully' });
  }
  res.status(401).json({ message: 'Invalid admin credentials' });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ message: 'Logged out successfully' });
});

app.use('/api/admin', requireAdmin);

// ==========================================
// 3. مسار استخراج بيانات المنتج من رابط (Scrape)
// ==========================================
app.post('/api/admin/scrape-product', async (req, res) => {
  let browser;
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    try { await page.waitForSelector('img', { timeout: 10000 }); } 
    catch (e) { throw new Error('Page took too long to load or blocked the scraper.'); }

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
    res.status(500).json({ error: 'Failed to scrape this URL. The site might be blocking bots.' });
  } finally {
    if (browser) await browser.close();
  }
});

// ==========================================
// مسارات الكوبونات (Coupons)
// ==========================================
app.post('/api/validate-coupon', async (req, res) => {
  try {
    const { code, cartTotal } = req.body;
    const result = await pool.query('SELECT * FROM coupons WHERE code = $1 AND is_active = true', [code.toUpperCase()]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid or expired coupon code.' });

    const coupon = result.rows[0];
    let discount = coupon.discount_type === 'percentage' ? (cartTotal * coupon.discount_value) / 100 : coupon.discount_value;

    res.json({
      discount: parseFloat(discount).toFixed(2),
      newTotal: parseFloat(cartTotal - discount).toFixed(2),
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

// ==========================================
// 3.5 مسارات التقييمات (Reviews)
// ==========================================
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

app.post('/api/reviews/add', authenticateToken, async (req, res) => {
  try {
    const { product_id, rating, content, country } = req.body;
    const userId = req.user.id;
    const userName = req.user.name;

    if (!product_id || !content) {
      return res.status(400).json({ error: 'Product ID and content are required' });
    }

    await pool.query(
      'INSERT INTO reviews (product_id, author, user_id, rating, content, country) VALUES ($1, $2, $3, $4, $5, $6)',
      [product_id, userName, userId, rating || 5, content, country || 'United States']
    );

    res.status(201).json({ message: 'Review added successfully!' });
  } catch (err) {
    logger.logError('Add Review (Authenticated)', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/api/admin/upload', upload.array('images', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    // ✨ Cloudinary يرجع الرابط في file.path
    const urls = req.files.map(file => file.path);
    res.status(200).json({ urls });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// ✨ مسار رفع صورة للمستخدمين العاديين (ماشي أدمن)
// السبب: صفحة "My Profile" كانت تبعث لـ /api/admin/upload، وهاذي محمية بـ
// requireAdmin (app.use('/api/admin', requireAdmin) فوق يخليها تطلب admin_token
// cookie) — زبون عادي معندوش هاذ الكوكي، فالرفع كان يفشل بصمت والصورة
// ماكانتش تتسجل. هاذ المسار محمي غير بـ authenticateToken (JWT ديال المستخدم).
app.post('/api/upload', authenticateToken, upload.array('images', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    // ✨ Cloudinary يرجع الرابط في file.path
    const urls = req.files.map(file => file.path);
    res.status(200).json({ urls });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// ==========================================
// 4. مسار إضافة منتج يدوياً
// ==========================================
app.post('/api/admin/add-product', async (req, res) => {
  try {
    let { title, price: costPrice, image_url, images, description, material, colors, sizes, category } = req.body;
    if (!title || !costPrice || !image_url) return res.status(400).json({ error: 'Title, cost price, and image_url are required' });

    const cjProductId = `MANUAL_${Date.now()}`;
    const imagesArray = images && images.length > 0 ? images : [image_url];
    const colorsArray = colors || [];
    const sizesArray = sizes || [];

    const calculateAutoPrice = (cost) => {
      const costNum = Number(cost) || 0;
      if (costNum <= 0) return { sellPrice: 0, oldPrice: 0 };
      let sellingPrice = costNum <= 5 ? costNum * 3.5 : costNum <= 15 ? costNum * 2.8 : costNum <= 30 ? costNum * 2.2 : costNum * 1.8;
      sellingPrice = Math.floor(sellingPrice) - 0.01;
      if (sellingPrice < 9.99) sellingPrice = 9.99;
      return { sellPrice: parseFloat(sellingPrice.toFixed(2)), oldPrice: parseFloat((sellingPrice * 1.5).toFixed(2)) };
    };

    const { sellPrice, oldPrice } = calculateAutoPrice(costPrice);

    await pool.query(
      `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, stock_status, cj_product_id, description, material, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [title, sellPrice, oldPrice, image_url, imagesArray, JSON.stringify([]), colorsArray, sizesArray, true, cjProductId, description || 'High quality product from NEO Store.', material || 'Premium Quality', category || 'other']
    );

    res.status(201).json({ message: 'Product added successfully with Auto-Pricing!', calculatedPrice: sellPrice, originalPrice: oldPrice });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسارات إدارة المنتجات
// ==========================================
app.delete('/api/admin/delete-product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE products SET stock_status = false WHERE id = $1', [id]);
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
    res.json({ message: 'Order updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/reorder-products', async (req, res) => {
  try {
    const { items } = req.body;
    const updatePromises = items.map((item, index) => pool.query('UPDATE products SET sort_order = $1 WHERE id = $2', [index, item.id]));
    await Promise.all(updatePromises);
    res.json({ message: 'Order updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسارات إدارة النزاعات والتتبع
// ==========================================
app.get('/api/admin/disputes', async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.get('https://developers.cjdropshipping.com/api2.0/v1/disputes/getDisputeList', { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/disputes/create', async (req, res) => {
  try {
    const { orderId, disputeReasonId, expectType, refundType, messageText, productInfoList } = req.body;
    const payload = { orderId, businessDisputeId: `NEO_DISPUTE_${Date.now()}`, disputeReasonId, expectType, refundType, messageText, productInfoList };
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/disputes/create', payload, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
    if (response.data.code === 200) res.json({ message: 'Dispute created successfully!' });
    else res.status(400).json({ error: response.data.message || 'Failed to create dispute' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/track/:trackNumber', async (req, res) => {
  try {
    const { trackNumber } = req.params;
    const response = await cjRequest((token) => axios.get(`https://developers.cjdropshipping.com/api2.0/v1/logistic/trackInfo`, { headers: { 'CJ-Access-Token': token }, params: { trackNumber: trackNumber } }));
    if (response.data.code === 200) res.json(response.data.data);
    else res.status(400).json({ error: response.data.message || 'Tracking number not found' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// 4.5 مسارات شجرة فئات CJ الرسمية
// ==========================================
app.post('/api/admin/sync-categories', async (req, res) => {
  try {
    const result = await syncCategoriesFromCJ();
    categoryTreeCache = null;
    res.json({ message: `Categories synced! Level 1: ${result.level1Count}, Level 2: ${result.level2Count}, Level 3: ${result.level3Count}.`, ...result });
  } catch (err) {
    logger.logError('Sync Categories', err);
    res.status(500).json({ error: 'Failed to sync categories from CJ', details: err.message });
  }
});

let categoryTreeCache = null;
let categoryTreeCacheTime = 0;
const CATEGORY_TREE_CACHE_TTL = 10 * 60 * 1000;

app.get('/api/categories', async (req, res) => {
  try {
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
  try {
    const { rows } = await pool.query(
      `SELECT id, cj_product_id FROM products
       WHERE cj_category_id IS NULL AND cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%'`
    );

    console.log(`⏳ Starting backfill for ${rows.length} products...`);

    let updatedCount = 0;
    const skipped = [];

    for (const p of rows) {
      try {
        await new Promise((r) => setTimeout(r, 1200));

        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', { ...config, headers: { 'CJ-Access-Token': token }, params: { pid: p.cj_product_id } })
        );

        const details = detailRes.data?.data;
        const cjCategoryId = details?.categoryId;
        if (!cjCategoryId) { 
          console.log(`⚠️ Skipped ${p.id} (No categoryId found)`);
          skipped.push(p.id); 
          continue; 
        }

        const resolved = await resolveCategoryByCjId(cjCategoryId);
        const newCategory = resolved ? resolved.slugPath : getCategorySlug(`${details.categoryName || ''} ${details.productNameEn || ''}`);

        await pool.query('UPDATE products SET cj_category_id = $1, category = $2 WHERE id = $3', [cjCategoryId, newCategory, p.id]);
        console.log(`✅ Updated product ${p.id} -> ${newCategory}`);
        updatedCount++;
      } catch (itemErr) {
        console.log(`⚠️ Skipped ${p.id} due to error:`, itemErr.message);
        skipped.push(p.id);
      }
    }

    productsCache = null;
    console.log(`🎉 Backfill complete! Updated: ${updatedCount}, Skipped: ${skipped.length}`);
    res.json({ message: `Backfilled ${updatedCount} product(s). ${skipped.length} skipped.`, updatedCount, skippedIds: skipped });
  } catch (err) {
    logger.logError('Backfill Categories', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ==========================================
// 5. مسار مزامنة منتجات CJ
// ==========================================
app.get('/api/sync-cj-products', requireAdmin, async (req, res) => {
  try {
    const keyword = req.query.keyword || '';
    const pagesToFetch = 5; 
    const pageSize = 20;
    let importedCount = 0;

    for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
      console.log(`Fetching page ${pageNum} for keyword: ${keyword || 'Trending'}...`);

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
          if (phoneAccRegex.test(lowerTitle)) continue;
          if (pcBlacklistRegex.test(lowerTitle)) continue;

          if (!hasTitle || !hasMainImage || !hasImages || !hasValidDescription || !hasPrice || !hasVariants || !isWorldwideShipping) continue;

          const cjPrice = parseNumeric(details.sellPrice);
          let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
          sellingPrice = Math.floor(sellingPrice) - 0.01;
          if (sellingPrice < 9.99) sellingPrice = 9.99;
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
            const videoRes = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/queryVideosByProductId', { productId: productId }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
            if (videoRes.data.code === 200 && videoRes.data.data?.length > 0) videoUrl = videoRes.data.data[0].videoUrl;
          } catch (e) {}

          await pool.query(
            `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, stock_status, cj_product_id, description, material, category, video_url, cj_category_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (cj_product_id) DO UPDATE SET 
               title=EXCLUDED.title, price=EXCLUDED.price, original_price=EXCLUDED.original_price, 
               image_url=EXCLUDED.image_url, images=EXCLUDED.images, variants=EXCLUDED.variants, 
               colors=EXCLUDED.colors, sizes=EXCLUDED.sizes, stock_status=EXCLUDED.stock_status, 
               description=EXCLUDED.description, material=EXCLUDED.material, category=EXCLUDED.category, 
               video_url=EXCLUDED.video_url, cj_category_id=EXCLUDED.cj_category_id`,
            [details.productNameEn, safePrice, safeOriginalPrice, details.bigImage, details.productImageSet, JSON.stringify(details.variants || []), parsedData.colors, parsedData.sizes, true, details.pid, details.description, material, categorySlug, videoUrl, cjCategoryId]
          );

          try {
            await new Promise(r => setTimeout(r, 500));
            await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/addToMyProduct', { productId: productId }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
          } catch (addToMyErr) {
            if (addToMyErr.response?.data?.code !== 1600000) console.log(`⚠️ Note: Could not add ${productId} to My Products.`);
          }

          importedCount++;
        } catch (productErr) {
          console.log(`⚠️ Skipped ${productId} due to error.`);
        }
      }
    }

    res.json({ message: `Sync complete! Imported ${importedCount} products for keyword: ${keyword || 'Trending'}.`, count: importedCount });
  } catch (error) {
    console.error('CJ Sync Error:', error.message);
    res.status(500).json({ error: 'Failed to sync products', details: error.message });
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

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { message: 'Too many attempts, please try again after 15 minutes.' } });

// ==========================================
// 7. مسارات المصادقة (Authentication)
// ==========================================
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userExists.rows.length > 0) return res.status(400).json({ message: 'Email already registered' });

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
            [name, email, passwordHash]
        );

        const verifyToken = jwt.sign({ id: newUser.rows[0].id }, JWT_SECRET, { expiresIn: '1d' });
        const verifyUrl = `${process.env.FRONTEND_URL}/auth/verify-email?token=${verifyToken}`;

        // ✨ إرسال الإيميل في الخلفية (بدون await) لكي لا يعلق المستخدم في Loading
        sendEmail({
          to: email,
          subject: 'Confirm your Email for NEO Store',
          html: `<h2>Welcome to NEO Store, ${name}!</h2>
                 <p>Please click the button below to activate your account:</p>
                 <a href="${verifyUrl}" style="background-color:#8B78C6; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; font-weight:bold;">Verify My Email</a>`
        });

        res.status(201).json({ message: 'User registered successfully! Please check your email to verify your account.' });
    } catch (error) {
        console.error("Register Error:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).send('Invalid token.');
        const decoded = jwt.verify(token, JWT_SECRET);
        await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [decoded.id]);
        res.send('<h1 style="color:#8B78C6; text-align:center; margin-top:50px;">Email verified successfully! 🎉</h1><p style="text-align:center;">You can now <a href="/auth">log in</a> to your account.</p>');
    } catch (err) {
        res.status(400).send('<h1 style="color:red; text-align:center; margin-top:50px;">Invalid or expired link.</h1>');
    }
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            const resetToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '15m' });
            const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${resetToken}`;

            // ✨ إرسال الإيميل في الخلفية (بدون await)
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
        console.error("Forgot Password Error:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
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
        console.error("Login Error:", error);
        res.status(500).json({ message: 'Server error' });
    }
});

// ==========================================
// مسارات إدارة طلبات BaridiMob (Manual Orders)
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
    await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [id]);

    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
    
    if (orderRes.rows.length > 0) {
      const order = orderRes.rows[0];
      const items = itemsRes.rows;
      let parsedAddress = {};
      try { parsedAddress = JSON.parse(order.shipping_address); } 
      catch (e) { parsedAddress = { line1: order.shipping_address, country: 'DZ' }; }

      const customerDetails = { address: parsedAddress, phone: order.customer_phone };
      await fulfillCJOrder(order.id, order.customer_name, customerDetails, items);

      // ✨ نبعثو إيميل تأكيد للزبون هنا زادة (قبل، كان يتبعث غير كي الدفع
      // يكون عبر Stripe؛ طلبات BaridiMob كانت توليو موافق عليها بلا ما يوصل
      // أي إيميل للزبون)
      if (order.customer_email) {
        const emailItemsRes = await pool.query(
          `SELECT oi.quantity, oi.price_at_purchase, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
          [id]
        );
        await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, emailItemsRes.rows);
      }
    }

    res.json({ message: 'Order approved and sent to CJ successfully!' });
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

// ==========================================
// مسار البحث الذكي (Live Search)
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
  if (q.length < 1) return res.json([]);

  try {
    const result = await pool.query("SELECT id, title, price, original_price, image_url, stock_status FROM products WHERE title ILIKE $1 ORDER BY id DESC LIMIT 50", [`%${q}%`]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسار التصنيف الذكي التلقائي (Auto-Categorize)
// ==========================================
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

    const client = await pool.connect();
    let updatedCount = 0;
    const errors = [];

    try {
      await client.query('BEGIN');
      for (const c of changes) {
        try {
          await client.query('UPDATE products SET category = $1 WHERE id = $2', [c.to, c.id]);
          updatedCount++;
        } catch (itemErr) {
          errors.push({ id: c.id, error: itemErr.message });
        }
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ message: `Successfully re-categorized ${updatedCount} product(s).`, count: updatedCount, categoryStats, errors: errors.length ? errors : undefined });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ==========================================
// 8. مسارات التطبيق الأخرى (API Routes)
// ==========================================
app.get('/', (req, res) => res.send('Dropshipping API is running on point!'));

let productsCache = null;
let cacheTime = 0;
const CACHE_TTL = 60000;

app.get('/api/products', async (req, res) => {
  try {
    const search = req.query.search || '';
    const category = req.query.category || 'All';
    
    if (search === '' && category === 'All') {
      if (productsCache && (Date.now() - cacheTime < CACHE_TTL)) {
        return res.json(productsCache);
      }
      const result = await pool.query('SELECT id, title, price, original_price, image_url, category FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC');
      productsCache = result.rows;
      cacheTime = Date.now();
      return res.json(result.rows);
    }

    let query = 'SELECT id, title, price, original_price, image_url, category FROM products WHERE stock_status = true';
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
// ✨ مسار جديد لجلب تفاصيل منتج واحد بالكامل (لصفحة المنتج)
app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // جلب كل الأعمدة بما فيها images, description, colors, sizes, video_url
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    
    // تحويل نص images إلى مصفوفة إذا كان نصاً
    const product = result.rows[0];
    if (product.images && typeof product.images === 'string') {
      try { product.images = JSON.parse(product.images); } catch (e) {}
    }
    
    res.json(product);
  } catch (err) {
    console.error('❌ Error fetching product details:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, origin, couponCode } = req.body;
    let baseUrl = origin && origin.startsWith('http') ? origin : 'http://localhost:3000';
    baseUrl = baseUrl.replace(/\/+$/, '');

    // ✨ إذا الزبون logged-in، نربطو الطلب بالحساب متاعو (user_id) باش يبان فـ "My Orders"
    // حتى لو دخل إيميل مختلف فـ Stripe Checkout. الـ guest checkout يبقى يخدم عادي (user_id = null).
    const optionalUser = getOptionalUser(req);
    const orderResult = await pool.query(
      "INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      ['Pending Customer', 'pending@neo.com', 'Pending', 0, 'pending', optionalUser ? optionalUser.id : null]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      await pool.query("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)", [orderId, item.id, item.quantity, Number(item.price) || 0, item.vid || null]);
    }

    let stripeDiscounts = [];
    if (couponCode) {
      const couponRes = await pool.query('SELECT * FROM coupons WHERE code = $1 AND is_active = true', [couponCode.toUpperCase()]);
      if (couponRes.rows.length > 0) {
        const coupon = couponRes.rows[0];
        const stripeCouponData = coupon.discount_type === 'percentage' ? { percent_off: parseFloat(coupon.discount_value), duration: 'once' } : { amount_off: Math.round(parseFloat(coupon.discount_value) * 100), currency: 'usd', duration: 'once' };
        const stripeCoupon = await stripe.coupons.create(stripeCouponData);
        stripeDiscounts = [{ coupon: stripeCoupon.id }];
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: items.map(item => {
        const hasValidImage = item.image_url && typeof item.image_url === 'string' && item.image_url.startsWith('http');
        return { price_data: { currency: 'usd', product_data: { name: item.title || 'Product', images: hasValidImage ? [item.image_url] : [] }, unit_amount: Math.round(Number(item.price || 0) * 100) }, quantity: Number(item.quantity || 1) };
      }),
      mode: 'payment',
      shipping_address_collection: { allowed_countries: ['US', 'GB', 'CA', 'DZ', 'AE', 'SA', 'FR', 'DE', 'MA', 'TN'] },
      phone_number_collection: { enabled: true },
      discounts: stripeDiscounts,
      shipping_options: [
        { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'usd' }, display_name: 'Standard Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 15 }, maximum: { unit: 'business_day', value: 35 } } } },
        { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 1500, currency: 'usd' }, display_name: 'Worldwide Express Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 7 }, maximum: { unit: 'business_day', value: 15 } } } }
      ],
      metadata: { orderId: orderId.toString() },
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.logError('Create Checkout Session', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT oi.quantity, oi.price_at_purchase, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ✨ مسار "My Orders" الخاص بالحساب المسجّل — يجيب الطلبات المربوطة بـ user_id
// (الطلبات الجديدة بعد هاذ التعديل)، وكـ fallback يجيب حتى الطلبات القديمة
// اللي إيميلها يطابق إيميل الحساب (لكن ماشي الطلبات pending اللي مازال معندهاش إيميل حقيقي).
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
    const result = await pool.query(`SELECT * FROM orders WHERE id::text = $1 OR customer_email = $2 ORDER BY id DESC`, [identifier, identifier]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No orders found' });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/update-category/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { category } = req.body;
    if (!category) return res.status(400).json({ error: 'Category is required' });
    await pool.query('UPDATE products SET category = $1 WHERE id = $2', [category, id]);
    res.json({ message: 'Category updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/update-product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, price, original_price, image_url, images, description, material, colors, sizes, category } = req.body;
    await pool.query(`UPDATE products SET title = $1, price = $2, original_price = $3, image_url = $4, images = $5, description = $6, material = $7, colors = $8, sizes = $9, category = $10 WHERE id = $11`, [title || null, Number(price) || 0, Number(original_price) || 0, image_url || null, images || null, description || null, material || null, colors || null, sizes || null, category || 'other', id]);
    res.json({ message: 'Product updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query('SELECT name, email, profile_picture FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) return res.status(404).json({ message: "User not found" });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, profilePicture } = req.body;
        if (!name) return res.status(400).json({ message: 'Name is required' });
        const updatedUser = await pool.query('UPDATE users SET name = $1, profile_picture = $2 WHERE id = $3 RETURNING id, name, email, profile_picture', [name, profilePicture, userId]);
        res.json(updatedUser.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// ==========================================
// 10. خدمات الإيميل (النسخة الاحترافية الإنجليزية)
// ==========================================
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
            <tbody>
              ${itemsHtml}
            </tbody>
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

    await sendEmail({
      to: email,
      subject: `Order Confirmation #${orderId} - NEO Store`,
      html: htmlContent
    });
    console.log(`📧 Professional confirmation email sent to ${email}`);
  } catch (err) {
    logger.logError('Send Order Email', err);
  }
}

// ==========================================
// مسارات النظام المتقدم
// ==========================================
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

app.get('/api/addresses', async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/privateInventory/address/list', {}, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/addresses/create', async (req, res) => {
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
// 11. تشغيل السيرفر
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server is running on http://localhost:${PORT}`));