/**
 * ============================================================
 * LACLARC — Server-Side Purchase Events
 * Meta Conversions API v18 + TikTok Events API v1.3
 * ------------------------------------------------------------
 * event_id deterministic: purch_{orderId} → Dedup ↔ browser pixel
 * Self-contained (لا استيراد من paymentController — Contract 3.5)
 * Fire-and-forget, timeout 8s — عمرها ما تعطل الـ fulfillment (Tenet #3)
 * Idempotent: retry / reconcile cron → نفس event_id → Dedup تلقائي
 * ============================================================
 */
const crypto = require('crypto');
const https = require('https');
const pool = require('../db');   // 🩹 db.js ورقة مستقلة — لا دائرية

// ─── Config (server-side فقط — ممنوع NEXT_PUBLIC_) ───
const META_PIXEL_ID  = process.env.META_CAPI_PIXEL_ID  || '';
const META_TOKEN     = process.env.META_CAPI_TOKEN     || '';
const META_TEST_CODE = process.env.META_TEST_EVENT_CODE || '';

const TIKTOK_PIXEL_ID  = process.env.TIKTOK_PIXEL_ID     || '';
const TIKTOK_TOKEN     = process.env.TIKTOK_EVENTS_TOKEN || '';
const TIKTOK_TEST_CODE = process.env.TIKTOK_TEST_EVENT_CODE || '';

const SITE_URL   = 'https://laclarc.com';
const TIMEOUT_MS = 8000;

console.log(`[CAPI] armed → Meta: ${META_PIXEL_ID ? '✓' : '✗'} | TikTok: ${TIKTOK_PIXEL_ID ? '✓' : '✗'}`);

// ─── Hashing Helpers (PII — SHA-256 hex) ───
function sha256(raw) {
  return crypto.createHash('sha256')
    .update(String(raw).trim().toLowerCase(), 'utf8').digest('hex');
}
function hashEmail(email) {
  if (!email || !String(email).includes('@')) return null;
  return sha256(email);
}
/** توحيد الهاتف الجزائري/الدولي → أرقام + كود الدولة → hash */
function hashPhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^\d+]/g, '');
  if (p.startsWith('+'))  p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('2130'))    p = `213${p.slice(4)}`;   // 2130XXXXXXXX → 213XXXXXXXXX
  else if (p.startsWith('0'))  p = `213${p.slice(1)}`;   // 0XXXXXXXXX   → 213XXXXXXXXX
  if (p.length < 10 || p.length > 15) return null;
  return sha256(p);
}
function hashName(name) {
  if (!name) return null;
  const clean = String(name).trim().toLowerCase().replace(/[^a-z\u0600-\u06ff ]/g, '');
  return clean ? sha256(clean) : null;
}
function hashCity(city) {
  if (!city) return null;
  return sha256(String(city).trim().toLowerCase().replace(/\s+/g, ''));
}

// ─── HTTP POST مع Timeout صارم — Node صافي، بلا dependencies ───
function postJSON(url, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, json: { raw: data.slice(0, 300) } }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CAPI timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Context Stash: الـ JIT يخبّئ IP/UA + بصمات Meta (Mission #4) قبل الـ fulfillment ───
const ctxMap = new Map();
function setConversionContext(orderId, { clientIp, userAgent, fbp, fbc, utmSource, utmCampaign, clickId } = {}) {
  if (!orderId) return;
  ctxMap.set(String(orderId), {
    clientIp, userAgent,
    fbp: typeof fbp === 'string' ? fbp : undefined,
    fbc: typeof fbc === 'string' ? fbc : undefined,
    utmSource:   typeof utmSource === 'string' ? utmSource : undefined,   // 🆕 #12
    utmCampaign: typeof utmCampaign === 'string' ? utmCampaign : undefined,
    clickId:     typeof clickId === 'string' ? clickId : undefined,
    ts: Date.now(),
  });
  if (ctxMap.size > 500) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of ctxMap) if (v.ts < cutoff) ctxMap.delete(k);
  }
}

