// server.js — Laclarc Enterprise Dropshipping Engine (hardened)
// Full audit applied 2026-10-02 (findings #1–#28 across session)
// 🩹 HOTFIX v2.0.1 — تهريب wildcards ديال LIKE/ILIKE (% _ \) — PostgreSQL كيستعمل \ كـ escape افتراضي
function escapeLikeSafe(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

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
const { applyCouponToTotal } = require('./utils/couponHelper'); // ✨ Helper الكوبون الموحد
const { detectAndConvert, SUPPORTED } = require('./lib/currency');
const { translateProduct, getLangFromCountry } = require('./lib/i18nEngine');

const requireAdmin = require('./middleware/requireAdmin');
const rateLimit = require('express-rate-limit');
const { setConversionContext } = require('./services/conversionService');
const { secondShotConversion } = require('./services/conversionService');
const { fulfillCJOrder, cjRequest, parseNumeric, autoRepairLogistics, sendAdminAlert, deleteCJOrder, payCJOrderBalance } = require('./services/cjService');
const { syncCategoriesFromCJ, getCategoryTree, resolveCategoryByCjId } = require('./services/categoryService');
const { buildProductRow, upsertProductRow } = require('./services/productImportService');
const { selfHealStuckOrders, disputeWatchdogCron, auditEvent } = require('./services/cjService');
const logger = require('./logger');
const { sendOrderTrackingWhatsApp } = require('./services/whatsappService');
const shipTruth = require('./services/shipTruth'); // كان مستعمل بلا require → ReferenceError → 500 دايماً
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const cron = require('node-cron');

// 🩹 FIX 18-C1 — CJ_API كان غير معرّف فـ server.js (معرّف غير داخل services/*) → ReferenceError
//   كايقبل كرونات TopSellers (0 5 * * *) كل يوم 5ص بصمت — الميزة كانت ميتة من الولادة (Task 18)
const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

// ✨ Pool واحد مشترك من db.js
const pool = require('./db');

// ──── [LACLARC::SENTRY-INIT] v1 (Task 16) ────
// 👁️ Sentry Phase 1 — عيون الموقع (Tenet: 记录即真相 / catch 中禁止沉默).
//    DSN كيجي من البيئة (Render → SENTRY_DSN). بلا DSN = no-op آمن:
//    النشر كيمشي قبل ما تضبط المفاتيح — صفر خطأ، تفعيل لحظة ما تزيد الـ var.
//    ⚠️ هاد البلوك قبل أي route — نفس درس first-line injection (Task 14-c).
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
  release: 'laclarc-server@' + (process.env.RENDER_GIT_COMMIT || 'dev'),
  tracesSampleRate: 0, // مرحلة 1 = أخطاء فقط (مجاني 5K/شهر)
  beforeSend(event) {
    // Privacy scrub — معطيات المستخدمين ما كتمشيش لـ Sentry
    if (event.user) delete event.user;
    if (event.request) { delete event.request.cookies; delete event.request.headers; }
    return event;
  },
});
// ──── [/LACLARC::SENTRY-INIT] ────

const app = express();

// ──── [LACLARC::SENTRY-REQ] v2 (Task 16-b hotfix) ────
// request context — v2: تصحيح باغ الإنتاج (TypeError: app.use() requires a middleware function)
//   الجذر (مثبت بالـ SDK الحقيقي 10.76.2): expressIntegration() كترجع integration object
//     { name, setupOnce, getShouldHandleError } ماشي middleware → app.use() كيرمي TypeError
//   بلاصتها الصحيحة فv8+: Sentry.init({ integrations: [Sentry.expressIntegration()] })
//   القرار لمرحلة 1 (أخطاء فقط · tracesSampleRate: 0):
//     · v8+/v10: حتى request middleware ما خاص — setupExpressErrorHandler (بلوك SENTRY-ERR)
//       + httpIntegration (مفعّل by default) كيكفيان لالتقاط الأخطاء مع سياق الطلب
//     · v7 فقط: Sentry.Handlers.requestHandler() — كيرجع middleware حقيقي (function)
if (Sentry.Handlers && typeof Sentry.Handlers.requestHandler === 'function') {
  app.use(Sentry.Handlers.requestHandler());     // v7 فقط — آمن: كيرجع function
}
// ──── [/LACLARC::SENTRY-REQ] ────

// ──── [LACLARC::SENTRY-TEST] v1 (Task 16) ────
// 🔬 marker endpoint — البرهان الحي (منهجية Task 14-c):
//    curl "https://<host>/__sentry_test?go=1"  →  الحدث فـ dashboard ≤60s
app.get('/__sentry_test', (req, res) => {
  if (req.query.go === '1') {
    Sentry.captureMessage('LACLARC-SENTRY-OK :: test event from ' + (req.ip || 'unknown'), 'info');
    return res.json({ ok: true, marker: 'LACLARC-SENTRY-OK', note: 'Check your Sentry dashboard within ~60 seconds' });
  }
  return res.json({ ok: true, marker: 'LACLARC-SENTRY-OK', hint: 'add ?go=1 to fire a test event' });
});
// ──── [/LACLARC::SENTRY-TEST] ────
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
  max: 25, // كافية للزبون الطبيعي وتمنع البوتات
  message: { error: 'Too many checkout attempts, please try again in a few minutes.' }
});
const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many tracking requests.' } });
// 🩹 FIX#6 — second-shot amplification shield (dedup يحمي عدّ Meta، لا يحمي DB من النداءات)
const secondShotLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: { error: 'Too many verification requests.' } });
// 🩹 P1 (Task 19-D) — wheel/claim كان بلا limiter: سكريبت كيولّد كوبونات 15% بلا حدود
//   (jwt.sign بلا حتى مصادقة). الـ limiter يشدّ السُحب الآلي — التحقق الجانبي للسحبة
//   (سجل spin) راه فالمرحلة 2 (خارطة الطريق).
const wheelLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many wheel claims, please try again later.' } });

const ALL_WORLD_COUNTRIES = ['AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ'];

// 🩹 FIX#3/#8 — email & password hygiene (مشتركة بين كل مسارات auth)
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const assertStrongPassword = (pwd) => typeof pwd === 'string' && pwd.length >= 8;

// ✨ كاش Stripe Coupons — 🩹 FIX#12: DB-backed (كان in-memory — كل deploy كيسرّب كوبون يتيم)
const stripeCouponCache = new Map();
async function getOrCreateStripeCoupon(couponData) {
  const key = JSON.stringify(couponData);
  if (stripeCouponCache.has(key)) return stripeCouponCache.get(key);

  // جرّب الـ DB cache الأول (يعيش عبر deploys)
  try {
    const persisted = await pool.query(
      'SELECT value FROM store_settings WHERE key = $1',
      ['stripe_coupon_' + key]
    );
    if (persisted.rows[0]?.value) {
      stripeCouponCache.set(key, persisted.rows[0].value);
      return persisted.rows[0].value;
    }
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    console.warn('⚠️ [CouponCache] read failed: ' + e.message);
  }

  const sc = await stripe.coupons.create(couponData);
  stripeCouponCache.set(key, sc.id);
  if (stripeCouponCache.size > 200) {
    stripeCouponCache.delete(stripeCouponCache.keys().next().value);
  }
  // persist — ما عادش يتيم
  await pool.query(
    "INSERT INTO store_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
    ['stripe_coupon_' + key, sc.id]
  ).catch((e) => console.warn('⚠️ [CouponCache] persist failed: ' + e.message));
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
  // 🩹 FIX#5 — NOWPAYMENTS: إما مربوط، أو crypto مقفول صراحةً (ماشي اكتشاف بأول زبون)
  if (!process.env.NOWPAYMENTS_API_KEY) {
    console.error('⚠️ NOWPAYMENTS_API_KEY missing — crypto gateway will be LOCKED (503). Set it before enabling Crypto.');
  }
}

// ═══════════════════════════════════════════════════════════════
// 🛡️ ADMIN SURFACE ENFORCER — سياج مركزي (Defense in Depth)
// ═══════════════════════════════════════════════════════════════
const ADMIN_PUBLIC_EXCEPTIONS = new Set([
  '/api/admin/login',
  '/api/admin/logout',
]);

app.use((req, res, next) => {
  // 🩹 hygiene — bare '/api/admin' محروس كذلك
  const isAdminPath = req.path === '/api/admin' || req.path.startsWith('/api/admin/');
  if (!isAdminPath || ADMIN_PUBLIC_EXCEPTIONS.has(req.path)) {
    return next();
  }

  let token = req.cookies?.admin_token;
  if (!token && req.headers['authorization']) {
    const parts = req.headers['authorization'].split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') token = parts[1];
  }

  if (!token) {
    logger.logError('ADMIN-SURFACE VIOLATION', new Error(`${req.method} ${req.path} — IP: ${req.ip} — no token`));
    return res.status(401).json({ error: 'Access Denied: Administrative authentication required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      logger.logError('ADMIN-SURFACE VIOLATION', new Error(`${req.method} ${req.path} — IP: ${req.ip} — insufficient role`));
      return res.status(403).json({ error: 'Access Denied: Administrative privileges required' });
    }
    req.user = decoded;
    return next();
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('ADMIN-SURFACE VIOLATION', new Error(`${req.method} ${req.path} — IP: ${req.ip} — invalid token`));
    return res.status(403).json({ error: 'Access Denied: Invalid administrative token' });
  }
});

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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Stripe Webhook Signature', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.status(200).json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = parseInt(session.metadata?.orderId, 10);
    if (!Number.isFinite(orderId)) return; // 🛡️ metadata تالفة → تجاهل بنعومة

    (async () => {
      try {
        // 🩹 M#33 FIX: fallback لـ Stripe API الجديد:
        const customerName = session.customer_details?.name || 'Guest Customer';
        const customerEmail = normalizeEmail(session.customer_details?.email);   // 🩹 FIX#8
        const customerPhone = session.customer_details?.phone
                           || session.collected_information?.shipping_details?.phone
                           || session.collected_information?.phone_number
                           || '';
        const addr = session.customer_details?.address
                  || session.collected_information?.shipping_details?.address
                  || null;
        const shippingAddress = addr ? JSON.stringify(addr) : JSON.stringify({ line1: 'Online Store Purchase', country: 'US' });
        const totalAmount = session.amount_total / 100;

        // 🚨 قفل ذري: واحد فقط كيربح (هادا ولا JIT verifier)
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

        // ✅ v2 — بلا 'completed': الحالة تبقى paid، webhook SHIPPED هو اللي كيرفعها
        if (cjResponse && cjResponse.success) {
          console.log(`📤 [Stripe WH] #${orderId} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
        } else {
          console.error(`❌ [Stripe WH] CJ fulfillment فشل لـ #${orderId} → manual داخل fulfillCJOrder`);
        }

        if (customerEmail) {
          sendOrderConfirmationEmail(customerEmail, orderId, totalAmount, items)
            .catch(err => logger.logError('Send Email (Background)', err));
        }
      } catch (dbErr) { try { Sentry.captureException(dbErr); } catch (__laclarcGuard) {}
        logger.logError('Stripe Webhook DB Update', dbErr);
      }
    })();
  }
});

// ==========================================
// 1.5 مسار CJ Webhook (يجب أن يبقى قبل express.json — بحال Stripe)
// ==========================================
const {
  cjWebhookHandler,
  notifyShipment,
  registerWebhooks,
  subscribeAllStoreProducts
} = require('./services/cjWebhookService');
app.post('/api/cj-webhook', express.raw({ type: 'application/json' }), cjWebhookHandler);

// ==========================================
// 2. Middlewares الأساسية
// ==========================================
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use(require('./routes/paymentGateways'));

// راوتر الدفع
const paymentRoutes = require('./controllers/paymentController');
app.use('/api/cj-live', require('./routes/cjLiveBridge'));
app.use('/api/payment', paymentRoutes);
// ==========================================
// 🩹 M#29 — Status Labels (human-readable, unified)
// ==========================================
function getStatusLabel(status) {
  const MAP = {
    'pending':           '⏳ Awaiting Payment',
    'paid':              '✅ Payment Confirmed',
    'awaiting_exchange': '📦 Alternative Offered — Check Email',
    'processing':        '⏳ Processing',
    'manual':            '⏳ Under Review',
    'fulfilled':         '🚚 Shipped',
    'completed':         '✅ Delivered',
    'refunded':          '💰 Refunded',
    'cancelled':         '❌ Cancelled',
    'expired':           '⏱ Expired',
    'archived':          '📦 Archived',
  };
  return MAP[String(status || '').toLowerCase()] || String(status || '');
}

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
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
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
  } catch (brevoErr) { try { Sentry.captureException(brevoErr); } catch (__laclarcGuard) {}
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
  } catch (resendErr) { try { Sentry.captureException(resendErr); } catch (__laclarcGuard) {}
    logger.logError('Send Email (Resend fallback)', resendErr.response?.data || resendErr.message);
  }
}

// ==========================================
// Cloudinary & Multer
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
// ═══ 🔐 SOCIAL LOGIN (Google OAuth) — identity موثقة من Google، JWT تاع laclarc ═══
app.post('/api/auth/social', authLimiter, async (req, res) => {
  try {
    const { email, name, provider } = req.body;
    if (!email || !provider) return res.status(400).json({ error: 'email and provider required' });
    if (!['google'].includes(provider)) return res.status(400).json({ error: 'Unsupported provider' });

    const cleanEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // موجود؟ → login · جديد → register (provider موثق الإيميل أصلاً — بلا password)
    let userRes = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [cleanEmail]);
    let user;

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
      console.log(`🔐 [Social] login via ${provider}: ${cleanEmail}`);
    } else {
      const insert = await pool.query(
        `INSERT INTO users (name, email, password_hash, provider) VALUES ($1, $2, NULL, $3) RETURNING id, name, email`,
        [String(name || cleanEmail.split('@')[0]).slice(0, 100), cleanEmail, provider]
      );
      user = insert.rows[0];
      console.log(`🆕 [Social] registered via ${provider}: ${cleanEmail}`);
      await auditEvent('SOCIAL_REGISTER', user.id, { provider, email: cleanEmail }, 'info').catch(()=>{});
    }

    // JWT نفس النظام — session bridging مكتمال
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('Social Auth', e);
    res.status(500).json({ error: 'Server error' });
  }
});

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

// 🚨 حماية الأدمن فوراً قبل أي مسار /api/admin
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
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
    logger.logError('Scrape Product', error);
    res.status(500).json({ error: 'Failed to scrape this URL. Site might be protected or slow.' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}}
    }
  }
});

// ═══ 💱 Currency Detection — حسب بلد الزائر (Cloudflare header مجاني) ═══
app.get('/api/currency/detect', async (req, res) => {
  // 🩹 FIX — usd خارج try (كان ReferenceError في الـ catch = كراش بعملية كاملة) + String() ضد array-params
  const usd = parseFloat(req.query.usd) || 0;
  try {
    const country = String(req.headers['cf-ipcountry'] || req.query.country || 'US')
      .toUpperCase()
      .slice(0, 2);
    const data = await detectAndConvert(usd, country);
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=1800');
    res.json({ ...data, supported: SUPPORTED.map(s => s.code) });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('currency/detect', e);
    res.json({ currency: 'USD', rate: 1, symbol: '$', localAmount: usd });
  }
});

// ==========================================
// 📊 مسار تقارير أرباح الإعلانات (Ad Attribution & ROI Analytics)
// ==========================================
app.get('/api/admin/analytics/ads', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(utm_source, 'organic/direct') AS source,
        COUNT(*) AS total_orders,
        COUNT(CASE WHEN status IN ('paid', 'completed', 'fulfilled') THEN 1 END) AS paid_orders,
        COALESCE(SUM(CASE WHEN status IN ('paid', 'completed', 'fulfilled') THEN total_amount ELSE 0 END), 0) AS revenue
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY COALESCE(utm_source, 'organic/direct')
      ORDER BY revenue DESC;
    `);

    res.json({ success: true, stats: rows });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Ad Analytics Query Error', err);
    res.status(500).json({ error: 'Failed to fetch ad analytics' });
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

    // ✨ Helper الموحد — fail-closed + سقف $0.50
    const { applied, discount, total } = await applyCouponToTotal(pool, code, cartTotal);
    if (!applied) {
      return res.status(404).json({ error: 'Invalid or expired coupon code.' });
    }

    res.json({
      discount: discount.toFixed(2),
      newTotal: total.toFixed(2),
      message: `Coupon applied! You saved $${discount.toFixed(2)}`
    });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/add-coupon', async (req, res) => {
  try {
    const { code, discount_type, discount_value } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: 'Code and value are required' });
    await pool.query('INSERT INTO coupons (code, discount_type, discount_value) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING', [code.toUpperCase(), discount_type || 'percentage', discount_value]);
    res.status(201).json({ message: 'Coupon added successfully!' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});
// ✨ كوبون الاسترجاع — seed عند الإقلاع (سقف أمان: 10%)
(async () => {
  try {
    await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, is_active)
       VALUES ('RECOVER10', 'percentage', 10, true)
       ON CONFLICT (code) DO NOTHING`
    );
    console.log('🎟️ Recovery coupon RECOVER10 ensured (abandoned-cart emails promise it).');
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    console.warn('Recovery coupon seed skipped:', e.message);
  }
})();

// ─── ⭐ [cj-reviews] دمج ريفيوزات CJ الحقيقية — قراءة فقط، بلا كتابة في الـ DB ───
// الفرونت (Customer Reviews في PDP) كتقرا نفس هذا الـ endpoint — صفر تعديل فرونت.
// الحقول مطبّعين على شكل صفوف الجدول: id/author/rating/content/country/images/created_at
async function getCjMergedReviews(productId) {
  try {
    const { fetchCjReviews } = require('./routes/cjLiveBridge');
    const q = await pool.query('SELECT cj_product_id FROM products WHERE id = $1 LIMIT 1', [productId]);
    const cjPid = q.rows && q.rows[0] && q.rows[0].cj_product_id ? String(q.rows[0].cj_product_id) : null;
    if (!cjPid) return { rows: [], total: 0 }; // منتج بلا ربط CJ → ريفيوزات محلية فقط [cj-reviews v2]
    const cj = await fetchCjReviews(cjPid, { size: 50 }); // [cj-reviews v2] 50 بدل 20 — تغطية أوسع بنفس نداء CJ الواحد (الكاش 6h نفسو)
    const rows = (cj.reviews || []).map(r => ({
      id: `cj-${r.id}`,
      product_id: Number(productId) || 0,
      author: r.name,
      rating: r.score,
      content: r.text,
      country: r.country,
      images: r.images,
      created_at: r.date,
      source: 'cj',
    }));
    return { rows, total: cj.total || rows.length }; // [cj-reviews v2] الصفوف + الإجمالي الحقيقي من CJ (ماشي غير المحمّل)
  } catch (e) {
    console.warn('[cj-reviews] merge skipped:', e.message);
    return { rows: [], total: 0 }; // 🛟 تدهور صامت — الريفيوزات المحلية باقة تخدم [cj-reviews v2]
  }
}

