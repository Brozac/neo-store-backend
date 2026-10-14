// massSync.js - Laclarc Enterprise Bulk Importer (v3.2 — Full Catalog · Resumable · Points-aware · Quality-filtered · Audited)
// ============================================================
// v3.2 — إصلاحات الـ audit (v3.1 محفوظة) + 🆕 جودة المورّد (M#53):
//   • 🆕 supplier quality filters — qualityDisputeRate · logisticScore · serviceScore (من 1.10 productDetail)
//   • 🆕 excludeCountries — إلا CJ ما يشحنش لدولة target → رفض
//   • 🆕 unsold flag warning — مراقبة المخزون البطيء
// v3.1 — إصلاحات الـ audit (مؤكدة بالبرهان الحي — 47k+ منتج مستورد):
//   • fail-fast على 4xx (عدا 429) — retry ما يبدلش جواب 401/403 (P1-1)
//   • points تُخصم مرة واحدة لكل نداء منطقي — التقرير صادق (P1-2)
//   • 429 بعد نضوب المحاولات يفتح الـ breaker (P2-2)
//   • code يُطبّع لـ Number مع NaN guard — "200" string ما يكسرش (P3)
//   • ضد log forgery: \n في العناوين تتسطح (P3)
//   • DRY RUN يقرا DB (skip-existing) — التقرير "would import" صادق (P2-1)
//   • dedupe in-memory حتى في DRY RUN — نفس الـ pid ما يتنداش مرتين
//   • break على صفحة غير ممتلئة إذا total غايب — نداء 50pt يوفر (P2-3)
// v3 (تبقى كاملة): checkpoints · breaker · budget · QPS=1 · تصنيفات · تقارير
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

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

const DRY_RUN = process.env.SYNC_DRY_RUN === 'true';

const CFG = {
  pageSize: parseInt(process.env.SYNC_PAGE_SIZE, 10) || 20,
  maxPagesPerCategory: parseInt(process.env.SYNC_MAX_PAGES, 10) || 10,
  maxProducts: parseInt(process.env.SYNC_MAX_PRODUCTS, 10) || 0,
  pointsBudget: (() => {
    const v = parseInt(process.env.SYNC_POINTS_BUDGET, 10);
    return Number.isFinite(v) ? v : 2000000;
  })(),
  sleepMs: parseInt(process.env.SYNC_SLEEP_MS, 10) || 1200,
  requestTimeoutMs: 20000,
  // P2-1: DRY_RUN يقرا الـ DB (SELECT مسموح) — الممنوع هو الكتابة فقط
  skipExisting: process.env.SYNC_SKIP_EXISTING !== 'false',
  byCategory: process.env.SYNC_BY_CATEGORY !== 'false',
  withVideo: process.env.SYNC_WITH_VIDEO === 'true',
  ignoreBlacklist: process.env.SYNC_IGNORE_BLACKLIST === 'true',
  syncCategoriesFirst: process.env.SYNC_CATEGORIES_FIRST !== 'false',
  stateFile: path.join(__dirname, 'massSync.state.json'),
  breakerThreshold: 5,
  breakerCooldownMs: 60000,
  breakerMaxTrips: 3,
  // 🆕 v3.2 — جودة المورّد thresholds (من 1.10 productDetail)
  minLogisticScore: parseFloat(process.env.SYNC_MIN_LOGISTIC_SCORE, 10) || 3.5,   // من 5
  minServiceScore: parseFloat(process.env.SYNC_MIN_SERVICE_SCORE, 10) || 3.5,     // من 5
  maxDisputeRate: parseFloat(process.env.SYNC_MAX_DISPUTE_RATE, 10) || 0.05,      // 5% max
};

// تكلفة كل نداء بالـ points (حسب جدول CJ)
const COST = { list: 50, detail: 10, category: 0 };

const stats = {
  points: 0,
  imported: 0,
  skippedExisting: 0,
  filtered: 0,
  errors: 0,
  pages: 0,
  filteredReasons: {},
  warnings: {},
};
let stopRequested = false;

class StopSync extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };

// ضد log forgery: العناوين من CJ قد تحتوي \n → أسطر مزوّرة في السجل (P3)
const safeLog = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

