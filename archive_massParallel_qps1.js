// massParallel.js - Laclarc Mass Sync — Parallel Workers (v4)
// ============================================================
// الهدف: تعمير 578 فئة بأسرع وقت — نفس القانون التجاري v3.1 (فلاتر · تسعير · checkpoint)
//   • N workers متوازية — كل وحدة queue فئات مستقلة
//   • QPS لكل worker = 0.8 (sleep 1250ms) → 4 workers ≈ 3.2 req/s إجمالي
//   • breaker مشترك · checkpoint لكل فئة · صفر تصادم (upsert يحمي)
//   • 🆕 resume دقيق: الفئة الجارية كتستأنف من صفحتها (مثل الأحادي)
// تشغيل:  SYNC_WORKERS=4 node massParallel.js
// probe:  SYNC_WORKERS=2 SYNC_MAX_PRODUCTS=100 node massParallel.js
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
  workers: (() => { const v = parseInt(process.env.SYNC_WORKERS, 10); return Number.isFinite(v) && v >= 1 && v <= 8 ? v : 4; })(),
  sleepMs: parseInt(process.env.SYNC_SLEEP_MS, 10) || 1250,
  pageSize: parseInt(process.env.SYNC_PAGE_SIZE, 10) || 20,
  maxPagesPerCategory: parseInt(process.env.SYNC_MAX_PAGES, 10) || 500,
  maxProducts: parseInt(process.env.SYNC_MAX_PRODUCTS, 10) || 0,
  pointsBudget: (() => { const v = parseInt(process.env.SYNC_POINTS_BUDGET, 10); return Number.isFinite(v) ? v : 0; })(),
  requestTimeoutMs: 20000,
  skipExisting: process.env.SYNC_SKIP_EXISTING !== 'false',
  ignoreBlacklist: process.env.SYNC_IGNORE_BLACKLIST === 'true',
  stateFile: path.join(__dirname, 'massParallel.state.json'),
  breakerThreshold: 8,
  breakerCooldownMs: 60000,
  breakerMaxTrips: 2,
};

const COST = { list: 50, detail: 10 };
const stats = { points: 0, imported: 0, skippedExisting: 0, filtered: 0, errors: 0, pages: 0, filteredReasons: {}, warnings: {} };
let stopRequested = false;

class StopSync extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const safeLog = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

// ── Breaker مشترك + budget ──
const breaker = { fails: 0, trips: 0 };
async function callCJ(kind, requestFn, workerId) {
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
      if (code === 1600201 || code === 16900500 || /insufficient api points|quota/i.test(msg)) throw new StopSync('POINTS_EXHAUSTED');
      if (code === 1600200 || res?.status === 429) {
        console.warn(`⏳ [W${workerId}] 429 — global backoff ${8 * attempt}s`);
        await sleep(8000 * attempt);
        continue;
      }
      if (code !== undefined && (Number.isNaN(code) || (code !== 200 && code !== 0))) throw new Error(`CJ code=${body?.code} ${msg}`);
      breaker.fails = 0;
      return body;
    } catch (e) {
      if (e instanceof StopSync) throw e;
      if (e.response?.status === 429) { await sleep(8000 * attempt); continue; }
      const st = e.response?.status;
      if (st && st >= 400 && st < 500) throw e;
      breaker.fails++;
      if (breaker.fails >= CFG.breakerThreshold) {
        breaker.trips++;
        if (breaker.trips > CFG.breakerMaxTrips) throw new StopSync('CIRCUIT_BREAKER');
        console.warn(`🔌 [W${workerId}] breaker #${breaker.trips} — cooling ${CFG.breakerCooldownMs / 1000}s`);
        await sleep(CFG.breakerCooldownMs);
        breaker.fails = 0;
      }
      if (attempt === 3) throw e;
    }
  }
  throw new Error('CJ call failed after retries');
}

