// services/shipTruth.js
/**
 * 🗺️ Ship Truth Engine — الرحلة الكاملة CN → باب الزبون
 * يجمع: أحداث CJ الحية + تاريخنا + توقع AI للوصول
 */
const axios = require('axios');
const pool = require('../db');
const { getCJToken, auditEvent, queryOrderTrackHistory } = require('./cjService');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

/**
 * 1️⃣ سحب أحداث التتبع الحية من CJ وتخزينها
 * (يُستدعى من: GET journey API + cron تتبع الشفاء F#77 + الويبهوكات)
 */

/**
 * 🩹 F#77 — سبلت الذكي للنص الملتصق (الدوك 2.2 عيب موثق: event+مكان بلا فاصل)
 *   "DeliveredNEW YORK, NY"             → { event: 'Delivered', place: 'NEW YORK, NY' }
 *   "Returned to senderLOS ANGELES, CA" → { event: 'Returned to sender', place: 'LOS ANGELES, CA' }
 *   "In transit to next facilityLOS ANGELES" → حدث كامل + مكان — حتى الكلمات المتعددة
 * النص العادي مع فاصل كيرجع كما هو (event=النص، place='').
 */
const EVENT_KEYWORDS = [
  'returned to sender', 'undeliverable', 'out for delivery', 'customs clearance',
  'customs cleared', 'delivered', 'returned', 'rejected', 'refused', 'arrived at',
  'departed from', 'accepted at', 'picked up', 'customs', 'arrived', 'departed',
  'in transit', 'transit', 'shipped', 'packing', 'warehouse', 'accepted',
];
function splitEventText(raw) {
  const s = String(raw || '').trim();
  if (!s) return { event: '', place: '' };
  // 1) حدّ الالتصاق: حرف صغير/رقم/قوس متبوع مباشرة بحرف كبير — بصمة الدوك 2.2
  const concat = s.match(/^(.{4,}?[a-z0-9\)\.])([A-Z]{2,}(?:[A-Za-z0-9 ,\.\-'\u2019]*)?)$/);
  if (concat) {
    const ev = concat[1].trim(), place = concat[2].trim();
    const lowEv = ev.toLowerCase();
    if (EVENT_KEYWORDS.some((k) => lowEv.includes(k)) && place.length >= 2) {
      return { event: ev, place };
    }
  }
  // 2) كلمات الحالة المعروفة — أطول تطابق أولاً (الأكثر تحديدًا)
  const low = s.toLowerCase();
  let best = null;
  for (const kw of EVENT_KEYWORDS) {
    const idx = low.indexOf(kw);
    if (idx === -1) continue;
    if (!best || kw.length > best.kw.length) best = { idx, kw };
  }
  if (best) {
    const cut = best.idx + best.kw.length;
    return { event: s.slice(0, cut).trim(), place: s.slice(cut).replace(/^[\s:,.\-–—]+/, '').trim() };
  }
  return { event: s, place: '' };
}

/**
 * 🩹 F#77 — Tracking Heal (الدوك logistic 2.2 getOrderTrackHistory)
 * الرقم القديم كيوقف يتحرك كي CJ تعاود تشحن (الويبهوك ما وصلش أو ما انبعثش)
 * → الزبون كيشوف رحلة مجمّدة. الكشف: >N أيام بلا حدث جديد + ما توصّلش
 * → نداء 2.2 بالرقم القديم (حتى 10 أرقام/نداء، 10 نقاط) → الرقم الجديد
 * → نفس مسار الويبهوك بالضبط (تحقق P0-20 + إيميل + واتساب + لوح الأدمن).
 */
const HEAL_STALE_DAYS = Math.max(3, Number(process.env.TRACK_HEAL_STALE_DAYS || 10) || 10);
let healColsEnsured = false;
async function ensureHealColumns(db) {
  if (healColsEnsured) return;
  // ضمان العمود قبل الاستعلام (نمط F54-SOURCING-TABLE — الكرون ما يرميش relation error)
  await (db || pool).query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_heal_checked_at TIMESTAMPTZ`);
  healColsEnsured = true;
}

async function healReplacedTracking(limit = 100, deps = {}) {
  // 🔬 F#77 — حقن التبعيات للاختبار بلا شبكة ولا DB حقيقية (defaults = الإنتاج نفسه)
  const db = deps.pool || pool;
  const queryHistory = deps.queryHistory || queryOrderTrackHistory;
  const getHook = deps.getHook || (() => require('./cjWebhookService'));  // lazy — يتجنب الدورة الدائرية
  const healed = [];
  try {
    await ensureHealColumns(db);
    // المرشحون: رقم تتبع خدام، ما توصّلش، وآخر حدث أقدم من HEAL_STALE_DAYS
    //   (بلا أحداث أصلاً؟ COALESCE على shipped_at/created_at — نفس العتبة)
    //   track_heal_checked_at = guard 24h — الرقم المختبَر ما يعاودش يحرق النقاط كل جولة
    const { rows: cands } = await db.query(`
      SELECT o.id, o.tracking_number, o.customer_email, o.customer_name, o.status
      FROM orders o
      LEFT JOIN shipment_events se ON se.order_id = o.id
      WHERE o.tracking_number != '' AND o.cj_order_number != ''
        AND o.delivered_at IS NULL
        AND o.status NOT IN ('cancelled', 'refunded')
        AND (o.track_heal_checked_at IS NULL OR o.track_heal_checked_at < NOW() - INTERVAL '24 hours')
      GROUP BY o.id, o.tracking_number, o.customer_email, o.customer_name, o.status,
               o.shipped_at, o.created_at
      HAVING COALESCE(MAX(se.event_time), o.shipped_at, o.created_at) < NOW() - ($2 || ' days')::interval
      ORDER BY o.id ASC
      LIMIT $1
    `, [limit, String(HEAL_STALE_DAYS)]);
    if (!cands.length) {
      console.log(`[ShipTruth] heal: صفر مرشحين (> ${HEAL_STALE_DAYS} أيام بلا حدث)`);
      return { checked: 0, healed: 0 };
    }
    console.log(`[ShipTruth] heal: ${cands.length} رقم مجمّد → 2.2 getOrderTrackHistory`);

    let lazyHook = null;
    for (let i = 0; i < cands.length; i += 10) {
      const chunk = cands.slice(i, i + 10);
      let hist;
      try {
        hist = await queryHistory(chunk.map((c) => c.tracking_number));
      } catch (e) {
        // فشل شبكة/كوتا — الجولة الجاية تجرب (ما سجلناش الفحص → ما كايناش هدر)
        console.warn(`[ShipTruth] heal chunk فشل: ${e.message}`);
        continue;
      }
      const byTrack = new Map();  // الدوك: رقم واحد خدّام بزوج أوامر = سطر لكل أمر
      for (const r of (hist || [])) {
        const k = String((r && r.trackNumber) || '').trim().toLowerCase();
        if (!k) continue;
        if (!byTrack.has(k)) byTrack.set(k, []);
        byTrack.get(k).push(r);
      }
      for (const c of chunk) {
        const key = String(c.tracking_number || '').trim().toLowerCase();
        const rows = byTrack.get(key) || [];
        if (!rows.length) {
          // الدوك 2.2: خاوية = أجنبي/مؤرشف/مقسوم — بلا خطأ. سجل الفحص، لا retry-loop
          await db.query('UPDATE orders SET track_heal_checked_at = NOW() WHERE id = $1', [c.id]);
          continue;
        }
        await db.query('UPDATE orders SET track_heal_checked_at = NOW() WHERE id = $1', [c.id]);
        for (const r of rows) {
          if (!r.replaced) continue;  // currentTrackNumber == trackNumber — ما تبدلش (الدوك)
          if (!lazyHook) lazyHook = getHook();
          // الشهادة جاءت من CJ 2.2 برك → نمّر الداتا نفسها كverification (P0-20 محفوظ، بلا نداء ثاني)
          const out = await lazyHook.handleTrackReplacement(c, r.currentTrackNumber, 'shiptruth-heal', {
            verifyTrackHistory: async () => [r],
          });
          if (out && out.replaced) {
            // سطر انتقال فالتايملاين — الزبون يفهم علاش الرقم تبدل
            const oldSpl = splitEventText(r.trackNumberLastEvent || '');
            const desc = `Tracking number updated: ${c.tracking_number} → ${r.currentTrackNumber}` +
              (oldSpl.event ? ` — last known: ${oldSpl.event}${oldSpl.place ? ', ' + oldSpl.place : ''}` : '');
            try {
              await db.query(`
                INSERT INTO shipment_events
                (order_id, event_type, status_raw, location, description, tracking_number, event_time, raw_data)
                VALUES ($1, 'UPDATE', 'TRACK_REPLACED', $2, $3, $4, NOW(), $5)
              `, [c.id, oldSpl.place || '', desc, r.currentTrackNumber, JSON.stringify({ old: c.tracking_number, new: r.currentTrackNumber, source: 'shiptruth-heal' })]);
            } catch (e) { console.warn(`[ShipTruth] heal transition row #${c.id}: ${e.message}`); }
            healed.push({ orderId: c.id, from: c.tracking_number, to: r.currentTrackNumber });
            console.log(`[ShipTruth] heal ✅ #${c.id}: ${c.tracking_number} → ${r.currentTrackNumber}`);
          }
        }
      }
    }
    return { checked: cands.length, healed: healed.length, healed_orders: healed.map((h) => h.orderId) };
  } catch (e) {
    console.warn(`[ShipTruth] heal failed: ${e.message}`);
    return { checked: 0, healed: healed.length, error: e.message };
  }
}
async function syncShipmentEvents(orderId) {
  try {
    const { rows } = await pool.query(
      `SELECT cj_order_number, tracking_number FROM orders WHERE id = $1 AND cj_order_number != ''`,
      [orderId]
    );
    if (!rows[0]) return { synced: 0 };

    // v36 G1 — الدوك 2.1: البرامتر الوحيد trackNumber (batch) — كان orderId=cj_order_number
    //   (موثق حتى لا مرة) + القراءة كانت data.result[0].logisticsTrackEvents (شكل غير موثق).
    const track = String(rows[0].tracking_number || '').trim();
    if (!track) return { synced: 0, reason: 'no_tracking_number' };
    const token = await getCJToken();

    const res = await axios.get(`${CJ_API}/logistic/trackInfo`, {
      params: { trackNumber: track },
      headers: { 'CJ-Access-Token': token },
      timeout: 30000,
    });

    // v36 G1 — parse مزدوج الشكل:
    //   legacy  = data.result[0].logisticsTrackEvents[] — أحداث كاملة (الشكل القديم، إذا CJ رجعو)
    //   summary = data[] الملخص الموثق فالدوك (trackingStatus/lastTrackNumber/lastMileCarrier...) بلا أحداث
    //             → نصايبو حدث واحد «آخر حالة حية» · اللوغ كيبين الشكل اللي رجع CJ = probe حي دائم
    // 🩹 F#77 — الملخص كيسجل حتى حقول الدوك 2.1 الزايدة (ETA حي + الناقل الأخير) فliveSummary
    //   للـ journey — والوصف ما يتبدلش (dedup بالوصف برك ما ينكسرش)
    const d = res.data && res.data.data;
    let events = [];
    let shape = 'none';
    let descOnly = false;
    let liveSummary = null;
    const legacy = d && d.result && Array.isArray(d.result) && d.result[0] && d.result[0].logisticsTrackEvents;
    if (Array.isArray(legacy)) {
      events = legacy;
      shape = 'legacy';
    } else if (Array.isArray(d) && d[0] && (d[0].trackingStatus || d[0].lastTrackNumber)) {
      const s = d[0];
      const desc = [String(s.trackingStatus || '').trim(), s.lastTrackNumber ? `last mile: ${s.lastTrackNumber}` : '']
        .filter(Boolean).join(' · ') || 'CJ live status';
      events = [{ ...s, logisticsStatus: s.trackingStatus || '', logisticsPlace: '', logisticsTime: '', description: desc }];
      shape = 'summary';
      descOnly = true;   // الملخص بلا وقت ثابت → dedup بالوصف برك (الوقت كيتبدل كل مزامنة)
      liveSummary = {
        status: String(s.trackingStatus || '').trim(),
        logisticName: String(s.logisticName || '').trim(),
        deliveryDay: String(s.deliveryDay || '').trim(),      // "13" — أيام CJ الرسمية
        deliveryTime: String(s.deliveryTime || '').trim(),    // "2021-06-17 07:04:04" — موعد التسليم
        lastMileCarrier: String(s.lastMileCarrier || '').trim(),
        lastMileCarrierPhone: String(s.lastMileCarrierPhone || '').trim(),
        lastMileCarrierEmail: String(s.lastMileCarrierEmail || '').trim(),
        lastMileNumber: String(s.lastTrackNumber || '').trim(),  // رقم الناقل المحلي — حدثأخر
        from: String(s.trackingFrom || '').trim(),
        to: String(s.trackingTo || '').trim(),
      };
    }
    console.log(`[ShipTruth] sync #${orderId} shape=${shape} events=${events.length}`);

    let inserted = 0;


    for (const ev of events) {
      const desc = ev.description || ev.trackInfo || '';
      const time = ev.logisticsTime || ev.time || new Date().toISOString();
      // Dedup — لا تكرار لنفس الحدث (الملخص: بالوصف برك — الوقت كيتبدل كل مزامنة)
      const dup = descOnly
        ? await pool.query(
            `SELECT 1 FROM shipment_events WHERE order_id = $1 AND description = $2 LIMIT 1`,
            [orderId, desc]
          )
        : await pool.query(
            `SELECT 1 FROM shipment_events WHERE order_id = $1 AND event_time = $2 AND description = $3 LIMIT 1`,
            [orderId, time, desc]
          );
      if (dup.rows.length > 0) continue;

      await pool.query(`
        INSERT INTO shipment_events
        (order_id, event_type, status_raw, location, description, tracking_number, event_time, raw_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        orderId,
        classifyEvent(ev),
        ev.logisticsStatus || ev.status || '',
        ev.logisticsPlace || ev.location || '',
        desc,
        rows[0].tracking_number || '',
        time,
        JSON.stringify(ev),
      ]);
      inserted++;
    }


    if (inserted > 0) {
      await auditEvent('SHIPTRUTH_SYNCED', orderId, { new_events: inserted }, 'info');
    }
    return { synced: inserted, live: liveSummary };
  } catch (e) {
    console.warn(`🗺️ [ShipTruth] sync #${orderId} failed: ${e.message}`);
    return { synced: 0, error: e.message };
  }
}

/** 2️⃣ تصنيف حدث CJ خام → نوع قياسي (للـ timeline الموحد) */
function classifyEvent(ev) {
  // v36 G1 — الحالة الصريحة (trackingStatus من الملخص الموثق 2.1) لها الأولوية على النص،
  //   حتّى «last mile: …» فالوصف ما تقلبش الحالة OUT_FOR_DELIVERY بالغلط.
  // 🩹 F#77 — RETURNED قبل DELIVERED: "Undeliverable — returned to sender" فيها 'deliver'
  //   والقاعدة القديمة كانت تديرها DELIVERED (خطأ حقيقي — الزبون يشوف "وصل" وهو رجع للمستودع!)
  const st = String(ev.logisticsStatus || ev.status || '').toLowerCase();
  if (/return|undeliver|reject|refus/.test(st)) return 'RETURNED';
  if (/out for delivery/.test(st)) return 'OUT_FOR_DELIVERY';
  if (/deliver/.test(st)) return 'DELIVERED';
  if (/custom|clearance/.test(st)) return 'CUSTOMS';
  if (/transit/.test(st)) return 'IN_TRANSIT';
  if (/arriv/.test(st)) return 'ARRIVED_COUNTRY';
  if (/depart|leave/.test(st)) return 'DEPARTED';
  if (/warehouse|pack/.test(st)) return 'PACKED';
  const text = `${ev.description || ''} ${ev.trackInfo || ''} ${ev.logisticsStatus || ''}`.toLowerCase();
  if (/return to sender|undeliver|rejected|refused|إرجاع/.test(text)) return 'RETURNED';
  if (/deliver|arrive.*door|完成派/.test(text)) return 'DELIVERED';
  if (/out for delivery|派送|last mile/.test(text)) return 'OUT_FOR_DELIVERY';
  if (/custom|clearance|清关|海关/.test(text)) return 'CUSTOMS';
  if (/arrive|arrival|到达|已到/.test(text)) return 'ARRIVED_COUNTRY';
  if (/depart|leave|起飞|离开/.test(text)) return 'DEPARTED';
  if (/transit|transport|运输|中转/.test(text)) return 'IN_TRANSIT';
  if (/warehouse|package|打包|仓/.test(text)) return 'PACKED';
  return 'UPDATE';
}

/** 3️⃣ الرحلة الكاملة — للـ API والـ UI */
async function getJourney(orderId, customerEmail) {
  // 🛡️ IDOR defense — نفس عقد التتبع الموجود
  const { rows: orders } = await pool.query(
    `SELECT o.*, o.shipping_address, o.customer_city, o.customer_country 
     FROM orders o WHERE o.id = $1`,
    [orderId]
  );
  const order = orders[0];
  if (!order || !customerEmail || 
      order.customer_email?.toLowerCase() !== customerEmail.toLowerCase()) {
    return null;
  }

  // مزامنة حية — النتيجة فيها الملخص الحي (F#77: ETA تاع CJ + الناقل الأخير)
  let live = null;
  try {
    const syncRes = await syncShipmentEvents(orderId);
    live = (syncRes && syncRes.live) || null;
  } catch (e) { /* حي فشل المزامنة — الرحلة التاريخية كتكمل */ }

  const { rows: events } = await pool.query(
    `SELECT event_type, status_raw, location, description, event_time 
     FROM shipment_events WHERE order_id = $1 ORDER BY event_time ASC`,
    [orderId]
  );

  // 📍 الموقع الحالي + المرحلة
  const current = events[events.length - 1];
  const currentStage = current?.event_type || (order.status === 'paid' ? 'PROCESSING' : order.status);

  // 🧮 توقع التسليم — من متوسط طلباتك الفعلية لنفس البلد
  const eta = await predictDelivery(orderId, order.customer_country || order.shipping_country);

  return {
    order: {
      id: order.id,
      order_number: order.order_number,   // 🩹 v1.1 — customer-facing
      status: order.status,
      tracking: order.tracking_number,
      destination: order.customer_city,
    },
    currentStage,
    events: events.map(e => ({
      type: e.event_type,
      location: e.location,
      description: e.description,
      time: e.event_time,
    })),
    eta,
    // 🩹 F#77 — الحالة الحية من الدوك 2.1 (كلها اختيارية — null كيما ما عندناش)
    //   deliveryDay/Time = ETA الرسمي تاع CJ · lastMileCarrier = من عندنو الطرود دابا
    //   (الزبون كيتصل بالناقل مباشرة — يقطع تيكتات "وين طلبيتي")
    live: live ? {
      status: live.status || '',
      deliveryDay: live.deliveryDay || '',
      deliveryTime: live.deliveryTime || '',
      lastMileCarrier: live.lastMileCarrier || '',
      lastMileCarrierPhone: live.lastMileCarrierPhone || '',
      lastMileCarrierEmail: live.lastMileCarrierEmail || '',
      lastMileNumber: live.lastMileNumber || '',
    } : null,
    truthLevel: 'live', // شارة "بيانات حية من CJ"
  };
}

/** 4️⃣ توقع التسليم — يتحسن مع كل طلب (Delivery Promise AI seed) */
async function predictDelivery(orderId, country) {
  try {
    // متوسط المدة الفعلية لطلبات مشحونة لنفس البلد
    const { rows } = await pool.query(`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400) as avg_days,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400) as median_days,
        COUNT(*) as sample_size
      FROM orders 
      WHERE customer_country = $1 
        AND delivered_at IS NOT NULL 
        AND shipped_at IS NOT NULL
    `, [country]);

    const { avg_days, median_days, sample_size } = rows[0] || {};
    
    if (sample_size >= 3) {
      const days = Math.ceil(parseFloat(median_days || avg_days));
      return {
        predictedDays: days,
        confidence: sample_size >= 10 ? 'high' : 'learning',
        sampleSize: sample_size,
        message: `Based on ${sample_size} real deliveries to ${country}`,
      };
    }

    // عينة ناقصة — افتراضي حسب المنطقة
    return {
      predictedDays: 12,
      confidence: 'estimate',
      sampleSize: 0,
      message: 'Standard international estimate',
    };
  } catch (e) {
    return { predictedDays: 12, confidence: 'estimate' };
  }
}

module.exports = { syncShipmentEvents, getJourney, predictDelivery, healReplacedTracking, splitEventText, classifyEvent };