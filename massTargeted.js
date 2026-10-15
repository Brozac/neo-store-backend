// massTargeted.js - Laclarc Targeted Category Importer (v1.3 FINAL)
// ============================================================
// 🎯 المهمة: تعمير الفئات الثلاثة الفارغة كاملة بجميع أقسامها
//   • automobiles-and-motorcycles
//   • computer-and-office
//   • sports-and-outdoors
// ============================================================
// 🩹 v1.3 — laclarc slug = leaf-only (بلا parent path)
//           → JOIN على parent_id chain = الـ L1 slug الحقيقي
//           → فلتر بالـ L1 slug (موثوق بالبرهان)
// v1.1 — دفاعي: CJ shapes متعددة (categoryName/name/...)
// v3.1 — فلاتر الجودة · skipExisting · checkpoint · breaker
// ============================================================
// التشغيل:
//   node massTargeted.js
//   SYNC_DRY_RUN=true node massTargeted.js
//   SYNC_MAX_PAGES=100 node massTargeted.js
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

// 🎯 الفئات الهدف — L1 slugs (مؤكدة من categories table)
const TARGET_ROOTS = [
  'automobiles-and-motorcycles',
  'computer-and-office',
  'sports-and-outdoors',
];

const CFG = {
  pageSize: parseInt(process.env.SYNC_PAGE_SIZE, 10) || 20,
  maxPagesPerCategory: parseInt(process.env.SYNC_MAX_PAGES, 10) || 50,  // 🎯 عمق كامل
  maxProducts: parseInt(process.env.SYNC_MAX_PRODUCTS, 10) || 0,
  pointsBudget: (() => {
    const v = parseInt(process.env.SYNC_POINTS_BUDGET, 10);
    return Number.isFinite(v) ? v : 0;  // 0 = unlimited
  })(),
  sleepMs: parseInt(process.env.SYNC_SLEEP_MS, 10) || 2000,  // QPS=1 آمن (Free tier)
  requestTimeoutMs: 20000,
  skipExisting: process.env.SYNC_SKIP_EXISTING !== 'false',
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
        console.warn(`🔌 breaker #${breaker.trips} — ${CFG.breakerCooldownMs / 1000}s`);
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

// ── 🩹 v1.3 — الفئات المستهدفة عبر JOIN على parent hierarchy ──
//    laclarc slug = leaf-only → JOIN هو الطريقة الصحيحة للحصول على الـ L1 slug الحقيقي
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

  // فلتر — الـ L1 slug يطابق أحد الـ targets (exact match)
  const targets = rows.filter(cat => {
    const l1Slug = (cat.l1_slug || '').toLowerCase();
    return TARGET_ROOTS.some(root => l1Slug === root);
  });

  console.log(`   🎯 فئات مستهدفة: ${targets.length}`);
  const byRoot = {};
  targets.forEach(t => {
    byRoot[t.l1_slug] = (byRoot[t.l1_slug] || 0) + 1;
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
    const body = await callCJ('detail', (token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config, timeout: CFG.requestTimeoutMs, headers: { 'CJ-Access-Token': token },
        params: { pid: productId },
      })
    );
    const details = body?.data;
    if (!details) { stats.errors++; return; }

    const reason = getIneligibilityReason(details, { ignoreBlacklist: false });
    if (reason) { stats.filtered++; bump(stats.filteredReasons, reason); return; }

    const productRow = await buildProductRow(details, {
      fallbackCategoryId: details.categoryId || cat.cj_category_id || null,
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

// ── مزامنة فئة كاملة ──
async function syncCategory(cat, existing) {
  console.log(`\n📦 [${cat.l1_name} / ${cat.name}] | pts=${stats.points}`);

  for (let pageNum = 1; pageNum <= CFG.maxPagesPerCategory; pageNum++) {
    if (stopRequested) return;

    let body;
    try {
      body = await callCJ('list', (token, config) =>
        axios.get(`${CJ_API}/product/list`, {
          ...config, timeout: CFG.requestTimeoutMs, headers: { 'CJ-Access-Token': token },
          params: { pageNum, pageSize: CFG.pageSize, categoryId: cat.cj_category_id },
        })
      );
    } catch (e) {
      if (e instanceof StopSync) throw e;
      stats.errors++;
      console.error(`❌ list error [${cat.name}] p${pageNum}: ${safeLog(e.message)}`);
      return;
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
  console.log(`🏁 [${cat.name}] done`);
}

// ── Main ──
async function run() {
  const startedAt = Date.now();
  const state = loadState();
  const pricing = getPricingConfig();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎯 Mass Targeted Importer — ${TARGET_ROOTS.length} فئة مستهدفة`);
  console.log(`   ${TARGET_ROOTS.join(' · ')}`);
  console.log(`💰 margin=${(pricing.margin * 100).toFixed(0)}% floor=$${pricing.floor}${DRY_RUN ? ' | 🧪 DRY' : ''}`);
  console.log(`⚙️  sleep=${CFG.sleepMs}ms · maxPages=${CFG.maxPagesPerCategory}/فئة · budget=${CFG.pointsBudget || '∞'}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    const existing = await loadExistingIds();
    console.log(`🗂️  ${existing.size} موجدين (skip=${CFG.skipExisting})\n`);

    // 1) الفئات المستهدفة عبر JOIN hierarchy (v1.3)
    const targetCats = await fetchTargetCategories();

    if (targetCats.length === 0) {
      console.error(`\n❌ صفر فئات مستهدفة — تحقق من TARGET_ROOTS أو laclarc categories`);
      return;
    }

    // 2) فلتر done — بـ cj_category_id
    const pending = targetCats.filter(c => !state.done.includes(c.cj_category_id));
    console.log(`\n📋 باقية: ${pending.length} (done: ${targetCats.length - pending.length})\n`);

    // 3) معالجة كل فئة
    let done = 0;
    for (const cat of pending) {
      if (stopRequested) break;
      await syncCategory(cat, existing);
      state.done.push(cat.cj_category_id);
      saveState(state);
      done++;
    }

    console.log(`\n🏁 اكتملت — ${done} فئة.`);
  } catch (err) {
    if (err instanceof StopSync) {
      console.log(`\n⏸️  توقف: ${err.reason} — checkpoint محفوظ`);
    } else {
      console.error('❌ Fatal:', err.message);
    }
  } finally {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 imported=${stats.imported} | skipped=${stats.skippedExisting} | filtered=${stats.filtered} | errors=${stats.errors}`);
    console.log(`📊 pages=${stats.pages} | pts≈${stats.points} | ${mins} min`);
    if (Object.keys(stats.filteredReasons).length) console.log('🚫:', stats.filteredReasons);
    if (Object.keys(stats.warnings).length) console.log('⚠️:', stats.warnings);
    console.log(`${'='.repeat(60)}\n`);
  }
}

process.on('SIGINT', () => { console.log('\n🛑 SIGINT'); stopRequested = true; });

run();