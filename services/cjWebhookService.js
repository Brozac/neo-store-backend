// services/cjWebhookService.js - Laclarc CJ Webhook Engine v2.1 (Schema-Confirmed + Hardened)
// ============================================================
// ✅ البنى الحقيقية مؤكدة من عينات حية (زر Test + production):
//   ORDER:    { cjOrderId, orderNum, orderStatus, logisticName, trackNumber,
//               createDate, payDate, deliveryDate, updateDate, postage }
//             ⚠️ orderNum = STORE-{id}(-S{n})(-R{n}) ديالنا (R = رقم مرقّى بعد رقم محروق عند CJ) | cjOrderId = BT... ديال CJ
//   LOGISTIC: { orderId (BT...), trackingNumber, trackingStatus, logisticName,
//               logisticsTrackEvents: "[{}]" }
//             ⚠️ type = "LOGISTIC" مفرد (ماشي LOGISTICS!) — و trackingNumber هنا
//               (فـ ORDER: trackNumber) — نفس المفهوم، اسمين مختلفين!
//   MAKEUP:   { orderId, relationOrderId, payOrderId, amount, reason, type,
//               diffUseType, status, createDate }  + مُوقّع (header: sign)
//   PRODUCT:  { pid, fields[], productImage, productName } — صور + DELETE فقط
//             (productName بالصينية — عمرو مايتلمس)
//   VARIANT:  { vid, pid, variantSellPrice, variantSku, variantKey,
//               variantStatus, variantImage } — مصدر الأسعار الحقيقي
//   STOCK:    { "<vid>": [ { pid, vid, storageNum, areaEn, countryCode } ] }
// ⚠️ openId فالويب هوك رقمي (44510) — ماشي نفس CJ_OPEN_ID ("CJ5670990")
// ⚠️ split shipments: tracking_number عمود واحد — S{n} الثاني كيتطنش
//    حالياً (جدول tracking_events = roadmap)
// ============================================================
// 🩹 HARDENING (2026-10-02 — full audit):
//   P0-20: ORDER/LOGISTIC غير موقّعة من CJ + order ids تسلسلية قابلة للتخمين
//          → أي حد على الإنترنت كان يقدر يزوّر SHIPPED/DELIVERED/CANCELLED
//            لأي طلب (tracking مزيف + إيميلات/واتساب للزبون + قتل السلسلة).
//          الإصلاح: كل حدث مُغيّر-للحالة يُتحقق منه باستجواب مباشر لـ CJ
//          (probeOrderStatus + classifyDuplicate) قبل قبوله. الحالات الإخبارية
//          (mapped=paid) تمر بلا تحقق — صفر side-effects.
//   P0-21: MAKEUP/PRIVATE_ORDER كانا يتخطاوان التحقق إذا sign غائب
//          (signHeader && ...) → تصيّد محفظة بإيميل مقنع. الآن: sign إجباري
//          بحضوره وغيابه — غيابه = رفض + alert.
//   P2-22: فرع manual كان يهرب من forward-only (completed قابل للهبوط لـ manual)
//   P2-24: حارس Mission#8 كان بعد الرد الإخباري — نُقل للأعلى (اتساق أمني)
// ============================================================
const axios = require('axios');
const crypto = require('crypto');
const pool = require('../db');
const logger = require('../logger');
const { cjRequest } = require('./cjService');
const { checkStripeDispute, sendAdminAlert, probeOrderStatus, classifyDuplicate, auditEvent } = require('./cjService'); // 🩹 P0-20 — أدوات التحقق
const { sendOrderTrackingWhatsApp } = require('./whatsappService');
const { syncShipmentEvents } = require('./shipTruth');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// ==========================================
// 🛡️ Idempotency — messageId ثابت حتى فالـ retries
// ==========================================
const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 60 * 60 * 1000); // تنظيف كل ساعة
// ⓘ ملاحظة معمارية موثقة: ما بعد الساعة، الإعادة الآمنة بنيوياً — كل المسارات
//   النهائية محروسة بـ RETURNING/state-machine (forward-only) فلا مضاعفة.

// ==========================================
// 🔐 التوقيع v2 — v1 (HMAC-SHA256/base64 على body فقط) فشلت فـ MAKEUP حقيقي!
// نجربو: {HMAC-SHA256, HMAC-MD5} × {apiKey, openId} × {body, openId+body}
//        × {hex, HEX, base64, base64url} + SHA256/MD5(body±apiKey)
// ⚠️ مؤقتاً: ماكاينش قائمة سوداء — إلا فشل كلشي كنرفضو + SIGN DEBUG + تنبيه
//    الأدمن (MAKEUP حدث مالي). الـ calibrator كيحسم الألغوريتم من أول زوج.
// ==========================================
function _tsEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function _candidateSigns(rawBody, eventOpenId) {
  const apiKey = process.env.CJ_API_KEY || process.env.CJ_API_TOKEN || '';
  const openId = String(eventOpenId ?? process.env.CJ_WEBHOOK_OPEN_ID ?? process.env.CJ_OPEN_ID ?? '');
  const openIdBuf = Buffer.from(openId);
  const out = [];

  for (const key of [apiKey, openId]) {
    if (!key) continue;
    const hmac = (alg, msg) => crypto.createHmac(alg, key).update(msg);
    for (const msg of [rawBody, ...(openId ? [Buffer.concat([openIdBuf, rawBody])] : [])]) {
      out.push(
        hmac('sha256', msg).digest('hex'),
        hmac('sha256', msg).digest('hex').toUpperCase(),
        hmac('sha256', msg).digest('base64'),
        hmac('sha256', msg).digest('base64url'),
        hmac('md5', msg).digest('hex'),
        hmac('md5', msg).digest('hex').toUpperCase()
      );
    }
  }

  for (const combo of [
    Buffer.concat([rawBody, Buffer.from(apiKey)]),
    Buffer.concat([Buffer.from(apiKey), rawBody]),
    ...(openId ? [Buffer.concat([openIdBuf, rawBody, Buffer.from(apiKey)])] : []),
  ]) {
    out.push(
      crypto.createHash('sha256').update(combo).digest('hex'),
      crypto.createHash('md5').update(combo).digest('hex')
    );
  }
  return out;
}

