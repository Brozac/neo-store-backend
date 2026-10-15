// massSync.js - Laclarc Enterprise Bulk Importer (v4 — Full Catalog · Hierarchy-aware · Quality-filtered · Resumable)
// ============================================================
// 🆕 v4 — بنهج massTargeted: كل فئة L3 معروفة الـ L1 الأب عبر JOIN
//   • fetchTargetCategories → كل الفئات (بلا فلتر) + L1 slug/name
//   • فلترة اختيارية: SYNC_ONLY_ROOTS="computer-and-office,sports-and-outdoors"
//   • checkpoint per-L3-category (cj_category_id)
//   • skipExisting=true → صفر duplicates
// v3.2 — جودة المورّد (disputeRate · logisticScore · serviceScore · excludeCountries · unsold)
// v3.1 — فلاتر 11 · checkpoint ذري · breaker · safeLog · fail-fast 4xx
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
  maxPagesPerCategory: parseInt(process.env.SYNC_MAX_PAGES, 10) || 30,
  maxProducts: parseInt(process.env.SYNC_MAX_PRODUCTS, 10) || 0,
  pointsBudget: (() => {
    const v = parseInt(process.env.SYNC_POINTS_BUDGET, 10);
    return Number.isFinite(v) ? v : 2000000;
  })(),
  sleepMs: parseInt(process.env.SYNC_SLEEP_MS, 10) || 2000,   // QPS=1 آمن
  requestTimeoutMs: 20000,
  skipExisting: process.env.SYNC_SKIP_EXISTING !== 'false',
  withVideo: process.env.SYNC_WITH_VIDEO === 'true',
  ignoreBlacklist: process.env.SYNC_IGNORE_BLACKLIST === 'true',
  syncCategoriesFirst: process.env.SYNC_CATEGORIES_FIRST !== 'false',
  stateFile: path.join(__dirname, 'massSync.state.json'),
  breakerThreshold: 5,
  breakerCooldownMs: 60000,
  breakerMaxTrips: 3,
  // 🆕 v4 — استهداف L1 محدد (اختياري — فارغ = كل الفئات)
  onlyRoots: (process.env.SYNC_ONLY_ROOTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // 🆕 v3.2 — جودة المورّد
  minLogisticScore: parseFloat(process.env.SYNC_MIN_LOGISTIC_SCORE) || 3.5,
  minServiceScore: parseFloat(process.env.SYNC_MIN_SERVICE_SCORE) || 3.5,
  maxDisputeRate: parseFloat(process.env.SYNC_MAX_DISPUTE_RATE) || 0.05,
};

const COST = { list: 50, detail: 10, category: 0 };

const stats = {
  points: 0, imported: 0, skippedExisting: 0, filtered: 0, errors: 0, pages: 0,
  filteredReasons: {}, warnings: {},
};
let stopRequested = false;

class StopSync extends Error { constructor(reason) { super(reason); this.reason = reason; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
const safeLog = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

// ── Checkpoint ──
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
    fs.writeFileSync(`${CFG.stateFile}.tmp`, JSON.stringify(state));
    fs.renameSync(`${CFG.stateFile}.tmp`, CFG.stateFile);
  } catch (e) { console.error('⚠️ checkpoint:', e.message); }
}
function clearState() { if (DRY_RUN) return; try { fs.unlinkSync(CFG.stateFile); } catch {} }