app.get('/api/reviews/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    // 🩹 FIX — أعمدة محددة (كان SELECT * يخرج user_id الداخلي في رد عام)
    const result = await pool.query('SELECT id, product_id, author, rating, content, country, images, created_at FROM reviews WHERE product_id = $1 ORDER BY created_at DESC', [productId]);
    // ⭐ [cj-reviews] — المحليون أولاً (زبائن حقيقيون) ثم ريفيوزات CJ (كاش 6 ساعات)
    const cj = await getCjMergedReviews(productId); // [cj-reviews v2] { rows, total }
    const merged = [...result.rows, ...cj.rows];

    // ⭐ [cj-reviews v2] — ?v2=1 → { reviews, meta }: meta.total = الإجمالي الحقيقي
    //    (المحليون + total تاع CJ) ماشي غير المحمّل. بلا ?v2 → array القديم (توافق رجعي كامل).
    if (req.query.v2 === '1' || req.query.v2 === 'true') {
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const r of merged) {
        const k = parseInt(r.rating, 10) || 0;
        if (k >= 1 && k <= 5) counts[k]++;
      }
      return res.json({
        reviews: merged,
        meta: {
          total: result.rows.length + (cj.total || cj.rows.length),
          loaded: merged.length,
          counts,
          local: result.rows.length,
          cj: cj.rows.length,
          hasMore: cj.total > cj.rows.length, // CJ عندها أكثر مما حُمّل → عرض جزئي صادق
        },
      });
    }
    res.json(merged);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/add-review', async (req, res) => {
  try {
    const { product_id, author, rating, content, country } = req.body;
    if (!product_id || !author || !content) return res.status(400).json({ error: 'Product ID, Author, and Content are required' });
    // 🩹 FIX#9 — rating clamp (كان العميل يبعث 999)
    const safeRating = Math.min(5, Math.max(1, Number(rating) || 5));
    await pool.query('INSERT INTO reviews (product_id, author, rating, content, country) VALUES ($1, $2, $3, $4, $5)', [product_id, author, safeRating, content, country || 'United States']);
    res.status(201).json({ message: 'Review added successfully!' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// 🐺 CJ Webhooks Management (Admin)
// ==========================================
app.post('/api/admin/webhook/register', async (req, res) => {
  try {
    const callbackUrl = `${process.env.BACKEND_URL || 'https://neo-store-backend.onrender.com'}/api/cj-webhook`;
    const response = await registerWebhooks(callbackUrl);
    if (response.data?.code === 200) {
      res.json({ message: `✅ Webhooks registered! Callback: ${callbackUrl}` });
    } else {
      res.status(400).json({ error: response.data?.message || 'Registration failed' });
    }
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Webhook Register', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/webhook/subscribe', async (req, res) => {
  // ✨ v2 — 200 فوري (invariant #3: لا نحجب الرد على مهام طويلة)
  res.json({ message: '📌 Subscription started in background — راقب اللوج للنتيجة النهائية' });
  (async () => {
    try {
      const result = await subscribeAllStoreProducts();
      console.log(`📌 [Subscribe] انتهى: ${result.success}/${result.total} منتج مشترك (${result.failed} فاشل/متخطى)`);
    } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Webhook Subscribe (Background)', err);
    }
  })();
});

app.post('/api/reviews/add', authenticateToken, async (req, res) => {
  try {
    const { product_id, rating, content, country, images } = req.body;
    const userId = req.user.id;
    const userName = req.user.name;

    if (!product_id || !content) {
      return res.status(400).json({ error: 'Product ID and content are required' });
    }

    // 🩹 FIX#8 — صور Cloudinary فقط (كان startsWith('http') — أي domain يُقبل)
    const safeImages = Array.isArray(images)
      ? images.filter(url => typeof url === 'string' && url.startsWith('https://res.cloudinary.com/'))
      : [];

    // 🩹 FIX#9 — rating clamp
    const safeRating = Math.min(5, Math.max(1, Number(rating) || 5));

    await pool.query(
      `INSERT INTO reviews (product_id, author, user_id, rating, content, country, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        product_id,
        userName,
        userId,
        safeRating,
        content.trim(),
        country || 'United States',
        safeImages
      ]
    );

    res.status(201).json({ message: 'Verified review with photos added successfully!' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Add Review with Photos Error', err);
    res.status(500).json({ error: 'Server error saving review' });
  }
});

// 🩹 FIX 18-E — وثائق KYC (receipts = بطاقات تعريف وطنية ديال الزبناء) ما يتحملوش من الويب أبداً
//   برهان Task 18: GET /uploads/receipt-*.png كان → 200 LIVE (تسريب PII حي). غير receipts ممنوعين.
app.use('/uploads', (req, res, next) => {
  if (/receipt-/i.test(req.path)) {
    logger.logError('UPLOADS-KYC-BLOCKED', new Error(`${req.method} ${req.originalUrl} — IP: ${req.ip}`));
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/api/admin/upload', upload.array('images', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const urls = req.files.map(file => file.path);
    res.status(200).json({ urls });
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

app.post('/api/upload', authenticateToken, upload.array('images', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const urls = req.files.map(file => file.path);
    res.status(200).json({ urls });
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
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
    let { title, price: costPrice, original_price, image_url, images, description, material, colors, sizes, category } = req.body;
    if (!title || !costPrice || !image_url) return res.status(400).json({ error: 'Title, cost price, and image_url are required' });

    // 🩹 v1.1 — floor enforced server-side (نفس قانون v3.1 — الكلفة عند الإدخال هنا هي cost)
    const costNum = Number(costPrice) || 0;
    if (costNum < 1.0) return res.status(400).json({ error: `Cost price must be ≥ $1.00 — got: ${costPrice}` });

    const cjProductId = `MANUAL_${Date.now()}`;
    const imagesArray = images && images.length > 0 ? images : [image_url];
    const colorsArray = colors || [];
    const sizesArray = sizes || [];

    // 🩹 v1.1 — weight-optional: المنتج اليدوي بلا وزن → تمرير 0 → محرك v3.1 كيحسب بـ min 50g
    // 💰 THE single pricing engine (v3.1) — بلا مضاعفات محلية
    const { calculateSellingPrice } = require('./services/productImportService');
    const { safePrice, safeOriginalPrice: _ignored } = calculateSellingPrice(costNum, 0);

    // 🩹 قرار 1: original_price — يدوي كامل الصلاحية إلا عطاه الأدمن، وإلا null (بلا 1.5x)
    const parsedOriginal = Number(original_price);
    const safeOldPrice = (Number.isFinite(parsedOriginal) && parsedOriginal > safePrice) ? parsedOriginal : null;

    // 🩹 قرار 2: material بلا شعار مجاني · description بلا filler
    const safeMaterial = (material && String(material).trim()) || '';
    const safeDescription = (description && String(description).trim()) || '';

    await pool.query(
      `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, stock_status, cj_product_id, description, material, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [title, safePrice, safeOldPrice, image_url, imagesArray, JSON.stringify([]), colorsArray, sizesArray, true, cjProductId, safeDescription, safeMaterial, category || 'other']
    );

    clearProductsCache();
    res.status(201).json({ message: 'Product added successfully with v3.1 pricing!', calculatedPrice: safePrice, originalPrice: safeOldPrice });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/delete-product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE products SET stock_status = false WHERE id = $1', [id]);
    clearProductsCache();
    res.json({ message: 'Product hidden successfully!' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/disputes/create', async (req, res) => {
  try {
    const { orderId, disputeReasonId, expectType, refundType, messageText, productInfoList } = req.body;
    const payload = { orderId, businessDisputeId: `NEO_DISPUTE_${Date.now()}`, disputeReasonId, expectType, refundType, messageText, productInfoList };
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/disputes/create', payload, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
    if (response.data.code === 200) res.json({ message: 'Dispute created successfully!' });
    else res.status(400).json({ error: response.data.message || 'Failed to create dispute' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/track/:trackNumber', async (req, res) => {
  try {
    const { trackNumber } = req.params;
    const response = await cjRequest((token) => axios.get(`https://developers.cjdropshipping.com/api2.0/v1/logistic/trackInfo`, { headers: { 'CJ-Access-Token': token }, params: { trackNumber } }));
    if (response.data.code === 200) res.json(response.data.data);
    else res.status(400).json({ error: response.data.message || 'Tracking number not found' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

// ════════════════════════════════════════════
// 🚚 Kit 27 — CJ Live Shipping Estimate (freightCalculate حقيقي)
// GET /api/shipping/estimate?pid=123&country=MA
//   · cache 6 ساعات على (pid|country) — 10 نقاط فقط على cache-miss
//   · pre-filter بـ shipping_matrix (دولة غير مدعومة = 0 نقطة)
//   · محدد IP بسيط: 30 طلب / 10 دقايق / IP
// ════════════════════════════════════════════
const shippingEstimateCache = new Map();
const SHIPPING_ESTIMATE_TTL_MS = 6 * 60 * 60 * 1000;
const shipIpHits = new Map();

app.get('/api/shipping/estimate', async (req, res) => {
  try {
    const pid = parseInt(String(req.query.pid || ''), 10);
    const country = String(req.query.country || '').trim().toUpperCase().slice(0, 2);
    if (!Number.isFinite(pid) || pid <= 0 || !/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({ error: 'pid (numeric) and country (ISO-2) required' });
    }

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const nowMs = Date.now();
    const hits = (shipIpHits.get(ip) || []).filter(ts => nowMs - ts < 10 * 60 * 1000);
    if (hits.length >= 30) return res.status(429).json({ supported: false, error: 'Too many requests' });
    hits.push(nowMs);
    shipIpHits.set(ip, hits);
    if (shipIpHits.size > 5000) shipIpHits.clear();

    const cacheKey = pid + '|' + country;
    const cached = shippingEstimateCache.get(cacheKey);
    if (cached && nowMs - cached.t < SHIPPING_ESTIMATE_TTL_MS) return res.json(cached.data);

    const { rows } = await pool.query(
      "SELECT id, cj_product_id, variants FROM products WHERE id = $1 AND cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%' LIMIT 1",
      [pid]
    );
    if (!rows.length) return res.status(404).json({ supported: false, error: 'product not found or not CJ-linked' });

    let variants = rows[0].variants;
    if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch (e) { variants = []; } }
    const vid = Array.isArray(variants) && variants[0] && variants[0].vid;
    if (!vid) return res.status(404).json({ supported: false, error: 'no CJ variant (vid) on product' });

    try {
      const sm = await pool.query('SELECT is_supported FROM shipping_matrix WHERE country_code = $1', [country]);
      if (sm.rows.length && sm.rows[0].is_supported === false) {
        const data = { supported: false, reason: 'country unsupported (matrix)', country, source: 'shipping_matrix' };
        shippingEstimateCache.set(cacheKey, { t: nowMs, data });
        return res.json(data);
      }
    } catch (smErr) { console.warn('⚠️ [ShipEstimate] matrix prefilter skipped:', smErr.message); }

    const cjRes = await cjRequest((token, config) =>
      axios.post('https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate', {
        startCountryCode: 'CN',
        endCountryCode: country,
        products: [{ vid, quantity: 1 }]
      }, { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
    );

    const list = Array.isArray(cjRes.data && cjRes.data.data) ? cjRes.data.data : [];
    if (!list.length) {
      const data = { supported: false, reason: 'no carriers returned', country, source: 'cj-live' };
      shippingEstimateCache.set(cacheKey, { t: nowMs, data });
      return res.json(data);
    }

    const byPrice = list.slice().sort((a, b) => (Number(a.logisticPrice) || 1e12) - (Number(b.logisticPrice) || 1e12));
    const byDays  = list.slice().sort((a, b) => (parseInt(a.logisticAging, 10) || 9999) - (parseInt(b.logisticAging, 10) || 9999));
    const cheapest = byPrice[0];
    const fastest = byDays[0];
    const agingNums = String(cheapest.logisticAging || '').match(/\d+/g);
    const agingDays = (agingNums && agingNums.length)
      ? { min: parseInt(agingNums[0], 10), max: parseInt(agingNums[agingNums.length - 1], 10) }
      : null;

    const data = {
      supported: true,
      country,
      cheapest: { price: cheapest.logisticPrice, carrier: cheapest.logisticName, aging: cheapest.logisticAging || null },
      fastest: { days: fastest.logisticAging || null, price: fastest.logisticPrice, carrier: fastest.logisticName },
      agingDays,
      carriersCount: list.length,
      source: 'cj-live',
      cached: false
    };
    shippingEstimateCache.set(cacheKey, { t: nowMs, data });
    if (shippingEstimateCache.size > 20000) shippingEstimateCache.clear();
    return res.json(data);
  } catch (err) {
    try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('ShippingEstimate', err);
    return res.status(502).json({ supported: false, error: 'upstream CJ error' });
  }
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
    } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
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

    // 🆕 Temu-style rail: SMART representative image per category.
    // (تعليق واحد — كان مكرر)
    try {
      const { rows: imgs } = await pool.query(`
        SELECT c.slug, img.image_url
        FROM categories c
        LEFT JOIN LATERAL (
          SELECT p.image_url
          FROM products p
          WHERE p.stock_status = true
            AND p.image_url IS NOT NULL AND p.image_url <> ''
            AND (p.category = c.slug OR p.category LIKE c.slug || '-%' OR p.category LIKE c.slug || '/%')
          ORDER BY
            p.sort_order DESC NULLS LAST,
            p.is_sourced DESC,
            (p.video_url IS NOT NULL AND p.video_url <> '') DESC,
            COALESCE(array_length(p.images, 1), 0) DESC,
            p.id DESC
          LIMIT 1
        ) img ON true
      `);
      const imgMap = new Map(imgs.map((r) => [r.slug, r.image_url]));
      const attach = (nodes) => {
        for (const n of nodes || []) {
          if (!n?.slug) continue;
          n.image_url = imgMap.get(n.slug) || null;
          if (Array.isArray(n.children) && n.children.length) {
            attach(n.children);
            // parent inherits first child's image when it has none of its own
            if (!n.image_url) n.image_url = n.children.find((c) => c.image_url)?.image_url || null;
          }
        }
      };
      attach(Array.isArray(tree) ? tree : tree?.children || []);
     } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
      console.warn('categories image enrichment failed:', e.message); // no silent catch
    }

    categoryTreeCache = tree;
    categoryTreeCacheTime = Date.now();
    res.json(tree);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════
// 🎯 GET /api/categories/seo?slug=xxx — الخطوة الأخيرة ديال SEO الأقسام
// (Task 21-e) كيرجع الحقول اللي حقنهم inject_categories_monster لصفحة
// القسم فالفرونت: seo_title / seo_h1 / description / content / faqs.
// 🔒 آمن: parameterized + slug guard [a-z0-9-] + fallback NULL لكل حقل
// ⚡ كاش: ذاكرة 10 دقائق + CDN ساعة (s-maxage=3600, SWR يوم)
// 🧬 schema-adaptive: كيكتاشف أسماء أعمدة seo_* من information_schema
// ═════════════════════════════════════════════════════════════════════
const categorySeoCache = new Map();
const CATEGORY_SEO_CACHE_TTL = 10 * 60 * 1000;
let categorySeoCols = null;

function getCategorySeoCols(c) {
  const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  const pick = (...cands) => cands.find((x) => c.has(x)) || null;
  return {
    title: pick('seo_title', 'seo_page_title', 'meta_title'),
    h1: pick('seo_h1', 'h1'),
    desc: pick('seo_meta_description', 'seo_description', 'meta_description', 'seo_desc'),
    content: pick('seo_content', 'seo_body', 'seo_text'),
    faqs: pick('seo_faqs', 'seo_faq', 'faqs'),
    version: pick('seo_content_version', 'content_version'),
  };
}

app.get('/api/categories/seo', async (req, res) => {
  try {
    const raw = String(req.query.slug || '').toLowerCase().trim();
    const slug = raw.split('/').filter(Boolean).pop() || '';
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ found: false, error: 'invalid slug' });
    }

    const hit = categorySeoCache.get(slug);
    if (hit && Date.now() - hit.t < CATEGORY_SEO_CACHE_TTL) {
      res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
      return res.json(hit.data);
    }

    if (!categorySeoCols) {
      const { rows: colRows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'categories' AND column_name LIKE 'seo_%'`
      );
      categorySeoCols = getCategorySeoCols(new Set(colRows.map((r) => r.column_name)));
    }
    const c = categorySeoCols;
    const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';
    const sel = [
      c.title   ? `${qi(c.title)}   AS "seo_title"`   : `NULL AS "seo_title"`,
      c.h1      ? `${qi(c.h1)}      AS "seo_h1"`      : `NULL AS "seo_h1"`,
      c.desc    ? `${qi(c.desc)}    AS "seo_meta_description"` : `NULL AS "seo_meta_description"`,
      c.content ? `${qi(c.content)} AS "seo_content"` : `NULL AS "seo_content"`,
      c.faqs    ? `${qi(c.faqs)}    AS "seo_faqs"`    : `NULL AS "seo_faqs"`,
      c.version ? `${qi(c.version)} AS "seo_content_version"` : `NULL AS "seo_content_version"`,
    ].join(', ');

    const { rows } = await pool.query(
      `SELECT slug, name, level, ${sel}
         FROM categories
        WHERE slug = $1
        ORDER BY level ASC, id ASC
        LIMIT 1`,
      [slug]
    );

    const data = rows.length ? { found: true, ...rows[0] } : { found: false, slug };
    categorySeoCache.set(slug, { t: Date.now(), data });
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.json(data);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Route Handler', err);
    return res.status(500).json({ found: false, error: 'server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// S4 — CATEGORIES HUB ENDPOINT (Section 4 — /categories hub)
// GET /api/categories/hub
//  • الشجرة الكاملة + slugPath كامل لكل عقدة (l1/l2/l3)
//  • counts حقيقية من DB — نفس سيمانتيك العدّاد الحي (prefix match على category)
//    استعلام واحد GROUP BY على distinct categories ثم prefix-sum فالذاكرة
//  • صور تمثيلية للجذور (L1) — نفس نمط /api/categories (LATERAL)
//  • كاش ذاكرة 6 سوايع + s-maxage=21600, SWR 86400
//  • فشل counts/images = غير fatal — الشجرة كترجع ديما (counts:false)
// ═══════════════════════════════════════════════════════════════════
let hubS4Cache = null;
let hubS4CacheTime = 0;
const HUB_S4_CACHE_TTL = 6 * 60 * 60 * 1000;

app.get('/api/categories/hub', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    if (hubS4Cache && (Date.now() - hubS4CacheTime < HUB_S4_CACHE_TTL)) {
      return res.json(hubS4Cache);
    }

    const tree = await getCategoryTree();

    // 1) counts — استعلام واحد: distinct category + عدد المنتجات لكل واحد
    //    (lower() على الجنبين = نفس معنى ILIKE الحي)
    let countsMap = null;
    let totalProducts = 0;
    try {
      const { rows } = await pool.query(
        "SELECT lower(category) AS cat, COUNT(*)::int AS n " +
        "FROM products " +
        "WHERE stock_status = true AND category IS NOT NULL AND category <> '' " +
        "GROUP BY lower(category)"
      );
      countsMap = new Map();
      for (const r of rows) countsMap.set(r.cat, r.n);
      totalProducts = rows.reduce((s, r) => s + r.n, 0);
    } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
      console.warn('hub counts query failed (non-fatal):', e.message);
      countsMap = null;
    }

    // 2) صور تمثيلية للجذور فقط (L1) — نفس نمط /api/categories
    const imgMap = new Map();
    try {
      const { rows: imgs } = await pool.query(
        "SELECT c.slug, img.image_url " +
        "FROM categories c " +
        "LEFT JOIN LATERAL ( " +
        "  SELECT p.image_url FROM products p " +
        "  WHERE p.stock_status = true " +
        "    AND p.image_url IS NOT NULL AND p.image_url <> '' " +
        "    AND (p.category = c.slug OR p.category LIKE c.slug || '-%' OR p.category LIKE c.slug || '/%') " +
        "  ORDER BY p.sort_order DESC NULLS LAST, p.is_sourced DESC, " +
        "    (p.video_url IS NOT NULL AND p.video_url <> '') DESC, " +
        "    COALESCE(array_length(p.images, 1), 0) DESC, p.id DESC " +
        "  LIMIT 1 " +
        ") img ON true " +
        "WHERE c.level = 1"
      );
      for (const r of imgs) imgMap.set(r.slug, r.image_url);
    } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
      console.warn('hub images query failed (non-fatal):', e.message);
    }

    // 3) بناء الشجرة: slugPath كامل + count لكل عقدة
    //    prefix raw (بلا boundary) — مطابق 1:1 للعدّاد الحي ILIKE 'path%'
    let totalCategories = 0;
    const attachS4 = (nodes, prefix) => {
      for (const n of nodes || []) {
        if (!n || !n.slug) continue;
        totalCategories++;
        n.slugPath = prefix ? (prefix + '/' + n.slug) : n.slug;
        if (countsMap) {
          let c = 0;
          const p = n.slugPath.toLowerCase();
          for (const [cat, cnt] of countsMap) {
            if (cat.startsWith(p)) c += cnt;
          }
          n.count = c;
        } else {
          n.count = null;
        }
        if (imgMap.has(n.slug)) n.image_url = imgMap.get(n.slug);
        if (Array.isArray(n.children) && n.children.length) {
          attachS4(n.children, n.slugPath);
        }
      }
    };
    attachS4(Array.isArray(tree) ? tree : [], '');

    hubS4Cache = {
      nodes: Array.isArray(tree) ? tree : [],
      counts: !!countsMap,
      totals: countsMap ? { categories: totalCategories, products: totalProducts } : null,
    };
    hubS4CacheTime = Date.now();
    return res.json(hubS4Cache);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════ END S4 CATEGORIES HUB ═══════════════
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
        } catch (itemErr) { try { Sentry.captureException(itemErr); } catch (__laclarcGuard) {} console.warn('⚠️ [Recat] product ' + (p && p.id) + ' failed: ' + itemErr.message); }
      }

      clearProductsCache();
      console.log(`🎉 Backfill complete! Updated: ${updatedCount}`);
    } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Backfill Categories (Background)', err);
    }
  })();
});

// ==========================================
// مزامنة منتجات CJ و 1688
// ==========================================
// ═══ 🆕 Reels server-side — الفيديوهات فقط، بلا كاتالوغ كامل ═══
app.get('/api/admin/videos', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, price, image_url, video_url
         FROM products
        WHERE video_url IS NOT NULL AND video_url <> ''
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 200`
    );
    res.json(rows);
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    console.error('[admin/videos] query failed:', e.message);
    res.status(500).json({ error: 'Failed to load video products' });
  }
});

// ═══ 🆕 /admin/settings GET — زوج الـ PUT /admin/settings/:key ═══
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM store_settings WHERE key = 'show_reels' LIMIT 1`
    );
    const v = rows[0]?.value;
    res.json({ show_reels: v === undefined ? true : (v === true || v === 'true') });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    console.error('[admin/settings GET] failed:', e.message);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.get('/api/sync-cj-products', requireAdmin, async (req, res) => {
  const keyword = req.query.keyword || '';
  res.json({ message: `Sync started in background for keyword: ${keyword || 'Trending'}. Check server logs for progress.` });
  runCjProductSync(keyword).catch((err) => logger.logError('CJ Product Sync (Background)', err));
});

// ✨ مسار تشغيل محرك الاستيراد بالجملة (Mass Sync)
const { runMassSync } = require('./massSync');

app.post('/api/admin/mass-sync', requireAdmin, async (req, res) => {
  res.json({ message: '🚀 Mass Sync Engine started in background! Check server logs.' });
  runMassSync().catch(err => logger.logError('Mass Sync Engine', err));
});
// ✨ مسار مزامنة المنتجات التي تحتوي على فيديوهات فقط (للريلز)
app.post('/api/admin/sync-videos', requireAdmin, async (req, res) => {
  res.json({ message: '🎬 Video Sync Engine started in background! Fetching products with videos...' });
  runCjVideoSync().catch(err => logger.logError('CJ Video Sync Engine', err));
});

async function runCjVideoSync() {
  // ✨ v2 — محرك تنويع البحث (تفاصيل في التعليق الأصلي بملفك)
  const SEARCH_QUERIES = [
    '',
    'grooming', 'hair trimmer', 'nail clipper',
    'makeup', 'beauty tool', 'skincare',
    'kitchen gadget', 'pet supplies',
    'watch', 'earbuds', 'lamp', 'fitness',
  ];

  let importedCount = 0;
  let checkedCount = 0;
  const seenPids = new Set();
  const startedAt = Date.now();

  console.log('⏳ [CJ Video Sync v2] Starting multi-keyword video hunt...');

  for (const keyword of SEARCH_QUERIES) {
    for (let pageNum = 1; pageNum <= 3; pageNum++) {
      const params = { pageNum, pageSize: 20, searchType: 2 };
      if (keyword) params.productNameEn = keyword;

      let cjProducts;
      try {
        const listRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list',
            { ...config, headers: { 'CJ-Access-Token': token }, params })
        );
        cjProducts = listRes.data?.data?.list || [];
      } catch (listErr) { try { Sentry.captureException(listErr); } catch (__laclarcGuard) {}
        logger.logError(`CJ Video Sync list (${keyword || 'Trending'} p${pageNum})`, listErr);
        continue;
      }

      if (cjProducts.length === 0) break;

      console.log(`📄 [Video Sync] "${keyword || 'Trending'}" p${pageNum}: scanning ${cjProducts.length}...`);

      for (const cjItem of cjProducts) {
        const productId = cjItem.pid ? String(cjItem.pid) : null;
        if (!productId || seenPids.has(productId)) continue;
        seenPids.add(productId);
        checkedCount++;

        await new Promise(r => setTimeout(r, 1200));

        try {
          const detailRes = await cjRequest((token, config) =>
            axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
              ...config,
              headers: { 'CJ-Access-Token': token },
              params: { pid: productId, features: 'enable_video' }
            })
          );

          const details = detailRes.data?.data;
          if (!details) continue;

          const productRow = await buildProductRow(details, { fetchVideo: true, isSourced: false });

          if (productRow && productRow.video_url) {
            await upsertProductRow(pool, productRow);
            importedCount++;
            console.log(`🎥 [Video Sync] ✅ #${importedCount}: ${String(productRow.title).slice(0, 60)}`);
          }
        } catch (productErr) { try { Sentry.captureException(productErr); } catch (__laclarcGuard) {}
          console.warn(`⚠️ [Video Sync] product failed: ${productErr.message}`); // 🩹 FIX (كان catch فارغ)
        }
      }
    }
  }

  clearProductsCache();
  const tookSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`✅ [Video Sync v2] Done in ${tookSec}s — Checked ${checkedCount} unique products, Imported ${importedCount} video products.`);
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
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
      await new Promise(r => setTimeout(r, 1200));
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
        } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} console.warn('⚠️ [Import] video query failed for ' + productId + ': ' + e.message); }

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
      } catch (productErr) { try { Sentry.captureException(productErr); } catch (__laclarcGuard) {} console.error('🔴 [Import] product FAILED: ' + productId + ' — ' + productErr.message); } // 🩹 FIX#P2
    }
  }

  clearProductsCache();
  console.log(`✅ [CJ Sync] Finished. Imported ${importedCount} products for keyword: ${keyword || 'Trending'}.`);
}

// ==========================================
// مسارات المستخدم والمصادقة — 🩹 FIX#3/#7/#8
// ==========================================
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'All fields are required' });
    if (!assertStrongPassword(password)) {
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });        // 🩹 FIX#7
    }
    const cleanEmail = normalizeEmail(email);                                                      // 🩹 FIX#8

    const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (userExists.rows.length > 0) return res.status(400).json({ message: 'Email already registered' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, cleanEmail, passwordHash]
    );

    // 🩹 FIX#3 — typed token: verify-token لا يصلح أبداً reset-token
    const verifyToken = jwt.sign({ id: newUser.rows[0].id, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
    const verifyUrl = `${process.env.FRONTEND_URL}/auth/verify-email?token=${verifyToken}`;

    sendEmail({
      to: cleanEmail,
      subject: 'Confirm your Email for Laclarc',
      html: `<h2>Welcome to Laclarc, ${name}!</h2>
             <p>Please click the button below to activate your account:</p>
             <a href="${verifyUrl}" style="background-color:#8B78C6; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; font-weight:bold;">Verify My Email</a>`
    });

    res.status(201).json({ message: 'User registered successfully! Please check your email to verify your account.' });
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
    logger.logError('Register Error', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Invalid token.');
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'verify') return res.status(400).send('Invalid token type.');            // 🩹 FIX#3
    await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [decoded.id]);
    res.send('<h1 style="color:#8B78C6; text-align:center; margin-top:50px;">Email verified successfully! 🎉</h1><p style="text-align:center;">You can now log in to your account.</p>');
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    res.status(400).send('<h1 style="color:red; text-align:center; margin-top:50px;">Invalid or expired link.</h1>');
  }
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const cleanEmail = normalizeEmail(email);                                                      // 🩹 FIX#8
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);

    if (userRes.rows.length > 0) {
      // 🩹 FIX#3 — typed reset token (15m)
      const resetToken = jwt.sign({ id: userRes.rows[0].id, type: 'reset' }, JWT_SECRET, { expiresIn: '15m' });
      const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${resetToken}`;

      sendEmail({
        to: cleanEmail,
        subject: 'Password Reset Request',
        html: `<h2>Did you forget your password?</h2>
               <p>Click the button below to set a new password. This link will expire in 15 minutes.</p>
               <a href="${resetUrl}" style="background-color:#8B78C6; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; font-weight:bold;">Reset My Password</a>`
      });
    }

    // anti-enumeration: نفس الرد موجود أم لا
    res.json({ message: 'If that email exists in our system, a reset link has been sent.' });
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
    logger.logError('Forgot Password', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ message: 'Token and new password are required.' });
    if (!assertStrongPassword(newPassword)) {                                                      // 🩹 FIX#7
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'reset') return res.status(400).json({ message: 'Invalid or expired token.' });  // 🩹 FIX#3
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);
    await pool.query('UPDATE users SET password_hash = $1, is_verified = true WHERE id = $2', [passwordHash, decoded.id]);
    res.json({ message: 'Password reset successfully! You can now log in.' });
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
    res.status(400).json({ message: 'Invalid or expired token.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanEmail = normalizeEmail(email);                                                      // 🩹 FIX#8
    const user = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (user.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!validPassword) return res.status(401).json({ message: 'Invalid credentials' });

    if (!user.rows[0].is_verified) return res.status(403).json({ message: 'Please verify your email first. Check your inbox.' });

    const token = jwt.sign({ id: user.rows[0].id, name: user.rows[0].name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Logged in successfully', token, user: { id: user.rows[0].id, name: user.rows[0].name, email: user.rows[0].email } });
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// مسارات BaridiMob والطلبات اليدوية (hardened)
// 🩹 approve: + receipt_url guard + halted-check + email normalization
// 🩹 reject: forward-only guard (موجود من قبل — أُبقي)
// 🩹 retry: HALTED guard (يمنع حلقة #79) + halted-clear logic
// 🩹 failed-orders: أعمدة محددة (كان SELECT * — يخرج stripe_session_id/exchange_token)
// ==========================================

app.put('/api/admin/manual-orders/approve/:id', async (req, res) => {
  // 🆕 v2 — verified_amount / declared_amount / mismatch (audit trail, optional)
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' });

    // 🩹 FIX-A1 — جلب الطلب أولاً للتحقق من receipt_url قبل القفل
    const preRes = await pool.query(
      'SELECT status, receipt_url, customer_email FROM orders WHERE id = $1',
      [id]
    );
    if (preRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const pre = preRes.rows[0];

    // 🩹 FIX-A2 — الموافقة تتطلب وصل مرفوع (لا موافقة عمياء)
    if (!pre.receipt_url) {
      return res.status(400).json({
        error: 'Cannot approve — no receipt uploaded. Reject this order or ask the customer to upload a receipt.'
      });
    }

    // ✨ v2: قفل ذري — pending → paid فقط
    const updateRes = await pool.query(
      "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING *",
      [id]
    );
    if (updateRes.rows.length === 0) {
      const exists = await pool.query('SELECT status FROM orders WHERE id = $1', [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      return res.status(409).json({ error: `Order is '${exists.rows[0].status}' — already processed` });
    }
    const order = updateRes.rows[0];

    // 🆕 v2 — BARIDIMOB_VERIFIED: audit trail للتسعير المُتحقق منه يدوياً
    const { verified_amount, declared_amount, mismatch } = req.body || {};
    await pool.query(
      `INSERT INTO system_events (event_type, order_id, details, severity)
       VALUES ('BARIDIMOB_VERIFIED', $1, $2, 'info')`,
      [
        id,
        JSON.stringify({
          declared: Number(declared_amount ?? order.total_amount) || null,
          verified: Number(verified_amount) || null,
          mismatch: mismatch === true,
          approved_by_admin: true,
          at: new Date().toISOString(),
        }),
      ]
    );

    res.json({ message: 'Order approved. Sending to CJ in background...' });

    (async () => {
      try {
        const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
        const items = itemsRes.rows;

        let parsedAddress = {};
        try { parsedAddress = JSON.parse(order.shipping_address); }
        catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} parsedAddress = { line1: order.shipping_address, country: 'DZ' }; }

        const customerDetails = {
          address: parsedAddress,
          phone: order.customer_phone,
          email: normalizeEmail(order.customer_email) || '',   // 🩹 FIX-A3
          name: order.customer_name,
        };

        const cjResponse = await fulfillCJOrder(order.id, order.customer_name, customerDetails, items);

        if (cjResponse && cjResponse.success) {
          console.log(`📤 [BaridiMob] #${id} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
        } else {
          console.error(`❌ [BaridiMob] CJ fulfillment فشل لـ #${id} → manual داخل fulfillCJOrder`);
        }

        if (order.customer_email) {
          const emailItemsRes = await pool.query(
            `SELECT oi.quantity, oi.price_at_purchase, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
            [id]
          );
          await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, emailItemsRes.rows);
        }
      } catch (bgErr) { try { Sentry.captureException(bgErr); } catch (__laclarcGuard) {}
        logger.logError('Approve BaridiMob Order (Background)', bgErr);
      }
    })();
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Approve BaridiMob Order', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/manual-orders/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // 🩹 FIX#14 — forward-only guard: ما كتكتبش cancelled فوق paid/fulfilled/refunded
    const upd = await pool.query(
      "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status IN ('pending','manual') RETURNING id",
      [id]
    );
    if (!upd.rowCount) {
      const exists = await pool.query('SELECT status FROM orders WHERE id = $1', [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      return res.status(409).json({ error: `Order is '${exists.rows[0].status}' — not rejectable` });
    }
    res.json({ message: 'Order rejected successfully.' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/retry-fulfillment/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' });
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];
    if (!['manual', 'paid'].includes(order.status)) {
      return res.status(409).json({ error: `Order is '${order.status}' — فقط manual أو paid يمكن إعادة إرسالهم` });
    }

    // 🩹 FIX-B1 v2 — HALTED guard (NULL-safe + 7-day window متسق مع الحارس الداخلي):
    //    1. NULL-safe: cj_order_number قد يكون NULL (halt من أول مرة بلا retry سابق) — كان يفلته
    //    2. نافذة 7 أيام: مطابقة للـ inner-shield — بعدها يُفترض أن الأدمن حسم في CJ
    //    3. أي halt خلال النافذة = retry مضمون الفشل (dedup على الزبون+المنتجات لا الرقم)
    if (order.status === 'manual') {
      const haltEv = await pool.query(`
        SELECT details, created_at FROM system_events
        WHERE order_id = $1 AND event_type = 'CJ_ORDER_HALTED'
        ORDER BY created_at DESC LIMIT 1
      `, [id]);
      const halt = haltEv.rows[0];
      if (halt) {
        const haltAgeHours = (Date.now() - new Date(halt.created_at).getTime()) / (1000 * 60 * 60);
        if (haltAgeHours < 168) {   // داخل نافذة الـ 7 أيام — مضمون الفشل
          return res.status(409).json({
            error: `⛔ Order #${id} is HALTED (CJ duplicate-blocked, ${Math.floor(haltAgeHours)}h ago) — retrying will fail identically.`,
            resolution: [
              '1. Manual order from CJ Dashboard (same customer details)',
              '2. Try Auto-Split path (different payload structure)',
              '3. Refund via Stripe Dashboard',
            ],
            detail: halt.details,
          });
        }
        // halt أقدم من 7 أيام → نسمح (اتساق مع inner-shield) — لكن ننبه
        console.warn(`ℹ️ [Retry] #${id} HALTED expired (${Math.floor(haltAgeHours)}h) — allowing fresh attempt`);
      }
    }

    // تمكين محاولة جديدة: نحيدو cj_order_number القديم (الـ COALESCE ما يسمحش بالكتابة فوق)
    await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1 AND status = 'manual'", [id]);
    const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);

    let parsedAddress = {};
    try { parsedAddress = JSON.parse(order.shipping_address); }
    catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} parsedAddress = { line1: order.shipping_address, country: 'US' }; }

    res.json({ message: 'Retry launched — شوف اللوج' });
    (async () => {
      try {
        const customerDetails = {
          address: parsedAddress,
          phone: order.customer_phone || '',
          email: normalizeEmail(order.customer_email) || '',    // 🩹 FIX-B2
          name: order.customer_name,
        };
        const r = await fulfillCJOrder(order.id, order.customer_name, customerDetails, itemsRes.rows);
        console.log(`🔁 [Retry] #${order.id} ->`, JSON.stringify(r).slice(0, 200));
      } catch (bgErr) { try { Sentry.captureException(bgErr); } catch (__laclarcGuard) {} logger.logError('Retry Fulfillment', bgErr); }
    })();
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Retry Fulfillment Route', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/failed-orders', async (req, res) => {
  try {
    // 🩹 FIX — أعمدة محددة + customer_phone + payment_method + halt_details
    //    (كان SELECT * — يخرج stripe_session_id + exchange_token)
    //    halt_details inline: الأدمن يرى سبب الـ HALT مباشرة بلا لوج
    const result = await pool.query(`
      SELECT
        o.id,
        o.customer_name,
        o.customer_email,
        o.customer_phone,
        o.total_amount,
        o.status,
        o.created_at,
        o.cj_order_number,
        o.manual_since,
        o.payment_method,
        (SELECT details FROM system_events se
         WHERE se.order_id = o.id AND se.event_type = 'CJ_ORDER_HALTED'
         ORDER BY created_at DESC LIMIT 1) AS halt_details
      FROM orders o
      WHERE o.status = 'manual' AND o.payment_method != 'BaridiMob'
      ORDER BY o.id DESC
    `);
    res.json(result.rows);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// البحث والتصنيف الذكي
// ==========================================
app.get('/api/search', async (req, res) => {
  // 🩹 hygiene — ILIKE wildcard escape (% و _ من المستخدم ما يولّدوش مطابقة عامة)
  const q = String(req.query.q || '').replace(/[%_]/g, '\\$&');
  if (q.length < 1) return res.json([]);

  try {
    const result = await pool.query("SELECT id, title, price, image_url FROM products WHERE stock_status = true AND (title ILIKE $1 OR description ILIKE $1) ORDER BY id DESC LIMIT 5", [`%${q}%`]);
    res.json(result.rows);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
        } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} console.warn('⚠️ [BgRecat] product ' + (c && c.id) + ' failed: ' + e.message); }
      }
      clearProductsCache();
      console.log(`✅ Finished auto-categorizing ${changes.length} products.`);
    })();
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
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
// ═══ [card-swatches] Kit 30 — سواتشات الصور لكارت المنتج (بداية) ═══
// المصدر: variants JSONB (CJ product/query) — variantKey بصيغة CJ الرسمية "Color-Size"
// (توثيق CJ: variants[].variantKey مثال "Black-XXL" · variants[].variantImage · vid)
// SW_SQL كيستخرج: لون واحد (قبل آخر -) + أول صورة + أول vid لكل لون (بترتيب أول ظهور)
// withSwatches كيفلتر: المقاسات-فقط (XL/42...) + الصور المكررة · سقف 5 · swMore = الباقي
// ⚡ صفر نقاط CJ — عملية DB محلية بحتة · الفرع الكامل (FULL_CAP=5000) بلا سواتشات عمداً (الأداء)
const SW_SIZE_ONLY_RX = /^(?:xxs|xs|s|m|l|xl|xxl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|\d{1,4})$/i;
const SW_MAX = 5;
const SW_SQL = `, COALESCE((
  SELECT json_agg(json_build_object('c', t.c, 'i', t.i, 'v', t.v) ORDER BY t.ord)
  FROM (
    SELECT regexp_replace(v.val->>'variantKey', '-[^-]+$', '') AS c,
           (array_agg(v.val->>'variantImage' ORDER BY v.ord))[1] AS i,
           (array_agg(v.val->>'vid' ORDER BY v.ord))[1] AS v,
           min(v.ord) AS ord
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(variants) = 'array' THEN variants ELSE '[]'::jsonb END) WITH ORDINALITY AS v(val, ord)
    WHERE COALESCE(v.val->>'variantImage', '') <> '' AND COALESCE(v.val->>'variantKey', '') <> ''
    GROUP BY 1
  ) t
), '[]'::json) AS swatches`;

