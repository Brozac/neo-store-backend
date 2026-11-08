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
const { checkStripeDispute, sendAdminAlert, probeOrderStatus, classifyDuplicate, auditEvent, pickMakeupRows, queryOrderTrackHistory, queryWalletBalance, pickWalletAlert } = require('./cjService'); // 🩹 P0-20 — أدوات التحقق · 🆕 v35 F1 — قارئ makeup/list الموحد · 🆕 v37 H2/H3/H5 — track-history + wallet
const { sendOrderTrackingWhatsApp, sendOrderTrackReplacedWhatsApp } = require('./whatsappService');
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
// 💓 v37 H4 — نبض الويبهوك (الدوك webhook 3.3 auto-close): آخر ويبهوك وصل —
//    جدول صغير صف واحد (id=1). بذرة عند الإقلاع (last_at=boot) — كتتحدث مع كل ويبهوك.
//    الحكم (صمت؟) نقي وقابل للاختبار: طلبات في الطيران + نبض عتيق >24h.
//    CJ كيسد الموضوع عند <80% نجاح/ساعتين + cold start تاع Render كيقتل الويبهوكات
//    صامتة — بلا هاد الحارس ما كاين حتى تنبيه والطلبات كتسنى بلا أخبار.
let _hbReady = false;
async function ensureWebhookHeartbeat() {
  if (_hbReady) return;
  _hbReady = true;
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS cj_webhook_heartbeat (id int PRIMARY KEY, last_at timestamptz NOT NULL, last_type text)');
    await pool.query("INSERT INTO cj_webhook_heartbeat (id, last_at, last_type) VALUES (1, NOW(), 'boot') ON CONFLICT (id) DO NOTHING");
    console.log('💓 [WebhookHeartbeat] ready');
  } catch (e) { _hbReady = false; logger.logError('WebhookHeartbeat init', e); }
}
function noteWebhookHeartbeat(type) {
  ensureWebhookHeartbeat()
    .then(() => pool.query(
      'INSERT INTO cj_webhook_heartbeat (id, last_at, last_type) VALUES (1, NOW(), $1) ON CONFLICT (id) DO UPDATE SET last_at = NOW(), last_type = EXCLUDED.last_type',
      [String(type || '?').slice(0, 40)]
    ))
    .catch((e) => logger.logError('WebhookHeartbeat write', e));
}
function webhookSilenceVerdict({ lastAt, inflightCount, now = Date.now(), maxSilenceMs = 24 * 60 * 60 * 1000 }) {
  if (!Number.isFinite(inflightCount) || inflightCount <= 0) return { silent: false, reason: 'no_inflight' };
  if (!lastAt) return { silent: false, reason: 'no_heartbeat' };
  const ageMs = now - Number(lastAt);
  if (ageMs < maxSilenceMs) return { silent: false, reason: 'fresh' };
  return { silent: true, ageHours: Math.round(ageMs / 3600000) };
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

// ==========================================
// 🔁 v37 H2 — تبديل رقم التتبع أوتوماتيك (الدوك webhook 3.5: ORDER UPDATE يشعل على
//    «Tracking number replaced» + LOGISTIC UPDATE بالرقم الجديد).
//    ORDER/LOGISTIC غير موقّعين → نفس درع P0-20: التحقق من CJ مباشرة قبل القبول.
//    الأداة الموثقة: getOrderTrackHistory(الرقم القديم) → currentTrackNumber (v36 G2):
//    CJ هي نفسها كتجاوب «القديم ولّى = X؟» — إيه = نقبل · لا = رفض + audit.
//    probe فاشل (شبكة) = fail-closed — الرسالة ضايعة (no-retry) والأداة اليدوية
//    POST /api/admin/track-history هي backstop.
//    الكلفة: 10 نقاط لكل تبديل مُدّعى (نادر) — كاش 10د مدمج فـ queryOrderTrackHistory.
async function handleTrackReplacement(order, claimedNewTrack, source, deps = {}) {
  const verify = deps.verifyTrackHistory || queryOrderTrackHistory;
  const oldTrack = String(order.tracking_number || '').trim();
  const newTrack = String(claimedNewTrack || '').trim();
  if (!oldTrack || !newTrack || oldTrack.toLowerCase() === newTrack.toLowerCase()) return { replaced: false, reason: 'noop' };

  try {
    const rows = await verify([oldTrack]);
    const cur = rows && rows[0] ? String(rows[0].currentTrackNumber || '').trim() : '';
    const ok = !!cur && cur.toLowerCase() === newTrack.toLowerCase();
    if (!ok) {
      await auditEvent('WEBHOOK_TRACK_REPLACE_REJECTED', order.id, { source, old: oldTrack, claimed: newTrack, cjCurrent: cur || null }, 'warning');
      console.warn(`🛡️ [TrackReplace] #${order.id} claimed=${newTrack} ≠ CJ current=${cur || '(empty)'} — مرفوض (P0-20)`);
      return { replaced: false, reason: 'unverified' };
    }
  } catch (e) {
    await auditEvent('WEBHOOK_TRACK_REPLACE_UNVERIFIED', order.id, { source, old: oldTrack, claimed: newTrack, error: String(e.message || e) }, 'warning');
    console.warn(`🛡️ [TrackReplace] #${order.id} probe فشل (${e.message}) — fail-closed`);
    return { replaced: false, reason: 'probe_failed' };
  }

  const upd = await pool.query(
    'UPDATE orders SET tracking_number = $1 WHERE id = $2 AND tracking_number = $3 RETURNING id',
    [newTrack, order.id, oldTrack]
  );
  if (!upd.rows.length) return { replaced: false, reason: 'race' };

  console.log(`🔁 [TrackReplace] #${order.id} (${source}): ${oldTrack} → ${newTrack}`);
  await auditEvent('CJ_TRACK_REPLACED', order.id, { source, old: oldTrack, new: newTrack, cjOrderId: order.cj_order_number }, 'info');

  // الأدمن دائماً — تبديل التتبع حدث تشغيلي مهم (نزاعات: الرقم القديم كيوقف يتحرك — الدوك 2.2)
  sendAdminAlert(
    `🔁 [Laclarc] رقم تتبع الطلب #${order.id} تبدل — CJ أكدو`,
    `<p>CJ عاودت شحن الطلب — الرقم القديم غادي يوقف يتحرك (الدوك logistic 2.2).</p>
     <p><b>Order:</b> #${order.id} — ${order.customer_name || ''}</p>
     <p><b>القديم:</b> ${oldTrack} → <b>الجديد:</b> ${newTrack} <i>(مصدر الحدث: ${source})</i></p>
     <p>الزبون توّا توصلو بالرقم الجديد (إيميل + واتساب مخصصين).</p>`
  ).catch((e) => logger.logError('TrackReplace admin alert', e));

  // الزبون — إيميل + واتساب مخصين (ماشي قالب "shipped" — ما نخلطوش)
  try { await notifyTrackReplacement(order, oldTrack, newTrack); }
  catch (e) { logger.logError('TrackReplace customer notify', e); }

  syncShipmentEvents(order.id).catch(() => {}); // أحداث الرقم الجديد من دابا
  return { replaced: true };
}

async function notifyTrackReplacement(order, oldTrack, newTrack) {
  if (order.customer_phone) {
    try {
      await sendOrderTrackReplacedWhatsApp({ phone: order.customer_phone, customerName: order.customer_name, orderId: order.id, oldTrackingNumber: oldTrack, trackingNumber: newTrack, email: order.customer_email });
    } catch (e) { logger.logError('TrackReplace WhatsApp', e); }
  }
  if (order.customer_email && !order.customer_email.includes('@laclarc.com')) {
    await sendEmailDirect({
      to: order.customer_email,
      subject: 'Tracking update for your Laclarc order #' + order.id + ' — new tracking number',
      html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px;">'
        + '<h2 style="color:#8B78C6;">Heads up — your tracking number changed</h2>'
        + '<p>Your order <strong>#' + order.id + '</strong> was re-shipped by our supplier, so the tracking number has been updated.</p>'
        + '<p style="background:#F9F8FC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;">'
        + '<strong>Old number (no longer moving):</strong> ' + oldTrack + '<br>'
        + '<strong>New tracking number:</strong> <span style="font-size:16px;color:#1D1E3C;">' + newTrack + '</span></p>'
        + '<p>Please use the new number above to follow your parcel. Sorry for any confusion — your order is on its way!</p>'
        + '<p>Thank you for shopping with Laclarc! 💜</p></div>'
    });
  }
}

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

  // v37 H2 — الدوك webhook 3.5: «Tracking number replaced» كيجي كـ ORDER UPDATE (نفس الحالة
  //   SHIPPED). بلا هاد الفرع: rank-check كيرجعو (fulfilled>=fulfilled) والرقم الجديد عمرو
  //   ما يدخل — الزبون يبقى عندو رقم ميت. الدرع الأول (probe P0-20) عدّى فوق — هذا الدرع الثاني.
  if (mapped === 'fulfilled' && trackNumber && order.tracking_number
      && (order.status === 'fulfilled' || order.status === 'completed')
      && String(order.tracking_number).trim().toLowerCase() !== trackNumber.toLowerCase()) {
    await handleTrackReplacement(order, trackNumber, 'ORDER');
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

  // v37 H2 — LOGISTIC UPDATE بالرقم الجديد (تبديل تتبع): كنلقاو عبر cj_order_number
  //   (الجديد ما كيتطابقش مع tracking_number عمودنا) → تحقق CJ ثم تحديث + إشعار.
  if (order.tracking_number && trackingNumber
      && (order.status === 'fulfilled' || order.status === 'completed')
      && String(order.tracking_number).trim().toLowerCase() !== trackingNumber.toLowerCase()) {
    await handleTrackReplacement(order, trackingNumber, 'LOGISTIC');
    return;
  }

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
    // 🩹 P0-27 — probe-before-trust: التوقيع راه قابل للتزوير نظرياً (المفتاح يمكن يكون
    //   openId الظاهر فجسم الحدث نفسو). الفاتورة المالية ما كنثيقش فيها من الويب هوك —
    //   كنأكّدوها من CJ API مباشرة (نفس endpoint ديال /api/admin/makeup/list) قبل
    //   ما نصيفطو إيميل "خلّص من المحفظة" — هادا هو قالب التصيّد نفسو إلا كان مزوّر.
    //   fail-closed: probe فاشل = إيميل UNVERIFIED بلا تعليمات دفع.
    let verified = false, probeFailed = false;
    try {
      for (let pageNum = 1; pageNum <= 3 && !verified; pageNum++) {
        const listRes = await cjRequest((token) => axios.post(
          `${CJ_BASE}/shopping/makeup/list`,
          { pageNum, pageSize: 50, type: 0 },
          { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 45000 }
        ));
        const list = pickMakeupRows(listRes && listRes.data);   // 🩹 v35 F1 — الدوك: data.pageData.content (الأشكال القديمة مغطيين نفس الشي)
        if (!Array.isArray(list) || list.length === 0) break;
        // مطابقة schema-agnostic: معرّف الطلب (BT...) فأي حقل ديال الفاتورة
        verified = list.some(item => {
          try { return JSON.stringify(item).includes(String(params.orderId)); } catch { return false; }
        });
      }
    } catch (probeErr) {
      probeFailed = true;
      logger.logError('Makeup probe failed', probeErr);
    }

    if (verified) {
      // 🩹 FIX#25 — النداء صُحح (كان { to: ... } على توقيع لا يستقبله)
      await sendAdminEmail({
        subject: `✅ CJ Makeup Bill VERIFIED — $${params.amount} for ${params.relationOrderId}`,
        html: `<h2>CJ Postage Makeup Bill</h2>
               <p style="color:#0a7d33;"><strong>✅ مُتحقّق منها من CJ API (P0-27) — يمكن الخلاص من المحفظة.</strong></p>
               <p><strong>Original Order:</strong> ${params.relationOrderId}</p>
               <p><strong>CJ Order:</strong> ${params.orderId}</p>
               <p><strong>Amount:</strong> $${params.amount}</p>
               <p><strong>Reason:</strong> ${params.reason || 'N/A'}</p>`
      }).catch(err => logger.logError('Makeup Alert Email', err));
    } else {
      await sendAdminEmail({
        subject: probeFailed
          ? `⚠️ Makeup event UNVERIFIED (probe failed) — تحقق يدوياً من CJ Dashboard — ${params.orderId}`
          : `🚨 FORGED MAKEUP event — الفاتورة ماكايناش فـ CJ! ${params.orderId}`,
        html: `<h2>${probeFailed ? '⚠️ فاتورة غير مُتحقق منها' : '🚨 حدث MAKEUP مزوّر (تصيّد؟)'}</h2>
               <p><strong>CJ Order:</strong> ${params.orderId}</p>
               <p><strong>Amount:</strong> $${params.amount}</p>
               <p style="color:#b00020;font-size:14px;"><strong>${probeFailed
                 ? 'الاستجواب فشل (شبكة/CJ طايح) — ما تخلّصش حتى تتحقق يدوياً من CJ Dashboard.'
                 : 'الويب هوك قال بوجود فاتورة، ولكن CJ API ماكيعرفش عليها = مزوّرة. ما تخلّصش!'}</strong></p>`
      }).catch(err => logger.logError('Makeup Alert Email', err));
      if (!probeFailed) {
        logger.logError('CJ Webhook: forged MAKEUP suspected', new Error(`orderId=${params.orderId} amount=${params.amount} — not found in CJ makeup/list`));
      }
    }
    return;
  }

  // v37 H3 — الدوك webhook 4: messageType CANCEL→params.status CANCELED · PAID→PAID.
  //   PAID = فلوس خرجت فعلاً من المحفظة — قبل v37 كان كيدوز صامت (console.warn برك):
  //   دابا إيميل + فحص رصيد فوري (الكرون يومي برك — تنبيه لحظي قبل 1605001).
  if (params.status === 'CANCELED') {
    await sendAdminEmail({
      subject: `➖ CJ Makeup Bill CANCELED — ${params.orderId} ($${params.amount})`,
      html: `<h2>فاتورة Makeup تلغات من CJ</h2>
             <p><strong>CJ Order:</strong> ${params.orderId} · <strong>Original:</strong> ${params.relationOrderId || '—'}</p>
             <p><strong>Amount:</strong> $${params.amount} · <strong>Reason:</strong> ${params.reason || 'N/A'}</p>
             <p style="color:#0a7d33;">ما كاين حتى إجراء — غير للعلم.</p>`
    }).catch((err) => logger.logError('Makeup CANCELED email', err));
    return;
  }
  if (params.status === 'PAID') {
    let balanceLine = '';
    try {
      const bal = await queryWalletBalance();
      const alert = pickWalletAlert(bal.amount, Number(process.env.CJ_WALLET_MIN_ALERT || 50));
      balanceLine = `<p><strong>الرصيد دابا:</strong> $${bal.amount}${alert ? ` — <span style="color:#b00020;">${alert.level === 'critical' ? '🚨 شبه فارغ' : '⚠️ منخفض'}</span>` : ' ✅'}</p>`;
      if (alert) {
        sendAdminAlert(
          `${alert.level === 'critical' ? '🚨' : '⚠️'} [Laclarc] CJ Wallet ${alert.level === 'critical' ? 'شبه فارغ' : 'منخفض'} بعد makeup: $${alert.amount}`,
          `<p>فاتورة makeup خلات <b>$${params.amount}</b> (${params.orderId}) — الرصيد المتاح دابا: <b>$${alert.amount}</b> · الحد: $${alert.min}.</p>
           <p>الطلبات الجاية غادي تعلق على 1605001 إلا عمّرتي المحفظة دابا: MyCJ → Finance → Top up.</p>`
        ).catch(() => {});
      }
    } catch (e) {
      logger.logError('Makeup PAID balance probe', e);
      balanceLine = '<p><i>فحص الرصيد فشل (شبكة) — تحقق بـ GET /api/admin/cj-balance.</i></p>';
    }
    await sendAdminEmail({
      subject: `💳 CJ Makeup Bill PAID — $${params.amount} خرجت من المحفظة (${params.orderId})`,
      html: `<h2>فاتورة Makeup تخلصت — خروج فعلي من المحفظة</h2>
             <p><strong>CJ Order:</strong> ${params.orderId} · <strong>Original:</strong> ${params.relationOrderId || '—'}</p>
             <p><strong>Amount:</strong> $${params.amount} · <strong>Reason:</strong> ${params.reason || 'N/A'} · <strong>Payment date:</strong> ${params.paymentDate || '—'}</p>
             ${balanceLine}`
    }).catch((err) => logger.logError('Makeup PAID email', err));
    return;
  }
}
// ==========================================
// 💰 v37 H5 — WALLET (الدوك webhook 6): CREATED/UPDATED على سجلات الفوترة ═══
//    التوقيع إجباري (موضوع مالي — signedTopic تحت). رسالة تسجيل CJ: messageId=wallet-registration-check
//    وparams.id='test' — كنعرفوها بذلك ونردّ 200 بلا تسجيل (الدوك 6.1). التكرار وارد
//    (نفس messageId) — dedup المعالج الرئيسي يحمي + هنا ماكاينش booking (لوج + تنبيه رصيد
//    برك) = إعادة آمنة بنيوياً. المصالحة الرسمية: Query Billing History (الدوك 6.5) —
//    كرون المحفظة اليومي runWalletWatch هو safety-net (no-retry: الرسائل الضائعة ضايعات).
function walletTypeName(t) {
  const MAP = { 1: 'Top-up', 2: 'Order payment', 3: 'Withdrawal', 4: 'Order refund', 5: 'Sold-out refund', 6: 'Order payment', 7: 'Benefit', 8: 'Balance deduction', 9: 'Order payment/affiliate', 17: 'Gift card top-up', 18: 'Order payment', 19: 'Order payment', 20: 'Order payment', 21: 'Deposit payment', 22: 'Deposit refund', 23: 'System refund', 26: 'CJ membership', 29: 'Order payment', 30: 'Shipping cost payment', 31: 'Paid sourcing', 32: 'Customization payment', 33: 'Freight payment', 34: 'Paid services', 35: 'AI credits top-up', 36: 'Credit loan', 37: 'Store sale' };
  return MAP[String(t)] || `type=${t}`;
}
async function handleWallet(params = {}) {
  if (String(params.id) === 'test') {
    console.log('🧪 [WALLET] wallet-registration-check — 200 مسجل، ما كتسجلش (الدوك 6.1)');
    return;
  }
  const statusName = { 0: 'Pending', 1: 'Success', 2: 'Failed', 3: 'Frozen' }[String(params.status)] || `status=${params.status}`;
  const line = `${params.messageType || '?'} ${walletTypeName(params.type)} ${statusName} amount=$${params.amount} fee=$${params.feeAmount ?? 0} balance ${params.balanceBefore} → ${params.balanceAfter} (${params.orderId || 'no-order'})`;
  console.log('💰 [WALLET] ' + line);
  auditEvent('CJ_WALLET_TX', null, { id: params.id, orderId: params.orderId, type: params.type, status: params.status, amount: params.amount, balanceAfter: params.balanceAfter, messageType: params.messageType }, 'info').catch(() => {});
  // تنبيه الرصيد المنخفض — نفس العتبة تاع الكرون اليومي (CJ_WALLET_MIN_ALERT)
  if (Number.isFinite(Number(params.balanceAfter))) {
    const alert = pickWalletAlert(Number(params.balanceAfter), Number(process.env.CJ_WALLET_MIN_ALERT || 50));
    if (alert) {
      sendAdminAlert(
        `${alert.level === 'critical' ? '🚨' : '⚠️'} [Laclarc] CJ Wallet ${alert.level === 'critical' ? 'شبه فارغ' : 'منخفض'}: $${alert.amount} (ويبهوك لحظي)`,
        `<p>${line}</p><p>الحد المبرمج: $${alert.min} — عمّر المحفظة: MyCJ → Finance → Top up.</p>`
      ).catch(() => {});
    }
  }
}