// ── Checkpoint: per-category ──
function loadState() {
  if (DRY_RUN) return { done: {}, inProgress: {} };
  try {
    const s = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    return { done: s.done || {}, inProgress: s.inProgress || {} };
  } catch { return { done: {}, inProgress: {} }; }
}
function saveState(state) {
  if (DRY_RUN) return;
  try {
    fs.writeFileSync(`${CFG.stateFile}.tmp`, JSON.stringify(state));
    fs.renameSync(`${CFG.stateFile}.tmp`, CFG.stateFile);
  } catch (e) { console.error('⚠️ checkpoint:', e.message); }
}
function clearState() { if (DRY_RUN) return; try { fs.unlinkSync(CFG.stateFile); } catch {} }

async function loadExistingIds() {
  const { rows } = await pool.query('SELECT cj_product_id FROM products WHERE cj_product_id IS NOT NULL');
  return new Set(rows.map((r) => String(r.cj_product_id)));
}

// ── منتج واحد — نفس منطق v3.1 بالحرف ──
async function processItem(cjItem, cat, existing, workerId) {
  const productId = cjItem.pid ? String(cjItem.pid) : null;
  if (!productId) return;
  if (existing.has(productId)) { stats.skippedExisting++; return; }
  try {
    const body = await callCJ('detail', (token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config, timeout: CFG.requestTimeoutMs, headers: { 'CJ-Access-Token': token },
        params: { pid: productId },
      }), workerId);
    const details = body?.data;
    if (!details) { stats.errors++; return; }
    const reason = getIneligibilityReason(details, { ignoreBlacklist: CFG.ignoreBlacklist });
    if (reason) { stats.filtered++; bump(stats.filteredReasons, reason); return; }
    const productRow = await buildProductRow(details, {
      fallbackCategoryId: details.categoryId || cat.id || null,
      fetchVideo: false, videoApiFallback: false,
      ignoreBlacklist: CFG.ignoreBlacklist, isSourced: false,
    });
    if (!productRow) { stats.filtered++; bump(stats.filteredReasons, 'unknown'); return; }
    const issues = auditProductRow(productRow);
    issues.forEach((i) => bump(stats.warnings, i));
    if (!DRY_RUN) await upsertProductRow(pool, productRow);
    existing.add(productId);
    stats.imported++;
    if (stats.imported % 50 === 0) console.log(`✅ total=${stats.imported} | pts=${stats.points} | filter=${stats.filtered}`);
    if (CFG.maxProducts && stats.imported >= CFG.maxProducts) throw new StopSync('MAX_PRODUCTS');
  } catch (e) {
    if (e instanceof StopSync) throw e;
    stats.errors++;
    console.log(`⚠️ [W${workerId}] ${productId}: ${safeLog(e.message)}`);
  }
}

// ── Worker loop — فئات من queue ديالو ──
async function workerLoop(workerId, queue, existing, state) {
  for (const cat of queue) {
    if (stopRequested) return;
    const key = cat.id ?? 'ALL';
    if (state.done[key]) continue;
    const startPage = (state.inProgress[key]?.workerId === workerId) ? (state.inProgress[key].page || 1) : 1;
    let ok = true;

    for (let pageNum = startPage; pageNum <= CFG.maxPagesPerCategory; pageNum++) {
      if (stopRequested) { state.inProgress[key] = { workerId, page: pageNum }; saveState(state); return; }
      let body;
      try {
        body = await callCJ('list', (token, config) =>
          axios.get(`${CJ_API}/product/list`, {
            ...config, timeout: CFG.requestTimeoutMs, headers: { 'CJ-Access-Token': token },
            params: { pageNum, pageSize: CFG.pageSize, ...(cat.id ? { categoryId: cat.id } : {}) },
          }), workerId);
      } catch (e) {
        if (e instanceof StopSync) { state.inProgress[key] = { workerId, page: pageNum }; saveState(state); throw e; }
        stats.errors++; ok = false;
        console.error(`❌ [W${workerId}] list [${cat.name}] p${pageNum}: ${safeLog(e.message)}`);
        break;
      }
      const list = body?.data?.list || [];
      const total = body?.data?.total || 0;
      stats.pages++;
      state.inProgress[key] = { workerId, page: pageNum };
      if (pageNum % 5 === 0) saveState(state);
      if (list.length === 0) break;
      for (const cjItem of list) await processItem(cjItem, cat, existing, workerId);
      if (total ? pageNum * CFG.pageSize >= total : list.length < CFG.pageSize) break;
    }
    if (ok) {
      state.done[key] = { workerId, at: new Date().toISOString() };
      delete state.inProgress[key];
      saveState(state);
      console.log(`🏁 [W${workerId}] done: ${cat.name} (${Object.keys(state.done).length} total)`);
    }
  }
}