function withSwatches(rows) {
  try {
    if (!Array.isArray(rows)) return rows;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      if (!('swatches' in r)) continue; // صفوف بلا الحقل (فروع غير مرقعة) → بلا لمس
      let arr = r.swatches;
      if (typeof arr === 'string') {
        try { arr = JSON.parse(arr || '[]'); } catch (e) {
          console.error('[card-swatches] swatches JSON parse failed (product ' + (r.id ?? '?') + '):', e.message);
          arr = [];
        }
      }
      if (!Array.isArray(arr)) { r.swatches = []; continue; }
      const out = [];
      const seenImg = new Set();
      let total = 0;
      for (const s of arr) {
        const c = (s && typeof s.c === 'string') ? s.c.trim() : '';
        const i = (s && typeof s.i === 'string') ? s.i.trim() : '';
        if (!c || !i) continue;
        if (SW_SIZE_ONLY_RX.test(c)) continue; // مقاس-فقط (XL/42) ماشي لون
        total++;
        if (seenImg.has(i)) continue; // جوج أسماء لنفس الصورة → سواتش واحد
        seenImg.add(i);
        if (out.length < SW_MAX) out.push({ c: c.slice(0, 40), i, v: (s && typeof s.v === 'string' && s.v) ? s.v : undefined });
      }
      r.swatches = out;
      const more = total - out.length;
      if (more > 0) r.swMore = more;
    }
  } catch (e) {
    console.error('[card-swatches] withSwatches failed:', e.message); // Tenet — بلا صمت
  }
  return rows;
}
// ═══ [card-swatches] Kit 30 — نهاية ═══

