// ============================================================
// LACLARC TANK HARDENING v1 — F#90
// طبقة تحصين واحدة، صفر dependencies جديدة (zlib + crypto مدمجين في Node)
// ============================================================
// كيضيف فوق server.js بالضبط:
//   1) /health       — مؤشر حياة فوري (Render Health Check + المراقبة) — بلا لمسة DB
//   2) /health/deep  — فحص DB حقيقي (كاش 10 ثواني) — 503 إلا قاعدة البيانات طاحت
//   3) gzip          — ضغط كل JSON > 1KB (zlib داخلي — ما كيتبدلش package.json — درس F#85)
//   4) edge-cache    — كاش ذاكرة بـ singleflight (درع الزحمة: 500 طلب متزامن على نفس
//                      المسار = استعلام DB واحد) — فقط على المسارات المسموحة أدناه
//   5) idempotency   — منع تكرار الطلبات على مسار الدفع (دبل-كليك = نفس الجلسة، ماكاينش طلبين)
//
// التركيب (أوتوماتيكي):  node tank-kit/tank-apply.cjs
// اليدوي:               في server.js، بعد سطر express.urlencoded، زيد:
//   require('./tank-kit/tank-hardening')(app, { pool });
// ⚠️ خاصها تُستدعى قبل أول app.get — وإلا Express ما يوصلهاش (ترتيب الميدلوير)
// ============================================================
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');

