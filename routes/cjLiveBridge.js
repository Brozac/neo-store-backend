// routes/cjLiveBridge.js - Laclarc Live Bridge (v3.3 GEO FLOW) [freight-row]
// ============================================================
// 🌍 Geo Flow — Integration layer على CJ API V2.0:
//   البلد ديال الزائر (GeoIP) → التحقق من الـ 250 → listV2
//   (countryCode = فلتر المخازن فقط — بلد بلا مخزن CJ = كاطالوغ عالمي)
//   → freightCalculateTip للثمن المباشر (الشحن الحقيقي، ماشي التقدير)
//
//   GET /geo            — كشف البلد + التحقق من سجل CJ الـ 250 دولة
//   GET /search         — /product/listV2 (V1 متقادمة!) + فلتر مخازن + كاش نقاط
//   GET /product/:pid   — /product/query + /logistic/freightCalculateTip
//
// 💰 v3.1 pricing law — الشحن الحقيقي يدخل التسعير عبر shipOverrideUsd
// 🚚 v3.3 freight row — صف الطلب ديال freightCalculateTip طبق الأصل من CURL الرسمي:
//    productProp = مصفوفة · freightTrialSkuList + skuList (Y) · volume (Y) —
//    بلاهم CJ كيرجع 200 بقنوات خاوية (بلا سبب) — و 1.3 unavailableShippingMethods
//    كيشرح علاش (تشخيصي) + ?debug=1 كيفثّح row/env/channels
// 🛡️ النقاط (Points): listV2 = 50pt · freightCalculateTip = 10pt
//    → كاش بحث 5 دقائق + كاش فريت 10 دقائق + limiter 20 بحث/10 دقائق/IP
// 🔁 التوافقية الخلفية: نفس عقود الاستجابة ديال v1 (products/pid/laclarcPrice/...)
// ============================================================
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { cjRequest } = require('../services/cjService');
const { calculateSellingPrice, sanitizeDescription } = require('../services/productImportService');
const { parseMaxNumber, parseWeightGrams, parseJsonArray, parseImageList } = require('../utils/cjNormalize');
const geo = require('../lib/geoCountry');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

// ════════════════════════════════════════════════════════════
// 🏭 مخازن CJ [geo-warehouse] — listV2.countryCode = "فلتر المخزون فالبلاد المحددة"
//    (توثيق listV2 الرسمي) — يعني بلد المخزن، ماشي بلد التوصيل!
//    البلدان اللي عندها مخازن CJ فقط كيتصيفط ليهم countryCode،
//    والباقي = كاطالوغ عالمي (اللّائي “واش كيوصل لبلادي”
//    كيجاوب عليه freightCalculateTip فالـ PDP — ماشي فلتر listV2)
// ════════════════════════════════════════════════════════════
const WAREHOUSE_SEED = new Set(['CN', 'US']); // الموثقين — globalWarehouseList كيوسعهم
let warehouseCountries = null;                // Set — كاش 24h
let whInflight = null;

function getWarehouseCountries() {
  if (warehouseCountries) return Promise.resolve(warehouseCountries);
  if (whInflight) return whInflight;
  whInflight = (async () => {
    try {
      const r = await cjRequest((token, config) =>
        axios.get(`${CJ_API}/product/globalWarehouseList`, {
          ...config,
          headers: { 'CJ-Access-Token': token },
          timeout: 8000,
        })
      );
      const arr = r?.data?.data;
      const set = new Set(WAREHOUSE_SEED);
      if (Array.isArray(arr)) {
        for (const w of arr) {
          const c = geo.normalize(w.countryCode);
          if (c && !w.disabled) set.add(c);
        }
      }
      warehouseCountries = set;
      console.log('[cj-live/search][warehouses]', [...set].join(','));
    } catch (e) {
      console.error('[cj-live/search][warehouses]', e.message);
      warehouseCountries = new Set(WAREHOUSE_SEED); // fallback موثق — ما كيوقفش البحث
    } finally {
      whInflight = null;
    }
    return warehouseCountries;
  })();
  return whInflight;
}