app.get('/api/products', async (req, res) => {
  try {
    const search = req.query.search || '';
    const category = req.query.category || 'All';

    // ✨ تفعيل التخزين المؤقت على شبكات CDN العالمية (Vercel & Cloudflare Edge)
    // 60 ثانية كاش طازج + 300 ثانية استجابة فورية أثناء التحديث في الخلفية
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

    // 1. الطلب العام بدون بحث (يخدم ملايين الزوار من الذاكرة اللحظية)
    // 🆕 minimal mode — للـ sitemap: ids+dates فقط (~400KB بدل 26MB)
    // 🆕 minimal chunked — sitemap يتوسع بلا حدود cache (20k/chunk · ~1.1MB كل chunk · سقف مُقفل دائماً)
    if (req.query.minimal === '1') {
      const minimalPage = Math.max(1, parseInt(req.query.page, 10) || 1);
      const CHUNK = 20000;
      const [{ rows }, { rows: totalRows }] = await Promise.all([
        pool.query(
          'SELECT id, created_at FROM products WHERE stock_status = true ORDER BY id DESC LIMIT $1 OFFSET $2',
          [CHUNK, (minimalPage - 1) * CHUNK]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM products WHERE stock_status = true'),
      ]);
      res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
      return res.json({ page: minimalPage, chunkSize: CHUNK, count: rows.length, total: totalRows[0].total, products: rows });
    }

    // 🆕 pagination mode — /all-products infinite scroll (24/شوط)
    // مقصود: بلا productsCache — الكاش للهوم فقط، هادا استعلام خفيف مباشر
    if (req.query.page) {
      const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
      const PER = 24;
      const cat = (req.query.category || '').trim();

      // 🆕 category mode — فئات كبار بلا سقف (BL-CAT-SCROLL)
      if (cat && cat !== 'All') {
        const { rows } = await pool.query(
          `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}
           FROM products WHERE stock_status = true AND category ILIKE $1
           ORDER BY sort_order ASC, id DESC LIMIT $2 OFFSET $3`,
          [`${escapeLikeSafe(cat)}%`, PER, (pageNum - 1) * PER]  // 🩹 FIX-LIKE
        );
        res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
        return res.json(withSwatches(rows));
      }

      // 🆕 Temu-mosaic: homepage feed متنوع من جميع الفئات — deterministic hash shuffle
      // (بلا random(): الـ pagination كتبقى متسقة، صفحة N ما كتكررش N-1)
      // 🩹 FIX-TIE — `, id DESC` tiebreaker: نظرياً md5 collision غير مستحيل رياضياً — الباب تسدّ
      // 📌 تكلفة موثقة: hash+sort كامل فوق الجدول في كل cache miss — البديل المستقبلي:
      //    عمود shuffle bucket يُحفظ عند massSync (يقتل الحساب الكامل)
      const { rows } = await pool.query(
        `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}
         FROM products WHERE stock_status = true
         ORDER BY md5(category || id::text), id DESC
         LIMIT $1 OFFSET $2`,
        [PER, (pageNum - 1) * PER]
      );
      res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.json(withSwatches(rows));
    }

    // 🆕 عدّاد الفئة — للـ header ("3,528 products")
    if (req.query.count === '1') {
      const cat = (req.query.category || '').trim();
      const sql = cat && cat !== 'All'
        ? ['SELECT COUNT(*)::int AS n FROM products WHERE stock_status = true AND category ILIKE $1', [`${escapeLikeSafe(cat)}%`]]  // 🩹 FIX-LIKE
        : ['SELECT COUNT(*)::int AS n FROM products WHERE stock_status = true', []];
      const { rows } = await pool.query(sql[0], sql[1]);
      return res.json({ count: rows[0].n });
    }

    // 1. الطلب العام بدون بحث
    if (search === '' && category === 'All') {
      // 🆕 الـ limit ولّى مطبَّق — HeroSection(12) و products/[id](100) عمرو ما استافدو بيه
      const limitParam = parseInt(req.query.limit, 10);
      if (Number.isFinite(limitParam) && limitParam > 0) {
        const q = await pool.query(
          `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}, created_at FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC LIMIT $1`,
          [Math.min(limitParam, 200)]
        );
        return res.json(withSwatches(q.rows));
      }
      if (productsCache && (Date.now() - cacheTime < CACHE_TTL)) {
        return res.json(productsCache);
      }
      const FULL_CAP = 5000; // 🆕 سقف أمان — الذاكرة/الـ payload ما يطيروش مع نمو الكاتالوغ
      const result = await pool.query(
        'SELECT id, title, price, original_price, image_url, category, video_url, created_at FROM products WHERE stock_status = true ORDER BY sort_order ASC, id DESC LIMIT $1',
        [FULL_CAP]
      );
      productsCache = result.rows;
      cacheTime = Date.now();
      if (result.rowCount >= FULL_CAP) {
        console.warn(`[products] FULL_CAP=${FULL_CAP} hit — homepage should pass ?limit=`); // بلا صمت
      }
      return res.json(result.rows);
    }

    // 2. استعلام البحث والتصنيف (سريع جداً بفضل فهارس GIN و B-Tree)
    let query = `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL} FROM products WHERE stock_status = true`;
    let params = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
      params.push(`%${escapeLikeSafe(search)}%`);  // 🩹 FIX-LIKE — wildcards مقفولة
      paramIndex++;
    }

    if (category !== 'All') {
      // 🩹 v1.1 — matching صارم: exact + prefix فقط (لا خلط بين الفئات المتشابهة)
      // 📌 ملاحظة موثقة: page-mode فوق يستعمل `cat%` (prefix واسع) وهذا الفرع صارم —
      //    دلالتان مختلفتان لنفس الحقل (مقصودتان اليوم — توحيد محتمل في backlog)
      query += ` AND (category = $${paramIndex} OR category LIKE $${paramIndex} || '/%')`;
      params.push(escapeLikeSafe(category));  // 🩹 FIX-LIKE — يحمي نصف الـ LIKE (exact ما يتأثرش عملياً)
      paramIndex++;
    }

    query += ` ORDER BY sort_order ASC, id DESC LIMIT 200`;

    const result = await pool.query(query, params);
    res.json(withSwatches(result.rows));
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    // 🩹 FIX-ERRCACHE — الخطأ ما يرثش public cache من الأعلى
    console.error('❌ Error fetching products:', err);
    res.set('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ═══ 🆕 Favorites by-ids — N+1 kill: الصفحة كيطلب غير المفضلة (KB بدل الكاتالوغ كامل) ═══
app.get('/api/products/by-ids', async (req, res) => {
  try {
    // 🩹 FIX-IDS-BOUND — حدّ int32: id أكبر من 2147483647 كان يفجّر cast $1::int[] → 500
    const ids = String(req.query.ids || '')
      .split(',').map(s => parseInt(s, 10))
      .filter(n => Number.isInteger(n) && n > 0 && n <= 2147483647).slice(0, 100);
    if (ids.length === 0) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, title, price, original_price, image_url, category, video_url${SW_SQL}
         FROM products
        WHERE stock_status = true AND id = ANY($1::int[])
        ORDER BY sort_order ASC, id DESC
        LIMIT 100`,
      [ids]
    );
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json(withSwatches(rows));
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ /api/products/by-ids:', err.message);
    res.set('Cache-Control', 'no-store');  // 🩹 FIX-ERRCACHE
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/products/deals', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, title, price, original_price, image_url FROM products WHERE stock_status = true AND is_sourced = true ORDER BY id DESC LIMIT 10");
    // 🩹 FIX-DEALSCACHE — كان بلا كاش: كل زائر deals = ضربة DB
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json(result.rows);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    // 🩹 FIX-DEALS-LOG — stdout هو اللي يوصل لـ log drain (Render disk = ephemeral)
    console.error('❌ /api/products/deals:', err);
    res.set('Cache-Control', 'no-store');  // 🩹 FIX-ERRCACHE
    res.status(500).json({ error: 'Server error' });
  }
});

// 🩹 FIX#11 — i18n short-circuit: قرارنا المؤجل (i18n لحملة DZ لاحقة).
// الكود القديم كان يضرب translateProduct لكل زائر ES/FR/AR → استعلام فاشل
// (product_translations غير موجودة في المخطط) → هدر DB + صفر ترجمة أبداً.
// التفعيل لاحقاً = I18N_ENABLED=true + إنشاء الجدولين — بلا نشر كود جديد.
const I18N_ENABLED = process.env.I18N_ENABLED === 'true';

// ⚠️ FIX-SHADOW — عقد ترتيب التسجيل (حرِس عليه أي refactor):
//    /api/products/by-ids و /api/products/deals لازم يبقاو مسجلين *فوق* هذا المسار —
//    وإلا ':id' ياكلهم بصمت (':id' = 'by-ids'). الترتيب الحالي صحيح — هذا التعليق حارسه.
app.get('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // 🩹 FIX-ID-404 — حارس رقمي: 'abc' كان يعدي لـ PostgreSQL → invalid input → 500.
    //    الآن: JSON 404 نظيف (الواجهة تعرض صفحة المنتج غير موجود بدل صفحة خطأ)
    const pid = parseInt(id, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await pool.query('SELECT * FROM products WHERE id = $1', [pid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    let product = result.rows[0];
    if (product.images && typeof product.images === 'string') {
      try { product.images = JSON.parse(product.images); } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
        // 🩹 FIX-SILENT — Tenet: catch بلا صوت ممنوع
        console.warn(`⚠️ [product] images JSON parse failed for #${pid} — serving raw string`);
      }
    }

    // 🩹 FIX-IDCACHE — صفحة الفلوس كانت الضربة الأكبر: كل مشاهدة منتج = استعلام SELECT *
    // 60s طازج + 300s stale — نفس عقد طلاقة الفيد (massSync يصل ≤60s)
    // ⚠️ I18N-TRAP — كي تفعّل I18N_ENABLED: زيد res.set('Vary', 'cf-ipcountry') هنا
    //    وإلا الكاش يخدم لغة بلد لبلد أخرى
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

    const visitorCountry = (req.headers['cf-ipcountry'] || '').toUpperCase();
    const targetLang = getLangFromCountry(visitorCountry);

    // 🩹 FIX#11 — بوابة الـ flag بدل الاعتماد على جداول غائبة
    if (I18N_ENABLED && targetLang) {
      try {
        const translated = await translateProduct(product.id, targetLang);
        if (translated) {
          product = { ...product, title: translated.title, description: translated.description };
          res.set('X-Laclarc-Lang', targetLang); // شارة التصحيح
        }
      } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
        console.warn(`🌐 [i18n] product #${product.id} translation skipped: ${e.message}`);
      }
    }
    res.json(product);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ /api/products/:id:', err);
    res.set('Cache-Control', 'no-store');  // 🩹 FIX-ERRCACHE
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 🩹 LACLARC::RELATED-UPGRADED v1 (Task 16) — LIMIT 4→8: ضعف الروابط
//    الداخلية للـ SEO (8 × كل صفحة منتج). الحارس الثلاثي تأكد قبل التعديل.
app.get('/api/products/:id/related', async (req, res) => {
  try {
    const { id } = req.params;
    // 🩹 FIX-ID-404 — نفس الحارس (نفس فئة الـ 500)
    const pid = parseInt(id, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const productRes = await pool.query('SELECT category FROM products WHERE id = $1', [pid]);
    if (productRes.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    const category = productRes.rows[0].category;
    const baseCategory = category ? category.split('-')[0] : '';

    let relatedRes = await pool.query(
      `SELECT id, title, price, image_url, category FROM products
       WHERE id != $1 AND category = $2 AND stock_status = true
       ORDER BY id DESC LIMIT 8`, [pid, category]
    );

    if (relatedRes.rows.length < 8 && baseCategory) {
      const existingIds = relatedRes.rows.map(r => r.id);
      existingIds.push(pid);
      const moreRes = await pool.query(
        `SELECT id, title, price, image_url, category FROM products
         WHERE id != ALL($1::int[]) AND category ILIKE $2 AND stock_status = true
         ORDER BY id DESC LIMIT $3`, [existingIds, `${baseCategory}%`, 8 - relatedRes.rows.length]
      );
      relatedRes.rows = [...relatedRes.rows, ...moreRes.rows];
    }

    if (relatedRes.rows.length < 8) {
      const existingIds = relatedRes.rows.map(r => r.id);
      existingIds.push(pid);
      // 📌 تكلفة موثقة: random() = scan+sort كامل — مسار نادر (فئة فيها <4 منتجات متوفرة)
      //    backlog: TABLESAMPLE أو اختيار من نطاق id عشوائي
      const randomRes = await pool.query(
        `SELECT id, title, price, image_url, category FROM products
         WHERE id != ALL($1::int[]) AND stock_status = true
         ORDER BY random() LIMIT $2`, [existingIds, 8 - relatedRes.rows.length]
      );
      relatedRes.rows = [...relatedRes.rows, ...randomRes.rows];
    }

    // 🩹 FIX-RELCACHE — المرتبطون ثابتون نسبياً → كاش CDN
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json(relatedRes.rows);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ /api/products/:id/related:', err);
    res.set('Cache-Control', 'no-store');  // 🩹 FIX-ERRCACHE
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2) قبل التعليق "🩹 FIX-SM — allowed_countries" — لصق هادا:
// ═══ 🎡 WHEEL_V1 — Spin Wheel claim → JWT-signed token (server = only truth) ═══
app.post('/api/wheel/claim', wheelLimiter, async (req, res) => {
  try {
    const pct = Math.min(15, Math.max(1, Math.round(Number(req.body?.pct) || 0)));
    if (!pct) return res.status(400).json({ error: 'Invalid wheel result' });
    const wheelToken = jwt.sign({ type: 'wheel', pct }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ pct, wheelToken });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('wheel/claim', e);
    res.status(500).json({ error: 'Server error' });
  }
});
// ==========================================
// مسار الدفع المحصن (Bank-Grade Checkout مع تتبع الإعلانات والكوبونات)
// 🩹 Hardening 2026-10-03:
//   FIX-SM: allowed_countries من shipping_matrix (222 دولة CJ-verified — مبنية بـ build_shipping_matrix)
//           كان: ALL_WORLD_COUNTRIES نظرية — تضمنت دول غير مدعومة (يمن، الفاتيكان، العراق...)
//           الزبون كان يستطيع الدفع من دولة لا يشحن إليها CJ = فاتورة ضائعة
//   FIX-ERR: err.message لم يعد يُكشف للعميل (كان يسرّب تفاصيل Stripe)
// ==========================================
// ═══ 🩹 FIX 18-D — ensureProductImported كانت مُستدعاة فـ Live Bridge (M#25) وما كايناش
//   فالـ repo كامل → ReferenceError → أي عربة فيها live_pid كانت كتفشل دايماً (Task 18)
async function ensureProductImported(livePid) {
  const pidStr = String(livePid || '').trim();
  if (!pidStr || pidStr.length > 100) throw new Error('invalid live pid');
  const existing = await pool.query('SELECT id FROM products WHERE cj_product_id = $1 LIMIT 1', [pidStr]);
  if (existing.rows.length > 0) return existing.rows[0];
  const detailRes = await cjRequest((token, config) =>
    axios.get(`${CJ_API}/product/query`, { ...config, headers: { 'CJ-Access-Token': token }, params: { pid: pidStr } })
  );
  const details = detailRes.data?.data;
  if (!details) throw new Error('product not available from supplier');
  const productRow = await buildProductRow(details, { fetchVideo: false, isSourced: false });
  if (!productRow) throw new Error('product failed import validation');
  await upsertProductRow(pool, productRow);
  const saved = await pool.query('SELECT id FROM products WHERE cj_product_id = $1 LIMIT 1', [pidStr]);
  if (!saved.rows.length) throw new Error('import persistence failed');
  clearProductsCache();
  console.log(`🌍 [LiveBridge] imported CJ pid ${pidStr} → local #${saved.rows[0].id}`);
  return saved.rows[0];
}

app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    let orderId = null;
    const { items: clientItems, origin, couponCode, utm, wheelToken } = req.body;
    let baseUrl = origin && origin.startsWith('http') ? origin : (process.env.FRONTEND_URL || 'https://laclarc.com');
    baseUrl = baseUrl.replace(/\/+$/, '');

    // ═══ 🌍 M#25 Live Bridge — المنتجات الحية من CJ تُستورد آلياً قبل الـ checkout ═══
    for (const item of clientItems || []) {
      if (item.live_pid) {
        try {
          const imported = await ensureProductImported(item.live_pid);
          item.id = imported.id;
          item.live_pid = undefined;
          console.log(`🌍 [LiveBridge] checkout: CJ pid → local #${imported.id}`);
        } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
          return res.status(400).json({ error: `Product ${item.live_pid} is no longer available from supplier.` });
        }
      }
    }
    // حساب الأسعار والـ vid حصراً من قاعدة البيانات (Tenet #1)
    const { secureItems, serverTotal } = await prepareSecureItems(pool, clientItems);
    const optionalUser = getOptionalUser(req);

    // ✨ استخراج وتأمين بيانات تتبع الإعلانات
    const utmSource = utm?.utm_source ? String(utm.utm_source).slice(0, 100) : 'organic';
    const utmMedium = utm?.utm_medium ? String(utm.utm_medium).slice(0, 100) : 'direct';
    const utmCampaign = utm?.utm_campaign ? String(utm.utm_campaign).slice(0, 150) : null;
    const clickId = utm?.click_id ? String(utm.click_id).slice(0, 255) : null;

    // ✨ تسجيل الطلب (مرة واحدة فقط) مع مصدر الإعلانات
    const orderResult = await pool.query(
      `INSERT INTO orders (customer_name, customer_email, shipping_address, total_amount, status, user_id, payment_method, utm_source, utm_medium, utm_campaign, click_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'Stripe', $7, $8, $9, $10) RETURNING id`,
      ['Pending Customer', 'pending@laclarc.com', 'Pending', serverTotal, 'pending', optionalUser ? optionalUser.id : null, utmSource, utmMedium, utmCampaign, clickId]
    );
    orderId = orderResult.rows[0].id;

    for (const item of secureItems) {
      await pool.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, vid) VALUES ($1, $2, $3, $4, $5)",
        [orderId, item.id, item.quantity, item.price, item.vid]
      );
    }

    // تصادق الكوبون عبر الـ Helper الموحد (Tenet #20)
    const { applied: couponApplied, discount: couponDiscount, clamped, coupon: couponRow } =
      await applyCouponToTotal(pool, couponCode, serverTotal);

    let stripeDiscounts = [];
    if (couponApplied) {
      const useNativePercent = couponRow.discount_type === 'percentage' && !clamped && Number(couponRow.discount_value) < 100;
      const couponData = useNativePercent
        ? { percent_off: parseFloat(couponRow.discount_value), duration: 'once' }
        : { amount_off: Math.round(couponDiscount * 100), currency: 'usd', duration: 'once' };
      stripeDiscounts = [{ coupon: await getOrCreateStripeCoupon(couponData) }];
    }


    // 🩹 FIX-SM — allowed_countries من shipping_matrix (CJ-verified 2026-10-03)
    //    222 دولة مؤكدة بالمسح الفعلي — 16 مستبعدة (اليمين الفاتيكان العراق موريتانيا...)
    //    الزبون من دولة غير مدعومة لا يصل لصفحة الدفع أصلاً — صفر فاتورة ميتة
    //    ⚠️ fallback: إن كان الجدول فارغاً (لم تُبنَ المصفوفة بعد) → ALL_WORLD_COUNTRIES (السلوك القديم)
    // 🎡 WHEEL_V1 — خصم العجلة من token موقّع فقط
    let wheelPct = 0;
    try {
      if (wheelToken) {
        const wheelClaim = jwt.verify(wheelToken, JWT_SECRET);
        if (wheelClaim.type === 'wheel') wheelPct = Math.min(15, Math.max(0, wheelClaim.pct));
      }
    } catch { /* token قديم/مزور — بلا خصم */ }
    if (wheelPct > 0) {
      const wheelOff = Math.round(serverTotal * wheelPct / 100 * 100);
      if (wheelOff > 0) {
        stripeDiscounts.push({ coupon: await getOrCreateStripeCoupon({ amount_off: wheelOff, currency: 'usd', duration: 'once' }) });
      }
    }

    let allowedCountries = ALL_WORLD_COUNTRIES;
    try {
      const { rows: supported } = await pool.query(
        'SELECT country_code FROM shipping_matrix WHERE is_supported = true'
      );
      if (supported.length > 0) {
        allowedCountries = supported.map(r => r.country_code);
      }
    } catch (smErr) { try { Sentry.captureException(smErr); } catch (__laclarcGuard) {}
      console.warn('⚠️ [Checkout] shipping_matrix unavailable — falling back to ALL_WORLD_COUNTRIES:', smErr.message);
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
      shipping_address_collection: { allowed_countries: allowedCountries },   // 🩹 FIX-SM
      phone_number_collection: { enabled: true },
      discounts: stripeDiscounts,
      shipping_options: [
        { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'usd' }, display_name: 'Standard Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 15 }, maximum: { unit: 'business_day', value: 35 } } } },
        { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 1500, currency: 'usd' }, display_name: 'Worldwide Express Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 7 }, maximum: { unit: 'business_day', value: 15 } } } }
      ],
      metadata: {
        orderId: orderId.toString(),
        couponCode: couponApplied ? String(couponCode).toUpperCase() : '',
        utmSource: utmSource,
        utmCampaign: utmCampaign || ''
      },
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cancel`,
    });

    await pool.query("UPDATE orders SET stripe_session_id = $1 WHERE id = $2", [session.id, orderId]);
    res.json({ url: session.url });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    // 🧹 فشل Stripe session → pending يُلغى ذرياً (لا يتيم في الـ Reconcile)
    if (orderId) {
      await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [orderId]).catch(() => {});
    }
    logger.logError('Create Checkout Session', err);
    // 🩹 FIX-ERR — كان err.message (يسرب تفاصيل Stripe: session limits, card errors API...)
    res.status(500).json({ error: 'Failed to create checkout session. Please try again.' });
  }
});

/// ==========================================
// ⚡ مسار التحقق المالي اللحظي JIT v2 (Just-In-Time Stripe Verifier)
// ⚠️ القاعدة الذهبية (v2): بعد النجاح الحالة تبقى 'paid' — الويب هوك
//    SHIPPED هو اللي كيرفعها لـ fulfilled + يصيفط واتساب/إيميل فثواني
// ==========================================
app.post('/api/payment/verify-session', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id || typeof session_id !== 'string' || session_id.length > 500) {
    return res.status(400).json({ success: false, error: 'Session ID is required' });
  }

  try {
    // 1. استجواب مباشر وفوري لخوادم Stripe — البيانات من Stripe ماشي من العميل
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
    } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
      // session_id غير صالح/منتهي → 404 نظيف بدل 500
      return res.status(404).json({ success: false, error: 'Invalid checkout session' });
    }

    if (!session || !session.metadata?.orderId) {
      return res.status(404).json({ success: false, error: 'Invalid checkout session' });
    }

    const orderId = parseInt(session.metadata.orderId, 10);
    if (!Number.isFinite(orderId)) {
      return res.status(404).json({ success: false, error: 'Invalid checkout session' });
    }

    // 2. التحقق الجازم: هل تم الدفع بنجاح 100% في Stripe؟
    if (session.payment_status !== 'paid') {
      return res.status(400).json({
        success: false,
        status: 'unpaid',
        message: 'Payment has not been completed or was declined by the bank.'
      });
    }

// 🩹 M#33 FIX: fallback لـ Stripe API الجديد (collected_information):
    const customerName = session.customer_details?.name || 'Valued Customer';
    const customerEmail = normalizeEmail(session.customer_details?.email || '');   // 🩹 FIX#8
    const customerPhone = session.customer_details?.phone
                       || session.collected_information?.shipping_details?.phone
                       || session.collected_information?.phone_number
                       || '';
    const addr = session.customer_details?.address
              || session.collected_information?.shipping_details?.address
              || null;
    const shippingAddress = addr
      ? JSON.stringify(addr)
      : JSON.stringify({ line1: 'Online Store Purchase', country: 'US' });
    // ⓘ USD/EUR: /100 صحيح. عملية zero-decimal (JPY/KRW) إلا فتحتوها يوماً
    const paidAmount = session.amount_total / 100;

    // 3. قفل ذري: pending → paid — واحد فقط كيربح (JIT ولا Stripe Webhook)
    const updateRes = await pool.query(
      `UPDATE orders
       SET customer_name = $1, customer_email = $2, customer_phone = $3,
           shipping_address = $4, total_amount = $5, payment_method = 'Stripe',
           status = 'paid'
       WHERE id = $6 AND status = 'pending'
       RETURNING id`,
      [customerName, customerEmail, customerPhone, shippingAddress, paidAmount, orderId]
    );

    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const fullOrder = orderRes.rows[0];
    if (!fullOrder) {
      // 🛡️ metadata يشير لطلب ماشي موجود (session قديم/test) — رد نظيف بدل 500
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const itemsRes = await pool.query(`
      SELECT oi.*, p.title, p.image_url
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [orderId]);
    const items = itemsRes.rows;

    // 🆕 خبّئ سياق المتصفح الحقيقي (IP/UA) قبل أي fulfillCJOrder محتمل.
    setConversionContext(orderId, {
      clientIp: req.ip,
      userAgent: req.headers['user-agent'],
      fbp: typeof req.body?._fbp === 'string' ? req.body._fbp.slice(0, 200) : undefined,
      fbc: typeof req.body?._fbc === 'string' ? req.body._fbc.slice(0, 500) : undefined,
    });

    // 4. إذا أمسكنا بالقفل (ما سبقناش الـ Webhook) → CJ فوراً فالخلفية
    if (updateRes.rows.length > 0) {
      console.log(`⚡ [JIT Verification] Order #${orderId} verified with Stripe! Fulfilling to CJ immediately...`);

      (async () => {
        try {
          const cjResponse = await fulfillCJOrder(orderId, customerName, session.customer_details, items);

          // ✅ v2 — بلا 'completed': الحالة تبقى paid، webhook SHIPPED كيرفعها
          if (cjResponse?.success) {
            console.log(`📤 [JIT] #${orderId} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
          } else {
            console.error(`❌ [JIT] CJ fulfillment فشل لـ #${orderId} → marked manual داخل fulfillCJOrder`);
          }

          if (customerEmail) {
            sendOrderConfirmationEmail(customerEmail, orderId, paidAmount, items)
              .catch(err => logger.logError('JIT Email Dispatch', err));
          }
        } catch (bgErr) { try { Sentry.captureException(bgErr); } catch (__laclarcGuard) {}
          logger.logError('JIT Background CJ Fulfillment', bgErr);
        }
      })();
    } else {
      console.log(`ℹ️ [JIT Verification] Order #${orderId} was already locked/processed by Webhook.`);
    }

    // 5. الرد الفوري — الحالة 'paid' (صحيحة: الشحن مازال ما وقعش!)
    res.json({
      success: true,
      verified: true,
      orderId: fullOrder.id,
      amount: paidAmount,
      currency: session.currency?.toUpperCase() || 'USD',
      customerEmail: fullOrder.customer_email,
      status: fullOrder.status,
      items: items.map(i => ({ productId: i.product_id, quantity: i.quantity })),
    });

  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
    const withLabels = result.rows.map(order => ({ ...order, status_label: getStatusLabel(order.status) }));
    res.json(withLabels);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// 🩹 FIX#1 — التسريب العام الأكبر في الملف كان هنا:
//    SELECT * بلا limiter → PII كاملة + stripe_session_id + exchange_token
//    (exchange_token في الرد العام = إبطال حماية الـ IDOR من الباب الخلفي)
//    الإصلاح: trackLimiter + أعمدة آمنة محددة + normalizeEmail
//    (التعداد بالبريد وحده يبقى — قرار سياسة منفصل)
// ==========================================
app.get('/api/orders/track/:identifier', trackLimiter, async (req, res) => {
  try {
    const { identifier } = req.params;
    const { email } = req.query;

    // 🛡️ v1.1 — الأعمدة الآمنة فقط + email إجباري (IDOR مقفول)
    // 🩹 v1.1 — shipping_address مضاف (مؤمن بالـ email matching — المالك فقط يشوف عنوانو)
    const SAFE_COLUMNS = 'id, order_number, status, total_amount, created_at, tracking_number, payment_method, customer_name, shipping_address';

    // 🆕 v1.1 — الإيميل إجباري دائماً — لا lookup بالإيميل وحده
    if (!email || !String(email).includes('@')) {
      return res.status(400).json({ error: 'Email is required for shipment verification' });
    }

    // 🆕 v1.1 — identifier = orderId فقط (ماشي إيميل) + email match إجباري
    // 🩹 ON1 — backward-compat: يقبل order_number الجديد (LC-...) ولا id القديم
    queryStr = `SELECT ${SAFE_COLUMNS} FROM orders
                WHERE (order_number = $1 OR id::text = $1) AND customer_email ILIKE $2
                ORDER BY id DESC`;
    params = [identifier, normalizeEmail(email)];

    const result = await pool.query(queryStr, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No orders found matching this Order ID and Email combination.' });
    }
    res.json(result.rows);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Track Orders', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/track/:trackNumber', trackLimiter, async (req, res) => {
    try {
    const { trackNumber } = req.params;
    const response = await cjRequest((token) => axios.get(`https://developers.cjdropshipping.com/api2.0/v1/logistic/trackInfo`, { headers: { 'CJ-Access-Token': token }, params: { trackNumber } }));
    if (response.data.code === 200) res.json(response.data.data);
    else res.status(404).json({ error: 'No tracking info found.' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
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
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// ✨ مسارات إدارة الإعدادات والريلز
// ==========================================

// 🩹 FIX#9 — GET: كان يرجع كل store_settings للعامة
//    (بما فيها المفاتيح الداخلية: exchange_resend_done / stripe_coupon_* / ...)
//    whitelist فقط — عدّل القائمة حسب مفاتيحك العامة الفعلية
const PUBLIC_SETTING_KEYS = ['show_reels', 'show_lightning', 'show_fb'];
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM store_settings WHERE key = ANY($1)', [PUBLIC_SETTING_KEYS]);
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = row.value === 'true';
      return acc;
    }, {});
    res.json(settings);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/update-product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, price, original_price, image_url, images, description, material, colors, sizes, category } = req.body;

    // 🆕 v1.1 — financial guard: floor + required fields (نفس قانون v3.1)
    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 9.99) {
      return res.status(400).json({ error: `Price must be ≥ $9.99 (v3.1 floor) — got: ${price}` });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // قرار 1: original_price — null إذا فارغ/سالب (لا 0 مزيف)
    const parsedOriginal = Number(original_price);
    const safeOriginal = Number.isFinite(parsedOriginal) && parsedOriginal > parsedPrice
      ? parsedOriginal
      : null;

    // ⚠️ موثق: يفرغ الحقول الغائبة — Backlog: dynamic SET للأعمدة المرسلة فقط
    await pool.query(
      `UPDATE products SET title = $1, price = $2, original_price = $3, image_url = $4, images = $5, description = $6, material = $7, colors = $8, sizes = $9, category = $10 WHERE id = $11`,
      [String(title).trim(), parsedPrice, safeOriginal, image_url || null, images || null, description || null, material || null, colors || null, sizes || null, category || 'other', id]
    );
    clearProductsCache();
    res.json({ message: 'Product updated successfully' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// مسارات CJ المتقدمة
app.post('/api/admin/cogs', async (req, res) => {
  try {
    const { orderCodes } = req.body;
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/queryCogsBasicDataOrderInfoList', { orderCodesList: orderCodes }, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/merge/match', async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/mergeOrder/autoMatchMergeOrderListV3', { filterOrder: true, orderStatus: 100 }, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/merge/submit', async (req, res) => {
  try {
    const { orders } = req.body;
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/mergeOrder/submitMergeOrderBatchV3', orders, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/makeup/list', async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/makeup/list', { pageNum: 1, pageSize: 20, type: 0 }, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/addresses', requireAdmin, async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/privateInventory/address/list', {}, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/addresses/create', requireAdmin, async (req, res) => {
  try {
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/privateInventory/address/create', req.body, { headers: { 'CJ-Access-Token': token } }));
    res.json(response.data);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} logger.logError('Route Handler', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/sourcing/create', async (req, res) => {
  try {
    const { productName, productImage, productUrl, price } = req.body;
    if (!productName || !productImage) return res.status(400).json({ error: 'Product name and image are required' });
    const response = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/sourcing/create', { productName, productImage, productUrl: productUrl || '', price: price || 0 }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
    if (response.data.success || response.data.code === 200 || response.data.code === 0) res.status(201).json({ message: 'Sourcing request sent successfully! CJ will review it.' });
    else res.status(400).json({ error: response.data.message || 'Failed to create sourcing request' });
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
      logger.logError('Route Handler', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══ 📋 System Events API — سجل القرارات الآلية (Mission #9) ═══
app.get('/api/admin/system-events', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const type = req.query.type ? String(req.query.type) : null;

    const { rows } = type
      ? await pool.query(
          'SELECT * FROM system_events WHERE event_type = $1 ORDER BY created_at DESC LIMIT $2',
          [type, limit]
        )
      : await pool.query(
          'SELECT * FROM system_events ORDER BY created_at DESC LIMIT $1',
          [limit]
        );

    res.json({ events: rows });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('system-events API', e);
    res.status(500).json({ error: 'Failed to fetch system events' });
  }
});

// ═══ 🩹 FIX#6 — CAPI Second-Shot: limiter + parseInt
//    (كان مفتوحاً — أي حد يضرب orderId آلاف المرات = amplification على DB)
// ═══ Mission #13 — fingerprint enrichment ═══
app.post('/api/payment/second-shot', secondShotLimiter, async (req, res) => {
  const orderId = parseInt(req.body?.orderId, 10);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ success: false, error: 'orderId required' });
  }
  // Fire-and-forget — الزبون ما يستناش
  secondShotConversion(orderId).catch(e => console.warn(`[SecondShot] #${orderId}: ${e.message}`));
  res.json({ accepted: true });
});
// ═══ 🧬 Mission #16 — Customer Exchange Page API (v2 — async booking contract) ═══
// 🔑 Exchange capability token regex — POST/GET validation
const EXCHANGE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 🛡️ طلبات عندها exchange fulfillment شغال في الخلفية — Reconcile ما يلمسهومش (يمنع cascade مزدوج)
const exchangeInFlight = new Set();

// ⚡ الـ fulfillment الفعلي بعد اختيار البديل — خارج الـ HTTP request (الرد خرج للزبون من قبل)
// الفشل الصادق: الحالة تحكم — awaiting_exchange (cascade أعاد العرض) | manual (cascade مات)
async function runExchangeFulfillment(orderId, ord, chosen) {
  try {
    const itemsRes = await pool.query(
      'SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1',
      [orderId]
    );
    const customerDetails = {
      email: ord.customer_email, phone: ord.customer_phone,
      address: (() => { try { return JSON.parse(ord.shipping_address); } catch { return { line1: 'N/A', country: 'DZ' }; } })(),
    };
    // بلا skipZeroTouch عمداً: فشل البديل يشعل cascade من جديد (S1 → S2)
    const result = await fulfillCJOrder(orderId, ord.customer_name, customerDetails, itemsRes.rows);

    if (result && result.success) {
      await auditEvent('EXCHANGE_SUCCESS', orderId, { newProduct: chosen.id, title: chosen.title }, 'info');
      console.log(`✅ [Exchange] #${orderId} replacement ${chosen.id} accepted by CJ (${result.orderNumber})`);
      return;
    }

    // 🛑 cjService أوقف الطلب (halted → manual + alert فعلاً) أو fulfillment آخر ماسك القفل — لا alert مكرر ولا كتابة حالة
    if (result && (result.halted || result.reason === 'IN_FLIGHT')) {
      await auditEvent('EXCHANGE_FAIL', orderId, { chosen: chosen.id, reason: result.reason }, 'warning');
      console.warn(`🛑 [Exchange] #${orderId} replacement ${chosen.id} not placed (${result.reason}) — handled by cjService`);
      return;
    }

    await auditEvent('EXCHANGE_FAIL', orderId, { chosen: chosen.id }, 'warning');

    const st = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (st.rows[0]?.status === 'awaiting_exchange') {
      // الـ cascade أعاد العرض + إيميل بدائل جديدة خرج — صفحة الزبون (polling) كتشوفها
      console.warn(`🔄 [Exchange] #${orderId} replacement ${chosen.id} failed — new options offered`);
      return;
    }

    // الـ cascade مات قبل إعادة العرض → manual + triage (شرط status='paid' = ما نكتبوش فوق حالة أخرى)
    await pool.query(
      "UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1 AND status = 'paid'",
      [orderId]
    );
    sendAdminAlert(`🚨 Exchange cascade died — #${orderId} → manual`,
      `<p>فشل البديل <b>${chosen.title}</b> ومات الـ cascade قبل إعادة العرض — triage يدوي أو انتظار L0 sweep.</p>`);
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('Exchange fulfillment', e);
    await pool.query(
      "UPDATE orders SET status = 'manual', manual_since = NOW() WHERE id = $1 AND status = 'paid'",
      [orderId]
    ).catch(() => {});
    sendAdminAlert(`🚨 Exchange fulfillment crashed — #${orderId} → manual`, `<p>${String(e.message).slice(0, 300)}</p>`);
  }
}

app.post('/api/exchange/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const token = String(req.body?.token || '');
  const pick = req.body?.pick;

  if (!Number.isInteger(orderId) || orderId <= 0 || !EXCHANGE_UUID_RE.test(token)) {
    return res.json({ success: false, code: 'invalid_link', message: 'Invalid link' });
  }

  let ord = null, chosen = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 🔒 القفل الذري — دبل-كليك وسباق S3: الفائز يكمل، الخاسر ينسحب.
    // flip إلى 'paid' يجعل الفشل لاحقًا مؤهلًا لإعادة S2 (IN ('manual','paid')) — cascade يكمل ذاتيًا
    const lock = await client.query(
      `UPDATE orders SET status = 'paid'
       WHERE id = $1 AND exchange_token = $2 AND status = 'awaiting_exchange'
       RETURNING exchange_options, customer_name, customer_email, customer_phone, shipping_address`,
      [orderId, token]
    );
    if (!lock.rowCount) {
      await client.query('ROLLBACK');
      return res.json({ success: false, code: 'already_picked', message: 'This exchange was already submitted or the link is no longer valid.' });
    }
    ord = lock.rows[0];

    chosen = (ord.exchange_options || []).find((s) => String(s.id) === String(pick));
    if (!chosen) {
      // خيار قديم من صفحة stale — أعِد الحالة + نافذة 72h جديدة عادلة
      await client.query(`UPDATE orders SET status = 'awaiting_exchange', manual_since = NOW() WHERE id = $1`, [orderId]);
      await client.query('COMMIT');
      await auditEvent('EXCHANGE_FAIL', orderId, { chosen: pick, reason: 'not_in_options' }, 'warning');
      return res.json({ success: false, code: 'stale_option', message: 'That option is no longer available — please choose from the updated list.' });
    }

    await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
    await client.query(
      'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1, $2, 1, $3)',
      [orderId, chosen.id, Number(chosen.price)]
    );
    await client.query('COMMIT');
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    await client.query('ROLLBACK').catch(() => {});
    logger.logError('Exchange API', e);
    return res.status(500).json({ success: false, code: 'internal', message: 'Internal error — please try again.' });
  } finally {
    client.release(); // 🔌 دائماً — مرة واحدة، حتى مع return مبكر
  }

  // ✅ الرد فوراً (invariant #3: لا نحجب الـ HTTP على مهمة طويلة) — الـ cascade ياخد دقيقة+
  // الصفحة كتعمل polling على /options وتعرض الحقيقة: exchanged | awaiting_exchange (بدائل جديدة) | processing
  exchangeInFlight.add(orderId);
  res.json({ success: true, status: 'processing', message: 'Replacement confirmed — we are booking it with our supplier now.' });

  runExchangeFulfillment(orderId, ord, chosen)
    .catch((e) => logger.logError('Exchange background', e))
    .finally(() => exchangeInFlight.delete(orderId));
});

// ═══ 🧬 Exchange — جلب الخيارات (قراءة) ═══
app.get('/api/exchange/:orderId/options', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const token = String(req.query.t || '');
  res.set('Cache-Control', 'no-store'); // polling — ما نكاشيوش الحالة
  if (!Number.isInteger(orderId) || orderId <= 0 || !EXCHANGE_UUID_RE.test(token)) {
    return res.json({ status: 'invalid' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT status, exchange_options, cj_order_number FROM orders WHERE id = $1 AND exchange_token = $2',
      [orderId, token]
    );
    if (!rows.length) return res.json({ status: 'invalid' });
    const { status, exchange_options, cj_order_number } = rows[0];
    if (status === 'awaiting_exchange') {
      return res.json({ status: 'awaiting_exchange', options: exchange_options || [] });
    }
    if (status === 'refunded') {
      // S3 نُفّذ فعلاً — الصفحة تقول "تم الاسترداد"
      return res.json({ status: 'refunded' });
    }
    if (status === 'manual') {
      // 🆕 manual = معالجة جارية (استرداد يدوي أو triage) — لا نؤكد استرداداً لم يحدث
      return res.json({ status: 'processing', detail: 'manual' });
    }
    if (status === 'paid' && (exchangeInFlight.has(orderId) || !cj_order_number)) {
      // 🆕 paid بلا رقم CJ = الـ fulfillment مازال جاري — ما نقولوش "exchanged" قبل ما CJ يقبل
      return res.json({ status: 'processing' });
    }
    if (['paid', 'fulfilled', 'completed'].includes(status)) {
      return res.json({ status: 'exchanged' });
    }
    return res.json({ status: 'invalid' });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('exchange-options', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// ═══ 🗺️ Ship Truth Engine — Journey API ═══
// 🛡️ IDOR defense: يتطلب orderId + customerEmail (نفس عقد التتبع)
app.get('/api/tracking/:orderId/journey', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { email } = req.query;

    if (!orderId || !email) {
      return res.status(400).json({ error: 'orderId and email required' });
    }

    const journey = await shipTruth.getJourney(parseInt(orderId), email);
    if (!journey) {
      return res.status(403).json({ error: 'Order not found or email mismatch' });
    }

    // Edge caching للطلبات القديمة فقط (الحية تُجلب حية)
    if (journey.currentStage === 'DELIVERED') {
      res.set('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
    }

    res.json(journey);
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('ShipTruth API', e);
    res.status(500).json({ error: 'Journey fetch failed' });
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
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
      } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} console.error('🔴 [PriceSync] product ' + (p && p.id) + ' FAILED: ' + e.message); }
    }
    clearProductsCache();
    console.log('✅ [Auto-Cron] Daily product update completed!');
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ [Auto-Cron] Error updating products:', err.message);
  }
});

// ==========================================
// 🔄 10. كرون تحديث أسعار ومقاسات المتغيرات (Variant Price Sync)
// ==========================================
cron.schedule('30 2 * * *', async () => {
  console.log('⏳ [Variant Sync] Starting daily variant price update...');
  try {
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
      } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
        // 🩹 FIX#10 — كان catch فارغ تماماً (آخر catch صامت في الملف)
        console.warn(`⚠️ [VariantSync] product ${p.id} failed: ${e.message}`);
      }
    }

    clearProductsCache();
    console.log(`✅ [Variant Sync] Daily variant update completed! Updated variants for ${updatedCount} products.`);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ [Variant Sync] Error updating variants:', err.message);
  }
});

// 2. إضافة تقييمات جديدة لـ 5 منتجات يومياً (الساعة 4 صباحاً)
// 🛑 DISABLED (2026-10-03) — fake-reviews strategy retired before first ad campaign:
//   • Meta/Google ToS risk — seeded reviews = misleading claims once ads drive traffic
//   • customer trust: identical names/phrases detected in seconds — worse than none
//   • the 237K legacy reviews stay UNTIL first campaign, then:
//     cleanup via cleanup_fake_reviews.js (user_id IS NULL = seeded/admin, real = kept)
//   • replacement strategy (Backlog): Verified-Purchase Review Invitation —
//     7 days after DELIVERED webhook → email the buyer → real reviews only
// Re-enable ONLY if the strategy ever changes back (not recommended).
// cron.schedule('0 4 * * *', async () => {
//   const authors = ["Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Sophia", "Mason"];
//   const contents = ["Highly recommend!", "Exactly as described.", "Great quality.", "Fast shipping, very happy."];
//
//   try {
//     const { rows } = await pool.query("SELECT id FROM products WHERE stock_status = true ORDER BY random() LIMIT 5");
//     for (const p of rows) {
//       const author = authors[Math.floor(Math.random() * authors.length)];
//       const content = contents[Math.floor(Math.random() * contents.length)];
//       const rating = Math.random() > 0.2 ? 5 : 4;
//
//       await pool.query(
//         'INSERT INTO reviews (product_id, author, rating, content, country) VALUES ($1, $2, $3, $4, $5)',
//         [p.id, author, rating, content, 'United States']
//       );
//     }
//     console.log('✅ [Auto-Cron] Added 5 new reviews successfully!');
//   } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
//     console.error('❌ [Auto-Cron] Error seeding reviews:', err.message);
//   }
// });

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
        } catch (mergeErr) { try { Sentry.captureException(mergeErr); } catch (__laclarcGuard) {} console.error('🔴 [Auto-Merge] group submission FAILED: ' + mergeErr.message); }
      }
      console.log('✅ Auto-merge completed successfully!');
    }
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {} console.error('🔴 [Auto-Merge] cron FAILED: ' + err.message); }
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
      } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} console.warn('⚠️ [WeeklyCleanup] product ' + (p && p.id) + ' failed: ' + e.message); }
    }
    clearProductsCache();
    console.log(`✅ [Auto-Cron] Weekly cleanup completed! Hidden ${hiddenCount} products.`);
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ [Auto-Cron] Weekly cleanup error:', err.message);
  }
});