// ==========================================
// 📌 v37 H6 — اشتراك منتج واحد (fire-and-forget من الاستيراد) — الدوك webhook 2:
//    product/stock webhooks يوجعو غير للمشتركين · subscribeAll ممنوع من يوليوز 2026
//    → اشتراك صريح بالـpid: 1 نقطة/منتج عند الاستيراد. فشله ما يوقفش الاستيراد،
//    وsubscribeAllStoreProducts اليدوي (POST /api/admin/webhook/subscribe) هو backstop.
// ==========================================
async function subscribeProductWebhook(cjProductId) {
  const pid = String(cjProductId || '').trim();
  if (!pid) return { ok: false, reason: 'no_pid' };
  const res = await cjRequest((token) => axios.post(`${CJ_BASE}/webhook/product/subscribe`,
    { productIds: [pid] },
    { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
  ));
  const d = (res.data && res.data.data) || {};
  const ok = (d.successProductIds || []).includes(pid);
  if (!ok) console.warn(`📌 [Subscribe] ${pid} ما تزادش (${(d.failProductIds || [])[0] || 'سبب غير معروف'})`);
  else console.log(`📌 [Subscribe] ${pid} مشترك — webhooks ستوك/صور/سعر نشطين`);
  return { ok, fail: (d.failProductIds || [])[0] || null };
}

// ═══ v37 H5 — تسجيل wallet بموضوعو وحدو فنداء منفصل (الدوك 6.1 صراحة: كيتبعت مع
//   مواضيع أخرى، فشلو كيخسر الطلب كامل ولا يخليهم ناقصين). callbackUrls إجبارية حتى
//   فالإلغاء. CJ كيصيفط رسالة اختبار أول — المعالج كيردّها 200 أوتوماتيكياً (الرد قبل المعالجة).
async function registerWalletWebhook(callbackUrl) {
  const whSecret = process.env.CJ_WEBHOOK_SECRET || '';
  const finalUrl = whSecret
    ? callbackUrl + (callbackUrl.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(whSecret)
    : callbackUrl;
  return cjRequest((token) => axios.post(`${CJ_BASE}/webhook/set`, {
    wallet: { type: 'ENABLE', callbackUrls: [finalUrl] },
  }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
}

// ==========================================
// 🎯 المعالج الرئيسي — 200 فوري (< 3s إجباري) + معالجة خلفية كاملة
// ==========================================
async function cjWebhookHandler(req, res) {
  // 🩹 P0-26 — توثيق أحداث الكاتالوغ (PRODUCT/VARIANT/STOCK) بسرّ فالـ URL
  //   هادو التلاتة كانو كيدخلو DB بلا حتى مصادقة (فقط MAKEUP موقّع):
  //   VARIANT = مصدر الأسعار (تلاعب بالهوامش!) · PRODUCT DELETE = إخفاء الكاتالوغ
  //   · STOCK = نفاد مزيف. CJ ماكيوقعش هاد المواضيع → الحل القياسي: سرّ فالـ callback.
  //   التفعيل اختياري (صفر downtime): زيد CJ_WEBHOOK_SECRET فـ Render → restart
  //   → POST /api/admin/webhook/register (كيحقن ?k= أوتوماتيكياً — انظر registerWebhooks).
  const catalogTopic = (() => {
    try {
      const t = JSON.parse(req.body.toString('utf8') || '{}').type;
      return t === 'PRODUCT' || t === 'VARIANT' || t === 'STOCK';
    } catch { return false; }
  })();
  if (catalogTopic) {
    const secret = process.env.CJ_WEBHOOK_SECRET || '';
    if (secret) {
      const provided = String(req.query.k || req.headers['x-cj-secret'] || '');
      const ok = provided.length === secret.length
        && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
      if (!ok) {
        logger.logError('CJ Webhook: catalog event rejected (bad/missing secret)', new Error(`IP: ${req.ip}`));
        return res.status(403).json({ code: 403, message: 'Forbidden' });
      }
    } else {
      console.warn('⚠️ [CJ Webhook P0-26] CJ_WEBHOOK_SECRET ما مُعدّش — أحداث الكاتالوغ بلا توثيق! زيد السرّ فالـ env وعاود register.');
    }
  }

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

      // 💓 v37 H4 — نبض: أي ويبهوك وصل = CJ ما سدّناش (fire-and-forget)
      noteWebhookHeartbeat(`${type}/${messageType || ''}`);

      // 🔬 عينة كاملة أول مرة لكل نوع+messageType — ground truth دايم فاللوج
      //    v37 H7: كان per-type برك → STOCK REDUCE (حذف سجل) عمره ما تلتقط عينتو
      const sampleKey = `_cjSample_${type}_${messageType || 'x'}`;
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
      const signedTopic = type === 'MAKEUP' || type === 'PRIVATE_ORDER' || type === 'WALLET'; // v37 H5 — wallet موضوع مالي
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
        case 'WALLET':      await handleWallet(params); break; // v37 H5
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
  // 🩹 P0-26 — حقن السرّ فالـ callback URL (كيفّعل بوّاجة P0-26 على PRODUCT/VARIANT/STOCK)
  const whSecret = process.env.CJ_WEBHOOK_SECRET || '';
  const finalUrl = whSecret
    ? callbackUrl + (callbackUrl.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(whSecret)
    : callbackUrl;
  return cjRequest((token) => axios.post(`${CJ_BASE}/webhook/set`, {
    product:   { type: 'ENABLE', callbackUrls: [finalUrl] },
    stock:     { type: 'ENABLE', callbackUrls: [finalUrl] },
    order:     { type: 'ENABLE', callbackUrls: [finalUrl] },
    logistics: { type: 'ENABLE', callbackUrls: [finalUrl] },
    makeup:    { type: 'ENABLE', callbackUrls: [finalUrl] },
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

module.exports = { cjWebhookHandler, registerWebhooks, registerWalletWebhook, subscribeAllStoreProducts, subscribeProductWebhook, notifyShipment, webhookSilenceVerdict, handleTrackReplacement, handleWallet, handleMakeup };