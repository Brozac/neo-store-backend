// services/shipTruth.js
/**
 * 🗺️ Ship Truth Engine — الرحلة الكاملة CN → باب الزبون
 * يجمع: أحداث CJ الحية + تاريخنا + توقع AI للوصول
 */
const axios = require('axios');
const pool = require('../db');
const { getCJToken, auditEvent } = require('./cjService');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

/**
 * 1️⃣ سحب أحداث التتبع الحية من CJ وتخزينها
 * (يُستدعى من: GET journey API + cron كل 6 ساعات للطلبات النشطة)
 */
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
    const d = res.data && res.data.data;
    let events = [];
    let shape = 'none';
    let descOnly = false;
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
    return { synced: inserted };
  } catch (e) {
    console.warn(`🗺️ [ShipTruth] sync #${orderId} failed: ${e.message}`);
    return { synced: 0, error: e.message };
  }
}

/** 2️⃣ تصنيف حدث CJ خام → نوع قياسي (للـ timeline الموحد) */
function classifyEvent(ev) {
  // v36 G1 — الحالة الصريحة (trackingStatus من الملخص الموثق 2.1) لها الأولوية على النص،
  //   حتّى «last mile: …» فالوصف ما تقلبش الحالة OUT_FOR_DELIVERY بالغلط.
  const st = String(ev.logisticsStatus || ev.status || '').toLowerCase();
  if (/out for delivery/.test(st)) return 'OUT_FOR_DELIVERY';
  if (/deliver/.test(st)) return 'DELIVERED';
  if (/custom|clearance/.test(st)) return 'CUSTOMS';
  if (/transit/.test(st)) return 'IN_TRANSIT';
  if (/arriv/.test(st)) return 'ARRIVED_COUNTRY';
  if (/depart|leave/.test(st)) return 'DEPARTED';
  if (/warehouse|pack/.test(st)) return 'PACKED';
  const text = `${ev.description || ''} ${ev.trackInfo || ''} ${ev.logisticsStatus || ''}`.toLowerCase();
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

  // مزامنة حية
  await syncShipmentEvents(orderId);

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

module.exports = { syncShipmentEvents, getJourney, predictDelivery };