// 5. نشر منتج يومياً على فيسبوك (11:00 و 18:00)
cron.schedule('0 11,18 * * *', async () => {
  await postDailyProductToFacebook();
});

// 🩺 🩹 (بقيت كما هي — مع FIX من الجلسة السابقة)
cron.schedule('0 */2 * * *', async () => {
  try { await selfHealStuckOrders(); } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} logger.logError('SelfHeal Scheduler', e); }
});

// ═══ ⚖️ Dispute Watchdog — مراقبة chargebacks (كل 6 ساعات) ═══
cron.schedule('0 */6 * * *', async () => {
  try {
    await disputeWatchdogCron();
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('DisputeWatch Scheduler', e); // Tenet #14
  }
});

// 6. كرون مطابقة مدفوعات Stripe v2 (كل ساعة — CRON-THIN F#29d)
// الهدف الحقيقي: طلب paid اللي fulfillment فشل قبل ما يوصل CJ (crash شبكي...)
// ✅ v2: guard cj_order_number — الطلب المقبول فـ CJ عندو رقم → عمرو ما يتعاود
// 🔥 CRON-THIN: كان */15 — الـ webhooks تاع Stripe كيأكدو فورياً، والكرون هو safety net برك
//   → كل 15 دقيقة = الداتابيز عمرها ما تنام = حرق الكوتا = 53000 في وسط الشهر
//   → كل ساعة على :00 مع باقي الكرونات = صحوة وحدة/ساعة، النيون ينام 55 دقيقة بين كل صحوة
cron.schedule('0 * * * *', async () => {
  if (isReconciling) return;
  isReconciling = true;

  try {
    const query = `
      SELECT id, stripe_session_id, total_amount
      FROM orders
      WHERE payment_method = 'Stripe'
        AND status IN ('paid', 'reconciling')
        AND stripe_session_id IS NOT NULL
        AND (cj_order_number IS NULL OR cj_order_number = '')
        AND created_at <= NOW() - INTERVAL '10 minutes'
      LIMIT 15;
    `;
    const { rows: pendingOrders } = await pool.query(query);
    if (pendingOrders.length > 0) {
      console.log(`🔄 [Stripe Reconcile v2] ${pendingOrders.length} طلب ما وصلوش لـ CJ — إعادة محاولة...`);
    }

    for (const order of pendingOrders) {
      if (exchangeInFlight.has(order.id)) continue; // 🛡️ exchange cascade شغال — لا تداخل
      try {
        // ✅ v2 — لا حالة وسيطة 'reconciling' جديدة (كانت كتخلي الطلب يتيم إلا crash)
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);

        if (session.payment_status === 'paid') {
          console.log(`💰 [Stripe Reconcile] Order ${order.id} confirmed paid. Sending to CJ...`);

          const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
          const fullOrder = orderRes.rows[0];
          const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [order.id]);
          const items = itemsRes.rows;

          let parsedAddress = {};
          try { parsedAddress = JSON.parse(fullOrder.shipping_address); }
          catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} parsedAddress = { line1: fullOrder.shipping_address, country: 'US' }; }
          const customerDetails = {
            address: parsedAddress,
            phone: fullOrder.customer_phone || '0000000000',
            email: fullOrder.customer_email || '',
            name: fullOrder.customer_name,
          };

          const cjResponse = await fulfillCJOrder(order.id, fullOrder.customer_name, customerDetails, items);

          if (cjResponse && cjResponse.success) {
            // ✅ الحالة تبقى paid + cj_order_number تولى محفوظ → ما يتعاودش أبداً
            console.log(`📤 [Reconcile] #${order.id} مقبول فـ CJ (${cjResponse.orderNumber})`);
            if (fullOrder.customer_email) {
              sendOrderConfirmationEmail(fullOrder.customer_email, order.id, fullOrder.total_amount, items)
                .catch(err => logger.logError('Reconcile Email', err));
            }
          } else if (cjResponse && cjResponse.reason === 'IN_FLIGHT') {
            // 🔒 fulfillment آخر شغال لنفس الطلب (webhook/JIT/exchange/retry) — هو المسؤول، نتخطى بلا أي تغيير حالة
            console.log(`⏭️ [Reconcile] #${order.id} fulfillment in flight elsewhere — skipped`);
          } else {
            // 🛡️ ما نكتبوش فوق awaiting_exchange (S2) ولا فوق طلب تقبّل فـ CJ — manual فقط إذا بقى paid/reconciling
            await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1 AND status IN ('paid','reconciling')", [order.id]);
          }
        } else {
          // ✅ v2 — إلغاء ذري (ما كيمسش طلب متسجل فـ CJ أصلاً)
          const upd = await pool.query(
            "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status IN ('paid','reconciling') AND (cj_order_number IS NULL OR cj_order_number = '') RETURNING id",
            [order.id]
          );
          if (upd.rows.length) console.log(`⚠️ [Stripe Reconcile] Order ${order.id} unpaid in Stripe. Cancelled.`);
        }
      } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
        logger.logError(`Stripe Reconcile Order #${order.id}`, error);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1 AND status IN ('paid','reconciling')", [order.id]);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 🧹 تنظيف legacy: 'reconciling' معلقين من النسخة القديمة → رجعهم paid (بلا مساس بالشاودين)
    await pool.query(
      "UPDATE orders SET status = 'paid' WHERE status = 'reconciling' AND (cj_order_number IS NULL OR cj_order_number = '') AND (tracking_number IS NULL OR tracking_number = '')"
    );
  } catch (error) { try { Sentry.captureException(error); } catch (__laclarcGuard) {}
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
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('Sweeper Cron', err);
  } finally {
    isSweeping = false;
  }
});