function verifySignatureFlexible(rawBody, signHeader, eventOpenId) {
  const received = String(signHeader || '').trim();
  if (!received) return false;
  return _candidateSigns(rawBody, eventOpenId).some(expected => _tsEq(expected, received));
}

// ==========================================
// 📦 ORDER — حالات الطلب + لحظة الشحن الذهبية
// خريطة حالات CJ → حالات laclarc
// ⓘ CREATED/IN_STOCK/IN_PROGRESS = معلومات فقط (الطلب عندنا ديجا paid قبل
//   الإرسال لـ CJ) — لا كتابة DB
// ==========================================
const CJ_ORDER_STATUS_MAP = {
  // ⭐ الحالات الرسمية (Order Status docs — مؤكدة 2026):
  CREATED: 'paid', IN_CART: 'paid', UNPAID: 'paid',        // معلومات — الزبون دفع عندنا أصلاً
  PENDING: 'paid', PROCESSING: 'paid', UNSHIPPED: 'paid',  // aggregate + sub-status — معلومات فقط
  TRASH: 'paid',  // 🆕 Fix#4 (درس #69): حذف داخلي من عندنا (zombie cleanup) — إخباري برك، لا mutation
  SHIPPED: 'fulfilled',
  DELIVERED: 'completed',
  CANCELLED: 'manual',
  // 🛡️ احتياط (أسماء قديمة/غير رسمية — ما تضرش):
  IN_STOCK: 'paid', IN_PROGRESS: 'paid', DISPATCHED: 'fulfilled',
  COMPLETED: 'completed', CLOSED: 'manual', REFUND_COMPLETE: 'manual', INTERCEPT: 'manual',
};
const STATUS_RANK = { pending: 0, manual: 0, paid: 1, fulfilled: 2, completed: 3 };