// ==========================================
// Checkpoint (كتابة ذرية: tmp → rename) — معطل في DRY RUN
// ==========================================
function loadState() {
  if (DRY_RUN) return { doneCategories: [], currentCategory: null, nextPage: 1 };
  try {
    const s = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    return {
      doneCategories: Array.isArray(s.doneCategories) ? s.doneCategories : [],
      currentCategory: s.currentCategory ?? null,
      nextPage: s.nextPage || 1,
    };
  } catch (e) {
    return { doneCategories: [], currentCategory: null, nextPage: 1 };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  try {
    const tmp = `${CFG.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, CFG.stateFile);
  } catch (e) {
    console.error('⚠️ Could not save checkpoint:', e.message);
  }
}

function clearState() {
  if (DRY_RUN) return;
  try { fs.unlinkSync(CFG.stateFile); } catch (e) { /* ignore */ }
}

// ==========================================
// Circuit Breaker
// ==========================================
const breaker = {
  fails: 0,
  trips: 0,
  success() { this.fails = 0; },
  async failure(err) {
    this.fails++;
    if (this.fails < CFG.breakerThreshold) return;
    this.trips++;
    if (this.trips > CFG.breakerMaxTrips) throw new StopSync('CIRCUIT_BREAKER');
    const wait = CFG.breakerCooldownMs * this.trips;
    console.warn(`🔌 Circuit breaker #${this.trips} (${this.fails} consecutive failures: ${err?.message}) — cooling ${wait / 1000}s`);
    await sleep(wait);
    this.fails = 0;
  },
};

// ==========================================
// نداء CJ موحد: budget + sleep + retry + breaker
// ==========================================
async function callCJ(kind, requestFn) {
  const cost = COST[kind] || 0;

  // P1-2: الميزانية تُفحص وتُخصم مرة واحدة لكل نداء منطقي (ماشي لكل محاولة)
  if (CFG.pointsBudget > 0 && stats.points + cost > CFG.pointsBudget) throw new StopSync('POINTS_BUDGET');
  stats.points += cost;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (stopRequested) throw new StopSync('SIGINT');

    await sleep(CFG.sleepMs); // Tactical sleep (QPS=1)

    try {
      const res = await cjRequest(requestFn);
      const body = res?.data;
      // P3: code قد يجي string — نطبعع لرقم، NaN = شكل غير متوقع → مسار الفشل
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

      breaker.success();
      return body;
    } catch (e) {
      if (e instanceof StopSync) throw e;
      if (e.response?.status === 429) {
        await sleep(5000 * attempt);
        continue;
      }
      // P1-1: 4xx (عدا 429) = فشل حتمي — إعادة المحاولة ما تبدلش الجواب
      const status = e.response?.status;
      if (status && status >= 400 && status < 500) throw e;

      await breaker.failure(e); // ممكن يرمي StopSync
      if (attempt === 3) throw e;
    }
  }
  // P2-2: انقطاع rate-limit مطوّل لازم يفتح الـ breaker
  await breaker.failure(new Error('rate-limited after retries'));
  throw new Error('CJ call failed after retries');
}

// ==========================================
// 🆕 v3.2 — فلتر جودة المورّد (من 1.10 productDetail/query)
//   • qualityDisputeRate > 0.05 → رفض (مورّد مشاكل)
//   • logisticScore < 3.5 → رفض (شحن سيء)
//   • serviceScore < 3.5 → رفض (خدمة سيئة)
//   • excludeCountries → إلا laclarc target ضمن الاستثناءات → رفض
//   • isUnsold = 1 → warning (مخزون بطيء — ما كيمنعش)
// ==========================================
const LACLARC_CRITICAL_COUNTRIES = ['RU', 'IR', 'KP']; // دول محظورة دائماً (مثال — عدل حسب الحاجة)

