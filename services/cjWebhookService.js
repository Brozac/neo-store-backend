// services/cjWebhookService.js - Laclarc CJ Webhook Engine (Real-time Sync)
const axios = require('axios');
const crypto = require('crypto');
const pool = require('../db');
const logger = require('../logger');
const { cjRequest } = require('./cjService');
const { sendOrderTrackingWhatsApp } = require('./whatsappService');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// ==========================================
// 🛡️ Idempotency — messageId ديما كيتبقى ثابت حتى فالـ retries
// (نفس نمط processedEvents ديال bot.js)
// ==========================================
const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 60 * 60 * 1000); // تنظيف كل ساعة

// ==========================================
// 🔐 التحقق من التوقيع: Base64(HmacSHA256(secret=openId, body))
// ==========================================
function verifySignature(rawBody, signHeader, openId) {
  if (!openId || !signHeader) return false;
  try {
    const expected = crypto.createHmac('sha256', openId).update(rawBody).digest('base64');
    const received = Buffer.from(signHeader);
    const expectedBuf = Buffer.from(expected);
    return received.length === expectedBuf.length && crypto.timingSafeEqual(received, expectedBuf);
  } catch {
    return false;
  }
}

// ==========================================
// 📦 ORDER — أهم معالج: حالات الطلب + الشحن لحظياً
// ==========================================
async function handleOrderUpdate(params = {}) {
  // دفاعي: CJ كيصيفط orderId (رقم CJ = STORE-X عندنا) و/أو orderNumber
  const cjOrderNumber = params.orderId || params.orderNumber || '';
  if (!cjOrderNumber) return;

  // استخراج معرف الطلب ديالنا من STORE-{id} (أو split: STORE-{id}-S{n})
  const storeMatch = cjOrderNumber.match(/^STORE-(\d+)/i);
  if (!storeMatch) return;
  const orderId = storeMatch[1];

  const status = String(params.status || '').toUpperCase();
  const trackNumber = params.trackNumber || params.trackingNumber || null;

  const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (orderRes.rows.length === 0) return;
  const order = orderRes.rows[0];

  // 🚚 SHIPPED — اللحظة الذهبية: تحديث + واتساب + إيميل فوراً (بدل انتظار الكرون ساعة)
  if ((status === 'SHIPPED' || status === 'DISPATCHED') && trackNumber && trackNumber.trim().length > 3) {
    const updateRes = await pool.query(
      "UPDATE orders SET tracking_number = $1, status = 'fulfilled' WHERE id = $2 AND (tracking_number IS NULL OR tracking_number = '') RETURNING id",
      [trackNumber.trim(), orderId]
    );
    if (updateRes.rows.length === 0) return; // عالجنا من قبل — dedup على مستوى الـ DB

    console.log(`🚀 [CJ Webhook] Order #${orderId} SHIPPED! Tracking: ${trackNumber} — notifying customer instantly...`);

    // واتساب (E.164/+213 داخل الخدمة)
    try {
      await sendOrderTrackingWhatsApp(order.customer_phone, order.customer_name, order.id, trackNumber.trim());
    } catch (waErr) {
      logger.logError('Webhook WhatsApp Notification', waErr);
    }

    // إيميل تأكيد الشحن
    if (order.customer_email && !order.customer_email.includes('@laclarc.com')) {
      try {
        const itemsRes = await pool.query(
          `SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
          [orderId]
        );
        const { sendOrderConfirmationEmail } = require('../controllers/paymentController');
        await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, itemsRes.rows);
      } catch (mailErr) {
        logger.logError('Webhook Tracking Email', mailErr);
      }
    }
    return;
  }

  // ✅ COMPLETED
  if (status === 'COMPLETED') {
    await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1 AND status IN ('paid', 'fulfilled')", [orderId]);
    return;
  }

  // ⚠️ إلغاء/استرجاع — علّم الأدمن فوراً
  if (status === 'CANCELLED' || status === 'REFUND_COMPLETE' || status === 'INTERCEPT') {
    logger.logError(`CJ Webhook: Order #${orderId} ${status}`, new Error(JSON.stringify(params).slice(0, 300)));
    await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1 AND status IN ('paid', 'completed', 'fulfilled')", [orderId]);
  }
}

// ==========================================
// 🚚 LOGISTICS — تحديثات تتبع إضافية (دفاعي — البنية ممكن تتبدل)
// ==========================================
async function handleLogistics(params = {}) {
  const trackNumber = params.trackNumber || params.trackingNumber;
  if (!trackNumber) return;
  // مستقبلاً: سجل أحداث التتبع التفصيلية فجدول tracking_events
  console.log(`📦 [CJ Webhook] Logistics update for ${trackNumber}: ${params.status || 'update'}`);
}

// ==========================================
// 🏷️ PRODUCT — تغيّر السعر/الحالة → نطبقو صيغة التسعير ديالنا
// ==========================================
async function handleProductUpdate(params = {}) {
  const cjPid = String(params.productId || params.pid || '');
  if (!cjPid) return;

  const prodRes = await pool.query('SELECT id, price FROM products WHERE cj_product_id = $1', [cjPid]);
  if (prodRes.rows.length === 0) return;
  const product = prodRes.rows[0];

  // منتج تزال من CJ → نخفيو من المتجر
  if (params.status && String(params.status).toUpperCase() === 'DELETE') {
    await pool.query('UPDATE products SET stock_status = false WHERE id = $1', [product.id]);
    console.log(`🗑️ [CJ Webhook] Product ${cjPid} delisted — hidden from store.`);
    return;
  }

  // تغيّر السعر → نعيدو الحساب بصيغة Laclarc (نفس معادلة الـ sync)
  const cjPrice = parseFloat(params.sellPrice ?? params.costPrice);
  if (Number.isFinite(cjPrice) && cjPrice > 0) {
    let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
    sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
    const safePrice = parseFloat(sellingPrice.toFixed(2));

    if (Math.abs(safePrice - Number(product.price)) > 0.01) {
      await pool.query('UPDATE products SET price = $1, original_price = $2 WHERE id = $3',
        [safePrice, parseFloat((safePrice * 1.5).toFixed(2)), product.id]);
      console.log(`💰 [CJ Webhook] Product ${cjPid} price updated: $${product.price} → $${safePrice}`);
    }
  }
}

// ==========================================
// 📦 STOCK — المخزون خوا → نخفيو فوراً (بلا بيع منتج ناقص)
// ==========================================
async function handleStockUpdate(params = {}) {
  const cjPid = String(params.productId || params.pid || '');
  if (!cjPid) return;
  const available = params.stockQuantity === undefined ? null : Number(params.stockQuantity) > 0;

  if (available === false) {
    await pool.query('UPDATE products SET stock_status = false WHERE cj_product_id = $1', [cjPid]);
    console.log(`📉 [CJ Webhook] Product ${cjPid} out of stock — hidden from store.`);
  } else if (available === true) {
    await pool.query('UPDATE products SET stock_status = true WHERE cj_product_id = $1', [cjPid]);
  }
}

// ==========================================
// 💳 MAKEUP — فاتورة فرق شحن من CJ → 🔔 إنذار الأدمن فوراً
// ==========================================
async function handleMakeup(params = {}) {
  console.warn(`💳 [CJ Webhook] MAKEUP BILL ${params.status}: ${params.orderId} — $${params.amount} (${params.reason})`);

  if (params.status === 'CREATED') {
    const { sendEmail } = require('../controllers/paymentController');
    await sendEmail({
      to: process.env.BREVO_USER,
      subject: `💳 CJ Makeup Bill Created — $${params.amount} for ${params.relationOrderId}`,
      html: `<h2>CJ Postage Makeup Bill</h2>
             <p><strong>Original Order:</strong> ${params.relationOrderId}</p>
             <p><strong>Amount:</strong> $${params.amount}</p>
             <p><strong>Reason:</strong> ${params.reason || 'N/A'}</p>
             <p>Pay it from CJ wallet to avoid fulfillment delays.</p>`
    }).catch(err => logger.logError('Makeup Alert Email', err));
  }
}

// ==========================================
// 🎯 المعالج الرئيسي — 200 فوري + معالجة خلفية
// ==========================================
async function cjWebhookHandler(req, res) {
  // ✅ الرد الفوري (< 3s إجباري من CJ) — الحماية من auto-close
  res.status(200).json({ code: 200, message: 'OK' });

  (async () => {
    try {
      const rawBody = req.body; // Buffer من express.raw
      const sign = req.headers['sign'];
      const openId = process.env.CJ_OPEN_ID;

      if (!verifySignature(rawBody, sign, openId)) {
        logger.logError('CJ Webhook Signature', new Error(`Invalid/missing sign header`));
        return;
      }

      const event = JSON.parse(rawBody.toString('utf8'));
      const { messageId, type, messageType, params } = event;

      if (!messageId || processedMessages.has(messageId)) return;
      processedMessages.add(messageId);

      console.log(`📨 [CJ Webhook] ${type}/${messageType} (${messageId.slice(0, 8)}...)`);

      switch (type) {
        case 'ORDER':        await handleOrderUpdate(params); break;
        case 'LOGISTICS':    await handleLogistics(params); break;
        case 'PRODUCT':      await handleProductUpdate(params); break;
        case 'STOCK':        await handleStockUpdate(params); break;
        case 'MAKEUP':       await handleMakeup(params); break;
        default: /* PRIVATE_ORDER — ماكانستعملوهش دابا */ break;
      }
    } catch (err) {
      // الخطأ فالمعالجة مايأثرش على الـ 200 اللي تصيفط — الـ topic مايتسدش
      logger.logError('CJ Webhook Processing', err);
    }
  })();
}

// ==========================================
// 📝 تسجيل الـ Callback URL عند CJ
// ==========================================
async function registerWebhooks(callbackUrl) {
  return cjRequest((token) => axios.post(`${CJ_BASE}/webhook/set`, {
    product:   { type: 'ENABLE', callbackUrls: [callbackUrl] },
    stock:     { type: 'ENABLE', callbackUrls: [callbackUrl] },
    order:     { type: 'ENABLE', callbackUrls: [callbackUrl] },
    logistics: { type: 'ENABLE', callbackUrls: [callbackUrl] },
    makeup:    { type: 'ENABLE', callbackUrls: [callbackUrl] },
  }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
}

// ==========================================
// 📌 اشتراك كل منتجات المتجر (دفاتر 100 — حسب مستوى الحساب)
// ==========================================
async function subscribeAllStoreProducts() {
  const { rows } = await pool.query(
    "SELECT cj_product_id FROM products WHERE stock_status = true AND cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%'"
  );

  const ids = rows.map(r => String(r.cj_product_id)).filter(Boolean);
  let success = 0, failed = 0;

  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const res = await cjRequest((token) => axios.post(`${CJ_BASE}/webhook/product/subscribe`,
        { productIds: batch },
        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
      ));
      const data = res.data?.data || {};
      success += (data.successProductIds || []).length;
      failed += (data.failProductIds || []).length;
    } catch (err) {
      logger.logError(`CJ Subscribe batch ${i / 100 + 1}`, err);
    }
    await new Promise(r => setTimeout(r, 1200)); // Tenet #6
  }

  return { total: ids.length, success, failed };
}

module.exports = { cjWebhookHandler, registerWebhooks, subscribeAllStoreProducts, verifySignature };