// ─── Meta CAPI v18 ───
async function sendMeta({ eventId, eventTime, value, contentIds, contents, p }) {
  if (!META_PIXEL_ID || !META_TOKEN) return { ok: false, detail: 'Meta env missing — skipped' };

  const userData = {};
  const em = hashEmail(p.email);                          if (em) userData.em = em;
  const ph = hashPhone(p.phone);                          if (ph) userData.ph = ph;
  const fn = hashName((p.customerName || '').split(' ')[0]); if (fn) userData.fn = fn;
  const ct = hashCity(p.city);                            if (ct) userData.ct = ct;
  if (p.clientIp && p.clientIp !== '::1' && !p.clientIp.startsWith('127.'))
    userData.client_ip_address = p.clientIp;              // يُرسل خام — ماشي hashed
  if (p.userAgent) userData.client_user_agent = String(p.userAgent).slice(0, 500);
  // 🆕 Mission #4: بصمات المتصفح — أقوى رابط مطابقة بين البكسل والسيرفر
  if (p.fbp) userData.fbp = String(p.fbp).slice(0, 200);
  if (p.fbc) userData.fbc = String(p.fbc).slice(0, 500);
  const event = {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: eventId,
    event_source_url: SITE_URL,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      currency: 'USD',
      value: parseFloat(value.toFixed(2)),
      content_type: 'product',
      content_ids: contentIds,
      contents,
      order_id: eventId,
      ...(p.utmSource ? { utm_source: String(p.utmSource).slice(0, 100) } : {}),
      ...(p.utmCampaign ? { utm_campaign: String(p.utmCampaign).slice(0, 150) } : {}),
      ...(p.clickId ? { click_id: String(p.clickId).slice(0, 255) } : {}),
    },
  };

  const body = { data: [event], ...(META_TEST_CODE ? { test_event_code: META_TEST_CODE } : {}) };
  const { status, json } = await postJSON(
    `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(META_TOKEN)}`,
    {}, body
  );
  const ok = status === 200 && json.events_received >= 1;
  return { ok, detail: ok ? `events_received=${json.events_received}`
                          : `HTTP ${status} ${JSON.stringify(json).slice(0, 200)}` };
}

// ─── TikTok Events API v1.3 ───
async function sendTikTok({ eventId, eventTime, value, contents, p }) {
  if (!TIKTOK_PIXEL_ID || !TIKTOK_TOKEN) return { ok: false, detail: 'TikTok env missing — skipped' };

  const user = {};
  const em = hashEmail(p.email); if (em) user.email = em;
  const ph = hashPhone(p.phone); if (ph) user.phone = ph;
  if (p.clientIp && p.clientIp !== '::1' && !p.clientIp.startsWith('127.')) user.ip = p.clientIp;
  if (p.userAgent) user.user_agent = String(p.userAgent).slice(0, 500);

  const event = {
    event: 'CompletePayment',
    event_time: eventTime,
    event_id: eventId,
    user,
    properties: {
      currency: 'USD',
      value: parseFloat(value.toFixed(2)),
      content_type: 'product',
      contents: contents.map(c => ({
        content_id: c.id, content_type: 'product', quantity: c.quantity,
        ...(c.item_price ? { price: c.item_price } : {}),
      })),
    },
    ...(TIKTOK_TEST_CODE ? { test_event_code: TIKTOK_TEST_CODE } : {}),
  };

  const body = { event_source: 'web', event_source_id: TIKTOK_PIXEL_ID, data: [event] };
  const { status, json } = await postJSON(
    'https://business-api.tiktok.com/open_api/v1.3/event/track/',
    { 'Access-Token': TIKTOK_TOKEN }, body
  );
  const ok = status === 200 && json.code === 0;
  return { ok, detail: ok ? 'code=0' : `HTTP ${status} ${JSON.stringify(json).slice(0, 200)}` };
}

/**
 * ═══════════ النقطة الوحيدة للدخول ═══════════
 * sendPurchaseConversion({ orderId, value, items?, email?, phone?,
 *   customerName?, city?, clientIp?, userAgent? })
 * Return: [{ platform, ok, detail }]
 */