// ── Breaker ──
const breaker = { fails: 0, trips: 0 };
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
      if (status && status >= 400 && status < 500) throw e;
      await breaker.failure(e);
      if (attempt === 3) throw e;
    }
  }
  await breaker.failure(new Error('rate-limited after retries'));
  throw new Error('CJ call failed after retries');
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
      l1.slug AS l1_slug,
      l1.name AS l1_name
    FROM categories l3
    INNER JOIN categories l2 ON l3.parent_id = l2.id
    INNER JOIN categories l1 ON l2.parent_id = l1.id
    WHERE l3.level = 3 AND l3.cj_category_id IS NOT NULL
    ORDER BY l1.slug, l3.slug
  `);

  console.log(`   🌳 laclarc L3 categories (with L1 parent): ${rows.length}`);

  // 🆕 v4 — فلتر SYNC_ONLY_ROOTS (اختياري)
  let targets = rows;
  if (CFG.onlyRoots.length > 0) {
    targets = rows.filter(cat => {
      const l1Slug = (cat.l1_slug || '').toLowerCase();
      return CFG.onlyRoots.includes(l1Slug);
    });
    console.log(`   🎯 فلتر SYNC_ONLY_ROOTS: ${CFG.onlyRoots.join(', ')} → ${targets.length} فئة`);
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

// ── 🆕 v3.2 — فلتر جودة المورّد (من 1.10 productDetail/query) ──
const LACLARC_CRITICAL_COUNTRIES = ['RU', 'IR', 'KP'];

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

// ── معالجة منتج واحد ──
async function processItem(cjItem, cat, existing) {
  const productId = cjItem.pid ? String(cjItem.pid) : null;
  if (!productId) return;
  if (existing.has(productId)) { stats.skippedExisting++; return; }

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

    const reason = getIneligibilityReason(details, { ignoreBlacklist: CFG.ignoreBlacklist });
    if (reason) {
      stats.filtered++;
      bump(stats.filteredReasons, reason);
      return;
    }

    // 🆕 v3.2 — فلتر جودة المورّد
    const supplierReason = getSupplierQualityReason(details);
    if (supplierReason) {
      stats.filtered++;
      bump(stats.filteredReasons, supplierReason);
      return;
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

    const issues = auditProductRow(productRow);
    issues.forEach((i) => bump(stats.warnings, i));

    // 🆕 v3.2 — unsold flag warning
    if (String(details.isUnsold || '') === '1' || String(details.isUnsoldVariant || '') === '1') {
      issues.push('unsold_product');
      bump(stats.warnings, 'unsold_product');
    }

    if (!DRY_RUN) {
      await upsertProductRow(pool, productRow);
    }
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

// ── مزامنة فئة L3 كاملة ──
async function syncCategory(cat, startPage, existing, state) {
  for (let pageNum = startPage; pageNum <= CFG.maxPagesPerCategory; pageNum++) {
    state.currentCategory = cat.cj_category_id ?? 'ALL';
    state.nextPage = pageNum;
    saveState(state);

    console.log(`\n📦 [${cat.l1_name} / ${cat.name}] page ${pageNum} | points ${stats.points}${CFG.pointsBudget > 0 ? `/${CFG.pointsBudget}` : ' (tracked)'}`);

    let body;
    try {
      body = await callCJ('list', (token, config) =>
        axios.get(`${CJ_API}/product/list`, {
          ...config,
          timeout: CFG.requestTimeoutMs,
          headers: { 'CJ-Access-Token': token },
          params: { pageNum, pageSize: CFG.pageSize, ...(cat.cj_category_id ? { categoryId: cat.cj_category_id } : {}) },
        })
      );
    } catch (e) {
      if (e instanceof StopSync) throw e;
      stats.errors++;
      console.error(`❌ List error [${cat.name}] page ${pageNum}: ${safeLog(e.message)}`);
      return false;
    }

    const list = body?.data?.list || [];
    const total = body?.data?.total || 0;
    stats.pages++;

    if (list.length === 0) break;

    for (const cjItem of list) {
      await processItem(cjItem, cat, existing);
    }

    if (total ? pageNum * CFG.pageSize >= total : list.length < CFG.pageSize) break;
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
  console.log(`🚀 Laclarc Mass Sync v4 — Hierarchy-aware (budget ${CFG.pointsBudget} pts)${DRY_RUN ? ' — 🧪 DRY RUN' : ''}`);
  console.log(`💰 Pricing: margin=${(pricing.margin * 100).toFixed(0)}% floor=$${pricing.floor} ship=$${pricing.shipBaseUsd}+${pricing.shipPerKgUsd}/kg dominantRatio=${pricing.shipDominantRatio}`);
  console.log(`🛡️  Quality: disputeRate≤${CFG.maxDisputeRate} · logisticScore≥${CFG.minLogisticScore} · serviceScore≥${CFG.minServiceScore}`);
  if (CFG.onlyRoots.length > 0) console.log(`🎯 Targeted roots: ${CFG.onlyRoots.join(', ')}`);
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
        console.warn(`⚠️ Category sync failed (continuing with DB snapshot): ${e.message}`);
      }
    }

    // 🆕 v4 — الفئات عبر JOIN hierarchy (بدل CJ getCategory)
    const categories = await fetchTargetCategories();
    console.log(`🗂️  ${categories.length} L3 categories to scan`);

    let allClean = true;
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

module.exports = { runMassSync, requestStop: () => { stopRequested = true; } };

if (require.main === module) {
  process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT — finishing current step then saving checkpoint...');
    stopRequested = true;
  });
  runMassSync({ standalone: true });
}