// 🔬 1.3 Unavailable Shipping Methods — التشخيص الرسمي ديال freightCalculateTip:
//    "When 1.2 returns fewer methods than expected (or an empty list), send the
//    exact same payload here" — كيرجع availableList + unavailableList{errorCode,errorEn}
//    (10pt — كيتعيط فقط ملي 1.2 كيرجع قنوات خاوية — مسار الفشل بوحدو)
async function freightDiagnose(row) {
  try {
    const dr = await cjRequest((token, config) =>
      axios.post(`${CJ_API}/logistic/unavailableShippingMethods`,
        { reqDTOS: [row] },
        { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 }
      )
    );
    const denv = dr?.data;
    if (!denv || (denv.code !== 200 && denv.code !== 0)) {
      console.error('[cj-live/product][freight][diag][cj-envelope]', denv?.code, denv?.message || '');
      return [{ optionName: 'diagnostic', errorCode: denv?.code ?? null, errorEn: String(denv?.message || '') }];
    }
    const dd = denv.data || {};
    const un = Array.isArray(dd.unavailableList) ? dd.unavailableList : [];
    const av = Array.isArray(dd.availableList) ? dd.availableList : [];
    const reasons = un.slice(0, 5).map(u => ({
      optionName: u.optionName || '',
      errorCode: u.errorCode ?? null,
      errorEn: String(u.errorEn || u.error || ''),
    }));
    console.error('[cj-live/product][freight][diag]', `available=${av.length} unavailable=${un.length}`, JSON.stringify(reasons).slice(0, 400));
    return reasons.length ? reasons : [{ optionName: 'diagnostic', errorCode: null, errorEn: `no reasons returned (available=${av.length})` }];
  } catch (de) {
    console.error('[cj-live/product][freight][diag]', de.message);
    return [{ optionName: 'diagnostic', errorCode: null, errorEn: String(de.message || '') }];
  }
}

// ════════════════════════════════════════════════════════════
// كاشات الذاكرة — حماية نقاط CJ (كل 50pt بحث = مبلغ من الرصيد اليومي)
// ════════════════════════════════════════════════════════════
const SEARCH_TTL = 5 * 60 * 1000;     // 5 دقائق — نتائج البحث
const FREIGHT_TTL = 10 * 60 * 1000;   // 10 دقائق — عروض الشحن
const searchCache = new Map();        // "q|page|country" → { data, ts }
const freightCache = new Map();       // "pid|vid|src|dest" → { data, ts }
// ── ⭐ ريفيوزات CJ [cj-reviews] — productComments GET — كاش 6 ساعات ──
//    (الريفيوزات كتبدل بالأيام — 6h كافية وحيانية مع النقاط)
const REVIEWS_TTL = 6 * 60 * 60 * 1000;
const reviewsCache = new Map();       // "pid|page|size|score" → { data, ts }

// 🛡️ درس الوثيقة: commentId = long 19 خانة (1536993287524069376) أكبر من
//    Number.MAX_SAFE_INTEGER (16 خانة) — JSON.parse كيقصّو بصمت.
//    الحل: الجواب كيتقري كنص وكنقتبسو الأرقام الطوال قبل JSON.parse.
function parseCjCommentsText(txt) {
  const safe = String(txt).replace(/("[A-Za-z_]*[Ii]d"\s*:\s*)(\d{15,})/g, '$1"$2"');
  return JSON.parse(safe);
}

