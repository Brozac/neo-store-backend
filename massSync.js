// massSync.js - Laclarc Enterprise Bulk Importer (v5.3 — PREMIUM · listV2 elasticsearch · Batched · Reviews-gated · Resumable)
// ============================================================
// 🆕 v5.3 — الترحيل لـ /product/listV2 (1.2 · Elasticsearch) — القديمة 1.4 /product/list محروسة رسمياً:
//   • DUAL-MODE: SYNC_LIST_ENDPOINT=v2 (default) | v1 (نفس سلوك v5.2b حرفياً)
//   • BATCHING: الـ L3s كيتجمعو حسب L2 الأب → chunks ديال lv3categoryList (10 IDs/طلب)
//     → طلب واحد كيسقي عدة فئات = توفير ~80% ديال نقاط list + لا probes خاوية لكل فئة
//   • ترجمة الباراميترات (الأسماء تبدلو فـ V2):
//       pageNum/pageSize → page/size (سقف size=100) · orderBy=listedNum (نص) → orderBy=1 (رقم)
//       minPrice/maxPrice → startSellPrice/endSellPrice · startInventory → startWarehouseInventory
//   • minListedNum/deliveryTime ماكاينش فـ V2 → post-filters محلية مجانية:
//       listedNum (كيرجع فالاستجابة) ≥ SYNC_MIN_LISTED_NUM · deliveryCycle "3-5" (أيام!) ≤ SYNC_MAX_DELIVERY_DAYS(5)
//       ⚠️ دلالات مختلفة: v1 كان deliveryTime=72 ساعة (handling) — V2 كيرجع deliveryCycle دورة كاملة بالأيام
//   • الاستجابة متداخلة: data.list[] → data.content[].productList[] · total → totalRecords · pid → id
//   • L2-relax بقى بخدم على مستوى الـ chunk (نفس المنطق: strict=0 → محاولة مرنة)
//   • checkpoint mode-aware: state ديال v1 ما كيتقراش فـ v2 (ولا العكس) — skipExisting كيحمي القاعدة
//   • paramsSerializer مخصص: arrays = مفاتيح مكررة بلا [] (lv3categoryList=a&lv3categoryList=b)
// 🩹 v5.2 — صفحات خاوية: التركيبة الصارمة (minListedNum=20+deliveryTime+startInventory) كانت كتخوي
//   الفئات الصغيرة (0 نتائج) بلا حتى لوق. دابا:
//   • لوق total الحقيقي من CJ على كل صفحة خاوية (تشخيص فوري)
//   • L2-RELAX تلقائي: strict=0 → محاولة مرنة (بلا minListedNum/deliveryTime/startInventory —
//     بقاو orderBy=listedNum desc + verifiedWarehouse + minPrice) وإلا لقات حوايج كمل الفئة كاملة مرن
//   • minListedNum default 20 → 5 (20 كان فانتازيا على الفئات الصغيرة — قابل للضبط بـ ENV)
// 🩹 v5.1 — إصلاح SYNC_ONLY_ROOTS: كان كيقارن slug فقط حرفياً → "Consumer Electronics" (بفراغ) ماكانش كيلقى
//   "consumer-electronics" (بشرطة) → 0 فئة. دابا: normalize (فراغ/_ → -) + مطابقة slug أو name
//   + substring (≥4 حروف) + إلا 0 match كيطبع الـ roots المتاحة.
// 🆕 v5 — الطراز العالي (المستويات 1+2+3 دفعة وحدة) + بوابة التقييمات:
//   • BREAKER FIXED — breaker.failure كان غير معرّف → TypeError كيقتل الـ retries
//     على 5xx/timeouts. دابا: breaker حقيقي (threshold 5 · cooldown 60s · max 3 trips
//     → StopSync('CIRCUIT_BREAKER'))
//   • L1 — جودة المورّد مرفوعة: dispute≤2% (كانت 5%) · logistic≥4.0 · service≥4.0 (كانت 3.5)
//   • L2 — باراميترات /product/list من وثائق CJ (كانت مستغلة أصلاً):
//       orderBy=listedNum&sort=desc  → المجربة عالمياً أولاً (كان default: createAt=الجديد)
//       minListedNum=20              → طلب مثبت في 20+ محل
//       deliveryTime=72              → شحن خلال 72 ساعة
//       verifiedWarehouse=1          → مخزون موثّق CJ
//       startInventory=10            → حد أدنى للمخزون
//       minPrice=2.0                 → لا للـ junk الرخيص من المصدر
//       pageSize=100 (كانت 20)       → توفير النقاط: 50 نقطة/صفحة باش تجيب 100 بدل 20
//   • L3 — طبقة الطراز العالي على مستوى المنتج (قبل buildProductRow):
//       cost≥$2.5 · description≥300 حرف · صور ≥3 · رفض isUnsold=1 صراحة
//   • REVIEWS — "جيب المنتجات اللي فيها review":
//       pre-check مجاني (0 نقاط) على /product/productComments قبل detail (10 نقاط)
//       + حزام أمان commentCount من detail · SYNC_MIN_COMMENTS (default 1 · 0=تعطيل)
//   • كل العتبات قابلة للضبط عبر ENV (شوف الجدول تحت) — بلا redeploy من Render
// v4 — بنهج massTargeted: كل فئة L3 معروفة الـ L1 الأب عبر JOIN · checkpoint per-L3
// v3.2 — جودة المورّد (disputeRate · logisticScore · serviceScore · excludeCountries)
// v3.1 — فلاتر 11 · checkpoint ذري · safeLog · fail-fast 4xx
// ============================================================
// 📋 ENV REFERENCE (v5):
//   التشغيل:  SYNC_DRY_RUN · SYNC_PAGE_SIZE(100) · SYNC_MAX_PAGES(30) · SYNC_MAX_PRODUCTS(0)
//             SYNC_POINTS_BUDGET(2000000) · SYNC_SLEEP_MS(2000) · SYNC_SKIP_EXISTING(true)
//             SYNC_WITH_VIDEO(false) · SYNC_IGNORE_BLACKLIST(false) · SYNC_CATEGORIES_FIRST(true)
//             SYNC_ONLY_ROOTS("" = كل الفئات)
//   L1 مورّد: SYNC_MAX_DISPUTE_RATE(0.02) · SYNC_MIN_LOGISTIC_SCORE(4.0) · SYNC_MIN_SERVICE_SCORE(4.0)
//   L2 list:  SYNC_ORDER_BY(listedNum) · SYNC_SORT(desc) · SYNC_MIN_LISTED_NUM(5)
//             SYNC_DELIVERY_TIME(72 · "0"=تعطيل) · SYNC_VERIFIED_WAREHOUSE(1 · "0"=تعطيل)
//             SYNC_START_INVENTORY(10) · SYNC_LIST_MIN_PRICE(2.0) · SYNC_LIST_MAX_PRICE(0=بلا حد)
//             SYNC_SEARCH_TYPE(0 · 2=Trending — v1 فقط) · SYNC_L2_RELAX(true = fallback مرن عند 0 نتائج)
//   🆕 v5.3:  SYNC_LIST_ENDPOINT(v2 = listV2 elasticsearch [default] · v1 = القديم المحروسم)
//             SYNC_MAX_DELIVERY_DAYS(5 · v2 فقط · post-filter على deliveryCycle بالأيام · 0=تعطيل)
//             SYNC_LV3_CHUNK_SIZE(10 · v2 فقط · عدد L3 IDs فكل طلب lv3categoryList · 1-20)
//   L3 منتج:  SYNC_MIN_COST(2.5) · SYNC_MIN_DESC_LEN(300) · SYNC_MIN_IMAGES(3)
//             SYNC_REJECT_UNSOLD(true) · SYNC_REQUIRE_CE_CATEGORIES("" = تعطيل)
//   الريفيوز: SYNC_MIN_COMMENTS(1 · 0=تعطيل) · SYNC_PRECHECK_REVIEWS(true)
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pool = require('./db');
const { cjRequest } = require('./services/cjService');
const { syncCategoriesFromCJ } = require('./services/categoryService');
const {
  buildProductRow,
  upsertProductRow,
  getIneligibilityReason,
  auditProductRow,
  getPricingConfig,
} = require('./services/productImportService');
const { parseMaxNumber, parseImageList } = require('./utils/cjNormalize');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

