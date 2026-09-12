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
// 🔐 التحقق المرن — نجرّب كل المفاتيح المحتملة
// (حصراً للمواضيع الموثقة بالتوقيع: MAKEUP docs 4.2 / PRIVATE_ORDER docs 5.3)
// ==========================================
function verifySignatureFlexible(rawBody, signHeader) {
  const candidates = [
    process.env.CJ_OPEN_ID,
    process.env.CJ_API_KEY,
    process.env.CJ_API_TOKEN,
  ].filter(Boolean);

  for (const secret of candidates) {
    try {
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
      const received = Buffer.from(signHeader);
      const expectedBuf = Buffer.from(expected);
      if (received.length === expectedBuf.length && crypto.timingSafeEqual(received, expectedBuf)) {
        return true;
      }
    } catch { /* نكملو للمفتاح الموالي */ }
  }
  return false;
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
let _logisticsSampleLogged = false;
async function handleLogistics(params = {}, rawEvent) {
  // عينة كاملة مرة وحدة — باش نظبو الـ parser على الواقع
  if (!_logisticsSampleLogged) {
    _logisticsSampleLogged = true;
    console.log('🔬 [Logistics Sample]', JSON.stringify(rawEvent || params).slice(0, 800));
  }

  const trackNumber = params.trackNumber || params.trackingNumber;
  if (!trackNumber) return;
  // مستقبلاً: سجل أحداث التتبع التفصيلية فجدول tracking_events
  console.log(`📦 [CJ Webhook] Logistics update for ${trackNumber}: ${params.status || 'update'}`);
}

// ==========================================
// 🏷️ PRODUCT — البنية الحقيقية (من العينة):
// { pid, fields: ["productImage"], productImage: "[json]", productName: "[صيني]" }
// ⚠️ السعر ماكيجيش هنا — كيجي من VARIANT/UPDATE
// ⚠️ productName بالصينية — مانتحديثوش العناوين أبداً!
// ==========================================
let _productSampleLogged = false;
async function handleProductUpdate(params = {}, rawEvent, messageType) {
  if (!_productSampleLogged) {
    _productSampleLogged = true;
    console.log('🔬 [Product Sample]', JSON.stringify(rawEvent || params).slice(0, 500));
  }

  const cjPid = String(params.pid || '');
  if (!cjPid) return;

  // 🗑️ حذف من CJ → إخفاء من المتجر
  if (messageType === 'DELETE') {
    await pool.query('UPDATE products SET stock_status = false WHERE cj_product_id = $1', [cjPid]);
    console.log(`🗑️ [CJ Webhook] Product ${cjPid} DELETED by CJ — hidden from store.`);
    return;
  }

  const prodRes = await pool.query('SELECT id, image_url FROM products WHERE cj_product_id = $1', [cjPid]);
  if (prodRes.rows.length === 0) return;
  const product = prodRes.rows[0];

  // ✨ نفحصو غير الحقول المعلنة فـ fields (بلا افتراضات)
  const changedFields = Array.isArray(params.fields) ? params.fields : [];

  // تغيّر الصورة الرئيسية → تحديث image_url (إلا الصورة القديمة من CJ نفسو)
  if (changedFields.includes('productImage') && params.productImage) {
    try {
      const imgs = JSON.parse(params.productImage);
      const firstImg = Array.isArray(imgs) ? imgs.find(u => typeof u === 'string' && u.startsWith('http')) : null;
      if (firstImg && product.image_url && product.image_url.includes('cjdropshipping') && firstImg !== product.image_url) {
        await pool.query('UPDATE products SET image_url = $1 WHERE id = $2', [firstImg, product.id]);
        console.log(`🖼️ [CJ Webhook] Product ${cjPid} main image refreshed.`);
      }
    } catch { /* productImage ماشي JSON صالح — تجاهل */ }
  }

  // 📝 ملاحظة: productName كيجي بالصينية — عناويننا إنجليزية، عمرو مايتلمسو
}
// ==========================================
// 🧬 VARIANT — البنية الحقيقية (من العينة):
// { vid, pid, variantSellPrice: "10.990", variantSku, variantKey, variantStatus: 1 }
// 💰 هذا هو مصدر الأسعار الحقيقي — حماية الهامش الزمنية!
// ==========================================
let _variantSampleLogged = false;
async function handleVariantUpdate(params = {}, rawEvent, messageType) {
  if (!_variantSampleLogged) {
    _variantSampleLogged = true;
    console.log('🔬 [Variant Sample]', JSON.stringify(rawEvent || params).slice(0, 500));
  }

  const vid = String(params.vid || '');
  const pid = String(params.pid || '');
  if (!vid || !pid) return;

  const prodRes = await pool.query('SELECT id, variants FROM products WHERE cj_product_id = $1', [pid]);
  if (prodRes.rows.length === 0) return;
  const product = prodRes.rows[0];

  // Parse الـ variants JSONB بأمان
  let variants = product.variants;
  if (typeof variants === 'string') {
    try { variants = JSON.parse(variants); } catch { variants = []; }
  }
  if (!Array.isArray(variants)) variants = [];

  const idx = variants.findIndex(v => String(v.vid) === vid);

  // 🗑️ DELETE → نحيدو الـ variant من القائمة
  if (messageType === 'DELETE') {
    if (idx > -1) {
      variants.splice(idx, 1);
      await pool.query('UPDATE products SET variants = $1 WHERE id = $2', [JSON.stringify(variants), product.id]);
      console.log(`🗑️ [CJ Webhook] Variant ${vid} removed from product ${pid}.`);
    }
    return;
  }

  // ✨ INSERT / UPDATE — دمج البيانات الجديدة (نحافظو على أي حقول محلية)
  const updates = {};
  if (params.variantSellPrice !== undefined) updates.variantSellPrice = params.variantSellPrice;
  if (params.variantSku !== undefined) updates.variantSku = params.variantSku;
  if (params.variantKey !== undefined) updates.variantKey = params.variantKey;
  if (params.variantStatus !== undefined) updates.variantStatus = params.variantStatus;
  if (params.variantImage !== undefined) updates.variantImage = params.variantImage;

  let oldPrice = null;
  if (idx > -1) {
    oldPrice = variants[idx].variantSellPrice;
    variants[idx] = { ...variants[idx], ...updates };
  } else {
    variants.push({ vid, ...updates });
  }

  await pool.query('UPDATE products SET variants = $1 WHERE id = $2', [JSON.stringify(variants), product.id]);

  // 💰 لوج تغيّرات الأسعار فقط — أهم إشارة مالية
  const newPrice = params.variantSellPrice;
  if (newPrice && oldPrice && String(oldPrice) !== String(newPrice)) {
    console.log(`💰 [CJ Webhook] Variant ${vid} price: $${oldPrice} → $${newPrice} (product ${pid})`);
  }
}

// ==========================================
// 📦 STOCK — البنية الحقيقية (من العينة الحية):
// params: { "<vid>": [ { pid, vid, storageNum, areaEn, countryCode } ] }
// الكمية الحقيقية = storageNum ✅
// ==========================================
let _stockSampleLogged = false;
async function handleStockUpdate(params = {}, rawEvent) {
  if (!_stockSampleLogged) {
    _stockSampleLogged = true;
    console.log('🔬 [Stock Sample]', JSON.stringify(rawEvent || params).slice(0, 500));
  }

  // ✨ تجميع المخزون الإجمالي لكل pid (عدة variants/warehouses لنفس المنتج)
  const stockByPid = new Map();

  for (const [key, records] of Object.entries(params)) {
    if (!Array.isArray(records)) continue;

    for (const rec of records) {
      const pid = String(rec.pid || key);
      const vid = rec.vid ? String(rec.vid) : null;
      const qty = Number(rec.storageNum ?? rec.stockQuantity ?? rec.quantity ?? rec.stock ?? rec.qty);
      if (!Number.isFinite(qty)) continue;

      // إجمالي عبر المستودعات/الـ variants
      stockByPid.set(pid, (stockByPid.get(pid) || 0) + qty);

      // ✨ اختياري مستقبلاً: تحديث مخزون كل variant فالـ JSONB
      // (حالياً كنكفيو بمستوى المنتج — كافي لعرض متوفر/غير متوفر)
    }
  }

  // تحديث واحد لكل منتج (ماشي واحد لكل record — أداء أنظف)
  for (const [pid, totalQty] of stockByPid) {
    const available = totalQty > 0;
    const res = await pool.query(
      'UPDATE products SET stock_status = $1 WHERE cj_product_id = $2 RETURNING id',
      [available, pid]
    );
    if (res.rows.length > 0 && !available) {
      console.log(`📉 [CJ Webhook] Product ${pid} OUT OF STOCK (${totalQty} left) — hidden from store.`);
    }
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
      const event = JSON.parse(rawBody.toString('utf8'));
      const { messageId, type, messageType, params } = event;

      // 🔬 عينة كاملة أول مرة لكل نوع — باش نظبو الـ parsers على الواقع
      const sampleKey = `_cjSample_${type}`;
      if (!global[sampleKey]) {
        global[sampleKey] = true;
        console.log(`🔬 [Sample ${type}]`, rawBody.toString('utf8').slice(0, 800));
      }

      // 🔐 التوقيع الصارم — حصراً للمواضيع الموثقة بالتوقيع (docs 4.2 / 5.3)
      // ORDER/PRODUCT/STOCK/LOGISTICS: CJ ماكيوثقش عليهم توقيعاً — كيتعالجو مباشرة
      const signHeader = req.headers['sign'];
      if (signHeader && (type === 'MAKEUP' || type === 'PRIVATE_ORDER')) {
        const valid = verifySignatureFlexible(rawBody, signHeader);
        if (!valid) {
          logger.logError('CJ Webhook: signed topic rejected', new Error(`${type} signature invalid`));
          return;
        }
      }

      // 🛡️ Idempotency — الرسائل المكررة (retries) كيتجاهلو
      if (!messageId || processedMessages.has(messageId)) return;
      processedMessages.add(messageId);

      console.log(`📨 [CJ Webhook] ${type}/${messageType} (${String(messageId).slice(0, 8)}...)`);

            switch (type) {
        case 'ORDER':        await handleOrderUpdate(params); break;
        case 'LOGISTICS':    await handleLogistics(params, event); break;
        case 'PRODUCT':      await handleProductUpdate(params, event, messageType); break;
        case 'VARIANT':      await handleVariantUpdate(params, event, messageType); break;  // ✨ جديد
        case 'STOCK':        await handleStockUpdate(params, event); break;
        case 'MAKEUP':       await handleMakeup(params); break;
        default: break;
      }
    } catch (err) {
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

module.exports = { cjWebhookHandler, registerWebhooks, subscribeAllStoreProducts };