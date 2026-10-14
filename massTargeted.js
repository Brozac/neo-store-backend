// massTargeted.js - Laclarc Targeted Category Importer (v3)
// ============================================================
// 🎯 المهمة: تعمير الفئات الثلاثة الفارغة
// 🩹 v3 — بمعاملات listV2 المتقدمة (verified · delivery · minListedNum)
//   • pageSize 200 (max CJ) — أسرع 10×
//   • verifiedWarehouse=1 — جودة inventory
//   • minListedNum=10 — منتجات مثبتة
//   • deliveryTime=72 — شحن سريع (اختياري)
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pool = require('./db');
const { cjRequest } = require('./services/cjService');
const {
  buildProductRow,
  upsertProductRow,
  getIneligibilityReason,
  auditProductRow,
  getPricingConfig,
} = require('./services/productImportService');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
const DRY_RUN = process.env.SYNC_DRY_RUN === 'true';

const TARGET_ROOTS = [
  'automobiles-and-motorcycles',
  'computer-and-office',
  'sports-and-outdoors',
];

const CFG = {
  pageSize: parseInt(process.env.SYNC_PAGE_SIZE, 10) || 200,  // 🩹 v3 — max CJ
  maxPagesPerCategory: parseInt(process.env.SYNC_MAX_PAGES, 10) || 30,
  maxProducts: parseInt(process.env.SYNC_MAX_PRODUCTS, 10) || 0,
  pointsBudget: (() => {
    const v = parseInt(process.env.SYNC_POINTS_BUDGET, 10);
    return Number.isFinite(v) ? v : 0;
  })(),
  sleepMs: parseInt(process.env.SYNC_SLEEP_MS, 10) || 2000,
  requestTimeoutMs: 30000,
  skipExisting: process.env.SYNC_SKIP_EXISTING !== 'false',
  // 🆕 v3 — معاملات الجودة
  minListedNum: parseInt(process.env.SYNC_MIN_LISTED_NUM, 10) || 10,   // منتجات شعبية
  verifiedOnly: process.env.SYNC_VERIFIED_ONLY === 'true',
  stateFile: path.join(__dirname, 'massTargeted.state.json'),
  breakerThreshold: 5,
  breakerCooldownMs: 60000,
  breakerMaxTrips: 3,
};

const COST = { list: 50, detail: 10 };

const stats = {
  points: 0, imported: 0, skippedExisting: 0, filtered: 0, errors: 0, pages: 0,
  filteredReasons: {}, warnings: {},
};
let stopRequested = false;

class StopSync extends Error { constructor(reason) { super(reason); this.reason = reason; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const safeLog = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

// ── Checkpoint ──
function loadState() {
  if (DRY_RUN) return { done: [] };
  try {
    const s = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    return { done: s.done || [] };
  } catch { return { done: [] }; }
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
        console.warn(`⏳ QPS hit — backoff ${5 * attempt}s`);
        await sleep(5000 * attempt);
        continue;
      }
      if (code !== undefined && (Number.isNaN(code) || (code !== 200 && code !== 0))) {
        throw new Error(`CJ code=${body?.code} ${msg}`);
      }
      breaker.fails = 0;
      return body;
    } catch (e) {
      if (e instanceof StopSync) throw e;
      if (e.response?.status === 429) { await sleep(5000 * attempt); continue; }
      const st = e.response?.status;
      if (st && st >= 400 && st < 500) throw e;
      breaker.fails++;
      if (breaker.fails >= CFG.breakerThreshold) {
        breaker.trips++;
        if (breaker.trips > CFG.breakerMaxTrips) throw new StopSync('CIRCUIT_BREAKER');
        console.warn(`🔌 breaker #${breaker.trips}`);
        await sleep(CFG.breakerCooldownMs);
        breaker.fails = 0;
      }
      if (attempt === 3) throw e;
    }
  }
  await breaker.failure(new Error('exhausted'));
  throw new Error('CJ call failed after retries');
}

// ── Existing ──
async function loadExistingIds() {
  const { rows } = await pool.query('SELECT cj_product_id FROM products WHERE cj_product_id IS NOT NULL');
  return new Set(rows.map((r) => String(r.cj_product_id)));
}