// ── Main ──
async function run({ standalone = true } = {}) {
  const startedAt = Date.now();
  let exitCode = 0;
  const state = loadState();
  const pricing = getPricingConfig();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Mass Parallel — ${CFG.workers} workers | pts ${CFG.pointsBudget > 0 ? CFG.pointsBudget : 'UNLIMITED (tracker)'}${DRY_RUN ? ' | 🧪 DRY' : ''}`);
  console.log(`💰 margin=${(pricing.margin * 100).toFixed(0)}% floor=$${pricing.floor} ship=$${pricing.shipBaseUsd}+${pricing.shipPerKgUsd}/kg`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    const existing = await loadExistingIds();
    console.log(`🗂️  ${existing.size} موجدين (skip=${CFG.skipExisting})`);
    if (!DRY_RUN) {
      try {
        await sleep(1200);
        const r = await syncCategoriesFromCJ();
        console.log(`🌳 Categories: L1=${r.level1Count} L2=${r.level2Count} L3=${r.level3Count}`);
      } catch (e) { console.warn(`⚠️ category sync: ${e.message}`); }
    }

    const catsBody = await callCJ('list', (token, config) =>
      axios.get(`${CJ_API}/product/getCategory`, { ...config, timeout: CFG.requestTimeoutMs, headers: { 'CJ-Access-Token': token } }), 0);
    const categories = [];
    for (const l1 of catsBody?.data || [])
      for (const l2 of l1.categoryFirstList || [])
        for (const l3 of l2.categorySecondList || [])
          if (l3.categoryId) categories.push({ id: String(l3.categoryId), name: l3.categoryName });
    if (!categories.length) throw new Error('No categories');

    const pending = categories.filter((c) => !state.done[c.id]);
    console.log(`🗂️  ${categories.length} فئة | ${pending.length} باقية | ${Object.keys(state.done).length} مكتملة`);

    // round-robin توزيع
    const queues = Array.from({ length: CFG.workers }, () => []);
    pending.forEach((cat, i) => queues[i % CFG.workers].push(cat));
    queues.forEach((q, i) => console.log(`   W${i}: ${q.length} فئة`));

    await Promise.all(queues.map((q, i) => workerLoop(i, q, existing, state)));

    clearState();
    console.log('\n🏁 كل الفئات اكتملت.');
  } catch (err) {
    if (err instanceof StopSync) {
      const hints = { POINTS_BUDGET: 'budget', POINTS_EXHAUSTED: 'CJ نقاط سالات', CIRCUIT_BREAKER: 'breaker', MAX_PRODUCTS: 'حد منتجات', SIGINT: 'يدوي' };
      console.log(`\n⏸️  توقف: ${hints[err.reason] || err.reason} — checkpoint محفوظ، عاود نفس الأمر`);
    } else { console.error('❌ Fatal:', err.message); exitCode = 1; }
  } finally {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 imported=${stats.imported} | skipped=${stats.skippedExisting} | filtered=${stats.filtered} | errors=${stats.errors}`);
    console.log(`📊 pages=${stats.pages} | pts≈${stats.points} | ${mins} min | workers=${CFG.workers}`);
    if (Object.keys(stats.filteredReasons).length) console.log('🚫:', stats.filteredReasons);
    if (Object.keys(stats.warnings).length) console.log('⚠️:', stats.warnings);
    console.log(`${'='.repeat(60)}\n`);
    if (standalone) { try { await pool.end(); } catch {} process.exit(exitCode); }
  }
  return { ...stats };
}

process.on('SIGINT', () => { console.log('\n🛑 SIGINT — checkpoint...'); stopRequested = true; });
module.exports = { run };
if (require.main === module) run({ standalone: true });