// ⭐ جيب ريفيوزات CJ مطبّعين — كيستهلكو server.js (الدمج في /api/reviews/:id)
//    والراوت GET /reviews/:pid مباشرة. الاستجابة:
//    { total, page, size, reviews: [{ id, name, score, date, text, images, country, flag }] }
async function fetchCjReviews(pid, opts = {}) {
  const page = Math.max(parseInt(opts.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(opts.size, 10) || 20, 1), 50);
  const scoreN = parseInt(opts.score, 10) || 0;
  const score = scoreN >= 1 && scoreN <= 5 ? scoreN : null;
  const key = `${pid}|${page}|${size}|${score || ''}`;
  const hit = cacheGet(reviewsCache, key, REVIEWS_TTL);
  if (hit) return hit;

  const params = { pid, pageNum: page, pageSize: size };
  if (score) params.score = score;
  const r = await cjRequest((token, config) =>
    axios.get(`${CJ_API}/product/productComments`, {
      ...config,
      headers: { 'CJ-Access-Token': token },
      params,
      timeout: 15000,
      responseType: 'text',            // 🛡️ precision-safe — كنحللو بيدينا
      transformResponse: [(x) => x],   // axios ما يلمسش الجواب
    })
  );

  // 🔍 envelope ديال CJ — ⚠️ الوثيقة: النجاح success:true والخطأ result:false!
  //    الثابت الوحيد الموثوق: code===0 (وكنقبلو 200 للتوافقية مع ES-backed)
  let env = null;
  try { env = parseCjCommentsText(r?.data); } catch (pe) {
    console.error('[cj-live/reviews][parse]', pe.message);
  }
  const envCode = env?.code ?? null;
  if (!env || (envCode !== 0 && envCode !== 200) || env.result === false) {
    console.error('[cj-live/reviews][cj-envelope]', envCode, env?.message || '');
    const err = new Error(`CJ envelope ${envCode}: ${String(env?.message || 'unknown')}`);
    err.cjCode = envCode;
    throw err;
  }

  const d = env?.data || {};
  const list = Array.isArray(d.list) ? d.list : [];
  const reviews = list
    .map(c => ({
      id: String(c.commentId ?? ''),
      name: String(c.commentUser || 'CJ Buyer').slice(0, 60),
      score: Math.min(Math.max(parseInt(c.score, 10) || 0, 1), 5),
      date: String(c.commentDate || ''),
      text: String(c.comment || '').slice(0, 1000),
      images: (Array.isArray(c.commentUrls) ? c.commentUrls : [])
        .filter(u => typeof u === 'string' && u.startsWith('http')).slice(0, 6),
      country: c.countryCode ? (geo.countryName(String(c.countryCode)) || String(c.countryCode)) : '',
      flag: typeof c.flagIconUrl === 'string' ? c.flagIconUrl : '',
    }))
    .filter(x => x.id && x.date && x.score >= 1);

  const out = { total: parseInt(d.total, 10) || reviews.length, page, size, reviews };
  cacheSet(reviewsCache, key, out);
  return out;
}


function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  if (hit) map.delete(key);
  return null;
}
function cacheSet(map, key, data) {
  map.set(key, { data, ts: Date.now() });
  if (map.size > 2000) { // GC خفيف — قصّ القديم
    const cut = Date.now() - Math.max(SEARCH_TTL, FREIGHT_TTL);
    for (const [k, v] of map) if (v.ts < cut) map.delete(k);
  }
}

// ── Rate limiter مبني — 20 بحث/10 دقائق/IP — كيتطبق غير على MISS (الكاش حر)
//    التطبيق داخل /search بعد فحص الكاش — شوف الكتلة "limiter — فقط على MISS" ──
const buckets = new Map();

// ════════════════════════════════════════════════════════════
// 🌍 GET /api/cj-live/geo — كشف البلد + باب الـ 250
// الاستجابة: { country, name, supported, source, registryCount, freightReady }
// ════════════════════════════════════════════════════════════
router.get('/geo', async (req, res) => {
  try {
    const g = await geo.resolveVisitorCountry(req);
    return res.json({
      country: g.code,
      name: geo.countryName(g.code),
      supported: g.supported,
      source: g.source,
      registryCount: geo.registryCount(),
      freightReady: g.supported, // الشحن الحقيقي ممكن فقط للدول المدعومة
      ip: g.ip,
    });
  } catch (e) {
    console.error('[cj-live/geo]', e.message);
    const def = geo.normalize(process.env.DEFAULT_COUNTRY) || 'US';
    return res.json({ country: def, name: geo.countryName(def), supported: true, source: 'default', registryCount: geo.registryCount(), freightReady: true });
  }
});