// 🛑 DISABLED (2026-10-02) — Neon free-plan compute killer:
// this 4-min ping kept the DB compute awake 24/7 → burned the monthly
// compute hours in ~4 days → project suspended by Neon.
// On Launch (always-on compute) it's redundant anyway.
// Re-enable ONLY if ever returning to Neon Free plan.
// cron.schedule('*/4 * * * *', async () => {
//   try {
//     await pool.query('SELECT 1');
//   } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
//     console.error('Neon keep-alive error:', err.message);
//   }
// });

// ==========================================
// 🛒 8. كرون استرجاع السلات المتروكة — 🩹 FIX#4 (كان ميتاً بنيوياً):
//    Sweeper (:00) كيقتل pending > 2h ونافذة الاستهداف كانت 2h–6h فارغة دائماً
//    + لا sent-flag = لو انعكس الترتيب كان سبام لانهائي
//    الإصلاح: كل ساعة على :15 · نافذة 1–2h · عمود recovery_email_sent_at (سقف: إيميل واحد/طلب)
//    ⚠️ migration إلزامي (مطبق):
//    ALTER TABLE orders ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;
// ==========================================
cron.schedule('0 * * * *', async () => { // CRON-THIN: كان 15 * (كل ساعة على :15) → انتقل لـ :00 باش يتجمع مع الباقي في صحوة وحدة
  console.log('⏳ [Abandoned Cart] Checking for abandoned checkouts...');
  try {
    const { rows: abandonedOrders } = await pool.query(`
      SELECT id, customer_name, customer_email, total_amount, created_at
      FROM orders
      WHERE status = 'pending'
        AND customer_email IS NOT NULL
        AND customer_email NOT LIKE '%@neo.com'
        AND customer_email NOT LIKE '%@laclarc.com'
        AND created_at BETWEEN NOW() - INTERVAL '2 hours' AND NOW() - INTERVAL '1 hour'
        AND receipt_url IS NULL
        AND recovery_email_sent_at IS NULL
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

      // 🩹 FIX#4 — سقف الـ spam: إيميل واحد لكل طلب، للأبد
      await pool.query('UPDATE orders SET recovery_email_sent_at = NOW() WHERE id = $1', [order.id]);
      console.log(`📧 [Abandoned Cart] Recovery email dispatched to ${order.customer_email} for Order #${order.id}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ [Abandoned Cart] Error:', err.message);
  }
});
// 📌 Backlog: الـ CTA يؤدي لـ /cart (سلة جلسة-محلية قد تكون فارغة) —
//    الإصلاح الكامل: "أكمل دفع طلبك #N" (endpoint يبني checkout من order_items)

// ==========================================
// 9. كرون التتبع v2 — fallback ديال الويب هوك (كل نصف ساعة)
// ==========================================

// ==========================================
// 🌍 M#26 — Auto-Import Top-Sellers (يومياً 5 صباحاً)
// الكتالوج ينمو آلياً بمنتجات CJ مجرّبة عالمياً — فلترة ثلاثية
// ==========================================
// 🩹 FIX 18-C2 — TopSellers v1 معطّل: كان خدّام فنفس الوقت ديال v2 (0 5 * * *) = ضعف استهلاك CJ
//   v1 كان ميت أصلاً (CJ_API undefined) — v2 (listV2) هو المعتمد. 31 فبراير = ما كيطلقش أبداً.
//   للرجوع: رجّع '0 5 * * *' فالسطر اللي تحت.
const TOPSELLERS_V1_ENABLED = false;
if (TOPSELLERS_V1_ENABLED) {
cron.schedule('0 5 * * *', async () => {
  console.log('🌍 [TopSellers] Auto-import starting... (v1 DISABLED by Task 18 — v2 active)');
  const startedAt = Date.now();
  let imported = 0, skipped = 0, rejected = 0, errors = 0;

  const CATEGORIES = [
    '', 'kitchen gadget', 'phone accessories', 'pet supplies',
    'home decor', 'fitness', 'beauty tool',
    'car accessories', 'toys', 'led light',
  ];
  const DAILY_LIMIT = 100;
  const MIN_CJ_ORDERS = 50;
  let importedThisRun = 0;

  try {
    let supportedCountries = [];
    try {
      const { rows } = await pool.query('SELECT country_code FROM shipping_matrix WHERE is_supported = true');
      supportedCountries = rows.map(r => r.country_code);
    } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
      console.warn('⚠️ [TopSellers] shipping_matrix unavailable — skipping shipping filter');
    }

    outer:
    for (const keyword of CATEGORIES) {
      if (importedThisRun >= DAILY_LIMIT) break outer;

      for (let pageNum = 1; pageNum <= 3; pageNum++) {
        if (importedThisRun >= DAILY_LIMIT) break outer;

        let cjProducts;
        try {
          const listRes = await cjRequest((token, config) =>
            axios.get(`${CJ_API}/product/list`, {
              ...config,
              headers: { 'CJ-Access-Token': token },
              params: {
                pageNum, pageSize: 20,
                ...(keyword ? { productNameEn: keyword } : { searchType: 2 }),
              }
            })
          );
          cjProducts = listRes.data?.data?.list || [];
        } catch (listErr) { try { Sentry.captureException(listErr); } catch (__laclarcGuard) {}
          console.warn(`⚠️ [TopSellers] list "${keyword}" p${pageNum} failed: ${listErr.message}`);
          continue;
        }

        if (cjProducts.length === 0) break;

        for (const cjItem of cjProducts) {
          if (importedThisRun >= DAILY_LIMIT) break outer;
          const pid = cjItem.pid ? String(cjItem.pid) : null;
          if (!pid) continue;

          const exists = await pool.query('SELECT id FROM products WHERE cj_product_id = $1', [pid]);
          if (exists.rows.length > 0) { skipped++; continue; }

          await new Promise(r => setTimeout(r, 1200));

          try {
            const detailRes = await cjRequest((token, config) =>
              axios.get(`${CJ_API}/product/query`, {
                ...config,
                headers: { 'CJ-Access-Token': token },
                params: { pid, features: 'enable_video' }
              })
            );

            const details = detailRes.data?.data;
            if (!details) { rejected++; continue; }

            const strippedDesc = (details.description || '').replace(/<[^>]*>/g, '').trim() || '';
            const ordersCount = Number(details.ordersCount) || 0;
            const rating = Number(details.rating) || 0;

            if (!details.productNameEn?.trim() ||
                !details.bigImage?.startsWith('http') ||
                details.productImageSet?.length < 2 ||
                strippedDesc.length < 20 ||
                parseNumeric(details.sellPrice) < 1 ||
                details.variants?.length < 1 ||
                details.isGlobalShipping === false) {
              rejected++; continue;
            }

            if (ordersCount < MIN_CJ_ORDERS && rating < 4.0) {
              rejected++; continue;
            }

            if (supportedCountries.length > 0 && !supportedCountries.includes('US')) {
              rejected++; continue;
            }

            const lowerTitle = (details.productNameEn || '').toLowerCase();
            if (phoneAccRegex.test(lowerTitle) || pcBlacklistRegex.test(lowerTitle)) {
              rejected++; continue;
            }

            const cjPrice = parseNumeric(details.sellPrice);
            let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
            sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
            const safePrice = parseFloat(sellingPrice.toFixed(2));
            const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));
            const parsedData = parseVariants(details.variants || []);
            const categorySlug = getCategorySlug(`${details.categoryName} ${details.productNameEn}`);

            let videoUrl = '';
            try {
              const videoRes = await cjRequest((token) =>
                axios.post(`${CJ_API}/product/queryVideosByProductId`, { productId: pid },
                  { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
              if (videoRes.data.code === 200 && videoRes.data.data?.length > 0)
                videoUrl = videoRes.data.data[0].videoUrl;
            } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} console.warn(`⚠️ [TopSellers] video query failed for ${pid}: ${e.message}`); }

            await pool.query(`
              INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, stock_status, cj_product_id, description, material, category, video_url, cj_category_id, is_sourced)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12, $13, $14, false)
              ON CONFLICT (cj_product_id) DO NOTHING
            `, [details.productNameEn, safePrice, safeOriginalPrice, details.bigImage,
                details.productImageSet, JSON.stringify(details.variants || []),
                parsedData.colors, parsedData.sizes, details.pid, details.description,
                'Premium Quality', categorySlug, videoUrl, details.categoryId]);

            imported++;
            importedThisRun++;
            console.log(`🌍 [TopSellers] ✅ imported #${importedThisRun}: ${String(details.productNameEn).slice(0, 50)} (${keyword || 'trending'}, CJ orders: ${ordersCount})`);

          } catch (productErr) { try { Sentry.captureException(productErr); } catch (__laclarcGuard) {}
            errors++;
            console.warn(`⚠️ [TopSellers] product ${pid} failed: ${productErr.message}`);
          }
        }
      }
    }

    clearProductsCache();
    const tookSec = Math.round((Date.now() - startedAt) / 1000);
    console.log(`🌍 [TopSellers] done in ${tookSec}s — imported=${imported} skipped=${skipped} rejected=${rejected} errors=${errors}`);

    await auditEvent('TOPSELLERS_IMPORT', null, {
      imported, skipped, rejected, errors,
      categories: CATEGORIES.length, dailyLimit: DAILY_LIMIT,
      durationSec: tookSec,
    }, 'info');

  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('TopSellers Cron Fatal', err);
  }
});
}