async function sendPurchaseConversion(p) {
  const orderId = p?.orderId;
  if (!orderId) throw new Error('[CAPI] orderId required');
  const value = parseFloat(p.value);
  if (!isFinite(value) || value < 0) throw new Error(`[CAPI] invalid value for ${orderId}`);

  const eventId   = `purch_${orderId}`;              // 🔒 صيغة ثابتة — ممنوع تغييرها
  const eventTime = Math.floor(Date.now() / 1000);

  // دمج Context تاع JIT إذا متوفرش فالمعاملات — 🆕 Mission #12: + UTM
  const ctx = ctxMap.get(String(orderId));
  const enriched = {
    ...p,
    clientIp:    p.clientIp    || ctx?.clientIp,
    userAgent:   p.userAgent   || ctx?.userAgent,
    fbp:         p.fbp         || ctx?.fbp,
    fbc:         p.fbc         || ctx?.fbc,
    utmSource:   p.utmSource   || ctx?.utmSource,
    utmCampaign: p.utmCampaign || ctx?.utmCampaign,
    clickId:     p.clickId     || ctx?.clickId,
  };

  const items = (Array.isArray(p.items) && p.items.length)
    ? p.items
    : [{ productId: 'LACLARC_ORDER', quantity: 1, price: value }];

  const contentIds = items.map(i => String(i.productId));
  const contents = items.map(i => ({
    id: String(i.productId),
    quantity: Number(i.quantity) || 1,
    ...(i.price ? { item_price: parseFloat(i.price) } : {}),
  }));

  const results = await Promise.allSettled([
    sendMeta({ eventId, eventTime, value, contentIds, contents, p: enriched }),
    sendTikTok({ eventId, eventTime, value, contents, p: enriched }),
  ]);

  const summary = results.map((r, i) => ({
    platform: i === 0 ? 'meta' : 'tiktok',
    ok: r.status === 'fulfilled' && r.value?.ok,
    detail: r.status === 'rejected' ? String(r.reason?.message) : r.value?.detail,
  }));

  if (!summary.some(s => s.ok)) {
    throw new Error(`[CAPI] purch_${orderId} all failed: ${JSON.stringify(summary)}`);
  }
  return summary;
}
/**
 * 🩹 Second-Shot — إعادة إرسال Purchase بعد وصول الزبون لـ /success
 * نفس event_id purch_{orderId} → Meta dedup يضمن عدم مضاعفة العد،
 * والأحداث اللي فاتت من مسار أسرع (webhook) تاخذ بصماتها المفقودة (fbp/fbc).
 * Fire-and-forget — فشلها non-fatal بالكامل.
 */
async function secondShotConversion(orderId) {
  try {
    const ctx = ctxMap.get(String(orderId));
    if (!ctx || (!ctx.fbp && !ctx.fbc)) {
      return { skipped: true, reason: 'no_fingerprints' }; // ما فاتش عبر /success ولا ما فيهش بصمات
    }

    // نحتاج قيمة وitems من DB — الـ ctx ما يحتاجهم
    const { rows } = await pool.query(
      'SELECT total_amount, customer_email, customer_phone, customer_name, customer_city, utm_source, utm_campaign, click_id FROM orders WHERE id = $1',
      [orderId]
    );
    const ord = rows[0];
    if (!ord) return { skipped: true, reason: 'order_missing' };

    const summary = await sendPurchaseConversion({
      orderId,
      value: parseFloat(ord.total_amount),
      items: [], // fallback داخلي: LACLARC_ORDER — المهم هو الـ match، مش الـ contents
      email:        ord.customer_email,
      phone:        ord.customer_phone,
      customerName: ord.customer_name,
      city:         ord.customer_city,
      utmSource:    ord.utm_source,
      utmCampaign:  ord.utm_campaign,
      clickId:      ord.click_id,
      clientIp:     ctx.clientIp,
      userAgent:    ctx.userAgent,
      fbp:          ctx.fbp,
      fbc:          ctx.fbc,
    });

    await auditEvent('CAPI_SECOND_SHOT', orderId, summary, 'info');
    console.log(`🎯 [CAPI] second-shot purch_${orderId} dispatched ✓ — fingerprints enriched`);
    return { ok: true, summary };
  } catch (e) {
    console.warn(`🎯 [CAPI] second-shot purch_${orderId} non-fatal: ${e.message}`);
    await auditEvent('CAPI_SECOND_SHOT_FAIL', orderId, { error: e.message }, 'warning');
    return { ok: false, error: e.message };
  }
}
// 🩹 FIX — auditEvent محلي (كان مستعملاً بلا تعريف → second-shot ميت 100% منذ Mission #13)
// local copy لتجنب circular require مع cjService (cjService يستورد conversionService)
// TODO (backlog): lib/audit الموحد — يُلغي كل النسخ المحلية
async function auditEvent(eventType, orderId, details = {}, severity = 'info') {
  try {
    await pool.query(
      `INSERT INTO system_events (event_type, order_id, details, severity) VALUES ($1, $2, $3, $4)`,
      [eventType, orderId || null, JSON.stringify(details), severity]
    );
  } catch (e) {
    console.warn(`⚠️ [CAPI Audit] ${eventType}#${orderId}: ${e.message}`);
  }
}
module.exports = { sendPurchaseConversion, setConversionContext ,secondShotConversion};