module.exports = function installTank(app, opts = {}) {
  const pool = opts.pool || null;

  const state = {
    startedAt: Date.now(),
    dbOk: null,
    dbCheckedAt: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheStale: 0,
    inflightNow: 0,
    idemHits: 0,
  };
  global.__laclarcTank = state; // للـ /health والفحص اليدوي

  // ------------------------------------------------------------
  // 1) /health — liveness: دايماً 200 (Render Health Check Path = /health)
  // ------------------------------------------------------------
  app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      tank: 'v1',
      uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
      rss_mb: +(mem.rss / 1048576).toFixed(1),
      heap_mb: +(mem.heapUsed / 1048576).toFixed(1),
      cache: {
        hits: state.cacheHits,
        misses: state.cacheMisses,
        stale: state.cacheStale,
        inflight: state.inflightNow,
      },
      idempotency_hits: state.idemHits,
    });
  });

  // ------------------------------------------------------------
  // 2) /health/deep — readiness: كيحسّ DB فعلياً (كاش 10s) — 503 إلا طاحت
  // ------------------------------------------------------------
  app.get('/health/deep', async (req, res) => {
    const now = Date.now();
    if (pool && (state.dbOk === null || now - state.dbCheckedAt > 10000)) {
      try {
        await pool.query('SELECT 1');
        state.dbOk = true;
      } catch (e) {
        state.dbOk = false;
      }
      state.dbCheckedAt = now;
    }
    res.set('Cache-Control', 'no-store');
    if (state.dbOk === false) return res.status(503).json({ ok: false, db: false });
    res.json({ ok: true, db: state.dbOk !== null ? state.dbOk : 'unknown', tank: 'v1' });
  });

  // ------------------------------------------------------------
  // 3) gzip — ضغط JSON بلا أي dependency (الـ bandwidth تاع Render→Cloudflare هو اللي يربح)
  // ------------------------------------------------------------
  const GZIP_MIN = 1024; // أقل من 1KB ما يستاهلش
  app.use(function tankGzip(req, res, next) {
    if (req.path === '/api/upload') return next(); // ملفات — بلا لمس
    const ae = req.headers['accept-encoding'] || '';
    if (!/gzip/i.test(ae)) return next();
    const origJson = res.json.bind(res);
    res.json = function tankGzipJson(body) {
      let buf;
      try {
        buf = Buffer.from(JSON.stringify(body));
      } catch (e) {
        return origJson(body);
      }
      if (buf.length < GZIP_MIN || res.getHeader('Content-Encoding')) return origJson(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      zlib.gzip(buf, { level: 6 }, (err, zipped) => {
        if (err || !zipped || !zipped.length) {
          res.removeHeader('Content-Encoding');
          res.removeHeader('Vary');
          try { return origJson(body); } catch (e2) { /* الاستجابة بدأت — نتخلاو */ }
          return;
        }
        res.setHeader('Content-Length', zipped.length);
        res.end(zipped);
      });
    };
    next();
  });

  // ------------------------------------------------------------
  // 4) edge-cache + singleflight — درع الزحمة (allowlist صارم: GET عام بلا توكن)
  // ------------------------------------------------------------
  const CACHE_RULES = [
    { re: /^\/api\/search/, ttl: 20000, swr: 60000, smax: 'public, s-maxage=20, stale-while-revalidate=60' },
    { re: /^\/api\/settings$/, ttl: 60000, swr: 300000, smax: 'public, s-maxage=60, stale-while-revalidate=300' },
    { re: /^\/api\/currency\/detect/, ttl: 300000, swr: 600000, smax: 'public, s-maxage=300, stale-while-revalidate=600' },
  ];
  const MAX_ENTRIES = 300;
  const MAX_BODY = 524288; // 512KB — فوق هذا ما نكاشيوش (ذاكرة Render محدودة)
  const memCache = new Map();  // key -> { t, status, body }
  const inflight = new Map();  // key -> Promise<{status, body}>

  function cacheRuleFor(url) {
    for (const r of CACHE_RULES) if (r.re.test(url)) return r;
    return null;
  }

  function serve(res, status, body, label) {
    res.set('X-Cache', label);
    try {
      res.status(status).json(body);
    } catch (e) { /* الاستجابة بدأت — نتخلاو بصمت */ }
  }

  app.use(function tankEdgeCache(req, res, next) {
    const rule = req.method === 'GET' ? cacheRuleFor(req.originalUrl) : null;
    if (!rule) return next();
    if (req.get('x-tank-refresh')) return next(); // طلبات التحديث الداخلي — خاصها تعبر للراوت الحقيقي
    if (req.get('authorization') || req.get('x-admin-token')) return next(); // طلبات شخصية — عمرو ما كتكاشى
    if (req.get('cache-control') === 'no-cache') return next(); // باب هروب للفحص اليدوي
    if (req.originalUrl.length > 300) return next(); // مفاتيح طويلة شذ — بلا كاش

    const key = req.originalUrl;
    const hit = memCache.get(key);
    const age = hit ? Date.now() - hit.t : Infinity;

    // طازج → serve فوري
    if (hit && age < rule.ttl) {
      state.cacheHits++;
      return serve(res, hit.status, hit.body, 'HIT');
    }

    // قديم لكن داخل SWR → serve القديم فوراً + حدّث في الخلفية (ما كانش تحديث جرى)
    if (hit && age < rule.ttl + rule.swr) {
      state.cacheStale++;
      if (!inflight.has(key)) refreshAsync(key, rule);
      return serve(res, hit.status, hit.body, 'STALE');
    }

    // ما كاين والو → singleflight: طلب واحد يضرب DB والباقي يستنى نفس الوعد
    if (inflight.has(key)) {
      inflight.get(key).then(
        (r) => serve(res, r.status, r.body, 'SHARED'),
        () => next() // فشل الزعيم → نخلّي الطلب الأصلي يمشي عادي
      );
      return;
    }
    state.cacheMisses++;
    refreshAsync(key, rule);
    res.set('X-Cache', 'MISS'); // الزعيم — الاستجابة الأولى من الراوت الحقيقي

    // أول طلب يمشي عادي عبر الراوت الأصلي (نكاشيو الاستجابة فالمار)
    const origJson = res.json.bind(res);
    res.json = function tankCacheJson(body) {
      if (res.statusCode === 200 && !res.getHeader('Content-Encoding')) {
        try {
          const size = Buffer.byteLength(JSON.stringify(body));
          if (size > 0 && size <= MAX_BODY) {
            if (memCache.size >= MAX_ENTRIES) {
              memCache.delete(memCache.keys().next().value); // أقدم مدخل
            }
            memCache.set(key, { t: Date.now(), status: 200, body });
            res.set('Cache-Control', rule.smax); // كيخلي Cloudflare Edge يكاشي حتى هو
          }
        } catch (e) { /* الكاش ما هواش حياة أو موت */ }
      }
      origJson(body);
    };
    next();
  });

  function refreshAsync(key, rule) {
    const p = (async () => {
      state.inflightNow++;
      try {
        // رحلة تحديث خفيفة: نفس الطلب داخلياً على 127.0.0.1 (نفس العملية، بلا شبكة خارجية)
        const port = process.env.PORT || 5000;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 12000);
        const r = await fetch(`http://127.0.0.1:${port}${key}`, {
          headers: { 'x-tank-refresh': '1', 'accept-encoding': 'identity' },
          signal: ac.signal,
        });
        clearTimeout(timer);
        const body = await r.json();
        let size = -1;
        try { size = Buffer.byteLength(JSON.stringify(body)); } catch (e) { /* غير قابل للتمسلسل */ }
        if (r.status === 200 && size >= 0 && size <= MAX_BODY) {
          if (memCache.size >= MAX_ENTRIES) memCache.delete(memCache.keys().next().value);
          memCache.set(key, { t: Date.now(), status: 200, body });
        }
        return { status: r.status, body };
      } catch (e) {
        return { status: 503, body: { error: 'refresh failed' } };
      } finally {
        state.inflightNow--;
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }

  // ------------------------------------------------------------
  // 5) idempotency — مسار الدفع: دبل-كليك/ريتراي = نفس الاستجابة، بلا طلبات مكررة
  // ------------------------------------------------------------
  const IDEM_PATHS = new Set(['/api/create-checkout-session', '/api/payment/verify-session']);
  const IDEM_HEADER_TTL = 10 * 60 * 1000; // مفتاح صريح من الفرونت = 10 دقائق
  const IDEM_AUTO_TTL = 15 * 1000;        // بصمة الجسم أوتوماتيك = 15 ثانية ضد الدبل-كليك
  const IDEM_MAX = 500;
  const idemStore = new Map(); // key -> { t, status, body }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of idemStore) {
      if (now - v.t > IDEM_HEADER_TTL) idemStore.delete(k);
    }
  }, 60000).unref();

  app.use(function tankIdempotency(req, res, next) {
    if (req.method !== 'POST' || !IDEM_PATHS.has(req.path)) return next();
    if (req.get('x-tank-refresh')) return next(); // طلبات التحديث الداخلي مستثناة

    let ttl = 0;
    let key = null;
    const explicit = req.get('x-idempotency-key');
    if (explicit) {
      key = 'K:' + String(explicit).slice(0, 128);
      ttl = IDEM_HEADER_TTL;
    } else if (req.body && typeof req.body === 'object') {
      try {
        key = 'B:' + crypto.createHash('sha1').update(JSON.stringify(req.body)).digest('hex');
        ttl = IDEM_AUTO_TTL;
      } catch (e) { return next(); }
    }
    if (!key) return next();

    const prior = idemStore.get(key);
    if (prior && Date.now() - prior.t < ttl) {
      state.idemHits++;
      res.set('X-Idempotency-Replay', '1');
      try {
        return res.status(prior.status).json(prior.body);
      } catch (e) { return next(); }
    }

    const origJson = res.json.bind(res);
    res.json = function tankIdemJson(body) {
      if (res.statusCode < 500 && idemStore.size <= IDEM_MAX) {
        try {
          JSON.stringify(body); // نتأكد كيتمسلسل — إلا فشل ما نكاشيوش
          idemStore.set(key, { t: Date.now(), status: res.statusCode, body });
        } catch (e) { /* بلا كاش */ }
      }
      origJson(body);
    };
    next();
  });

  console.log('[TANK] v1 hardened — /health + /health/deep + gzip + edge-cache(search|settings|currency) + idempotency(checkout)');
};