// ── 🩹 v3 — الفئات L3 المستهدفة من laclarc (slug matching) ──
async function fetchTargetL3Categories() {
  const { rows } = await pool.query(`
    SELECT id, name, slug, cj_category_id, parent_id
    FROM categories
    WHERE level = 3 AND cj_category_id IS NOT NULL
    ORDER BY slug ASC
  `);
  console.log(`   🌳 laclarc L3 categories: ${rows.length}`);

  const targets = rows.filter(cat => {
    const slug = (cat.slug || '').toLowerCase();
    return TARGET_ROOTS.some(root => slug.startsWith(root + '/') || slug.includes('/' + root + '/'));
  });

  console.log(`   🎯 فئات مستهدفة: ${targets.length}`);
  const byRoot = {};
  targets.forEach(t => {
    const root = t.slug.split('/')[0];
    byRoot[root] = (byRoot[root] || 0) + 1;
  });
  Object.keys(byRoot).forEach(r => console.log(`      ${r}: ${byRoot[r]} فئة`));

  return targets;
}

// ── معالجة منتج واحد ──
async function processItem(cjItem, cat, existing) {
  const productId = cjItem.pid ? String(cjItem.pid) : null;
  if (!productId) return;
  if (existing.has(productId)) { stats.skippedExisting++; return; }

  try {
    const detailRes = await callCJ('detail', (token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config, timeout: CFG.requestTimeoutMs, headers: { 'CJ-Access-Token': token },
        params: { pid: productId },
      })
    );
    const details = detailRes?.data;
    if (!details) { stats.errors++; return; }

    const reason = getIneligibilityReason(details, { ignoreBlacklist: false });
    if (reason) { stats.filtered++; bump(stats.filteredReasons, reason); return; }
    // 🆕 v3.1 — vendor quality filters (1.10 productDetail/query fields)
const disputeRate = parseFloat(details.qualityDisputeRate || '0');
const logisticsScore = parseFloat(details.logisticScore || '5');
const serviceScore = parseFloat(details.serviceScore || '5');
const excludedCountries = details.excludeCountries || [];

if (disputeRate > 0.05) {
  stats.filtered++;
  bump(stats.filteredReasons, 'supplier_dispute_rate_high');
  return;
}
if (logisticsScore < 3.5 || serviceScore < 3.5) {
  stats.filtered++;
  bump(stats.filteredReasons, 'supplier_score_low');
  return;
}

// 🩹 M#47 followup — excludeCountries فلتر
//   (laclarc يبيع عالمياً — إلا CJ ما يشحنش لدولة من excluded → نرفض)
//   ملاحظة: 1.10 كيرجع `excludeCountries` كـ array — مثلاً ["RU"]
//   إلا المنتج مستثنى من دولة target، نرفضو
//   (laclarc targets = 222 دولة CJ-verified — إلا excluded يشمل واحدة → exclude)

// حالياً — نتفقدو الشائعة (RU · CN · ...):
if (excludedCountries.includes('RU') || excludedCountries.includes('IR')) {
  // 🩹 مثال — إلا بغيتي تحظر دول معينة
  stats.filtered++;
  bump(stats.filteredReasons, 'excluded_country');
  return;
}

// 📝 unsold flag — 📋 Backlog للـ audit:
if (String(details.isUnsold) === '1') {
  issues.push('unsold_product');
}

    const productRow = await buildProductRow(details, {
      fallbackCategoryId: cat.cj_category_id || details.categoryId || null,
      fetchVideo: false, videoApiFallback: false, isSourced: false,
    });
    if (!productRow) { stats.filtered++; bump(stats.filteredReasons, 'unknown'); return; }

    const issues = auditProductRow(productRow);
    issues.forEach((i) => bump(stats.warnings, i));

    if (!DRY_RUN) await upsertProductRow(pool, productRow);
    existing.add(productId);
    stats.imported++;

    if (stats.imported % 25 === 0) {
      console.log(`✅ total=${stats.imported} | pts=${stats.points} | filtered=${stats.filtered}`);
    }
    if (CFG.maxProducts && stats.imported >= CFG.maxProducts) throw new StopSync('MAX_PRODUCTS');
  } catch (e) {
    if (e instanceof StopSync) throw e;
    stats.errors++;
    console.log(`⚠️ ${productId}: ${safeLog(e.message)}`);
  }
}