const DRY_RUN = process.env.SYNC_DRY_RUN === 'true';

// 🆕 v5 — قارئ ENV عددي يسمح بقيمة 0 صريحة (تعطيل) — parseInt||default كان كيمنعها
const envNum = (name, d) => {
  const n = parseFloat(process.env[name]);
  return Number.isFinite(n) ? n : d;
};

const CFG = {
  pageSize: Math.min(200, Math.max(1, Math.round(envNum('SYNC_PAGE_SIZE', 100)))),
  maxPagesPerCategory: Math.max(1, Math.round(envNum('SYNC_MAX_PAGES', 30))),
  maxProducts: envNum('SYNC_MAX_PRODUCTS', 0),
  pointsBudget: (() => {
    const v = parseInt(process.env.SYNC_POINTS_BUDGET, 10);
    return Number.isFinite(v) ? v : 2000000;
  })(),
  sleepMs: envNum('SYNC_SLEEP_MS', 2000),   // QPS=1 آمن (فوقه cjPace عالمي 1100ms)
  requestTimeoutMs: 20000,
  skipExisting: process.env.SYNC_SKIP_EXISTING !== 'false',
  withVideo: process.env.SYNC_WITH_VIDEO === 'true',
  ignoreBlacklist: process.env.SYNC_IGNORE_BLACKLIST === 'true',
  syncCategoriesFirst: process.env.SYNC_CATEGORIES_FIRST !== 'false',
  stateFile: path.join(__dirname, 'massSync.state.json'),
  breakerThreshold: 5,
  breakerCooldownMs: 60000,
  breakerMaxTrips: 3,
  onlyRoots: (process.env.SYNC_ONLY_ROOTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  // ── 🆕 v5 L1 — جودة المورّد (defaults مرفوعة من v3.2: 0.05/3.5/3.5) ──
  minLogisticScore: envNum('SYNC_MIN_LOGISTIC_SCORE', 4.0),
  minServiceScore: envNum('SYNC_MIN_SERVICE_SCORE', 4.0),
  maxDisputeRate: envNum('SYNC_MAX_DISPUTE_RATE', 0.02),

  // ── 🆕 v5 L2 — باراميترات /product/list (موثقة فوثائق CJ — كانت بلا استعمال) ──
  orderBy: (process.env.SYNC_ORDER_BY || 'listedNum').trim() || 'listedNum',
  sortDir: (process.env.SYNC_SORT || 'desc').trim() || 'desc',
  minListedNum: envNum('SYNC_MIN_LISTED_NUM', 5),
  // 🆕 v5 fix (kit37): env فارغ = غير معرّف → default '72' · "0"/"none" صريحة = تعطيل
  deliveryTime: (() => {
    const raw = String(process.env.SYNC_DELIVERY_TIME ?? '').trim();
    if (raw === '') return '72';
    if (['0', 'false', 'none', 'null'].includes(raw.toLowerCase())) return null;
    return raw;
  })(),
  verifiedWarehouse: process.env.SYNC_VERIFIED_WAREHOUSE !== '0',
  startInventory: envNum('SYNC_START_INVENTORY', 10),
  listMinPrice: envNum('SYNC_LIST_MIN_PRICE', 2.0),
  listMaxPrice: envNum('SYNC_LIST_MAX_PRICE', 0),
  searchType: envNum('SYNC_SEARCH_TYPE', 0),
  // 🆕 v5.2 — fallback مرن: إلا التركيبة الصارمة عطات 0 → محاولة بلا الفلاتر القاسحة
  l2Relax: process.env.SYNC_L2_RELAX !== 'false',

  // ── 🆕 v5.3 — مسار V2 (/product/listV2 · Elasticsearch) ──
  listEndpoint: (process.env.SYNC_LIST_ENDPOINT || 'v2').trim().toLowerCase() === 'v1' ? 'v1' : 'v2',
  maxDeliveryDays: envNum('SYNC_MAX_DELIVERY_DAYS', 5),        // post-filter deliveryCycle (0=تعطيل)
  lv3ChunkSize: Math.max(1, Math.min(20, Math.round(envNum('SYNC_LV3_CHUNK_SIZE', 10)))), // IDs/طلب

  // ── 🆕 v5 L3 — طبقة الطراز العالي على مستوى المنتج ──
  minCost: envNum('SYNC_MIN_COST', 2.5),
  minDescLen: envNum('SYNC_MIN_DESC_LEN', 300),
  minImages: envNum('SYNC_MIN_IMAGES', 3),
  rejectUnsold: process.env.SYNC_REJECT_UNSOLD !== 'false',
  requireCeSlugs: (process.env.SYNC_REQUIRE_CE_CATEGORIES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  // ── 🆕 v5 — بوابة التقييمات (طلب المالك: منتجات فيها review) ──
  minComments: envNum('SYNC_MIN_COMMENTS', 1),                      // 0 = تعطيل
  precheckReviews: process.env.SYNC_PRECHECK_REVIEWS !== 'false',   // فحص مجاني قبل detail
};

// نقاط CJ (points.txt): list=50 · query=10 · productComments غير مذكور = مجاني
const COST = { list: 50, detail: 10, category: 0, comments: 0 };

const stats = {
  points: 0, imported: 0, skippedExisting: 0, filtered: 0, errors: 0, pages: 0,
  reviewsChecked: 0, filteredReasons: {}, warnings: {},
  relaxedCats: 0, emptyCats: 0,   // 🆕 v5.2 — تشخيص الفئات الخاوية/المرنة
  emptyChunks: 0,                 // 🆕 v5.3 — تشخيص الـ chunks الخاوية (v2)
};
let stopRequested = false;

class StopSync extends Error { constructor(reason) { super(reason); this.reason = reason; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
const safeLog = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');
// نسخة محلية من stripHtml (productImportService ما كيصدرهاش) — لنفس دلالات العد
const stripHtml = (html) => String(html || '').replace(/<[^>]*>?/gm, '').replace(/&nbsp;/gi, ' ').trim();

// ── Checkpoint ──
// 🆕 v5.3 — state mode-aware: v1 (فئات) و v2 (chunks) عندهم مفاتيح مختلفة
const STATE_MODE = () => (CFG.listEndpoint === 'v2' ? 'v2-chunks' : 'v1-cats');
function freshState() {
  return { mode: STATE_MODE(), doneCategories: [], currentCategory: null, nextPage: 1, doneChunks: [], currentChunk: null };
}
function loadState() {
  if (DRY_RUN) return freshState();
  try {
    const s = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    if (s.mode && s.mode !== STATE_MODE()) {
      console.log(`♻️  Checkpoint من وضع آخر (${s.mode}) — الحالي ${STATE_MODE()} → نبدا من الصفر (skipExisting كيحمي من التكرار)`);
      return freshState();
    }
    return {
      ...freshState(),
      doneCategories: Array.isArray(s.doneCategories) ? s.doneCategories : [],
      currentCategory: s.currentCategory ?? null,
      nextPage: s.nextPage || 1,
      doneChunks: Array.isArray(s.doneChunks) ? s.doneChunks : [],
      currentChunk: s.currentChunk ?? null,
    };
  } catch (e) {
    return freshState();
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  try {
    fs.writeFileSync(`${CFG.stateFile}.tmp`, JSON.stringify(state));
    fs.renameSync(`${CFG.stateFile}.tmp`, CFG.stateFile);
  } catch (e) { console.error('⚠️ checkpoint:', e.message); }
}
function clearState() { if (DRY_RUN) return; try { fs.unlinkSync(CFG.stateFile); } catch {} }

// ── Breaker (🆕 v5 — FIXED) ──
// v3.1-v4 كان فيه بوق: `const breaker = { fails: 0, trips: 0 }` بلا ميثود failure،
// و callCJ كان كيعيط `await breaker.failure(e)` → TypeError فوري كيقتل الـ 3 retries
// على كل timeout/5xx (المنتج كيتسكيب برسالة "breaker.failure is not a function").
// دابا: عدّاد حقيقي — عند threshold → cooldown؛ بعد max trips → StopSync('CIRCUIT_BREAKER').
const breaker = { fails: 0, trips: 0 };
async function breakerCooldownIfNeeded(err) {
  if (breaker.fails < CFG.breakerThreshold) return;
  breaker.trips++;
  if (breaker.trips > CFG.breakerMaxTrips) throw new StopSync('CIRCUIT_BREAKER');
  console.warn(`🔴 Circuit breaker tripped (${breaker.trips}/${CFG.breakerMaxTrips}) — cooldown ${CFG.breakerCooldownMs}ms | last: ${safeLog(err?.message)}`);
  breaker.fails = 0;
  await sleep(CFG.breakerCooldownMs);
}

async function callCJ(kind, requestFn) {
  const cost = COST[kind] || 0;
  if (CFG.pointsBudget > 0 && stats.points + cost > CFG.pointsBudget) throw new StopSync('POINTS_BUDGET');
  stats.points += cost;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (stopRequested) throw new StopSync('SIGINT');
    await sleep(CFG.sleepMs);
    try {
      const res = await cjRequest(requestFn);
      const body = res?.data;
      const code = body?.code === undefined ? undefined : Number(body?.code);
      const msg = String(body?.message || '');

      if (code === 1600201 || code === 16900500 || /insufficient api points|quota/i.test(msg)) {
        throw new StopSync('POINTS_EXHAUSTED');
      }
      if (code === 1600200 || res?.status === 429) {
        await sleep(5000 * attempt);
        continue;
      }
      if (code !== undefined) {
        if (Number.isNaN(code) || (code !== 200 && code !== 0)) {
          throw new Error(`CJ code=${body?.code} ${msg}`);
        }
      }
      breaker.fails = 0;
      return body;
    } catch (e) {
      if (e instanceof StopSync) throw e;
      if (e.response?.status === 429) { await sleep(5000 * attempt); continue; }
      const status = e.response?.status;
      if (status && status >= 400 && status < 500) throw e; // fail-fast: أخطاء auth/params
      // 🆕 v5 — breaker حقيقي (كان: await breaker.failure(e) → TypeError)
      breaker.fails++;
      if (attempt >= 3) throw e;
      await breakerCooldownIfNeeded(e);
    }
  }
  breaker.fails++; // كل المحاولات ولّاو 429 — صحة الخدمة ضعيفة
  throw new Error('CJ call failed after retries (persistent 429)');
}

// ── 🆕 v5 L2 — باراميترات /product/list من وثائق CJ (1.0) ──
// orderBy=listedNum → المنتجات المثبتة الطلب أولاً (default كان createAt = الجديد أول)
function buildListParams(pageNum, cat) {
  const params = { pageNum, pageSize: CFG.pageSize };
  if (cat.cj_category_id) params.categoryId = cat.cj_category_id;
  if (CFG.orderBy) params.orderBy = CFG.orderBy;
  if (CFG.sortDir) params.sort = CFG.sortDir;
  if (CFG.minListedNum > 0) params.minListedNum = CFG.minListedNum;
  if (CFG.deliveryTime) params.deliveryTime = CFG.deliveryTime;
  if (CFG.verifiedWarehouse) params.verifiedWarehouse = 1;
  if (CFG.startInventory > 0) params.startInventory = CFG.startInventory;
  if (CFG.listMinPrice > 0) params.minPrice = CFG.listMinPrice;
  if (CFG.listMaxPrice > 0) params.maxPrice = CFG.listMaxPrice;
  if (CFG.searchType > 0) params.searchType = CFG.searchType;
  return params;
}

// ── 🆕 v5.2 — نسخة مرنة من params: كنحيدو الفلاتر القاسحة اللي كيخويو الفئات الصغيرة
//    وبقينا: ترتيب listedNum desc (الجودة أولاً) + verifiedWarehouse + minPrice (أنتي-جونك)
function buildRelaxedParams(pageNum, cat) {
  const p = buildListParams(pageNum, cat);
  delete p.minListedNum;
  delete p.deliveryTime;
  delete p.startInventory;
  return p;
}

// ============================================================
// 🆕 v5.3 — مسار V2 (/product/listV2 — 1.2 · Elasticsearch)
// ============================================================
// الفروقات الموثقة (product.html#_1-2-product-list-v2-get):
//   • page/size بدل pageNum/pageSize · سقف size=100 · page حتى 1000
//   • orderBy رقمي: 0=best match · 1=listing count · 2=sell price · 3=create · 4=inventory
//   • startSellPrice/endSellPrice · startWarehouseInventory · verifiedWarehouse (نفس الدلالة)
//   • lv3categoryList: عدة فئات فطلب واحد = أصل التوفير الكبير فالنقاط
//   • الاستجابة: data.content[].productList[] متداخلة · totalRecords (سقف 6000) · id بدل pid
//   • ماكاينش minListedNum ولا deliveryTime → post-filters محلية مجانية (v2ListFilterReason)

// Arrays = مفاتيح مكررة بلا أقواس (lv3categoryList=a&lv3categoryList=b) — الصيغة القياسية
// للـ Spring/Java backends؛ الـ default ديال axios كيزيد [] وكقدر ما يتبنداش فالسيرفر
function cjV2ParamsSerializer(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== undefined && item !== null && item !== '') {
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
        }
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

function buildV2Params(pageNum, categoryIds) {
  const params = { page: pageNum, size: Math.min(CFG.pageSize, 100) }; // سقف V2 = 100
  if (Array.isArray(categoryIds) && categoryIds.length) params.lv3categoryList = categoryIds;
  // orderBy: 'listedNum' (الاسم ديال v1) → 1 (الرقم ديال v2) — أو رقم صريح 0-4
  const ob = String(CFG.orderBy).toLowerCase();
  if (ob === 'listednum' || ob === '1') params.orderBy = 1;
  else if (/^[0-4]$/.test(ob)) params.orderBy = Number(ob);
  // أي قيمة أخرى (createAt...) كتطيح — V2 default 0 (best match) أحسن من param error
  if (CFG.sortDir) params.sort = CFG.sortDir;
  if (CFG.listMinPrice > 0) params.startSellPrice = CFG.listMinPrice;
  if (CFG.listMaxPrice > 0) params.endSellPrice = CFG.listMaxPrice;
  if (CFG.verifiedWarehouse) params.verifiedWarehouse = 1;
  if (CFG.startInventory > 0) params.startWarehouseInventory = CFG.startInventory;
  return params;
}

// الوضع المرن v2 = كيف v1 relax: كنحيدو المخزون فقط — الباقي (orderBy/verified/price) كيبقى
// + post-filters كيتجاوزو كاملين (شوف v2ListFilterReason)
function buildV2RelaxedParams(pageNum, categoryIds) {
  const p = buildV2Params(pageNum, categoryIds);
  delete p.startWarehouseInventory;
  return p;
}

// الاستجابة متداخلة: content[] كيكون فيه عادة عنصر واحد فيه productList — نفردو للأمان
function parseV2List(body) {
  const data = body?.data || {};
  const contents = Array.isArray(data.content) ? data.content : [];
  const list = [];
  for (const c of contents) {
    if (Array.isArray(c?.productList)) list.push(...c.productList);
  }
  return { list, total: Number(data.totalRecords) || 0 };
}

// v1 كيرجع pid · v2 كيرجع id — كنقبلو بجوج
function extractProductId(item) {
  return String(item?.pid || item?.id || '').trim() || null;
}

// Post-filters المجانية (V2 ما عندوش minListedNum ولا deliveryTime فالسيرفر):
//   • listedNum كيرجع فالاستجابة · ناقص = مجهول → fail-open (نفس فلسفة المخزون)
//   • deliveryCycle "3-5" بالأيام — الحد الأعلى > SYNC_MAX_DELIVERY_DAYS → بطيء
//     ⚠️ مختلف على deliveryTime=72 ساعة ديال v1 (handling) — هنا دورة التوصيل الكاملة
//   • الوضع المرن = بلا الفلاتر القاسحة كاملين (كيف v1 relax)
function v2ListFilterReason(item, { relaxed = false } = {}) {
  if (relaxed) return null;
  if (CFG.minListedNum > 0) {
    const ln = Number(item?.listedNum);
    if (Number.isFinite(ln) && ln < CFG.minListedNum) return 'listednum_below_min';
  }
  if (CFG.maxDeliveryDays > 0) {
    const dc = String(item?.deliveryCycle || '').trim();
    if (dc) {
      const days = dc.split('-').map((x) => parseFloat(x)).filter(Number.isFinite);
      if (days.length && Math.max(...days) > CFG.maxDeliveryDays) return 'delivery_cycle_slow';
    }
  }
  return null;
}

// تجميع L3s حسب L2 الأب → chunks صغيرة (URL آمن + الأخطاء معزولة لكل chunk)
function buildChunks(categories) {
  const byL2 = new Map();
  for (const cat of categories) {
    if (!cat.cj_category_id) continue; // fetchTargetCategories كيرجع غير اللي عندهم id
    const key = cat.l2_slug || cat.l1_slug || 'ALL';
    if (!byL2.has(key)) {
      byL2.set(key, { l2_slug: cat.l2_slug, l2_name: cat.l2_name || cat.l2_slug, l1_slug: cat.l1_slug, l1_name: cat.l1_name, cats: [] });
    }
    byL2.get(key).cats.push(cat);
  }
  const chunks = [];
  for (const grp of byL2.values()) {
    for (let i = 0; i < grp.cats.length; i += CFG.lv3ChunkSize) {
      const ids = grp.cats.slice(i, i + CFG.lv3ChunkSize).map((c) => c.cj_category_id).filter(Boolean);
      if (ids.length) chunks.push({ ...grp, chunkPart: Math.floor(i / CFG.lv3ChunkSize), ids });
    }
  }
  return chunks;
}

function chunkKey(chunk) {
  return `${chunk.l2_slug || 'ALL'}#${chunk.chunkPart}`;
}

// ── 🆕 v4 — الفئات المستهدفة عبر JOIN hierarchy (بنهج massTargeted) ──
//    كل L3 معروفة الـ L1 الأب — ممكن فلترتها بـ SYNC_ONLY_ROOTS
async function fetchTargetCategories() {
  const { rows } = await pool.query(`
    SELECT
      l3.id,
      l3.name,
      l3.slug AS l3_slug,
      l3.cj_category_id,
      l2.slug AS l2_slug,
      l2.name AS l2_name,
      l1.slug AS l1_slug,
      l1.name AS l1_name
    FROM categories l3
    INNER JOIN categories l2 ON l3.parent_id = l2.id
    INNER JOIN categories l1 ON l2.parent_id = l1.id
    WHERE l3.level = 3 AND l3.cj_category_id IS NOT NULL
    ORDER BY l1.slug, l3.slug
  `);

  console.log(`   🌳 laclarc L3 categories (with L1 parent): ${rows.length}`);

  // فلتر SYNC_ONLY_ROOTS (اختياري) — v5.1: مطابقة تسامحية
  //   • كيقارن slug وname معاً · فراغ/شرطة سفلية → شرطة ("Consumer Electronics" = "consumer-electronics")
  //   • substring fallback (≥4 حروف) — "electronics" كتلقى consumer-electronics
  //   • إلا طلع 0 match → كيطبع الـ roots المتاحة باش ما تعاودش تخمن
  let targets = rows;
  if (CFG.onlyRoots.length > 0) {
    const norm = (s) => String(s || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
    const wanted = CFG.onlyRoots.map(norm);
    targets = rows.filter(cat => {
      const slugN = norm(cat.l1_slug);
      const nameN = norm(cat.l1_name);
      return wanted.some(w => w === slugN || w === nameN
        || (w.length >= 4 && (slugN.includes(w) || nameN.includes(w))));
    });
    console.log(`   🎯 فلتر SYNC_ONLY_ROOTS: ${CFG.onlyRoots.join(', ')} → ${targets.length} فئة`);
    if (targets.length === 0) {
      const avail = [...new Set(rows.map(r => String(r.l1_slug || '').trim()).filter(Boolean))].sort();
      console.log(`   ⚠️  ماكاين حتى match! الـ roots المتاحة (${avail.length}):`);
      avail.forEach(a => console.log(`      • ${a}`));
    }
  }

  console.log(`   🎯 فئات مستهدفة: ${targets.length}`);
  const byRoot = {};
  targets.forEach(t => {
    byRoot[t.l1_slug] = (byRoot[t.l1_slug] || 0) + 1;
  });
  Object.keys(byRoot).forEach(r => console.log(`      ${r}: ${byRoot[r]} فئة`));

  return targets;
}

// ── Existing ──
async function loadExistingIds() {
  if (!CFG.skipExisting) return new Set();
  const { rows } = await pool.query('SELECT cj_product_id FROM products WHERE cj_product_id IS NOT NULL');
  return new Set(rows.map((r) => String(r.cj_product_id)));
}

// ── v3.2/v5 L1 — فلتر جودة المورّد (من 1.10 productDetail/query) ──
// v5: defaults مرفوعة عبر CFG (dispute≤2% · logistic≥4.0 · service≥4.0)
function getSupplierQualityReason(details) {
  const disputeRate = parseFloat(details.qualityDisputeRate || '0');
  const logisticScore = parseFloat(details.logisticScore || '5');
  const serviceScore = parseFloat(details.serviceScore || '5');

  if (Number.isFinite(disputeRate) && disputeRate > CFG.maxDisputeRate) {
    return 'supplier_dispute_rate_high';
  }
  if (Number.isFinite(logisticScore) && logisticScore < CFG.minLogisticScore) {
    return 'supplier_logistic_score_low';
  }
  if (Number.isFinite(serviceScore) && serviceScore < CFG.minServiceScore) {
    return 'supplier_service_score_low';
  }

  const excluded = details.excludeCountries || [];
  if (Array.isArray(excluded)) {
    if (excluded.includes('US') || excluded.includes('GB') || excluded.includes('FR')) {
      return 'excluded_countries_major_market';
    }
  }

  return null;
}

// ── 🆕 v5.2 — ملاحظة توثيق: /product/query (1.5) ما كيرجعش commentCount (موثق غير فـ
//    1.7 My Product List) → العد الوحيد الموثوق للريفيوزات هو /product/productComments
// ── 🆕 v5 — فحص التقييمات (مجاني: /product/productComments خارج جدول النقاط) ──
// كيرجع عدد الريفيوزات الكلي، أو -1 إلا فشل الفحص (v5.2: -1 → الحزام الأخير كيعاود
// يجرب مجاناً؛ إلا بقا -1 → 'reviews_unverifiable' = رفض — fail-closed للطراز العالي)
async function hasReviews(productId) {
  try {
    const body = await callCJ('comments', (token, config) =>
      axios.get(`${CJ_API}/product/productComments`, {
        ...config,
        timeout: CFG.requestTimeoutMs,
        headers: { 'CJ-Access-Token': token },
        params: { pid: productId, pageNum: 1, pageSize: 1 },
      })
    );
    return parseInt(body?.data?.total, 10) || 0; // CJ كيرجع total كـ string
  } catch (e) {
    if (e instanceof StopSync) throw e;
    bump(stats.warnings, 'reviews_precheck_failed');
    return -1;
  }
}

// ── 🆕 v5 L3 — طبقة الطراز العالي على مستوى المنتج ──
// كتمر بعد الفلاتر الأساسية (getIneligibilityReason) وفوقها بصرامة
function getPremiumQualityReason(details) {
  // a) التكلفة — بلا junk رخيص (الأساس كيرفض <$1 · هنا ≥$2.5)
  const cost = parseMaxNumber(details.sellPrice);
  if (cost > 0 && cost < CFG.minCost) return 'premium_cost_below_floor';

  // b) الوصف — وصف نحيف = صفحة فقيرة (الأساس كيطلب >10 حرف · هنا ≥300)
  if (stripHtml(details.description).length < CFG.minDescLen) return 'premium_description_thin';

  // c) الصور — معرض حقيقي ≥3 (بلا صور الـ variants — الصور ديال المتغيرات كيتزادو
  //    فالـ row من بعد؛ الفحص هنا على جودة المعرض الفعلي)
  const galleryCount = parseImageList(details, { includeVariantImages: false }).length;
  if (galleryCount < CFG.minImages) return 'premium_too_few_images';

  // d) المنتجات البطيئة الحركة — CJ كيقول صراحة "ما كيتباعش" (كان غير warning فv4)
  if (CFG.rejectUnsold) {
    if (String(details.isUnsold || '') === '1' || String(details.isUnsoldVariant || '') === '1') {
      return 'premium_unsold_product';
    }
  }

  return null;
}

// ── معالجة منتج واحد (v5 — قمع 6 طبقات) ──
async function processItem(cjItem, cat, existing) {
  // 🆕 v5.3 — v1 كيرجع pid · v2 كيرجع id (extractProductId كتقبل بجوج)
  const productId = extractProductId(cjItem);
  if (!productId) return;
  if (existing.has(productId)) { stats.skippedExisting++; return; }

  try {
    // 🆕 v5 — الفحص المجاني للتقييمات (0 نقاط) قبل detail (10 نقاط):
    // الريفيوزات = طلب صريح — ما نخسروش نقاط على منتجات بلا تقييمات
    let precheckTotal = -1; // 🆕 v5.2 — كيتحفظ للحزام الأخير (detail ما كيرجعش commentCount!)
    if (CFG.minComments > 0 && CFG.precheckReviews) {
      stats.reviewsChecked++;
      precheckTotal = await hasReviews(productId);
      if (precheckTotal === 0) {
        stats.filtered++;
        bump(stats.filteredReasons, 'no_reviews');
        return;
      }
    }

    const body = await callCJ('detail', (token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config,
        timeout: CFG.requestTimeoutMs,
        headers: { 'CJ-Access-Token': token },
        params: CFG.withVideo ? { pid: productId, features: 'enable_video' } : { pid: productId },
      })
    );

    const details = body?.data;
    if (!details) { stats.errors++; return; }

    // القاعدة (فلاتر 11 · blacklist · stock · shipping_dominant)
    const reason = getIneligibilityReason(details, { ignoreBlacklist: CFG.ignoreBlacklist });
    if (reason) {
      stats.filtered++;
      bump(stats.filteredReasons, reason);
      return;
    }

    // 🆕 v5 L1 — جودة المورّد (عتبات مرفوعة)
    const supplierReason = getSupplierQualityReason(details);
    if (supplierReason) {
      stats.filtered++;
      bump(stats.filteredReasons, supplierReason);
      return;
    }

    // 🆕 v5 L3 — الطراز العالي (cost · desc · images · unsold)
    const premiumReason = getPremiumQualityReason(details);
    if (premiumReason) {
      stats.filtered++;
      bump(stats.filteredReasons, premiumReason);
      return;
    }

    // 🆕 v5.2 — حزام أمان التقييمات (مصلّح):
    // توثيق CJ: /product/query (1.5) ما كيرجعش commentCount أصلاً (الحقل موثق غير ف
    // My Product List) → parseInt(undefined)=NaN → الفحص القديم كان كيتجاوز بصمت دائماً.
    // الحكم دابا من comments API المجاني (نفس المصدر اللي كيقرا منو الموقع فـ kit 34):
    //   • إلا precheck نجح → استعملو
    //   • إلا فشل (-1) → جرب مجاناً مرة أخرى هنا
    //   • بلاك ما تعرفنا العدد → رفض 'reviews_unverifiable' (الطَراز العالي = fail-closed)
    let revFinal = null; // للعرض فاللوق — العدد الحقيقي
    if (CFG.minComments > 0) {
      let cc = parseInt(details.commentCount, 10);
      if (!Number.isFinite(cc)) {
        cc = precheckTotal >= 0 ? precheckTotal : await hasReviews(productId); // مجاني
      }
      if (!Number.isFinite(cc) || cc < 0) {
        stats.filtered++;
        bump(stats.filteredReasons, 'reviews_unverifiable');
        bump(stats.warnings, 'reviews_unverifiable');
        return;
      }
      if (cc < CFG.minComments) {
        stats.filtered++;
        bump(stats.filteredReasons, cc === 0 ? 'no_reviews' : 'low_reviews');
        return;
      }
      revFinal = cc;
    }

    const productRow = await buildProductRow(details, {
      fallbackCategoryId: details.categoryId || cat.cj_category_id || null,
      fetchVideo: CFG.withVideo,
      videoApiFallback: false,
      ignoreBlacklist: CFG.ignoreBlacklist,
      isSourced: false,
    });

    if (!productRow) {
      stats.filtered++;
      bump(stats.filteredReasons, 'unknown');
      return;
    }

    // 🆕 v5 — شهادة CE للفئات الحساسة (اختياري: SYNC_REQUIRE_CE_CATEGORIES="electronics,kids")
    if (CFG.requireCeSlugs.length > 0 && details.hasCECertification !== 1) {
      const catSlug = String(productRow.category || '').toLowerCase();
      const sensitive = CFG.requireCeSlugs.some((s) =>
        catSlug === s || catSlug.startsWith(`${s}-`) || catSlug.startsWith(`${s}/`)
      );
      if (sensitive) {
        stats.filtered++;
        bump(stats.filteredReasons, 'ce_cert_required');
        return;
      }
    }

    const issues = auditProductRow(productRow);
    issues.forEach((i) => bump(stats.warnings, i));

    if (!DRY_RUN) {
      await upsertProductRow(pool, productRow);
    }
    existing.add(productId);
    stats.imported++;

    const tag = DRY_RUN ? '🧪' : '✅';
    console.log(
      `${tag} [${stats.imported}] ${safeLog(productRow.title).substring(0, 35)}... ($${productRow.price}) ` +
      `| imgs=${productRow.images.length} desc=${productRow.description.length} ` +
      `var=${(details.variants || []).length} w=${productRow.weight_grams}g rev=${revFinal ?? '?'} cat=${safeLog(productRow.category)}` +
      (issues.length ? ` | ⚠ ${issues.join(',')}` : '')
    );

    if (CFG.maxProducts && stats.imported >= CFG.maxProducts) throw new StopSync('MAX_PRODUCTS');
  } catch (e) {
    if (e instanceof StopSync) throw e;
    stats.errors++;
    console.log(`⚠️ Skipped product ${productId}: ${safeLog(e.message)}`);
  }
}

// ── مزامنة فئة L3 كاملة — 🆕 v5.2: L2-relax تلقائي + تشخيص total ──
//    strict=0 → محاولة مرنة وحدة؛ إلا لقات → الفئة كاملة كتتم بالوضع المرن (useRelaxed)
async function syncCategory(cat, startPage, existing, state) {
  let useRelaxed = false;
  for (let pageNum = startPage; pageNum <= CFG.maxPagesPerCategory; pageNum++) {
    state.currentCategory = cat.cj_category_id ?? 'ALL';
    state.nextPage = pageNum;
    saveState(state);

    console.log(`\n📦 [${cat.l1_name} / ${cat.name}] page ${pageNum}${useRelaxed ? ' 🔄relaxed' : ''} | points ${stats.points}${CFG.pointsBudget > 0 ? `/${CFG.pointsBudget}` : ' (tracked)'}`);

    const fetchList = (params) => callCJ('list', (token, config) =>
      axios.get(`${CJ_API}/product/list`, {
        ...config,
        timeout: CFG.requestTimeoutMs,
        headers: { 'CJ-Access-Token': token },
        params,
      })
    );

    let body;
    try {
      body = await fetchList(useRelaxed ? buildRelaxedParams(pageNum, cat) : buildListParams(pageNum, cat));
    } catch (e) {
      if (e instanceof StopSync) throw e;
      stats.errors++;
      console.error(`❌ List error [${cat.name}] page ${pageNum}: ${safeLog(e.message)}`);
      return false;
    }

    let list = body?.data?.list || [];
    let total = Number(body?.data?.total) || 0;
    stats.pages++;

    // 🆕 v5.2 — الصارم عطى 0 → محاولة مرنة كاشفة (50 نقطة زايدة غير هنا)
    if (list.length === 0 && !useRelaxed && CFG.l2Relax) {
      console.log(`   🍃 strict=0 (total=${total}) → جرب L2-relax (بلا listedNum/delivery/inv)...`);
      try {
        body = await fetchList(buildRelaxedParams(pageNum, cat));
        list = body?.data?.list || [];
        total = Number(body?.data?.total) || 0;
        stats.pages++;
        if (list.length > 0) {
          useRelaxed = true;
          stats.relaxedCats++;
          console.log(`   🔄 L2-relax [${cat.name}]: strict=0 → relaxed=${list.length}/${total} — الفئة كاملة غادي يتم بالوضع المرن`);
        }
      } catch (e) {
        if (e instanceof StopSync) throw e;
        stats.errors++;
        console.error(`❌ Relax error [${cat.name}] p${pageNum}: ${safeLog(e.message)}`);
      }
    }

    if (list.length === 0) {
      if (pageNum === startPage) stats.emptyCats++;
      console.log(`   🍃 [${cat.name}] page ${pageNum} — 0 نتائج (total=${total})${useRelaxed ? '' : ' — الـ relax حتى هو خاوي'}`);
      break;
    }

    for (const cjItem of list) {
      await processItem(cjItem, cat, existing);
    }

    if (total ? pageNum * CFG.pageSize >= total : list.length < CFG.pageSize) break;
  }
  return true;
}

// ── 🆕 v5.3 — مسح chunk ديال L3s عبر /product/listV2 (نفس قلب syncCategory معدّل للـ V2) ──
// الفروقات: lv3categoryList بلاصة categoryId · parseV2List (استجابة متداخلة) · post-filters مجانية
async function syncChunk(chunk, startPage, existing, state) {
  let useRelaxed = false;
  for (let pageNum = startPage; pageNum <= CFG.maxPagesPerCategory; pageNum++) {
    state.currentChunk = chunkKey(chunk);
    state.nextPage = pageNum;
    saveState(state);

    const label = `${chunk.l1_name} / ${chunk.l2_name} · chunk ${chunk.chunkPart + 1} (${chunk.ids.length} L3)`;
    console.log(`\n📦 [${label}] page ${pageNum}${useRelaxed ? ' 🔄relaxed' : ''} | points ${stats.points}${CFG.pointsBudget > 0 ? `/${CFG.pointsBudget}` : ' (tracked)'}`);

    const fetchListV2 = (params) => callCJ('list', (token, config) =>
      axios.get(`${CJ_API}/product/listV2`, {
        ...config,
        timeout: CFG.requestTimeoutMs,
        headers: { 'CJ-Access-Token': token },
        params,
        paramsSerializer: cjV2ParamsSerializer, // arrays = مفاتيح مكررة بلا []
      })
    );

    const applyV2PostFilters = (items, { relaxed }) => {
      const kept = [];
      for (const item of items) {
        const reason = v2ListFilterReason(item, { relaxed });
        if (reason) { stats.filtered++; bump(stats.filteredReasons, reason); continue; }
        kept.push(item);
      }
      return kept;
    };

    let body;
    try {
      body = await fetchListV2(useRelaxed ? buildV2RelaxedParams(pageNum, chunk.ids) : buildV2Params(pageNum, chunk.ids));
    } catch (e) {
      if (e instanceof StopSync) throw e;
      stats.errors++;
      console.error(`❌ ListV2 error [${label}] page ${pageNum}: ${safeLog(e.message)}`);
      return false;
    }

    let { list, total } = parseV2List(body);
    stats.pages++;
    if (total >= 6000) {
      console.log(`   ⚠️ totalRecords=${total} — V2 كيسقف العرض فـ 6000، النتائج الحقيقية أكثر (صغّر SYNC_LV3_CHUNK_SIZE إلا بغيتي دقة أكبر)`);
    }

    // 🆕 v5.3 — post-filters مجانية (listedNum/deliveryCycle) قبل أي طلب مدفوع
    if (list.length) {
      const kept = applyV2PostFilters(list, { relaxed: useRelaxed });
      if (kept.length < list.length) {
        console.log(`   🧹 post-filter: ${list.length - kept.length}/${list.length} ترددو محلياً (listedNum/deliveryCycle) — 0 نقاط`);
        list = kept;
      }
    }

    // 🍃 strict=0 → relax probe على مستوى الـ chunk (نفس منطق v5.2 ولكن للـ V2)
    if (list.length === 0 && !useRelaxed && CFG.l2Relax) {
      console.log(`   🍃 strict=0 (total=${total}) → جرب L2-relax (بلا startWarehouseInventory + بلا post-filters)...`);
      try {
        body = await fetchListV2(buildV2RelaxedParams(pageNum, chunk.ids));
        const r2 = parseV2List(body);
        const kept2 = applyV2PostFilters(r2.list, { relaxed: true }); // المرن بلا فلاتر
        stats.pages++;
        if (kept2.length > 0) {
          useRelaxed = true;
          list = kept2;
          total = r2.total;
          stats.relaxedCats++;
          console.log(`   🔄 L2-relax [${chunk.l2_name}#${chunk.chunkPart + 1}]: strict=0 → relaxed=${kept2.length}/${total} — الـ chunk كامل غادي يتم بالوضع المرن`);
        }
      } catch (e) {
        if (e instanceof StopSync) throw e;
        stats.errors++;
        console.error(`❌ Relax error [${label}] p${pageNum}: ${safeLog(e.message)}`);
      }
    }

    if (list.length === 0) {
      if (pageNum === startPage) stats.emptyChunks++;
      console.log(`   🍃 [${label}] page ${pageNum} — 0 نتائج (total=${total})${useRelaxed ? '' : ' — الـ relax حتى هو خاوي'}`);
      break;
    }

    for (const cjItem of list) {
      // pseudoCat من categoryId ديال المنتج نفسو (V2 كيرجعو فالليستة) —
      // نستعملوه غير كـ fallback إلا detail رجع بلا categoryId (chunk فيه عشر فئات، ما نقدرش نخمّن)
      await processItem(cjItem, { cj_category_id: cjItem?.categoryId || null }, existing);
    }

    const size = Math.min(CFG.pageSize, 100);
    if (total ? pageNum * size >= total : list.length < size) break;
  }
  return true;
}

// ── Main ──
async function runMassSync({ standalone = false } = {}) {
  const startedAt = Date.now();
  let exitCode = 0;
  const state = loadState();
  const pricing = getPricingConfig();

  console.log(`\n==================================================`);
  console.log(`🚀 Laclarc Mass Sync v5.3 — PREMIUM · listV2 elasticsearch (budget ${CFG.pointsBudget} pts)${DRY_RUN ? ' — 🧪 DRY RUN' : ''}`);
  console.log(`💰 Pricing: margin=${(pricing.margin * 100).toFixed(0)}% floor=$${pricing.floor} ship=$${pricing.shipBaseUsd}+${pricing.shipPerKgUsd}/kg dominantRatio=${pricing.shipDominantRatio}`);
  // 🆕 v5 — بانور الطبقات الثلاث + التقييمات
  console.log(`🛡️  L1 Supplier: disputeRate≤${CFG.maxDisputeRate} · logisticScore≥${CFG.minLogisticScore} · serviceScore≥${CFG.minServiceScore}`);
  console.log(`🧭 L2 List: orderBy=${CFG.orderBy}/${CFG.sortDir} · minListedNum=${CFG.minListedNum} · deliveryTime=${CFG.deliveryTime || 'any'} · verifiedWH=${CFG.verifiedWarehouse ? 1 : 0} · startInv=${CFG.startInventory} · price=$${CFG.listMinPrice}-${CFG.listMaxPrice || '∞'} · pageSize=${CFG.pageSize} · relax=${CFG.l2Relax ? 'ON' : 'off'}`);
  console.log(`🔌 Endpoint: ${CFG.listEndpoint === 'v2' ? `🟢 /product/listV2 (1.2 elasticsearch) · chunks=${CFG.lv3ChunkSize} L3/طلب · size≤100 · post-filters: listedNum≥${CFG.minListedNum} · deliveryCycle≤${CFG.maxDeliveryDays || '∞'}d` : '🟠 /product/list (1.4 — deprecated)'}${DRY_RUN ? ' · 🧪 DRY RUN' : ''}`);
  if (CFG.listEndpoint === 'v2' && String(process.env.SYNC_DELIVERY_TIME ?? '').trim() !== '') {
    console.log(`   ⚠️ SYNC_DELIVERY_TIME ما كيتستعملش فـ v2 (listV2 ما عندوش deliveryTime) — البديل: SYNC_MAX_DELIVERY_DAYS=${CFG.maxDeliveryDays}`);
  }
  console.log(`💎 L3 Premium: cost≥$${CFG.minCost} · desc≥${CFG.minDescLen}ch · imgs≥${CFG.minImages} · unsold=${CFG.rejectUnsold ? 'REJECTED' : 'allowed'}${CFG.requireCeSlugs.length ? ` · CE in [${CFG.requireCeSlugs.join(',')}]` : ''}`);
  console.log(`⭐ Reviews: minComments=${CFG.minComments}${CFG.minComments > 0 && CFG.precheckReviews ? ' (pre-checked free before detail)' : ''}`);
  if (CFG.onlyRoots.length > 0) console.log(`🎯 Targeted roots: ${CFG.onlyRoots.join(', ')}`);
  if (state.doneChunks?.length || state.currentChunk) {
    console.log(`♻️  Resuming (v2 chunks): ${state.doneChunks.length} chunks done, current=${state.currentChunk ?? '-'} page ${state.nextPage}`);
  } else if (state.doneCategories.length || state.currentCategory) {
    console.log(`♻️  Resuming: ${state.doneCategories.length} categories done, current=${state.currentCategory ?? '-'} page ${state.nextPage}`);
  }
  console.log(`==================================================\n`);

  try {
    const existing = await loadExistingIds();
    console.log(`🗂️  ${existing.size} products already in DB (skipExisting=${CFG.skipExisting})`);

    if (CFG.syncCategoriesFirst && !DRY_RUN) {
      try {
        await sleep(CFG.sleepMs);
        const r = await syncCategoriesFromCJ();
        console.log(`🌳 Categories synced: L1=${r.level1Count} L2=${r.level2Count} L3=${r.level3Count}`);
      } catch (e) {
        console.warn(`⚠️ Category sync failed (continuing with DB snapshot): ${e.message}`);
      }
    }

    const categories = await fetchTargetCategories();
    console.log(`🗂️  ${categories.length} L3 categories to scan`);

    let allClean = true;

    if (CFG.listEndpoint === 'v2') {
      // ── 🆕 v5.3 — مسار V2: chunks ديال lv3categoryList (طلب واحد لعدة L3s) ──
      const chunks = buildChunks(categories);
      console.log(`🧩 V2 batch: ${chunks.length} chunks (حتى ${CFG.lv3ChunkSize} L3/طلب) من ${categories.length} فئة`);
      for (const chunk of chunks) {
        const key = chunkKey(chunk);
        if (state.doneChunks.includes(key)) continue;

        const startPage = state.currentChunk === key ? state.nextPage : 1;
        const ok = await syncChunk(chunk, startPage, existing, state);

        if (ok) {
          state.doneChunks.push(key);
          state.currentChunk = null;
          state.nextPage = 1;
          saveState(state);
        } else {
          allClean = false;
        }
      }
    } else {
      // ── المسار القديم v1 (1.4) — محفوظ حرفياً كيف كان فـ v5.2b ──
      for (const cat of categories) {
        const key = cat.cj_category_id ?? 'ALL';
        if (state.doneCategories.includes(key)) continue;

        const startPage = state.currentCategory === key ? state.nextPage : 1;
        const ok = await syncCategory(cat, startPage, existing, state);

        if (ok) {
          state.doneCategories.push(key);
          state.currentCategory = null;
          state.nextPage = 1;
          saveState(state);
        } else {
          allClean = false;
        }
      }
    }

    if (allClean) {
      clearState();
      console.log('\n🏁 All categories scanned.');
    } else {
      console.log('\n🏁 Scan finished, but some categories failed — checkpoint kept, re-run to retry them.');
    }
  } catch (err) {
    if (err instanceof StopSync) {
      const hints = {
        POINTS_BUDGET: 'Local points budget reached',
        POINTS_EXHAUSTED: 'CJ says API points are exhausted',
        CIRCUIT_BREAKER: 'Too many consecutive CJ failures', // 🆕 v5 — ولّى قابلاً للوصول فعلاً
        MAX_PRODUCTS: 'SYNC_MAX_PRODUCTS reached',
        SIGINT: 'Stopped manually',
      };
      console.log(`\n⏸️  Stopped: ${hints[err.reason] || err.reason}.${DRY_RUN ? '' : ' Checkpoint saved — run again to resume.'}`);
      if (err.reason === 'CIRCUIT_BREAKER') exitCode = 1;
    } else {
      console.error('❌ Fatal error in Mass Sync:', err.message);
      exitCode = 1;
    }
  } finally {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`\n==================================================`);
    console.log(`📊 imported=${stats.imported}${DRY_RUN ? ' (dry-run, not saved)' : ''} | skipped(existing)=${stats.skippedExisting} | filtered=${stats.filtered} | errors=${stats.errors}`);
    const emptyLabel = CFG.listEndpoint === 'v2' ? `emptyChunks=${stats.emptyChunks}` : `emptyCats=${stats.emptyCats}`;
    console.log(`📊 pages=${stats.pages} | relaxed=${stats.relaxedCats} | ${emptyLabel} | reviewsChecked=${stats.reviewsChecked} | points≈${stats.points} | ${mins} min`);
    if (Object.keys(stats.filteredReasons).length) console.log(`🚫 filtered reasons:`, stats.filteredReasons);
    if (Object.keys(stats.warnings).length) console.log(`⚠️  data gaps (imported anyway):`, stats.warnings);
    console.log(`==================================================\n`);

    if (standalone) {
      try { await pool.end(); } catch (e) { /* ignore */ }
      process.exit(exitCode);
    }
  }

  return { ...stats };
}

module.exports = {
  runMassSync,
  requestStop: () => { stopRequested = true; },
  // 🆕 v5.3 — internals للفحص الوحدوي (بلا credentials بلا DB)
  __internals: { cjV2ParamsSerializer, buildV2Params, buildV2RelaxedParams, parseV2List, extractProductId, v2ListFilterReason, buildChunks, chunkKey, CFG },
};

if (require.main === module) {
  process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT — finishing current step then saving checkpoint...');
    stopRequested = true;
  });
  // 🆕 v5 — .catch: كان unhandledRejection محتمل إلا طاح شي حاجة برا الـ try
  runMassSync({ standalone: true }).catch((e) => {
    console.error('❌ Fatal (unhandled):', e.message);
    process.exit(1);
  });
}