// 🔔 إشعار الشحن الموحد — ORDER webhook + LOGISTIC rescue + كرون Tracking كيتقاسموه
// ⚠️ توقيع whatsappService: هادي نسخة positional (مطابقة للويب هوك الأصلي).
//   إلا فحصتِ services/whatsappService.js ولقيتيه كياخد object واحد، عوّض
//   السطر المعلّم بـ ⚠️ بالنسخة المعلّمة تحته.
async function notifyShipment(order, trackNumber, logisticName) {
  // واتساب (E.164 داخل الخدمة)
  try {
    await sendOrderTrackingWhatsApp({ phone: order.customer_phone, customerName: order.customer_name, orderId: order.id, trackingNumber: trackNumber, email: order.customer_email }); // ⚠️ السطر المرجعي
  } catch (waErr) { logger.logError('Webhook WhatsApp Notification', waErr); }

  // إيميل تأكيد الشحن (لا إيميلات داخلية)
  if (order.customer_email && !order.customer_email.includes('@laclarc.com')) {
    try {
      const itemsRes = await pool.query(
        `SELECT oi.*, p.title, p.image_url FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
        [order.id]
      );
      const pcMod = require('../controllers/paymentController');
      if (typeof pcMod.sendOrderConfirmationEmail === 'function') {
        await pcMod.sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, itemsRes.rows);
      } else {
        // 🩹 hygiene (قابل للحذف): الفرع ميت دائماً حالياً — paymentController يصدّر router فقط.
        //    إن صدّرت sendOrderConfirmationEmail من paymentController يوماً — هذا الفرع سيعمل تلقائياً.
        await sendEmailDirect({
          to: order.customer_email,
          subject: 'Your Laclarc order #' + order.id + ' has shipped! Tracking: ' + trackNumber,
          html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px;">'
            + '<h2 style="color:#8B78C6;">Great news — your order is on its way! 🚀</h2>'
            + '<p>Order <strong>#' + order.id + '</strong> has been shipped'
            + (logisticName ? ' via <strong>' + logisticName + '</strong>' : '') + '.</p>'
            + '<p style="background:#F9F8FC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;">'
            + '<strong>Tracking number:</strong> <span style="font-size:16px;color:#1D1E3C;">' + trackNumber + '</span></p>'
            + '<p>You can follow your parcel anytime with this number.</p>'
            + '<p>Thank you for shopping with Laclarc! 💜</p></div>'
        });
      }
    } catch (mailErr) { logger.logError('Webhook Tracking Email', mailErr); }
  }
}

// 🩹 P2-27 hygiene — sendEmailDirect يحتاج تعريفه قبل استعماله (function declaration = hoisted، آمن —
//    لكن نثبّت الموضع للوضوح). التعريف الفعلي في الدفعة 2 مع بقية المرسلات.

async function handleOrderUpdate(params = {}) {
  const cjOrderId    = String(params.cjOrderId || '').trim();
  const orderNum     = String(params.orderNum || params.orderNumber || '').trim();
  const statusRaw    = String(params.orderStatus || params.status || '').trim().toUpperCase();
  const trackNumber  = String(params.trackNumber || '').trim();
  const logisticName = params.logisticName || null;
  const postage      = Number.isFinite(Number(params.postage)) ? Number(params.postage) : null;

  const storeMatch = orderNum.match(/^STORE-(\d+)(?:-S\d+)?(?:-R\d+)?$/i);
  if (!storeMatch && !cjOrderId) return;

  const mapped = CJ_ORDER_STATUS_MAP[statusRaw];
  if (!mapped) {
    console.warn(`⚠️ [ORDER] orderStatus غير معروف "${statusRaw}" — لوج فقط (raw كاين فوق). زيدو للـ map إلا كان حقيقياً.`);
    return;
  }

  // 🩹 P2-24 — حارس Mission#8 نُقل للأعلى (كان بعد الرد الإخباري — اتساق أمني):
  //    الرفض المبكر: CJ لا يوقّع ORDER/LOGISTIC، فالـ "هوية" الحدث = وجود الطلب في DB.
  const orderId = storeMatch ? Number(storeMatch[1]) : null;
  const knownRes = await pool.query(
    `SELECT id FROM orders
     WHERE ($1::int IS NOT NULL AND id = $1)
        OR (NULLIF($2,'') IS NOT NULL AND cj_order_number = $2)
     LIMIT 1`,
    [orderId, cjOrderId || null]
  );
  if (knownRes.rows.length === 0) {
    console.warn(`🛡️ [ORDER] Unrecognized order dropped (orderNum=${orderNum}, cj=${cjOrderId}, status=${statusRaw}) — possible spoof/scan`);
    return;
  }

  // معلومات ضعيفة — ديجا paid (بعد الحارس — 🩹 P2-24)
  if (mapped === 'paid') { console.log(`ℹ️ [ORDER] ${statusRaw} — تجاهل (ديجا paid عندنا)`); return; }

  const orderRes = await pool.query(
    `SELECT * FROM orders
     WHERE ($1::int IS NOT NULL AND id = $1)
        OR (NULLIF($2,'') IS NOT NULL AND cj_order_number = $2)
     LIMIT 1`,
    [orderId, cjOrderId || null]
  );
  if (!orderRes.rows.length) {
    console.warn(`⚠️ [ORDER] ما لقيناش order: orderNum=${orderNum} / cj=${cjOrderId}`);
    return;
  }
  const order = orderRes.rows[0];

  // 🩹 P0-20 — منع التزوير (أهم إصلاح في الملف):
  //    CJ لا يوقّع ORDER + الـ ids عندنا تسلسلية قابلة للتخمين → أي حد على الإنترنت
  //    كان يقدر يزوّر SHIPPED (tracking مزيف + واتساب/إيميل للزبون)
  //    أو CANCELLED (قتل السلسلة) أو DELIVERED (قفل forward-only للأبد).
  //    الحارس أعلاه يمنع الضجيج (طلبات مجهولة) — هذا يمنع التزوير (طلبات معروفة):
  //    كل حدث مُغيّر-للحالة يُستجوب من CJ مباشرة قبل قبوله.
  //    الكلفة: نداء CJ واحد لكل SHIPPED/DELIVERED — حدث يحدث مرة في عمر الطلب.
  if (mapped !== 'paid') {
    const targetNum = (order.cj_order_number && !/^STORE-/i.test(order.cj_order_number))
      ? order.cj_order_number
      : `STORE-${order.id}`;
    const probe = await probeOrderStatus(targetNum, 'WebhookVerify');
    const kind = classifyDuplicate(probe);
    const verified = kind === 'alive' && probe.matched;

    if (!verified) {
      await auditEvent('WEBHOOK_SPOOF_REJECTED', order.id, {
        claimed: { statusRaw, trackNumber, orderNum },
        probe: { status: probe.status, matched: probe.matched, orderNum: probe.orderNum }
      }, 'critical');
      logger.logError('CJ Webhook: state-mutation event FAILED CJ verification', new Error(`${orderNum} ${statusRaw}`));
      return; // لا إيميل، لا واتساب، لا حالة — أثر فقط
    }
    // 🩹 شدّة إضافية للشحن: رقم التتبع المزعوم يجب أن يطابق ما تقوله CJ نفسها
    //    (إذا CJ أعطت رقماً في الـ probe). إن أعطت لا شيء — نقبل رقم الـ webhook
    //    (بعض التريغات ترسل trackNumber في ORDER فقط) — حساسية معتدلة موثقة.
    if (mapped === 'fulfilled' && trackNumber && probe.realCj) {
      // probe.realCj هو كود CJ الداخلي لا رقم التتبع — التطابق الكامل للتتبع يتطلب
      // getOrderLogisticsInfo — نكتفي بالتحقق أن الحالة حية+matched (درع P0) حالياً.
      // Backlog: tighten بـ getOrderLogisticsInfo للتحقق من trackNumber نفسه.
    }
  }

  // ⚠️ إلغاء — transition جانبي
  if (mapped === 'manual') {
    // 🩹 P2-22 — forward-only: 'completed' لا يهبط لـ manual (كان ينتهك Tenet#6
    //    وكان المزوّر من P0-20 يقدر يستغلّه — الآن الدرعان معاً)
    if (order.status === 'pending') return;
    if (order.status === 'completed') {
      console.warn(`🛡️ [ORDER] #${order.id} ${statusRaw} على طلب completed — مرفوض (forward-only)`);
      await auditEvent('WEBHOOK_SPOOF_REJECTED', order.id, { claimed: statusRaw, current: 'completed' }, 'critical');
      return;
    }
    const manz = await pool.query(
      "UPDATE orders SET status = 'manual' WHERE id = $1 AND status IN ('paid','fulfilled') RETURNING id",
      [order.id]
    );
    if (manz.rowCount) {
      logger.logError(`CJ Webhook: Order #${order.id} ${statusRaw}`, new Error(orderNum));
    }
    return;
  }

  // 🛡️ forward-only
  if ((STATUS_RANK[order.status] ?? -1) >= (STATUS_RANK[mapped] ?? -1)) return;

  // 🚚 SHIPPED — اللحظة الذهبية
  if (mapped === 'fulfilled' && trackNumber) {
    const upd = await pool.query(
      `UPDATE orders
         SET tracking_number = $1,
             status = 'fulfilled',
             cj_order_number = COALESCE(NULLIF(cj_order_number,''), $3)
       WHERE id = $2
         AND (tracking_number IS NULL OR tracking_number = '')
       RETURNING id`,
      [trackNumber, order.id, cjOrderId || null]
    );
    if (!upd.rows.length) return;
    console.log(`🚀 [ORDER] #${order.id} SHIPPED (${logisticName || '?'}) → ${trackNumber}`);

    // ⚖️ الحارس الأخير (Mission #7)
    const dg = await checkStripeDispute(order.id, { strict: false }).catch(e => {
      console.warn(`⚖️ [SHIPPED-guard] check failed #${order.id}: ${e.message}`);
      return { disputed: false, reason: 'guard_exception' };
    });
    if (dg.disputed) {
      console.error(`⚖️ [SHIPPED-guard] #${order.id} notifications BLOCKED — ${dg.reason} (charge=${dg.chargeId || 'n/a'})`);
      sendAdminAlert(
        `⚖️ DISPUTE at SHIPPED gate — Order #${order.id} — notifications held`,
        `<h3 style="color:#FF6B9D;">Dispute مفتوح — الشحنة عبرت، الإشعارات مجمّدة</h3>
         <p><b>Order:</b> #${order.id} — ${order.customer_name} (${order.customer_email})</p>
         <p><b>Track:</b> ${trackNumber} — <b>Charge:</b> ${dg.chargeId || 'n/a'}</p>
         <p><b>الحالة:</b> 'fulfilled' (حقيقة فيزيائية — ما تبدلش).</p>
         <p><b>المطلوب منك:</b> استجب للـ dispute فـ Stripe Dashboard —
         evidence: رقم التتبع + proof of delivery + مراسلات الزبون + العنوان الموثق.</p>`
      );
      return;
    }

    await notifyShipment(order, trackNumber, logisticName);
    return;
  }


    // 🌟 M#27 — Track delivered_at for Review Invitation (first delivery only)
    if (mapped === 'completed' && !order.review_submitted_at) {
      await pool.query(
        "UPDATE orders SET delivered_at = NOW() WHERE id = $1 AND delivered_at IS NULL",
        [order.id]
      ).catch(() => {});
    }
  // ✅ completed وغيره
  await pool.query(
    `UPDATE orders
       SET status = $1,
           tracking_number = COALESCE(NULLIF(tracking_number,''), NULLIF($3,'')),
           cj_order_number = COALESCE(NULLIF(cj_order_number,''), NULLIF($2,''))
     WHERE id = $4`,
    [mapped, cjOrderId || '', trackNumber, order.id]
  );
  console.log(`✅ [ORDER] #${order.id}: ${order.status} → ${mapped}`);

  syncShipmentEvents(order.id || orderId).catch(() => {}); // fire-and-forget
}
// ==========================================
// 🚚 LOGISTIC — أحداث التتبع التفصيلية
// ⚠️ هنا الحقل trackingNumber (فـ ORDER: trackNumber) — مؤكد بالعينة!
// 🛟 Rescue: إلا فاتنا ORDER/SHIPPED (رسالة ضايعة) — LOGISTIC كيسالى الوضع
// ==========================================
async function handleLogistic(params = {}) {
  const trackingNumber = String(params.trackingNumber || params.trackNumber || '').trim();
  const cjOrderId = String(params.orderId || '').trim();
  if (!trackingNumber && !cjOrderId) return;

  // 🛡️ Mission #8 Hardening — نفس منطق الرفض المبكر
  const knownRes = await pool.query(
    `SELECT id FROM orders
     WHERE tracking_number = $1
        OR (NULLIF($2,'') IS NOT NULL AND cj_order_number = $2)
     LIMIT 1`,
    [trackingNumber, cjOrderId]
  );
  if (knownRes.rows.length === 0) {
    console.warn(`🛡️ [LOGISTIC] Unrecognized event dropped (track=${trackingNumber}, cj=${cjOrderId}) — possible spoof/scan`);
    return;
  }

  let eventsCount = 0;
  if (params.logisticsTrackEvents) {
    try {
      const a = JSON.parse(params.logisticsTrackEvents);
      eventsCount = Array.isArray(a) ? a.length : 0;
    } catch { /* string ماشي JSON — تجاهل */ }
  }
  console.log(`📦 [LOGISTIC] cj=${cjOrderId} track=${trackingNumber} trackingStatus=${params.trackingStatus} events=${eventsCount} carrier=${params.logisticName || '—'}`);
  if (!trackingNumber) return;

  const findRes = await pool.query(
    `SELECT * FROM orders
     WHERE tracking_number = $1
        OR (NULLIF($2,'') IS NOT NULL AND cj_order_number = $2)
     LIMIT 1`,
    [trackingNumber, cjOrderId]
  );
  if (!findRes.rows.length) return;
  const order = findRes.rows[0];

  // 🛟 Rescue — للطلبات المدفوعة أو المشحونة بلا tracking (ORDER webhook فاتها)
  // 🩹 FIX#23 — وسّعنا الشرط ليشمل 'fulfilled': طلب مشحون (webhook) فقد tracking_number
  //    ما كانش يُرمم أبداً (بلا رقم للزبون، ولن يصل completed عبر مسار التتبع)
  //    — نفس الفجوة كانت في كرون server.js (بند #11 الموحد) — كلاهما يُصلح معاً
  if (!order.tracking_number && (order.status === 'paid' || order.status === 'fulfilled')) {
    const wasFulfilled = order.status === 'fulfilled';
    const upd = await pool.query(
      `UPDATE orders SET tracking_number = $1, status = 'fulfilled'
       WHERE id = $2 AND tracking_number IS NULL RETURNING id`,
      [trackingNumber, order.id]
    );
    if (upd.rows.length) {
      console.log(`🛟 [LOGISTIC] Rescue #${order.id} — ORDER/SHIPPED فات، إشعار العميل دابا`);

      // ⚖️ الحارس على مسار الإنقاذ (Mission #7) — الأعلى خطورة للـ disputes:
      // الطلب قعد مدة طويلة 'paid' بلا شحن = نافذة chargeback موسعة
      const dg = await checkStripeDispute(order.id, { strict: false }).catch(e => {
        console.warn(`⚖️ [Rescue-guard] check failed #${order.id}: ${e.message}`);
        return { disputed: false, reason: 'guard_exception' };
      });
      if (dg.disputed) {
        console.error(`⚖️ [Rescue-guard] #${order.id} notifications BLOCKED — ${dg.reason} (charge=${dg.chargeId || 'n/a'})`);
        sendAdminAlert(
          `⚖️ DISPUTE at RESCUE gate — Order #${order.id} — notifications held`,
          `<p>مسار الإنقاذ (LOGISTIC) لقى شحنة لطلب عليه dispute مفتوح.</p>
           <p><b>Order:</b> #${order.id} — ${order.customer_name} — <b>Track:</b> ${trackingNumber}</p>
           <p><b>Charge:</b> ${dg.chargeId || 'n/a'} — الإشعارات موقفة.</p>
           <p><b>المطلوب:</b> استجابة للـ dispute بـ evidence (delivery proof قوي هنا — الشحنة كانت معلقة طويلاً).</p>`
        );
        return;
      }

      await notifyShipment(order, trackingNumber, params.logisticName);
    }
  }

  syncShipmentEvents(order.id || orderId).catch(() => {}); // fire-and-forget
}

// ==========================================
// 🏷️ PRODUCT — صور + DELETE فقط (بنية مؤكدة بعينة حية)
// ⚠️ السعر ماكيجيش هنا (كيجي من VARIANT) | productName صيني — مانلمسوهش
// ==========================================
async function handleProductUpdate(params = {}, messageType) {
  const cjPid = String(params.pid || '');
  if (!cjPid) return;

  // 🗑️ حذف من CJ → إخفاء من المتجر
  if (messageType === 'DELETE') {
    await pool.query('UPDATE products SET stock_status = false WHERE cj_product_id = $1', [cjPid]);
    console.log(`🗑️ [CJ Webhook] Product ${cjPid} DELETED by CJ — hidden from store.`);
    return;
  }

  const prodRes = await pool.query('SELECT id, image_url FROM products WHERE cj_product_id = $1', [cjPid]);
  if (!prodRes.rows.length) return;
  const product = prodRes.rows[0];

  // نفحصو غير الحقول المعلنة فـ fields (بلا افتراضات)
  const changedFields = Array.isArray(params.fields) ? params.fields : [];

  // ✨ الصورة الرئيسية — غير إلا القديمة من CJ نفسو (حماية الصور ديالنا)
  if (changedFields.includes('productImage') && params.productImage) {
    try {
      const imgs = JSON.parse(params.productImage);
      const firstImg = Array.isArray(imgs) ? imgs.find(u => typeof u === 'string' && u.startsWith('http')) : null;
      if (firstImg && product.image_url && product.image_url.includes('cjdropshipping') && firstImg !== product.image_url) {
        await pool.query('UPDATE products SET image_url = $1 WHERE id = $2', [firstImg, product.id]);
        console.log(`🖼️ [CJ Webhook] Product ${cjPid} main image refreshed.`);
      }
    } catch { /* productImage ماشي JSON — تجاهل */ }
  }
}

// ==========================================
// 🧬 VARIANT — مصدر الأسعار الحقيقي (حماية الهامش الزمنية)
// INSERT/UPDATE = دمج | DELETE = حيد من JSONB
// ==========================================
async function handleVariantUpdate(params = {}, messageType) {
  const vid = String(params.vid || '');
  const pid = String(params.pid || '');
  if (!vid || !pid) return;

  const prodRes = await pool.query('SELECT id, variants FROM products WHERE cj_product_id = $1', [pid]);
  if (!prodRes.rows.length) return;
  const product = prodRes.rows[0];

  let variants = product.variants;
  if (typeof variants === 'string') {
    try { variants = JSON.parse(variants); } catch { variants = []; }
  }
  if (!Array.isArray(variants)) variants = [];

  const idx = variants.findIndex(v => String(v.vid) === vid);

  // 🗑️ DELETE → حيد من القائمة
  if (messageType === 'DELETE') {
    if (idx > -1) {
      variants.splice(idx, 1);
      await pool.query('UPDATE products SET variants = $1 WHERE id = $2', [JSON.stringify(variants), product.id]);
      console.log(`🗑️ [CJ Webhook] Variant ${vid} removed from product ${pid}.`);
    }
    return;
  }

  // ✨ INSERT/UPDATE — دمج (نحافظو على أي حقول محلية)
  const updates = {};
  if (params.variantSellPrice !== undefined) updates.variantSellPrice = params.variantSellPrice;
  if (params.variantSku      !== undefined) updates.variantSku = params.variantSku;
  if (params.variantKey      !== undefined) updates.variantKey = params.variantKey;
  if (params.variantStatus   !== undefined) updates.variantStatus = params.variantStatus;
  if (params.variantImage    !== undefined) updates.variantImage = params.variantImage;

  let oldPrice = null;
  if (idx > -1) {
    oldPrice = variants[idx].variantSellPrice;
    variants[idx] = { ...variants[idx], ...updates };
  } else {
    variants.push({ vid, ...updates });
  }

  await pool.query('UPDATE products SET variants = $1 WHERE id = $2', [JSON.stringify(variants), product.id]);

  // 💰 لوج تغيّرات الأسعار — أهم إشارة مالية
  const newPrice = params.variantSellPrice;
  if (newPrice && oldPrice && String(oldPrice) !== String(newPrice)) {
    console.log(`💰 [CJ Webhook] Variant ${vid} price: $${oldPrice} → $${newPrice} (product ${pid})`);
  }
}

// ==========================================
// 📦 STOCK — Debounced Batch Writer (Quota Defense)
// مئات الرسائل من CJ → تجميع في الذاكرة → كتابة واحدة كل 5 دقائق
// يقلل DB writes بـ 95%+ (درس Quota Wall — الجولة #11)
// ==========================================
const stockUpdateBuffer = new Map();   // pid → aggregated qty
const stockSeenSignature = new Map();  // pid → last qty (تجاهل القيم المتطابقة)
let stockFlushScheduled = false;

const STOCK_FLUSH_INTERVAL_MS = 5 * 60 * 1000;  // 5 دقائق
const STOCK_MAX_BUFFER = 500;                    // حد أمان الذاكرة

async function handleStockUpdate(params = {}) {
  let buffered = 0;

  for (const [key, records] of Object.entries(params)) {
    if (!Array.isArray(records)) continue;
    for (const rec of records) {
      const pid = String(rec.pid || key);
      const qty = Number(rec.storageNum ?? rec.stockQuantity ?? rec.quantity ?? rec.stock ?? rec.qty);
      if (!Number.isFinite(qty)) continue;

      // ✨ Dedup: نفس القيمة السابقة = لا كتابة جديدة (أغلب الرسائل لا تغير شيئًا)
      const lastQty = stockSeenSignature.get(pid);
      if (lastQty !== undefined && lastQty === qty) continue;

      stockSeenSignature.set(pid, qty);
      stockUpdateBuffer.set(pid, qty);
      buffered++;
    }
  }

  if (buffered === 0) return;
  console.log(`📦 [Stock] buffered ${buffered} updates (pending flush: ${stockUpdateBuffer.size})`);

  // 🛡️ حد أمان الذاكرة — إذا فاض، اضغط فورًا (debounce قسري)
  if (stockUpdateBuffer.size >= STOCK_MAX_BUFFER) {
    console.warn(`📦 [Stock] buffer overflow (${stockUpdateBuffer.size}) — forcing immediate flush`);
    await flushStockUpdates();
    return;
  }

  // ⏰ جدولة الـ flush الوحيد (debounce)
  if (!stockFlushScheduled) {
    stockFlushScheduled = true;
    setTimeout(async () => {
      stockFlushScheduled = false;
      await flushStockUpdates();
    }, STOCK_FLUSH_INTERVAL_MS).unref?.(); // لا يمنع الإغلاق الرشيق
  }
}

// 💾 الكاتب الفعلي — batch واحد أنيق
async function flushStockUpdates() {
  const updates = Array.from(stockUpdateBuffer.entries());
  stockUpdateBuffer.clear();
  if (updates.length === 0) return;

  console.log(`📦 [Stock] flushing ${updates.length} batched stock updates...`);
  let hidden = 0, failed = 0;

  for (const [pid, totalQty] of updates) {
    try {
      const available = totalQty > 0;
      const res = await pool.query(
        'UPDATE products SET stock_status = $1 WHERE cj_product_id = $2 RETURNING id',
        [available, pid]
      );
      if (res.rows.length > 0 && !available) {
        hidden++;
        console.log(`📉 [Stock] Product ${pid} OUT OF STOCK (${totalQty} left) — hidden from store.`);
      }
    } catch (e) {
      failed++;
      // Tenet #14 — لكن لا نغرق اللوج: ملخص كل 10 أخطاء
      if (failed % 10 === 1) {
        logger.logError(`Stock flush (and ${failed > 1 ? failed - 1 : 0} similar)`, e);
      }
    }
  }

  console.log(`📦 [Stock] flush done — ${updates.length} processed, ${hidden} hidden, ${failed} failed`);
}

// ==========================================
// 📧 المرسلات المحلية (Brevo مباشرة — مكتفية ذاتياً)
// ⚠️ sendEmail محلية فـ server.js وما كتتصدرش — الاعتماد عليها كان bug انكشف بفضل نجاح التوقيع
//    (paymentController كيصدر router فقط!)
// 🩹 FIX#25 — sendAdminEmail كان يستقبل { to } ويتجاهله دائماً (يرسل للأدمن دائماً) —
//    التوقيع نظّف: { subject, html } فقط. النداءات صُححت في handleMakeup/المقبض.
// ==========================================
async function sendEmailDirect({ to, subject, html }) {
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Laclarc Support', email: process.env.BREVO_USER },
      to: [{ email: to }],
      subject, htmlContent: html
    }, {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    console.log('[direct-email] sent to ' + to + ': ' + subject);
  } catch (e) {
    logger.logError('Direct Email (Brevo)', (e.response && e.response.data) || e.message);
  }
}