function getSupplierQualityReason(details) {
  // 🔍 جودة المورّد — إلا كاينة الحقول (اختيارية في بعض المنتجات)
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

  // 🩹 M#47 followup — excludeCountries (1.10 productDetail)
  //    إلا CJ ما يشحنش للدولة المستهدفة من laclarc → رفض
  //    (laclarc يبيع عالمياً 222 دولة — إلا excluded يشمل واحدة رئيسية → exclude)
  const excluded = details.excludeCountries || [];
  if (Array.isArray(excluded)) {
    // حالياً — نتفقدو الشائعة (RU · IR · KP) — إلا المنتج مستثنى منها
    // laclarc يبيع عالمياً — إلا excluded يشمل دولة كبيرة → نرفضو
    // ⚠️ استراتيجية: نرفض فقط إلا excluded يشمل أسواق laclarc الرئيسية
    if (excluded.includes('US') || excluded.includes('GB') || excluded.includes('FR')) {
      return 'excluded_countries_major_market';
    }
  }

  return null; // 🟢 المورّد يعدّي الفلاتر
}

// ==========================================
// جلب التصنيفات (المستوى الثالث = categoryId)
// ==========================================
async function fetchCategories() {
  if (!CFG.byCategory) return [{ id: null, name: 'ALL' }];

  const body = await callCJ('category', (token, config) =>
    axios.get(`${CJ_API}/product/getCategory`, {
      ...config,
      timeout: CFG.requestTimeoutMs,
      headers: { 'CJ-Access-Token': token },
    })
  );

  const cats = [];
  for (const l1 of body?.data || []) {
    for (const l2 of l1.categoryFirstList || []) {
      for (const l3 of l2.categorySecondList || []) {
        if (l3.categoryId) cats.push({ id: String(l3.categoryId), name: l3.categoryName });
      }
    }
  }
  if (cats.length === 0) throw new Error('No categories returned by CJ');
  return cats;
}

// ==========================================
// منتجات موجودة (باش ما نضيعوش points)
// ==========================================
async function loadExistingIds() {
  if (!CFG.skipExisting) return new Set();
  const { rows } = await pool.query('SELECT cj_product_id FROM products WHERE cj_product_id IS NOT NULL');
  return new Set(rows.map((r) => String(r.cj_product_id)));
}

// ==========================================
// معالجة منتج واحد
// ==========================================
async function processItem(cjItem, cat, existing) {
  const productId = cjItem.pid ? String(cjItem.pid) : null;
  if (!productId) return;

  if (existing.has(productId)) {
    stats.skippedExisting++;
    return;
  }

  try {
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

    // فلتر v3.1 — 11 فلتر
    const reason = getIneligibilityReason(details, { ignoreBlacklist: CFG.ignoreBlacklist });
    if (reason) {
      stats.filtered++;
      bump(stats.filteredReasons, reason);
      return;
    }

    // 🆕 v3.2 — فلتر جودة المورّد (3 فلاتر جداد)
    const supplierReason = getSupplierQualityReason(details);
    if (supplierReason) {
      stats.filtered++;
      bump(stats.filteredReasons, supplierReason);
      return;
    }

    const productRow = await buildProductRow(details, {
      fallbackCategoryId: details.categoryId || cat.id || null,
      fetchVideo: CFG.withVideo,
      videoApiFallback: false, // بلا نداء إضافي (يوفر points)
      ignoreBlacklist: CFG.ignoreBlacklist,
      isSourced: false,
    });

    if (!productRow) {
      stats.filtered++;
      bump(stats.filteredReasons, 'unknown');
      return;
    }

    const issues = auditProductRow(productRow);
    issues.forEach((i) => bump(stats.warnings, i));

    // 🆕 v3.2 — unsold flag warning (مخزون بطيء — ما كيمنعش)
    if (String(details.isUnsold || '') === '1' || String(details.isUnsoldVariant || '') === '1') {
      issues.push('unsold_product');
      bump(stats.warnings, 'unsold_product');
    }

    if (!DRY_RUN) {
      await upsertProductRow(pool, productRow);
    }
    // dedupe in-memory حتى في DRY RUN — نفس الـ pid ما يتنداش مرتين في نفس التشغيل
    existing.add(productId);
    stats.imported++;

    const tag = DRY_RUN ? '🧪' : '✅';
    console.log(
      `${tag} [${stats.imported}] ${safeLog(productRow.title).substring(0, 35)}... ($${productRow.price}) ` +
      `| imgs=${productRow.images.length} desc=${productRow.description.length} ` +
      `var=${(details.variants || []).length} w=${productRow.weight_grams}g cat=${safeLog(productRow.category)}` +
      (issues.length ? ` | ⚠ ${issues.join(',')}` : '')
    );

    if (CFG.maxProducts && stats.imported >= CFG.maxProducts) throw new StopSync('MAX_PRODUCTS');
  } catch (e) {
    if (e instanceof StopSync) throw e;
    stats.errors++;
    console.log(`⚠️ Skipped product ${productId}: ${safeLog(e.message)}`);
  }
}

