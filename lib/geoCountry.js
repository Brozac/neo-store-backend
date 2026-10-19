// lib/geoCountry.js — LaClarc GeoIP Gate (Geo Flow v3.0)
// ============================================================
// المهمة: البلد ديال الزائر (ISO-2) → التحقق من سجل CJ الـ 250 دولة
//
// أولوية الحل (resolution order):
//   1. ?country=XX   — override صريح (الزبون بدّلها يدوياً / الاختبارات)
//   2. CDN geo headers — cf-ipcountry / x-vercel-ip-country / cloudfront-...
//   3. IP → بلد (ipwho.is — مجاني بلا مفتاح) بكاش 24h/IP
//   4. DEFAULT_COUNTRY env (افتراضي US)
//
// تسامح مع الأسماء: UK→GB (alias شائع فالكاشنات)، XK→YK (كوسوفو عند CJ)
// حماية النقاط: الـ lookup كيتكاشا 24h لكل IP + واحد فالمرة (in-flight dedup)
// ============================================================
const fs = require('fs');
const path = require('path');

// ── سجل الـ 250 دولة (مصدر: CJ Appendix B — data/cjCountries.json) ──
let REGISTRY = new Set();
let NAMES = new Map();
let registryLoaded = false;

function loadRegistry() {
  if (registryLoaded) return;
  registryLoaded = true;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'data', 'cjCountries.json'), 'utf8')
    );
    for (const c of raw.countries || []) {
      if (c.iso2 && /^[A-Z]{2}$/.test(c.iso2)) {
        REGISTRY.add(c.iso2);
        NAMES.set(c.iso2, (c.name_en || c.iso2).replace(/\s+/g, ' ').trim());
      }
    }
  } catch (e) {
    // فشل القراءة ما يطيحش النظام — يسجل ويسمح بديفولت
    console.error('[geoCountry] registry load failed:', e.message);
  }
  // ضمانة صلبة: هاد الكودات معروفة مدعومة عند CJ
  ['US', 'CN', 'GB', 'FR', 'MA', 'DZ', 'TN', 'EG', 'SA', 'AE', 'DE', 'ES', 'IT', 'YK'].forEach(c => REGISTRY.add(c));
  console.log(`[geoCountry] CJ registry loaded: ${REGISTRY.size} countries`);
}
loadRegistry();

// ── التسوية: alias → ISO-2 الصحيح، ورفض أي حاجة ماشي حرفين ──
function normalize(raw) {
  if (!raw) return null;
  let c = String(raw).trim().toUpperCase();
  if (c.length !== 2) return null;
  if (c === 'UK') c = 'GB'; // alias شائع عند CDN — ISO الرسمي GB
  if (c === 'XK') c = 'YK'; // كوسوفو — CJ كيستعمل YK (ماشي ISO رسمي)
  if (!/^[A-Z]{2}$/.test(c)) return null;
  return c;
}

function isSupported(code) {
  return REGISTRY.has(code);
}

function countryName(code) {
  return NAMES.get(code) || code;
}

function registryCount() {
  return REGISTRY.size;
}

// ── 1+2: الحل السطحي (متزامن — override أو CDN headers) ──
const GEO_HEADERS = [
  'cf-ipcountry',                // Cloudflare
  'x-vercel-ip-country',         // Vercel
  'cloudfront-viewer-country',   // AWS CloudFront
  'fastly-client-country',       // Fastly
  'x-geo-country',               // generic proxies
  'x-geo-country-code',
  'x-country-code',
];

function clientIp(req) {
  const xf = req.headers && req.headers['x-forwarded-for'];
  if (xf && String(xf).trim()) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// IP عمومي؟ (الخاص/اللوكال ما عندوش GeoIP)
function isPublicIp(ip) {
  if (!ip) return false;
  if (ip.startsWith('::1') || ip.startsWith('127.') || ip.startsWith('::ffff:127.')) return false;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return false;
  if (ip.startsWith('169.254.') || ip.startsWith('fc') || ip.startsWith('fd')) return false;
  if (ip === '::ffff:172.' ) return false; // حماية زايدة
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 ملفوف فـ IPv6
  const v4 = m ? m[1] : ip;
  if (/^(10|127)\./.test(v4) || /^192\.168\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return false;
  if (v4 === '0.0.0.0') return false;
  return /\d+\.\d+\.\d+\.\d+/.test(v4);
}

function resolveVisitorCountryShallow(req) {
  // 1 — override صريح (منسوخ دائماً بالتسوية)
  const q = normalize(req.query && req.query.country);
  if (q && q !== 'XX') return { code: q, source: 'override', supported: isSupported(q) };
  // 2 — CDN geo headers بالترتيب
  for (const h of GEO_HEADERS) {
    const v = normalize(req.headers && req.headers[h]);
    if (v && v !== 'XX') return { code: v, source: `cdn:${h}`, supported: isSupported(v) };
  }
  return null; // → العمق (IP lookup) على المستدعي
}

// ── 3: IP → بلد عبر ipwho.is — كاش 24h + in-flight dedup ──
const LOOKUP_TTL = 24 * 60 * 60 * 1000;
const lookupCache = new Map(); // ip → { code, ts }
const inflight = new Map();    // ip → Promise<code|null>

function gcLookupCache() {
  if (lookupCache.size <= 3000) return;
  const now = Date.now();
  for (const [k, v] of lookupCache) if (now - v.ts > LOOKUP_TTL) lookupCache.delete(k);
}

async function lookupCountryByIp(ip) {
  const now = Date.now();
  const hit = lookupCache.get(ip);
  if (hit && now - hit.ts < LOOKUP_TTL) return hit.code;

  if (inflight.has(ip)) return inflight.get(ip);

  const job = (async () => {
    try {
      const r = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, 2500);
      const j = await r.json();
      const code = j && j.success !== false ? normalize(j.country_code) : null;
      lookupCache.set(ip, { code, ts: Date.now() }); // كنكاشاو حتى النتيجة السالبة (تجنب الضرب على نفس IP الخربان)
      gcLookupCache();
      return code;
    } catch {
      lookupCache.set(ip, { code: null, ts: Date.now() });
      return null;
    } finally {
      inflight.delete(ip);
    }
  })();
  inflight.set(ip, job);
  return job;
}

function fetchWithTimeout(url, ms) {
  // Node 18+ فيه fetch عالمي — مع timeout يدوي (AbortController)
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'LaClarc-GeoGate/1.0' } })
    .finally(() => clearTimeout(t));
}

// ── الحل الكامل (async) — هادي اللي كيستعملوها الـ routes ──
async function resolveVisitorCountry(req) {
  const shallow = resolveVisitorCountryShallow(req);
  if (shallow) return shallow;

  // 3 — IP lookup (غير للـ IP العمومي)
  const ip = clientIp(req);
  if (isPublicIp(ip)) {
    const code = await lookupCountryByIp(ip);
    if (code) return { code, source: 'ip-lookup', supported: isSupported(code), ip };
  }

  // 4 — الديفولت
  const def = normalize(process.env.DEFAULT_COUNTRY) || 'US';
  return { code: def, source: 'default', supported: isSupported(def), ip: ip || undefined };
}

module.exports = {
  normalize,
  isSupported,
  countryName,
  registryCount,
  resolveVisitorCountry,
  resolveVisitorCountryShallow,
  clientIp,
};