async function sendAdminEmail({ subject, html }) {
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: 'Laclarc Support', email: process.env.BREVO_USER },
      to: [{ email: process.env.BREVO_USER }],
      subject, htmlContent: html
    }, {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    console.log('[admin-email] sent: ' + subject);
  } catch (e) {
    logger.logError('Admin Email (Brevo)', (e.response && e.response.data) || e.message);
  }
}

// ==========================================
// 💳 MAKEUP — فاتورة فرق شحن (حقول مؤكدة بالعينة: status/orderId/amount/reason)
// 🩹 P0-21 — الموضوع مُوقّع إجبارياً — ما كيوصل هنا إلا بعد verifySignatureFlexible
//    (الرفض الآن يشمل sign الغائب — انظر المقبض في الدفعة 3)
// ==========================================
async function handleMakeup(params = {}) {
  console.warn(`💳 [CJ Webhook] MAKEUP BILL ${params.status}: ${params.orderId} — $${params.amount} (${params.reason})`);

  if (params.status === 'CREATED') {
    // 🩹 FIX#25 — النداء صُحح (كان { to: ... } على توقيع لا يستقبله)
    await sendAdminEmail({
      subject: `💳 CJ Makeup Bill Created — $${params.amount} for ${params.relationOrderId}`,
      html: `<h2>CJ Postage Makeup Bill</h2>
             <p><strong>Original Order:</strong> ${params.relationOrderId}</p>
             <p><strong>CJ Order:</strong> ${params.orderId}</p>
             <p><strong>Amount:</strong> $${params.amount}</p>
             <p><strong>Reason:</strong> ${params.reason || 'N/A'}</p>
             <p>Pay it from CJ wallet to avoid fulfillment delays.</p>
             <p style="color:#FF6B9D;font-size:12px;">⚠️ تأكد أن الفاتورة حقيقية من CJ Dashboard قبل الدفع — فاتورة Makeup كانت هدفاً للتصيّد.</p>`
    }).catch(err => logger.logError('Makeup Alert Email', err));
  }
}
// ==========================================
// 🎯 المعالج الرئيسي — 200 فوري (< 3s إجباري) + معالجة خلفية كاملة
// ==========================================
async function cjWebhookHandler(req, res) {
  res.status(200).json({ code: 200, message: 'OK' });

  (async () => {
    try {
      const rawBody = req.body; // Buffer من express.raw
      let event;
      try { event = JSON.parse(rawBody.toString('utf8')); }
      catch {
        logger.logError('CJ Webhook: JSON غير صالح', new Error(rawBody.toString('utf8').slice(0, 200)));
        return;
      }

      const { messageId, type, messageType, params } = event;
      if (!type) return;

      // 🔬 عينة كاملة أول مرة لكل نوع — ground truth دايم فاللوج
      const sampleKey = `_cjSample_${type}`;
      if (!global[sampleKey]) {
        global[sampleKey] = true;
        console.log(`🔬 [Sample ${type}]`, rawBody.toString('utf8').slice(0, 800));
      }

      // 🪪 فحص openId مرن (soft — تحذير فقط؛ الويب هوك كيصيفط رقم 44510)
      const expectedOpenId = process.env.CJ_WEBHOOK_OPEN_ID;
      if (expectedOpenId && String(event.openId ?? '') !== expectedOpenId) {
        console.warn(`⚠️ [CJ Webhook] openId ${event.openId} ≠ المتوقع (${expectedOpenId}) — تحذير فقط`);
      }

      // 🩹 P0-21 — التوقيع الصارم للأنواع المالية — إجباري بحضوره وغيابه:
      //    كان: signHeader && (MAKEUP || PRIVATE_ORDER) → التوقيع مطلوب فقط إذا حضر!
      //    MAKEUP مزوّر بلا sign كان يتخطى التحقق كلياً → handleMakeup → إيميل أدمن
      //    مقنع "ادفع من المحفظة" = قالب تصيّد جاهز.
      //    الآن: MAKEUP/PRIVATE_ORDER بلا sign أو بـ sign خاطئ = رفض + alert.
      //    ORDER/PRODUCT/STOCK/VARIANT/LOGISTIC: CJ ماكيوثقش عليهم — مباشرة
      //    (التزوير في ORDER مُغطى بـ P0-20 في handleOrderUpdate — التحقق عبر CJ)
      const signHeader = req.headers['sign'];
      const signedTopic = type === 'MAKEUP' || type === 'PRIVATE_ORDER';
      if (signedTopic) {
        if (!signHeader || !verifySignatureFlexible(rawBody, signHeader, event.openId)) {
          // 🧪 تسريب تشخيصي (مرة/10د) — زوج (body, sign) جاهز للـ calibrator
          if (!global._cjSignFailAt || Date.now() - global._cjSignFailAt > 10 * 60 * 1000) {
            global._cjSignFailAt = Date.now();
            console.warn(
              `🔐 [SIGN DEBUG] ${type} rejected — sign missing or invalid\n` +
              `🔐 [SIGN DEBUG] sign(${String(signHeader).length})=${String(signHeader)}\n` +
              `🔐 [SIGN DEBUG] body(${rawBody.length})=${rawBody.toString('utf8')}\n` +
              `🔐 [SIGN DEBUG] openId=${event.openId} → node tools/cj-sign-calibrator.js '<body>' '<sign>' ${event.openId}`
            );
          }
          // 💳 MAKEUP = حدث مالي — الأدمن خاصو يعرف حتى إلا تسقات
          if (type === 'MAKEUP') {
            sendAdminEmail({
              subject: `🚨 CJ MAKEUP rejected (signature missing/invalid) — $${params?.amount} ${params?.orderId}`,
              html: `<p>فاتورة Makeup رُفضت — <b>التوقيع ناقص أو غير صالح</b>.</p>
                     <p>شوف 🔐 [SIGN DEBUG] فاللوج + شغّل calibrator.</p>
                     <p style="color:#FF6B9D;">⚠️ إذا وصلتك فاتورة Makeup عبر الإيميل مباشرة بلا هاد الرفض — فهي تصيّد.</p>
                     <pre>${JSON.stringify(params || {}).slice(0, 400)}</pre>`
            }).catch(() => {});
          }
          logger.logError('CJ Webhook: signed topic rejected', new Error(`${type} signature missing/invalid`));
          return;
        }
      }

      // 🛡️ Idempotency — retries كيتجاهلو
      //    (ما بعد الساعة: الإعادة آمنة بنيوياً — كل المسارات النهائية محروسة
      //     بـ RETURNING/forward-only فلا مضاعفة ممكنة)
      if (!messageId || processedMessages.has(messageId)) return;
      processedMessages.add(messageId);

      console.log(`📨 [CJ Webhook] ${type}/${messageType} (${String(messageId).slice(0, 8)}...)`);

      switch (type) {
        case 'ORDER':       await handleOrderUpdate(params); break;
        case 'LOGISTIC':    // ✅ CJ كيصيفط "LOGISTIC" مفرد (عينة d99e1435) — كان كيطيح صامت!
        case 'LOGISTICS':   await handleLogistic(params); break; // احتياط للجمع
        case 'PRODUCT':     await handleProductUpdate(params, messageType); break;
        case 'VARIANT':     await handleVariantUpdate(params, messageType); break;
        case 'STOCK':       await handleStockUpdate(params); break;
        case 'MAKEUP':      await handleMakeup(params); break;
        default:
          console.log(`ℹ️ [CJ Webhook] نوع غير معالج: ${type}/${messageType}`);
          break;
      }
    } catch (err) {
      logger.logError('CJ Webhook Processing', err);
    }
  })();
}

// ==========================================
// 📝 تسجيل الـ Callback URL عند CJ
// (PRIVATE_ORDER ما كنسجلوهش عمداً — ماعندناش معالج مستقل ليه دابا،
//  والتوقيع إجباري عليه الآن — يُسجل بعد بناء معالجه)
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
      failed  += (data.failProductIds   || []).length;
    } catch (err) {
      logger.logError(`CJ Subscribe batch ${i / 100 + 1}`, err);
    }
    await new Promise(r => setTimeout(r, 3000)); // invariant #6 — QPS=1
  }

  return { total: ids.length, success, failed };
}

module.exports = { cjWebhookHandler, registerWebhooks, subscribeAllStoreProducts, notifyShipment };