// ==========================================
// مزامنة تصنيف كامل (كل الصفحات)
// ==========================================
async function syncCategory(cat, startPage, existing, state) {
  for (let pageNum = startPage; pageNum <= CFG.maxPagesPerCategory; pageNum++) {
    state.currentCategory = cat.id ?? 'ALL';
    state.nextPage = pageNum;
    saveState(state);

    console.log(`\n📦 [${cat.name}] page ${pageNum} | points ${stats.points}${CFG.pointsBudget > 0 ? `/${CFG.pointsBudget}` : ' (tracked)'}`);

    let body;
    try {
      body = await callCJ('list', (token, config) =>
        axios.get(`${CJ_API}/product/list`, {
          ...config,
          timeout: CFG.requestTimeoutMs,
          headers: { 'CJ-Access-Token': token },
          params: { pageNum, pageSize: CFG.pageSize, ...(cat.id ? { categoryId: cat.id } : {}) },
        })
      );
    } catch (e) {
      if (e instanceof StopSync) throw e;
      stats.errors++;
      console.error(`❌ List error [${cat.name}] page ${pageNum}: ${safeLog(e.message)}`);
      return false; // التصنيف ما يتسجلش done → يتعاود في التشغيل الجاي
    }

    const list = body?.data?.list || [];
    const total = body?.data?.total || 0;
    stats.pages++;

    if (list.length === 0) break;

    for (const cjItem of list) {
      await processItem(cjItem, cat, existing);
    }

    // P2-3: صفحة غير ممتلئة = آخر صفحة — نوفر نداء 50pt إذا total غايب
    if (total ? pageNum * CFG.pageSize >= total : list.length < CFG.pageSize) break;
  }
  return true;
}

// ==========================================
// المحرك الرئيسي
// ==========================================
async function runMassSync({ standalone = false } = {}) {
  const startedAt = Date.now();
  let exitCode = 0;
  const state = loadState();
  const pricing = getPricingConfig();

  console.log(`\n==================================================`);
  console.log(`🚀 Laclarc Mass Sync — Full Catalog (budget ${CFG.pointsBudget} pts)${DRY_RUN ? ' — 🧪 DRY RUN (no DB writes)' : ''}`);
  console.log(`💰 Pricing: margin=${(pricing.margin * 100).toFixed(0)}% floor=$${pricing.floor} ship=$${pricing.shipBaseUsd}+${pricing.shipPerKgUsd}/kg dominantRatio=${pricing.shipDominantRatio}`);
  console.log(`🛡️  Quality filters: disputeRate≤${CFG.maxDisputeRate} · logisticScore≥${CFG.minLogisticScore} · serviceScore≥${CFG.minServiceScore}`);
  if (state.doneCategories.length || state.currentCategory) {
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
        console.warn(`⚠️ Category sync failed (continuing with keyword fallback): ${e.message}`);
      }
    }

    const categories = await fetchCategories();
    console.log(`🗂️  ${categories.length} categories to scan`);

    let allClean = true;
    for (const cat of categories) {
      const key = cat.id ?? 'ALL';
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
        CIRCUIT_BREAKER: 'Too many consecutive CJ failures',
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
    console.log(`📊 pages=${stats.pages} | points≈${stats.points} | ${mins} min`);
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

// ✨ تصدير — إذا استوردتها من server.js ما تقتلش الـ pool ولا الـ process
module.exports = { runMassSync, requestStop: () => { stopRequested = true; } };

// تشغيل يدوي: node massSync.js
if (require.main === module) {
  process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT — finishing current step then saving checkpoint...');
    stopRequested = true;
  });
  runMassSync({ standalone: true });
}