// ════════════════════════════════════════════════════════════
// 🔍 GET /api/cj-live/search?q=&page=&country=
// v3.2: /product/listV2 (50pt) — countryCode = فلتر المخازن فقط (ماشي بلد التوصيل!)
//       البلدان بلا مخزن CJ → كاطالوغ عالمي + الفريت الحقيقي فالـ PDP
// ════════════════════════════════════════════════════════════
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (q.length < 2) return res.json({ geo: {}, products: [], page, hasMore: false });

    // 🌍 البلد: override → CDN → IP lookup → default (كاش IP داخلي 24h)
    const g = await geo.resolveVisitorCountry(req);
    const country = g.supported ? g.code : null; // غير مدعوم → وضع عالمي بلا فلتر

    // 💰 الكاش قبل الـ limiter — الضربة المدفوعة (50pt) غير على MISS
    //    (cached.geo فيه filterMode من الـ MISS الأصلي)
    const ckey = `${q.toLowerCase()}|${page}|${country || '*'}`;
    const cached = cacheGet(searchCache, ckey, SEARCH_TTL);
    if (cached) return res.json({ ...cached, cached: true });

    // 🛡️ limiter — فقط على الطلبات اللي غادي تضرب CJ فعلاً
    const limited = new Promise((resolve) => {
      const ip = geo.clientIp(req) || 'unknown';
      const now = Date.now();
      const b = (buckets.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
      if (b.length >= 20) return resolve(false);
      b.push(now); buckets.set(ip, b);
      if (buckets.size > 5000) for (const [k, v] of buckets) if (v.every(t => now - t > 10 * 60 * 1000)) buckets.delete(k);
      resolve(true);
    });
    if (!(await limited)) {
      return res.status(429).json({ error: 'Too many searches. Try again later.' });
    }

    const params = { keyWord: q, page, size: 20 }; // listV2: keyWord (ماشي keyword ديال V1!)

    // 🏭 countryCode = فلتر المخازن (توثيق listV2: "filter products with inventory
    //    in specified countries") — بلد المخزن، ماشي بلد التوصيل!
    //    عند البلد مخزن CJ → فلتر محلي (شحن أسرع). بلا مخزن (بحال MA) →
    //    كاطالوغ عالمي بلا فلتر — التوصيل كيتأكد بالفريت الحقيقي فالـ PDP.
    let filterMode = 'worldwide';
    if (country) {
      const wh = await getWarehouseCountries();
      if (wh.has(country)) { params.countryCode = country; filterMode = 'warehouse'; }
    }
    const geoInfo = { country: g.code, name: geo.countryName(g.code), supported: g.supported, source: g.source, filterMode };

    const r = await cjRequest((token, config) =>
      axios.get(`${CJ_API}/product/listV2`, {
        ...config,
        headers: { 'CJ-Access-Token': token },
        params,
        timeout: 15000,
      })
    );

    // 🔍 فحص envelope ديال CJ — listV2 (ES-backed) كيرجع 200 أو 0؛ أي كود آخر = خطأ حقيقي
    //    (نقاط 16900500 / أوث 1600001 / باراميتر) — كنظهرو كود CJ بدل ما نبلعوه بصمت
    const envCode = r?.data?.code;
    if (envCode !== 200 && envCode !== 0) {
      console.error('[cj-live/search][cj-envelope]', envCode, r?.data?.message || '');
      return res.status(502).json({
        error: 'CJ unavailable',
        cjCode: envCode ?? null,
        cjMessage: String(r?.data?.message || '') || null,
      });
    }

    const d = r?.data?.data || {};
    const rawContent = Array.isArray(d.content) ? d.content : [];
    // ⚠️ الشكل الحقيقي ديال listV2 (توثيق Return الرسمي):
    //    content[i] = مجموعة { productList: [...], keyWord, relatedCategoryList }
    //    كنفككو productList مع حماية للشكل المسطح (توافقية إلا تبدل CJ)
    const list = rawContent.flatMap(g =>
      Array.isArray(g?.productList) ? g.productList
        : (g && (g.id || g.pid || g.nameEn) ? [g] : [])
    );
    const totalRecords = parseInt(d.totalRecords, 10) || 0;

    const products = list.map(p => {
      // 💰 v3.1 — التسعير المقدر فاللائحة (500g) — التفاصيل كتجيب الفريت الحقيقي
      const cost = Math.min(
        ...[p.discountPrice, p.nowPrice, p.sellPrice]
          .map(v => parseMaxNumber(v))
          .filter(v => v > 0)
      ) || parseMaxNumber(p.sellPrice) || 0;
      const { safePrice } = calculateSellingPrice(cost, 500);
      return {
        pid: String(p.id || p.pid || ''),
        title: p.nameEn || p.productNameEn || '',
        price: cost,                                // كلفة CJ (داخلي)
        laclarcPrice: safePrice,                    // 💰 السعر المعروض
        image: p.bigImage || p.productImage || '',
        ordersCount: parseInt(p.listedNum ?? p.ordersCount, 10) || 0,
        deliveryCycle: p.deliveryCycle || '',       // 🆕 "3-5" أيام — من listV2 مباشرة
        isVideo: !!p.isVideo,
      };
    }).filter(p => p.pid);

    const payload = {
      products, page,
      hasMore: list.length >= 20 && page < Math.min(parseInt(d.totalPages, 10) || 1000, 300),
      totalRecords,
      geo: geoInfo, // 🌍 داخل الكاش — hits كيرجعو بالـ geo كاملة (فيها filterMode)
    };
    cacheSet(searchCache, ckey, payload);
    return res.json({ ...payload, cached: true });
  } catch (e) {
    console.error('[cj-live/search]', e.message);
    return res.status(502).json({ error: 'CJ unavailable' });
  }
});