// ==========================================
// 🌍 M#26 v2 — Top-Sellers Auto-Import (يومياً 5 صباحاً)
// مبني على Product List V2 — الفلاتر مدمجة في الـ endpoint نفسه
// لا تخمين حقول — كل شيء من الوثيقة الرسمية
// ==========================================
cron.schedule('0 5 * * *', async () => {
  console.log('🌍 [TopSellers v2] Auto-import starting...');
  const startedAt = Date.now();
  let imported = 0, skipped = 0, rejected = 0, errors = 0;
  let importedThisRun = 0;
  const DAILY_LIMIT = 100;

  // ─── فلترة ذكية مدمجة في Product List V2 ───
  // كل config = استراتيجية استيراد مختلفة
  const SEARCH_CONFIGS = [
    // 1. Trending Global — الأكثر مبيعاً عالمياً (CJ نفسه يرشحهم)
    { label: 'trending-global', params: {
        page: 1, size: 50,
        productFlag: 0,                  // Trending products
        verifiedWarehouse: 1,            // مستودع موثق فقط
        startWarehouseInventory: 100,    // مخزون ≥ 100
        features: ['enable_category', 'enable_description', 'enable_video'],
    }},
    // 2. New Arrivals — منتجات جديدة ناجحة
    { label: 'new-arrivals', params: {
        page: 1, size: 30,
        productFlag: 1,                  // New products
        verifiedWarehouse: 1,
        startWarehouseInventory: 50,
        features: ['enable_category', 'enable_description'],
    }},
    // 3. Free Shipping — أعلى تحويل
    { label: 'free-shipping', params: {
        page: 1, size: 30,
        addMarkStatus: 1,               // Free shipping فقط
        verifiedWarehouse: 1,
        startWarehouseInventory: 50,
        features: ['enable_category', 'enable_description'],
    }},
    // 4. Video Products — للـ Reels والـ social proof
    { label: 'video-products', params: {
        page: 1, size: 20,
        productType: 10,                 // Video products
        verifiedWarehouse: 1,
        features: ['enable_category', 'enable_description', 'enable_video'],
    }},
  ];

  try {
    for (const config of SEARCH_CONFIGS) {
      if (importedThisRun >= DAILY_LIMIT) break;

      try {
        const listRes = await cjRequest((token, cfg) =>
          axios.get(`${CJ_API}/product/listV2`, {
            ...cfg,
            headers: { 'CJ-Access-Token': token },
            params: { ...config.params, page: 1, size: 50 },
          })
        );

        if (listRes.data?.code !== 200) {
          console.warn(`⚠️ [TopSellers v2] ${config.label}: code=${listRes.data?.code}`);
          continue;
        }

        // 🩹 البنية الفعلية: content[0].productList (وليس content مباشرة)
        const content = listRes.data?.data?.content || [];
        const productList = content[0]?.productList || [];

        console.log(`📊 [TopSellers v2] ${config.label}: ${productList.length} منتج مؤهل`);

        for (const p of productList) {
          if (importedThisRun >= DAILY_LIMIT) break;

          const pid = p.id;
          if (!pid) { skipped++; continue; }

          // Dedup — موجود في DB؟
          const exists = await pool.query('SELECT id FROM products WHERE cj_product_id = $1', [pid]);
          if (exists.rows.length > 0) { skipped++; continue; }

          await new Promise(r => setTimeout(r, 800)); // pacing أخف — listV2 أسرع

          try {
            // 💰 التسعير — discountPrice (أفضل سعر CJ) أو sellPrice
            const cjPrice = parseFloat(p.discountPrice || p.sellPrice) || 0;
            if (cjPrice < 0.5) { rejected++; continue; }

            let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5
              : cjPrice <= 15 ? cjPrice * 2.8
              : cjPrice <= 30 ? cjPrice * 2.2
              : cjPrice * 1.8;
            sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
            const safePrice = parseFloat(sellingPrice.toFixed(2));
            const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));

            // 🏷️ Category — من الاستجابة مباشرة (threeCategoryName موجود!)
            const categorySlug = getCategorySlug(
              p.threeCategoryName || p.twoCategoryName || p.oneCategoryName || config.label
            );

            // 💾 Insert — بجميع الحقول الحقيقية من listV2
            const insert = await pool.query(`
              INSERT INTO products (
                title, price, original_price, image_url, images,
                stock_status, cj_product_id, description, category,
                is_sourced, sales_count,
                cj_listed_num, warehouse_inventory, verified_warehouse,
                has_video, free_shipping, delivery_cycle, has_ce_cert, product_type_cj
              )
              VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, true, $9, $10, $11, $12, $13, $14, $15, $16, $17)
              ON CONFLICT (cj_product_id) DO NOTHING
              RETURNING id
            `, [
              p.nameEn,
              safePrice, safeOriginalPrice,
              p.bigImage,
              [], // images تُستكمل في Product Details fetch
              pid,
              p.description || 'High quality product from Laclarc Global Catalog.',
              categorySlug.toLowerCase().replace(/\s+/g, '-'),
              true,                             // is_sourced — منتج CJ مؤهل
              p.listedNum || 0,                 // sales_count = listedNum الحقيقي
              p.warehouseInventoryNum || 0,     // warehouse_inventory
              p.verifiedWarehouse === 1,        // verified_warehouse
              p.isVideo === 1,                  // has_video
              p.addMarkStatus === 1,            // free_shipping
              p.deliveryCycle || '7-15',        // delivery_cycle
              p.hasCECertification === 1,       // has_ce_cert
              p.productType || 'ORDINARY_PRODUCT', // product_type_cj
            ]);

            if (insert.rowCount > 0) {
              imported++;
              importedThisRun++;
              console.log(`🌍 [TopSellers v2] ✅ #${importedThisRun}: ${p.nameEn?.slice(0, 50)} (${config.label}, listedNum=${p.listedNum}, inventory=${p.warehouseInventoryNum})`);
            }
          } catch (prodErr) { try { Sentry.captureException(prodErr); } catch (__laclarcGuard) {}
            errors++;
            console.warn(`⚠️ [TopSellers v2] product ${pid} failed: ${prodErr.message}`);
          }
        }
      } catch (configErr) { try { Sentry.captureException(configErr); } catch (__laclarcGuard) {}
        console.error(`❌ [TopSellers v2] ${config.label} failed: ${configErr.message}`);
        errors++;
      }
    }

    clearProductsCache();
    const tookSec = Math.round((Date.now() - startedAt) / 1000);
    console.log(`🌍 [TopSellers v2] done in ${tookSec}s — imported=${imported} skipped=${skipped} rejected=${rejected} errors=${errors}`);

    await auditEvent('TOPSELLERS_V2_IMPORT', null, {
      imported, skipped, rejected, errors,
      strategies: SEARCH_CONFIGS.map(c => c.label),
      durationSec: tookSec,
    }, 'info');

  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('TopSellers v2 Fatal', err);
  }
});