// ── 🩹 v3 — استيراد فئة L3 كاملة (بمعاملات الجودة) ──
async function importCategory(l3Cat, existing) {
  console.log(`\n📦 [${l3Cat.slug}] ${l3Cat.name} | pts=${stats.points}`);

  let importedCount = 0;
  const maxPages = Math.ceil(6000 / CFG.pageSize);   // CJ 6000 max

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (stopRequested) return importedCount;

    let body;
    try {
      body = await callCJ('list', (token, config) =>
        axios.get(`${CJ_API}/product/list`, {
          ...config, timeout: CFG.requestTimeoutMs, headers: { 'CJ-Access-Token': token },
          params: {
            categoryId: l3Cat.cj_category_id,
            pageNum, 
            pageSize: CFG.pageSize,                    // 🩹 v3 — 200 max (أسرع 10×)
            // 🆕 v3 — معاملات الجودة:
            verifiedWarehouse: CFG.verifiedOnly ? 1 : undefined,  // inventory مؤكد
            minListedNum: CFG.minListedNum,                        // منتجات مثبتة شعبية
          },
        })
      );
    } catch (e) {
      if (e instanceof StopSync) throw e;
      stats.errors++;
      console.error(`❌ list error [${l3Cat.slug}] p${pageNum}: ${safeLog(e.message)}`);
      return importedCount;
    }

    const list = body?.data?.list || [];
    const total = body?.data?.total || 0;
    stats.pages++;

    if (list.length === 0) break;

    console.log(`   📄 p${pageNum}: ${list.length} منتجات`);

    for (const cjItem of list) {
      await processItem(cjItem, l3Cat, existing);
    }

    if (total ? pageNum * CFG.pageSize >= total : list.length < CFG.pageSize) break;
  }

  console.log(`🏁 [${l3Cat.slug}] done — ${importedCount} مستورد`);
  return importedCount;
}

// ── Main ──
async function run() {
  const startedAt = Date.now();
  const state = loadState();
  const pricing = getPricingConfig();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎯 Mass Targeted v3 — ${TARGET_ROOTS.length} فئة مستهدفة`);
  console.log(`💰 margin=${(pricing.margin * 100).toFixed(0)}% floor=$${pricing.floor}`);
  console.log(`⚙️  pageSize=${CFG.pageSize} · minListedNum=${CFG.minListedNum} · verified=${CFG.verifiedOnly}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    const existing = await loadExistingIds();
    console.log(`🗂️  ${existing.size} موجدين (skip=${CFG.skipExisting})\n`);

    const targetL3Cats = await fetchTargetL3Categories();
    if (targetL3Cats.length === 0) { console.error('❌ صفر فئات'); return; }

    const pending = targetL3Cats.filter(c => !state.done.includes(c.cj_category_id));
    console.log(`\n📋 باقية: ${pending.length}\n`);

    for (const l3Cat of pending) {
      if (stopRequested) break;
      await importCategory(l3Cat, existing);
      state.done.push(l3Cat.cj_category_id);
      saveState(state);
    }

    console.log(`\n🏁 اكتملت.`);
  } catch (err) {
    if (err instanceof StopSync) {
      console.log(`\n⏸️  توقف: ${err.reason}`);
    } else { console.error('❌ Fatal:', err.message); }
  } finally {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 imported=${stats.imported} | filtered=${stats.filtered} | errors=${stats.errors}`);
    console.log(`📊 pts≈${stats.points} | ${mins} min`);
    if (Object.keys(stats.filteredReasons).length) console.log('🚫:', stats.filteredReasons);
    console.log(`${'='.repeat(60)}\n`);
  }
}

process.on('SIGINT', () => { console.log('\n🛑 SIGINT'); stopRequested = true; });

run();