// ════════════════════════════════════════════════════════════
// 📦 GET /api/cj-live/product/:pid?country=&vid=
// v3: /product/query + 🚚 freightCalculateTip — الثمن المباشر
// ════════════════════════════════════════════════════════════
router.get('/product/:pid', async (req, res) => {
  try {
    const pid = String(req.params.pid || '').trim();
    if (!pid || pid.length < 5) return res.status(400).json({ error: 'Bad pid' });

    const r = await cjRequest((token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config,
        headers: { 'CJ-Access-Token': token },
        params: { pid, features: 'enable_video' },
        timeout: 15000,
      })
    );

    // 🔍 فحص envelope ديال CJ — product/query
    const envCodeQ = r?.data?.code;
    if (envCodeQ !== 200 && envCodeQ !== 0) {
      console.error('[cj-live/product][cj-envelope]', envCodeQ, r?.data?.message || '');
      return res.status(502).json({
        error: 'CJ unavailable',
        cjCode: envCodeQ ?? null,
        cjMessage: String(r?.data?.message || '') || null,
      });
    }
    const d = r?.data?.data;
    if (!d || !d.pid) return res.status(404).json({ error: 'Product not found' });

    // 🌍 البلد — للفريت الحقيقي
    const g = await geo.resolveVisitorCountry(req);
    const dest = g.supported ? g.code : null;
    const geoInfo = { country: g.code, name: geo.countryName(g.code), supported: g.supported, source: g.source };

    // ⚖️ الوزن الحقيقي (المستوى المنتج)
    const weight = Math.max(parseWeightGrams(d.productWeight), parseWeightGrams(d.packingWeight));

    // 🏷️ productProp — من productProEnSet (Appendix D) — شرط صلب للفريت
    const proList = parseJsonArray(d.productProEnSet) || parseJsonArray(d.productProSet) || [];
    const rawProp = proList.find(x => typeof x === 'string' && x.trim());
    const productProp = (rawProp && rawProp.trim() && !/^PROOERTY$/i.test(rawProp.trim()))
      ? String(rawProp.trim()).slice(0, 40) : 'COMMON';

    // 📐 الحجم — L/W/H (mm) من أول variant → cm³
    const v0 = (Array.isArray(d.variants) && d.variants[0]) || {};
    const numF = (o, keys) => { for (const k of keys) { const n = parseFloat(o?.[k]); if (n > 0 && isFinite(n)) return n; } return 0; };
    const L = numF(v0, ['length', 'variantLength', 'productLength', 'long']);
    const W = numF(v0, ['width', 'variantWidth', 'productWidth']);
    const H = numF(v0, ['height', 'variantHeight', 'productHeight']);
    const volumeCm3 = L && W && H ? Math.round((L * W * H) / 1000) : 0;

    // 🏭 srcAreaCode — من مخزون أول variant: المخزن المحلي إن وجد، وإلا CN
    const invCountries = (Array.isArray(v0.inventories) ? v0.inventories : [])
      .filter(i => (parseInt(i.totalInventory, 10) || parseInt(i.cjInventory, 10) || 0) > 0)
      .map(i => geo.normalize(i.countryCode)).filter(Boolean);
    const srcAreaCode = dest && invCountries.includes(dest) ? dest
      : (invCountries.includes('CN') ? 'CN' : (invCountries[0] || 'CN'));

    // 🚚 freightCalculateTip — الثمن المباشر (10pt) — كاش 10 دقائق [freight-row]
    // (قبل mapping الـ variants باش v0 ياخد الفريت الحقيقي فالتسعير —
    //  Add-to-Cart كيستعمل laclarcVariantPrice → خاصو يطابق laclarcPrice المعروض)
    const cost0 = parseMaxNumber(v0.variantSellPrice) || parseMaxNumber(d.sellPrice) || 0;
    let shipping = { source: 'unavailable', amount: 0, currency: 'USD' };
    let freightUsd = 0;
    let emptyDiag = null; // أسباب 1.3 ملي CJ كيرجع 200 بقنوات خاوية
    const wantDebug = String(req.query.debug || '') === '1';
    const dbg = { dest: dest || null, srcAreaCode: null, weight: null, volumeCm3: null, productProp: null, row: null, envCode: null, rawType: null, channelCount: null, validCount: 0, fromCache: false, diag: null };

    if (dest) {
      dbg.srcAreaCode = srcAreaCode; dbg.weight = Math.max(weight, 1); dbg.volumeCm3 = volumeCm3; dbg.productProp = productProp;
      const fkey = `${pid}|${v0.vid || 'x'}|${srcAreaCode}|${dest}`;
      const cachedF = cacheGet(freightCache, fkey, FREIGHT_TTL);
      let channels = Array.isArray(cachedF) ? cachedF : null; // {__empty} = كاش سلبي تشخيصي
      if (cachedF) {
        dbg.fromCache = true;
        if (cachedF.__empty) emptyDiag = cachedF.unavailable || [];
      }

      if (!cachedF) {
        // 🚚 صف الطلب [freight-row] — نسخة طبق الأصل من CURL الرسمي ديال freightCalculateTip:
        //   · productProp = مصفوفة ["…"] (الشكل الرسمي — ماشي String!)
        //   · freightTrialSkuList + skuList = Y فالتوثيق — بلاتهم CJ كيرجع 200 بقنوات خاوية
        //   · volume (Y) + totalGoodsAmount كيما فالمثال الرسمي
        const vSku = v0.variantSku ? String(v0.variantSku) : '';
        const row = {
          srcAreaCode,
          destAreaCode: dest,
          weight: Math.max(weight, 1),       // شرط صلب: weight > 0
          productProp: [productProp],         // شرط صلب — مصفوفة (CURL الرسمي)
          productTypes: [0],
        };
        if (volumeCm3 > 0) row.volume = volumeCm3;
        if (cost0 > 0) row.totalGoodsAmount = +cost0.toFixed(2);
        if (vSku) {
          row.skuList = [vSku];
          row.freightTrialSkuList = [{ skuQuantity: 1, sku: vSku }];
        }
        dbg.row = row;

        try {
          const fr = await cjRequest((token, config) =>
            axios.post(`${CJ_API}/logistic/freightCalculateTip`,
              { reqDTOS: [row] },
              { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 }
            )
          );
          const fenv = fr?.data;
          dbg.envCode = fenv?.code ?? null;
          if (!fenv || (fenv.code !== 200 && fenv.code !== 0)) {
            // خطأ envelope ديال CJ (نقاط/أوث) — نسجلو بالعلم، الفريت غادي يرجع للتقدير
            console.error('[cj-live/product][freight][cj-envelope]', fenv?.code, fenv?.message || '');
            shipping = { source: 'cj-error', cjCode: fenv?.code ?? null, cjMessage: String(fenv?.message || '') || null };
          } else {
            const fd = fenv.data;
            dbg.rawType = Array.isArray(fd) ? 'array' : (fd && typeof fd === 'object' ? 'object' : typeof fd);
            channels = Array.isArray(fd) ? fd : (fd?.list || fd?.channels || fd?.content || fd?.rows || []);
            if (channels.length) {
              cacheSet(freightCache, fkey, channels);
            } else {
              // 🫥 200 بقنوات خاوية — CJ ما قدرش يسعّر هاد الـ route (بلا سبب فالجواب)
              //   1.3 unavailableShippingMethods (10pt) بنفس الـ payload كيقول علاش
              console.error('[cj-live/product][freight][empty]', JSON.stringify(row), JSON.stringify(fd).slice(0, 300));
              emptyDiag = await freightDiagnose(row);
              dbg.diag = emptyDiag;
              cacheSet(freightCache, fkey, { __empty: true, unavailable: emptyDiag }); // كاش سلبي — حماية النقاط
            }
          }
        } catch (fe) {
          console.error('[cj-live/product][freight]', fe.message);
          dbg.rawType = 'throw: ' + fe.message;
        }
      }

      dbg.channelCount = (channels || []).length; // كاش ولا MISS — نفس الحساب

      // أرخص قناة صالحة → totalPostageFee = الثمن المباشر المعروض
      const valid = (channels || [])
        .map(c => ({
          amount: parseMaxNumber(c.totalPostageFee) || (parseMaxNumber(c.wrapPostage) || parseMaxNumber(c.postage) || 0) + (parseMaxNumber(c.taxesFee) || 0) + (parseMaxNumber(c.tariff) || 0),
          name: c.channel?.enName || c.enName || c.logisticName || '',
          id: c.channel?.id ?? c.option?.id ?? null,
          arrivalTime: c.arrivalTime || c.option?.arrivalTime || '',
        }))
        .filter(c => c.amount > 0)
        .sort((a, b) => a.amount - b.amount);
      dbg.validCount = valid.length;

      if (valid.length) {
        freightUsd = valid[0].amount;
        shipping = {
          source: 'cj-live',
          amount: freightUsd,
          currency: 'USD',
          channelName: valid[0].name,
          channelId: valid[0].id,
          arrivalTime: valid[0].arrivalTime,
          srcAreaCode,
          options: valid.slice(0, 3), // أفضل 3 قنوات للعرض
        };
      }
    }

    if (shipping.source !== 'cj-live') {
      // 🛟 fallback — تقدير v3.1 القديم (نفس المعادلة) مع علامة المصدر
      //    cjError = خطأ envelope · unavailable = أسباب 1.3 (تشخيصي فقط)
      const cjErr = shipping.source === 'cj-error'
        ? { cjCode: shipping.cjCode ?? null, cjMessage: shipping.cjMessage ?? null } : null;
      shipping = {
        source: 'estimate',
        amount: +(5 + Math.max(weight, 50) / 1000 * 4).toFixed(2),
        currency: 'USD',
        ...(cjErr ? { cjError: cjErr } : {}),
        ...(Array.isArray(emptyDiag) && emptyDiag.length ? { unavailable: emptyDiag.slice(0, 5) } : {}),
      };
    }

    // 💰 أسعار الـ variants — وزن الـ variant نفسه
    //    v0 كياخد الفريت الحقيقي (shipOverride) — الباقي تقدير (بلا حرق نقاط إضافية)
    const variants = (d.variants || []).map((v, idx) => {
      const vWeight = Math.max(parseWeightGrams(v.weight), 0) || weight;
      const vCost = parseMaxNumber(v.variantSellPrice) || parseMaxNumber(d.sellPrice) || 0;
      const vFreight = idx === 0 && freightUsd > 0 ? freightUsd : null;
      return {
        vid: v.vid,
        variantKey: v.variantKey || '',
        variantSellPrice: vCost, // كلفة CJ للـ variant
        laclarcVariantPrice: calculateSellingPrice(vCost, vWeight, vFreight).safePrice,
        inventoryCountries: (Array.isArray(v.inventories) ? v.inventories : [])
          .filter(i => (parseInt(i.totalInventory, 10) || 0) > 0)
          .map(i => geo.normalize(i.countryCode)).filter(Boolean),
      };
    });

    // 💰 v3.0 — السعر الرسمي: قانون v3.1 بالفريت الحقيقي (shipOverrideUsd)
    const { safePrice } = calculateSellingPrice(cost0, weight, freightUsd > 0 ? freightUsd : null);

    return res.json({
      pid: String(d.pid),
      title: d.productNameEn || '',
      description: sanitizeDescription(d.description || ''), // 🔒 XSS shield
      bigImage: d.bigImage || '',
      images: parseImageList(d, { includeVariantImages: false, max: 12 }),
      variants,
      sellPrice: parseMaxNumber(d.sellPrice),
      laclarcPrice: safePrice,     // 💰 السعر الرسمي — فريت حقيقي إن توفر، وإلا تقدير
      original_price: null,        // قرار 1 — بلا strikethrough مولّد
      estimatedShipUsd: shipping.amount, // توافقية خلفية + القيمة الحقيقية إن توفرت
      shipping,                    // 🆕 الثمن المباشر الكامل
      ...(wantDebug ? { freightDebug: dbg } : {}), // 🔬 ?debug=1 — تشخيص الفريت
      geo: geoInfo,                // 🆕 بلد الزائر المستعملة
      weightGrams: weight,
      productProp,
    });
  } catch (e) {
    console.error('[cj-live/product]', e.message);
    return res.status(502).json({ error: 'CJ unavailable' });
  }
});

// ════════════════════════════════════════════════════════════
// ⭐ GET /api/cj-live/reviews/:pid?page=&size=&score=   [cj-reviews]
//    وكيل ريفيوزات CJ مباشر (تشخيص + استهلاك مستقبلي للفرونت)
// ════════════════════════════════════════════════════════════
router.get('/reviews/:pid', async (req, res) => {
  try {
    const pid = String(req.params.pid || '').trim();
    if (!pid || pid.length < 5) return res.status(400).json({ error: 'Bad pid' });
    const data = await fetchCjReviews(pid, {
      page: req.query.page, size: req.query.size, score: req.query.score,
    });
    return res.json(data);
  } catch (e) {
    console.error('[cj-live/reviews]', e.message);
    return res.status(502).json({ error: 'CJ unavailable', cjCode: e.cjCode ?? null });
  }
});

module.exports = router;
module.exports.fetchCjReviews = fetchCjReviews; // ⭐ [cj-reviews] — server.js كيستهلكو للدمج