cron.schedule('0 * * * *', async () => { // CRON-THIN: كان 30 * (كل ساعة على :30) → انتقل لـ :00 باش يتجمع مع الباقي في صحوة وحدة
  console.log('⏳ [CJ Logistics v3] Batch tracking (1 call / up to 50 orders)...');
  try {
    const { rows: pendingTrackingOrders } = await pool.query(`
      SELECT id, status, customer_name, customer_email, customer_phone, total_amount, cj_order_number, created_at
      FROM orders
      WHERE status IN ('paid', 'fulfilled')
        AND (tracking_number IS NULL OR tracking_number = '')
        AND created_at >= NOW() - INTERVAL '15 days'
      LIMIT 50;
    `);
    if (pendingTrackingOrders.length === 0) return;

    // ⭐ 1.16 قبل: رقم CJ (SD...) / رقم المتجر (STORE-x) / order id
    const keys = pendingTrackingOrders.map(o => {
      const stored = String(o.cj_order_number || '').trim();
      const key = stored && !/^STORE-/i.test(stored) ? stored : `STORE-${o.id}`;
      return { order: o, key };
    });

    const batchRes = await cjRequest((token) =>
      axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetailBatch',
        { orderIds: keys.map(k => k.key) },
        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
      )
    );

    if (batchRes.data?.code !== 200) {
      // 1600000 = retry later — الدورة الجاية تعاود
      console.warn(`⚠️ [Tracking] Batch: ${batchRes.data?.message} (code: ${batchRes.data?.code})`);
      return;
    }
    const list = Array.isArray(batchRes.data?.data) ? batchRes.data.data : [];

    // 🔬 عينة أول قراءة Batch
    if (!global._cjSample_OrderDetailBatch) {
      global._cjSample_OrderDetailBatch = true;
      console.log('[Sample OrderDetailBatch]', JSON.stringify(list[0] || {}).slice(0, 1000));
    }

    // فهرسة بالمفتاحين (orderNum = STORE-x | cjOrderCode = SD...)
    const byKey = new Map();
    for (const d of list) {
      if (d.orderNum) byKey.set(String(d.orderNum).toLowerCase(), d);
      if (d.cjOrderCode) byKey.set(String(d.cjOrderCode).toLowerCase(), d);
    }

    for (const { order, key } of keys) {
      const d = byKey.get(key.toLowerCase());
      if (!d) continue; // CJ تخطاه بصمت — نستنى الدورة الجاية

      const status = String(d.orderStatus || '').toUpperCase();
      const track = String(d.trackNumber || '').trim();

      if (status === 'SHIPPED' && track.length > 3) {
        const upd = await pool.query(
          `UPDATE orders
             SET tracking_number = $1, status = 'fulfilled',
                 cj_order_number = COALESCE(NULLIF(cj_order_number,''), $3)
           WHERE id = $2 AND status = 'paid'
             AND (tracking_number IS NULL OR tracking_number = '')
           RETURNING id`,
          [track, order.id, d.cjOrderCode || key]
        );
        if (upd.rows.length) {
          console.log(`🚀 [CJ Dispatched] #${order.id}: ${track} (${d.logisticName || '?'})`);
          await notifyShipment(order, track, d.logisticName);
        }
      } else if (status === 'DELIVERED') {
        if (order.status === 'paid' && track.length > 3) {
          // 🚨 فاتنا SHIPPED (ويب هوك ضايع) — إشعار متأخر خير من والو
          const upd = await pool.query(
            `UPDATE orders SET tracking_number = $1, status = 'fulfilled'
             WHERE id = $2 AND status = 'paid' AND (tracking_number IS NULL OR tracking_number = '') RETURNING id`,
            [track, order.id]
          );
          if (upd.rows.length) {
            console.log(`[CJ] #${order.id} DELIVERED (SHIPPED فات) — إشعار متأخر`);
            await notifyShipment(order, track, d.logisticName);
          }
        } else if (order.status === 'fulfilled') {
          const upd = await pool.query(
            "UPDATE orders SET status = 'completed' WHERE id = $1 AND status = 'fulfilled' RETURNING id",
            [order.id]
          );
          if (upd.rows.length) console.log(`[CJ] #${order.id} DELIVERED -> completed`);
        }
      }
    }
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('CJ Logistics Cron', err);
  }
});

// ==========================================
// 🤖 Auto-Heal cron - السلّم الكامل للطلبات العالقة
// ==========================================
cron.schedule('17,47 * * * *', async () => {
  try {
    const { rows: stuck } = await pool.query(`
      SELECT id, status, customer_name, customer_email, customer_phone, total_amount, cj_order_number, created_at
      FROM orders
      WHERE status IN ('paid', 'fulfilled')
        AND (tracking_number IS NULL OR tracking_number = '')
        AND created_at <= NOW() - INTERVAL '2 hours'
        AND created_at >= NOW() - INTERVAL '30 days'
      LIMIT 10;
    `);
    if (!stuck.length) return;

    const keys = stuck.map(function (o) {
      const stored = String(o.cj_order_number || '').trim();
      return { order: o, key: (stored && !/^STORE-/i.test(stored)) ? stored : ('STORE-' + o.id) };
    });

    const res = await cjRequest((token) =>
      axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetailBatch',
        { orderIds: keys.map(function (k) { return k.key; }) },
        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
      )
    );
    if (res.data?.code !== 200) return;
    const list = Array.isArray(res.data.data) ? res.data.data : [];
    const byKey = new Map();
    for (const d of list) {
      if (d.orderNum) byKey.set(String(d.orderNum).toLowerCase(), d);
      if (d.cjOrderCode) byKey.set(String(d.cjOrderCode).toLowerCase(), d);
    }

    for (const { order, key } of keys) {
      const d = byKey.get(key.toLowerCase());
      if (!d) continue;
      const status = String(d.orderStatus || '').toUpperCase();
      const hasLogi = !!d.logisticName;
      const paid = !!d.paymentDate;

      // 1) CREATED عالق بلا شحن بلا دفع → السلّم
      if (status === 'CREATED' && !hasLogi && !paid) {
        const rep = await autoRepairLogistics(d.cjOrderCode || key);
        if (rep.repaired) {
          console.log('[AutoHeal] #' + order.id + ' logistics bound: ' + rep.logisticsName + ' ($' + rep.postage + ')');
          continue;
        }
        if (!global['_cjRecreate_' + order.id]) {
          global['_cjRecreate_' + order.id] = true; // محاولة recreate واحدة برك لكل session
          console.warn('[AutoHeal] #' + order.id + ' repair failed (' + rep.reason + ') - delete + recreate...');
          const del = await deleteCJOrder(d.orderId, d.cjOrderCode, key);
          if (!del.ok) {
            console.warn('[AutoHeal] delete failed #' + order.id + ': ' + del.reason);
            sendAdminAlert('[CJ] Stuck order #' + order.id + ' - auto-repair & delete failed', '<p>repair: ' + rep.reason + ' | delete: ' + del.reason + '</p>').catch(function () {});
            continue;
          }
          await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [order.id]).catch(function () {});
          (async () => {
            try {
              const oRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
              const full = oRes.rows[0];
              const iRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
              let addr = {};
              try { addr = JSON.parse(full.shipping_address); } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} addr = { line1: full.shipping_address, country: 'US' }; }
              const r = await fulfillCJOrder(order.id, full.customer_name, {
                address: addr, phone: full.customer_phone || '', email: full.customer_email || '', name: full.customer_name
              }, iRes.rows);
              console.log('[AutoHeal] recreate #' + order.id + ' ->', JSON.stringify(r).slice(0, 200));
            } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {} logger.logError('AutoHeal recreate #' + order.id, e); }
          })();
          continue;
        }
        // سبقنا recreate — تنبيه مرة كل 24س
        if (!global['_cjStuckAlert_' + order.id] || Date.now() - global['_cjStuckAlert_' + order.id] > 86400000) {
          global['_cjStuckAlert_' + order.id] = Date.now();
          sendAdminAlert('[CJ] Order #' + order.id + ' still stuck after recreate attempt', '<p>Status: CREATED, no logistics, no payment. Last repair reason: ' + rep.reason + '</p>').catch(function () {});
        }
        continue;
      }

      // 2) شحن محدد لكن غير مدفوع عند CJ → autopay من المحفظة (2.2)
      if (hasLogi && !paid && (status === 'UNPAID' || status === 'CREATED')) {
        if (!global['_cjPayTry_' + order.id] || Date.now() - global['_cjPayTry_' + order.id] > 3600000) {
          global['_cjPayTry_' + order.id] = Date.now();
          const pay = await payCJOrderBalance(d.orderId, d.cjOrderCode, key);
          console.log('[AutoHeal] payBalance #' + order.id + ':', pay.ok ? 'PAID' : 'failed: ' + pay.reason);
        }
      }
    }
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('AutoHeal Cron', err);
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

  // 🛡️ IDOR Defense: بيانات الطلب الحقيقية تُحقن في الـ prompt فقط بعد تطابق
  //    مزدوج (order_id + customer_email)
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
    } catch (dbErr) { try { Sentry.captureException(dbErr); } catch (__laclarcGuard) {}
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

  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    logger.logError('AI Chat Error', err);
    res.json({ reply: FALLBACK_REPLIES[lang].error });
  }
});
// ==========================================
// 🌟 M#27 — Verified-Purchase Review Invitation (يومياً 10:00 صباحاً)
// الزبون استلم طلبه (completed) — 5-10 أيام → دعوة مراجعة بالكوبون
// Anti-spam: review_invited_at IS NULL → دعوة واحدة للأبد
// ==========================================
cron.schedule('0 10 * * *', async () => {
  console.log('🌟 [ReviewInvite] Checking for delivered orders...');
  try {
    const { rows: toInvite } = await pool.query(`
      SELECT id, customer_name, customer_email, review_token
      FROM orders
      WHERE status = 'completed'
        AND delivered_at BETWEEN NOW() - INTERVAL '10 days' AND NOW() - INTERVAL '5 days'
        AND customer_email IS NOT NULL
        AND customer_email NOT LIKE '%@laclarc.com'
        AND review_invited_at IS NULL
      LIMIT 20;
    `);
    if (toInvite.length === 0) { console.log('🌟 [ReviewInvite] nothing to invite.'); return; }

    for (const order of toInvite) {
      const reviewUrl = `${process.env.FRONTEND_URL || 'https://laclarc.com'}/review/${order.id}?t=${order.review_token}`;

      const itemsRes = await pool.query(`
        SELECT p.title, p.image_url FROM order_items oi
        JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1
      `, [order.id]);
      const product = itemsRes.rows[0];

      await sendEmail({
        to: order.customer_email,
        subject: `⭐ How was your ${product?.title || 'order'}? Get 5% off!`,
        html: `
          <div style="font-family:Arial;max-width:550px;margin:auto;background:#F9F8FC;padding:25px;border-radius:16px;border:1px solid #E5E7EB;">
            <div style="text-align:center;margin-bottom:20px;">
              <h1 style="color:#1D1E3C;margin:0;font-size:24px;">Laclarc</h1>
              <p style="color:#8B78C6;font-weight:bold;font-size:12px;margin:4px 0 0;">Your opinion matters 💜</p>
            </div>
            <p style="color:#4B5563;font-size:14px;line-height:1.6;">
              Hello <strong>${order.customer_name || 'there'}</strong>,<br>
              Your order <strong>#${order.id}</strong> has been delivered! 🎉<br><br>
              We'd love to hear about your experience. Your honest review helps other shoppers and helps us improve.
            </p>
            ${product?.image_url ? `<div style="text-align:center;margin:20px 0;"><img src="${product.image_url}" style="max-width:200px;border-radius:12px;border:1px solid #E5E7EB;" /></div>` : ''}
            <div style="background:#FFF;border:2px dashed #8B78C6;padding:15px;border-radius:12px;text-align:center;margin-bottom:25px;">
              <p style="margin:0 0 5px;color:#1D1E3C;font-size:12px;font-weight:bold;">WRITE A REVIEW & GET:</p>
              <span style="display:inline-block;background:#8B78C6;color:#fff;padding:6px 16px;border-radius:6px;font-weight:bold;font-size:15px;letter-spacing:1px;">5% OFF NEXT ORDER</span>
            </div>
            <div style="text-align:center;">
              <a href="${reviewUrl}" style="display:inline-block;background:#8B78C6;color:#fff;padding:14px 32px;border-radius:30px;font-weight:bold;text-decoration:none;font-size:14px;">
                Write My Review ⭐
              </a>
            </div>
            <p style="text-align:center;color:#9CA3AF;font-size:11px;margin-top:25px;">
              This link is unique to your order and expires after use.
            </p>
          </div>
        `
      });

      await pool.query('UPDATE orders SET review_invited_at = NOW() WHERE id = $1', [order.id]);
      console.log(`🌟 [ReviewInvite] Invitation sent for #${order.id} → ${order.customer_email}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) { try { Sentry.captureException(err); } catch (__laclarcGuard) {}
    console.error('❌ [ReviewInvite] Error:', err.message);
  }
});

// ==========================================
// 🌟 M#27 — Verified-Review Endpoints (token-gated)
// ==========================================

// GET — verify token + load order details (public)
app.get('/api/review/verify/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const token = String(req.query.t || '');
  if (!Number.isInteger(orderId) || orderId <= 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return res.status(400).json({ error: 'Invalid link' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, customer_name, status, review_submitted_at FROM orders
       WHERE id = $1 AND review_token = $2`,
      [orderId, token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Link invalid' });
    if (rows[0].review_submitted_at) return res.status(409).json({ error: 'Review already submitted' });
    if (rows[0].status !== 'completed') return res.status(400).json({ error: 'Order not delivered yet' });

    const itemsRes = await pool.query(
      `SELECT oi.product_id, oi.quantity, oi.price_at_purchase, p.title, p.image_url
       FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [orderId]
    );

    res.json({ orderId, customerName: rows[0].customer_name, items: itemsRes.rows });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('Review Verify', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST — submit verified review (token-gated, one-time)
app.post('/api/review/invite/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const token = String(req.body?.token || '');
  const rating = parseInt(req.body?.rating, 10);
  const content = String(req.body?.content || '').trim();
  const images = Array.isArray(req.body?.images) ? req.body.images : [];

  if (!Number.isInteger(orderId) || orderId <= 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return res.status(400).json({ success: false, error: 'Invalid link' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, error: 'Rating must be 1-5' });
  }
  if (content.length < 10) {
    return res.status(400).json({ success: false, error: 'Review must be at least 10 characters.' });
  }

  try {
    // Verify token + status + not already submitted
    const { rows } = await pool.query(
      `SELECT id, customer_name, user_id FROM orders
       WHERE id = $1 AND review_token = $2 AND status = 'completed' AND review_submitted_at IS NULL`,
      [orderId, token]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Link already used or invalid' });

    // Get first product_id from order
    const itemsRes = await pool.query(
      'SELECT product_id FROM order_items WHERE order_id = $1 LIMIT 1',
      [orderId]
    );
    const productId = itemsRes.rows[0]?.product_id;
    if (!productId) return res.status(400).json({ success: false, error: 'No product in order' });

    // 🩹 Images — Cloudinary only
    const safeImages = images.filter((u) => typeof u === 'string' && u.startsWith('https://res.cloudinary.com/'));
    // 💾 Insert — user_id من الـ order owner → تصير "حقيقية" بالفلتر تاعنا!
    await pool.query(
      `INSERT INTO reviews (product_id, author, user_id, rating, content, country, images, verified_purchase)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [productId, rows[0].customer_name || 'Verified Buyer', rows[0].user_id, rating, content, 'Verified Purchase', safeImages]
    );

    // Mark token consumed (one-time use)
    await pool.query('UPDATE orders SET review_submitted_at = NOW() WHERE id = $1', [orderId]);
    await auditEvent('VERIFIED_REVIEW_SUBMITTED', orderId, { productId, rating }, 'info');

    res.json({ success: true, message: 'Review published! Use NEXT5 for 5% off your next order.' });
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}
    logger.logError('Review Submit', e);
    res.status(500).json({ success: false, error: 'Internal error' });
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
  } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}} // ✅ Tenet#14 documented exception: already dying — forceExit timer covers

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
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  server.close(async () => {
    console.log('✅ HTTP server closed.');
    try {
      await pool.end();
      console.log('✅ DB Pool drained.');
    } catch (e) { try { Sentry.captureException(e); } catch (__laclarcGuard) {}} // ✅ Tenet#14 documented exception: exiting anyway
    process.exit(0);
  });

  setTimeout(() => {
    console.error('⚠️ Forcefully exiting after 10s shutdown timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// ──── [LACLARC::SENTRY-ERR] v1 (Task 16) ────
// errorHandler — AFTER كامل الـ routes، BEFORE أي error middleware آخر.
// (Sentry كيلقط كمان uncaughtException/unhandledRejection أوتوماتيكياً —
//  GlobalHandlers integration مفعّلة by default، ما محتاجينش hooks يدوية)
if (typeof Sentry.setupExpressErrorHandler === 'function') {
  Sentry.setupExpressErrorHandler(app);          // v8+
} else if (Sentry.Handlers && typeof Sentry.Handlers.errorHandler === 'function') {
  app.use(Sentry.Handlers.errorHandler());       // v7 fallback
}
// ──── [/LACLARC::SENTRY-ERR] ────
