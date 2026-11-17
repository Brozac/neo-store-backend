#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   apply-f105.js — F#105 EGRESS FIX KIT  v2.1
   ═══════════════════════════════════════════════════════════════════════════
   الهدف: تخفيض egress ديال Supabase (6.57GB/شهر ← تحت 5GB)

   الإصلاحات:
     R1  PDP SELECT * → projection متحقق من قاعدة البيانات + LEFT(description,4000)
         (~880MB/شهر من الـ egress — الاستعلامات بـ id=$1 فقط، مسارات admin كتتخطى)
     R2  /related in-memory cache (600k استدعاء/شهر كانوا بلا أي تخزين مؤقت)
     R4  f105-truncate-descriptions.sql — قص الوصف الزائد (يدوي، بلا تنفيذ آلي)
     R3  (backlog — بلا كود): feed md5 query 11.7s — يحتاج تحسين يدوي

   الاستعمال:
     node apply-f105.js server.js              ← DRY-RUN: فحص + تقرير، بلا تعديل
     node apply-f105.js server.js --apply      ← تطبيق فعلي (مع backup)
     node apply-f105.js server.js --apply --db "postgres://..."   ← فرض رابط DB

   المخرجات (فـ مجلد server.js):
     f105-scan-report.txt             ← دوماً (حتى فـ dry-run)
     f105-truncate-descriptions.sql   ← دوماً (تنفيذه يدوي فـ Supabase SQL Editor)
     server.js.pre-f105.bak           ← فقط مع --apply

   كل إصلاح مستقل: فشل واحد ما كيوقفش الباقي.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIT_VERSION = '2.1';
const MARK_R1 = 'F105:[R1]';
const MARK_R2 = 'F105:[R2]';
const MARK_TOP = 'F#105 egress kit';
const DESC_CAP = 4000;          // LEFT(description, N)
const FAT_EXCLUDE_BYTES = 8192; // نص بحجم متوسط أكبر من هادا → يتقصى من projection (ماشي فـ FORCE)
const FORCE_COLUMNS = new Set([
  'id', 'slug', 'name', 'title', 'price', 'sale_price', 'compare_price', 'old_price',
  'category', 'subcategory', 'images', 'variants', 'colors', 'sizes', 'brand',
  'rating', 'rating_average', 'reviews_count', 'stock', 'inventory', 'active',
  'is_active', 'published', 'created_at', 'updated_at',
  'cj_product_id', 'seo_title', 'seo_meta_description',
]);
const SAMPLE_TYPES = ['text', 'character varying', 'character', 'json', 'jsonb'];

/* ── CLI ─────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const args = { target: 'server.js', apply: false, db: null };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--db=')) args.db = a.slice(5);
    else if (a === '--db') { /* next arg handled below */ }
    else if (!a.startsWith('--')) args.target = a;
  }
  // handle: --db <url>
  const i = argv.indexOf('--db');
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) args.db = argv[i + 1];
  return args;
}

function maskUrl(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.hostname}${x.port ? ':' + x.port : ''}${x.pathname}`;
  } catch { return '(unparsable-host-masked)'; }
}

function lineOf(content, idx) { return content.slice(0, idx).split('\n').length; }

/* ── DB access (lazy — used only by R1 verification + R4 count) ──────────── */
async function resolveDbUrl(args, targetDir) {
  if (args.db) return args.db;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(targetDir, '.env');
  try {
    if (fs.existsSync(envPath)) {
      const txt = fs.readFileSync(envPath, 'utf8');
      const m = txt.match(/^DATABASE_URL\s*=\s*["']?([^"'\n\r]+)["']?\s*$/m);
      if (m) return m[1].trim();
    }
  } catch { /* ignore */ }
  return null;
}

class DB {
  constructor(url) { this.url = url; this.pool = null; }
  async connect() {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: this.url,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 15000,
      statement_timeout: 45000,
      application_name: 'f105-kit',
    });
    await this.pool.query('SELECT 1');
  }
  async columns() {
    const { rows } = await this.pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'products' ORDER BY ordinal_position`);
    return rows;
  }
  async avgSize(colName) {
    const q = `SELECT COALESCE(avg(pg_column_size("${colName}")), 0)::int AS avg
               FROM (SELECT "${colName}" FROM products TABLESAMPLE SYSTEM (10)) s`;
    const { rows } = await this.pool.query(q);
    return Number(rows[0] && rows[0].avg) || 0;
  }
  async descOversizedCount() {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM products WHERE length(description) > ${DESC_CAP}`);
    return Number(rows[0] && rows[0].n);
  }
  async end() { try { if (this.pool) await this.pool.end(); } catch { /* noop */ } }
}

/* ── R1 scan: كل مكان فيه SELECT * FROM products ─────────────────────────── */
function scanRouteRegistrations(content) {
  const re = /\b(?:app|router)\s*\.\s*(?:get|post|put|patch|delete|use|all)\s*\(\s*(['"])([^'"]*)\1/g;
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) out.push({ idx: m.index, path: m[2] });
  return out;
}

function scanSelectStar(content, routes) {
  const re = /SELECT\s+\*\s+FROM\s+(?:public\.)?products\b/gi;
  const occs = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const idx = m.index;
    const window = content.slice(idx, idx + 500);            // ما بعد التطابق

    // أقرب تسجيل مسار قبل الاستعلام — هو اللي كيحدد واش الاستعلام فـ handler ديال admin
    let nearest = null;
    for (const r of routes) { if (r.idx < idx) nearest = r; else break; }
    const gapLines = nearest
      ? content.slice(nearest.idx, idx).split('\n').length
      : Infinity;

    // ═══ حدود الاستعلام: من التطابق حتى أول ';' (نهاية query('…');) — يمنع تلوث الاستعلام التالي ═══
    const stmt = window.split(';')[0] || '';
    const isIdWhere = /WHERE[\s\S]{0,160}?\bid\s*=\s*\$\d+/i.test(stmt);
    // فحص JOIN محصور بالـ SQL ديال هاد الاستعلام — ما كيديرش النافذة الطويلة
    const stmtHead = stmt.split(/WHERE/i)[0];
    const hasJoin = /JOIN\b/i.test(stmtHead);

    let cls;
    if (!nearest) cls = 'UNKNOWN-SKIP';                 // بلا route مرئي — أمان
    else if (/admin/i.test(nearest.path)) cls = 'ADMIN-SKIP';
    else if (gapLines > 30) cls = 'HELPER-SKIP';        // بعيد على أي مسار — helper مشترك، أمان
    else if (hasJoin) cls = 'JOIN-SKIP';
    else if (isIdWhere) cls = 'PDP';
    else cls = 'LIST';

    const snipStart = Math.max(0, idx - 80);
    const snippet = content.slice(snipStart, idx + 160).replace(/\s+/g, ' ').trim();
    occs.push({
      idx, matchLen: m[0].length, line: lineOf(content, idx),
      cls, near: nearest ? `${nearest.path} (-${gapLines}l)` : '-',
      snippet: snippet.slice(0, 200),
    });
  }
  return occs;
}

function buildProjection(cols) {
  const parts = [], excluded = [], truncated = [];
  for (const c of cols) {
    const name = c.column_name || c.name;
    const type = c.data_type || c.type || '';
    if (!name) continue;
    if (name === 'description') {
      parts.push(`LEFT("description", ${DESC_CAP}) AS "description"`);
      truncated.push(`description → LEFT(…,${DESC_CAP})`);
      continue;
    }
    if (SAMPLE_TYPES.includes(type) && !FORCE_COLUMNS.has(name)) {
      const sz = c._avg;
      if (typeof sz === 'number' && sz > FAT_EXCLUDE_BYTES) {
        excluded.push(`${name} (avg ${sz}B)`);
        continue;
      }
    }
    parts.push(`"${name}"`);
  }
  // ⚠️ سطر واحد — الحقن كيوقع داخل JS string literals، والسطر الجديد الحقيقي كيكسر الـ syntax
  return { sql: parts.join(', '), excluded, truncated, count: parts.length };
}

/* ── R2 scan: تسجيلات مسارات /related ────────────────────────────────────── */
function scanRelatedRoutes(content) {
  const re = /\b(app|router)\s*\.\s*(get|use|all)\s*\(\s*(['"])([^'"]*related[^'"]*)\3/gi;
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({
      idx: m.index, line: lineOf(content, m.index),
      varName: m[1], method: m[2].toLowerCase(), routePath: m[4],
      snippet: content.slice(m.index, m.index + 120).replace(/\s+/g, ' '),
    });
  }
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildR2Middleware(varName, routePath) {
  let urlReLine;
  const stripped = routePath.replace(/:[^/]*/g, '').replace(/\/{2,}/g, '/');
  const base = stripped.length > 1 ? stripped.replace(/\/+$/, '') : stripped;
  if (base.startsWith('/')) {
    urlReLine = `const F105_RELATED_URL_RE = new RegExp('^' + ${JSON.stringify(escapeRe(base))} + '(\\\\/|$)');`;
  } else {
    // مسار نصب على router فرعي بلا "/" — اعتماد containment
    urlReLine = `const F105_RELATED_URL_RE = new RegExp(${JSON.stringify(escapeRe(base))});`;
  }
  return [
    `// ═══ ${MARK_R2} /related in-memory cache — egress fix ═══`,
    `// كانت 600k استدعاء/شهر على DB بلا أي تخزين مؤقت — هاد الـ middleware`,
    `// كيخدم GET المكرر من ذاكرة LRU (TTL ساعة، caps 2000 مدخل ≈ 40MB)`,
    `// وكيتخزن غير HTTP 200. التحقق: curl -D - مرتين → X-F105-Cache: HIT`,
    `const F105_RELATED_TTL_MS = Number(process.env.RELATED_CACHE_TTL_MS || 3600000);`,
    `const F105_RELATED_MAX = 2000;`,
    `const f105RelatedCache = new Map();`,
    `${varName}.use((req, res, next) => {`,
    `  if (req.method !== 'GET') return next();`,
    `  const url = req.originalUrl || req.url || '';`,
    `  if (!F105_RELATED_URL_RE.test(url)) return next();`,
    `  const hit = f105RelatedCache.get(url);`,
    `  if (hit && (Date.now() - hit.t) < F105_RELATED_TTL_MS) {`,
    `    f105RelatedCache.delete(url); f105RelatedCache.set(url, hit);`,
    `    res.set('X-F105-Cache', 'HIT');`,
    `    return res.status(200).json(hit.body);`,
    `  }`,
    `  const f105OrigJson = res.json.bind(res);`,
    `  res.json = (body) => {`,
    `    try {`,
    `      if (res.statusCode === 200 && body && typeof body === 'object') {`,
    `        if (f105RelatedCache.size >= F105_RELATED_MAX) f105RelatedCache.delete(f105RelatedCache.keys().next().value);`,
    `        f105RelatedCache.set(url, { t: Date.now(), body });`,
    `      }`,
    `    } catch (e) { /* cache must never break a response */ }`,
    `    res.set('X-F105-Cache', 'MISS');`,
    `    return f105OrigJson(body);`,
    `  };`,
    `  next();`,
    `});`,
    urlReLine,
    `// ═══ نهاية F105:[R2] ═══`,
  ].join('\n');
}

/* ── R4 SQL ──────────────────────────────────────────────────────────────── */
function buildTruncateSql(liveCount) {
  const n = (typeof liveCount === 'number')
    ? `${liveCount} (count حي من قاعدة البيانات)`
    : '15,524 (تقدير التشخيص F#105 — >2000 حرف؛ حد >4000 غادي يكون أصغر)';
  return [
    `-- ═══ F105 R4 — قص ذيل الوصف الزائد (فواضل الاستيراد) ═══`,
    `-- التشخيص: 15,524 منتج description > 2000 حرف، أقصى واحد 89,112 حرف.`,
    `-- الحد هنا: > ${DESC_CAP} حرف ← كيتقص لـ ${DESC_CAP}. العرض آمن؛ SEO كيقرا من`,
    `-- seo_title / seo_meta_description (أعمدة منفصلة). الاسترجاع: غير عبر massSync.`,
    `-- عدد السطور المتوقع: ${n}`,
    ``,
    `-- 1) معاينة (شغلها أولاً):`,
    `SELECT count(*) AS oversized FROM products WHERE length(description) > ${DESC_CAP};`,
    `SELECT id, name, length(description) AS len`,
    `FROM products WHERE length(description) > ${DESC_CAP}`,
    `ORDER BY len DESC LIMIT 10;`,
    ``,
    `-- 2) الإصلاح (شغله ملي تكون واجد — Supabase SQL Editor):`,
    `BEGIN;`,
    `UPDATE products SET description = LEFT(description, ${DESC_CAP}) WHERE length(description) > ${DESC_CAP};`,
    `COMMIT;`,
    ``,
    `-- من بعد: TOAST كيتخف (كان 117MB) وكل القراءات المستقبلية كيصغر egress ديالها.`,
  ].join('\n');
}

/* ── report helpers ──────────────────────────────────────────────────────── */
function ctxAround(content, idx, span = 220) {
  const s = Math.max(0, idx - 60);
  return content.slice(s, idx + span).replace(/\s+/g, ' ').trim().slice(0, 240);
}

/* ═══ MAIN ═════════════════════════════════════════════════════════════════ */
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const targetPath = path.resolve(process.cwd(), args.target);
  const targetDir = path.dirname(targetPath);
  const reportPath = path.join(targetDir, 'f105-scan-report.txt');
  const sqlPath = path.join(targetDir, 'f105-truncate-descriptions.sql');
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';

  const L = [];
  const log = (s) => { console.log(s); L.push(s); };
  const rep = (s) => L.push(s);

  log(`F#105 EGRESS KIT v${KIT_VERSION} — mode: ${mode}`);
  log(`target: ${targetPath}`);

  if (!fs.existsSync(targetPath)) {
    log(`[FAIL] الملف ماكاينش: ${targetPath}`);
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    process.exit(1);
  }
  const original = fs.readFileSync(targetPath, 'utf8');
  const sha = crypto.createHash('sha1').update(original).digest('hex').slice(0, 10);
  log(`size: ${original.length} bytes | sha1: ${sha}`);
  if (!/express|listen\(|router\./i.test(original)) {
    log('[WARN] الملف ما كيبانش server.js ديال Express — كمّل بحذر.');
  }
  const alreadyApplied = original.includes(MARK_TOP);
  if (alreadyApplied) rep(`[NOTE] هاد الملف تطبق عليه الكيت من قبل — العملية غادي تكون idempotent (اللي طبق ما كيتعاودش).`);

  let content = original;
  const edits = []; // {idx, matchLen, replacement}
  const results = { R1: '', R2: '', R4: '', R3: 'REPORT-ONLY (backlog)' };

  /* ── DB resolve ── */
  let db = null, dbStatus = 'NOT AVAILABLE';
  const dbUrl = await resolveDbUrl(args, targetDir);
  if (dbUrl) {
    try {
      db = new DB(dbUrl);
      await db.connect();
      dbStatus = `connected (${maskUrl(dbUrl)})`;
      log(`[OK] DB متصلة: ${maskUrl(dbUrl)}`);
    } catch (e) {
      db = null;
      dbStatus = `FAILED: ${e.message}`;
      log(`[WARN] DB ما قدراتش تتصل (${e.message}) — R1 غادي يتحول لـ NEEDS-DB`);
    }
  } else {
    log('[INFO] ما كاينش DATABASE_URL (--db / env / .env) — R1 يتحول لـ NEEDS-DB');
  }

  /* ═══ R1 — PDP projection ═══ */
  try {
    const routes = scanRouteRegistrations(content);
    const occs = scanSelectStar(content, routes);
    rep('');
    rep('═══ R1 — PDP column projection ═══');
    rep(`SELECT * FROM products — التطابقات: ${occs.length} | المسارات المسجلة: ${routes.length}`);
    for (const o of occs) {
      rep(`  line ${o.line} [${o.cls}] (قريب من: ${o.near}) …${o.snippet}`);
    }

    const pdps = occs.filter(o => o.cls === 'PDP');
    if (occs.length === 0) {
      results.R1 = 'SKIP (ماكاين حتى تطابق — يمكن طبق من قبل أو SQL مكتوب بطريقة أخرى)';
    } else if (pdps.length === 0) {
      results.R1 = 'REPORT-ONLY (كاين تطابقات ولكن والو مؤهل لـ PDP — شوف التقرير)';
    } else if (!db) {
      results.R1 = `NEEDS-DB (${pdps.length} مواقع مؤهلة — عاود شغّل بـ --db أو DATABASE_URL فـ .env)`;
    } else {
      const cols = await db.columns();
      if (!cols.length) {
        results.R1 = 'FAIL (جدول products ماكاينش فـ هاد الـ DB)';
      } else {
        for (const c of cols) {
          if (SAMPLE_TYPES.includes(c.data_type) && c.column_name !== 'description') {
            try { c._avg = await db.avgSize(c.column_name); } catch { c._avg = 0; }
          }
        }
        const proj = buildProjection(cols);
        rep(`  projection: ${proj.count} عمود | مقصوص: ${proj.truncated.join(', ') || 'والو'} | متقصى (كبار): ${proj.excluded.join(', ') || 'والو'}`);
        for (const o of pdps) {
          edits.push({
            idx: o.idx, matchLen: o.matchLen,
            replacement: `SELECT ${proj.sql} FROM products`,
          });
        }
        results.R1 = `READY (${pdps.length} استعلام غادي يتبدل)`;
        if (args.apply) results.R1 = `APPLIED (${pdps.length} استعلام تبدل)`;
        rep(`  [${args.apply ? 'APPLY' : 'DRY-RUN'}] ${results.R1}`);
      }
    }
    rep(`  الحالة: ${results.R1}`);
  } catch (e) {
    results.R1 = `FAIL: ${e.message}`;
    log(`[FAIL] R1: ${e.message}`);
  }

  /* ═══ R2 — /related cache ═══ */
  try {
    rep('');
    rep('═══ R2 — /related response cache ═══');
    if (content.includes(MARK_R2)) {
      results.R2 = 'SKIP (طبق من قبل — marker موجود)';
      rep(`  ${results.R2}`);
    } else {
      const routes = scanRelatedRoutes(content);
      for (const r of routes) rep(`  line ${r.line}: ${r.varName}.${r.method}('${r.routePath}')`);
      if (!routes.length) {
        results.R2 = 'NEEDS-MANUAL (ما لقيتش تسجيل مسار فيه كلمة related — شوف التقرير وعرّفني بالمسار)';
        rep(`  ${results.R2}`);
      } else {
        const first = routes[0];
        const mw = buildR2Middleware(first.varName, first.routePath);
        const lineStart = content.lastIndexOf('\n', first.idx) + 1;
        edits.push({ idx: lineStart, matchLen: 0, replacement: mw + '\n' });
        rep(`  الحقن قبل السطر ${lineOf(content, lineStart)} (${first.varName}.${first.method}('${first.routePath}'))`);
        if (routes.length > 1) rep(`  [NOTE] كاين ${routes.length - 1} تسجيلات أخرى لـ related — الكاش غطى الأول فقط.`);
        results.R2 = args.apply ? 'APPLIED (middleware محقون)' : `READY (غادي يتحقن قبل السطر ${lineOf(content, lineStart)})`;
        rep(`  [${args.apply ? 'APPLY' : 'DRY-RUN'}] ${results.R2}`);
      }
    }
    rep(`  الحالة: ${results.R2}`);
  } catch (e) {
    results.R2 = `FAIL: ${e.message}`;
    log(`[FAIL] R2: ${e.message}`);
  }

  /* ═══ R4 — truncate SQL (دوماً يتولد — التنفيذ يدوي) ═══ */
  try {
    rep('');
    rep('═══ R4 — truncate oversized descriptions (يدوي) ═══');
    let liveCount = null;
    if (db) {
      try { liveCount = await db.descOversizedCount(); }
      catch (e) { rep(`  [WARN] count حي فشل (${e.message}) — نعتمدو تقدير التشخيص`); }
    }
    fs.writeFileSync(sqlPath, buildTruncateSql(liveCount) + '\n');
    results.R4 = `SQL-GENERATED (${sqlPath}${liveCount !== null ? ` | ${liveCount} سطر متأثر` : ''})`;
    rep(`  ${results.R4}`);
  } catch (e) {
    results.R4 = `FAIL: ${e.message}`;
    log(`[FAIL] R4: ${e.message}`);
  }

  /* ═══ apply ═══ */
  let applied = false;
  if (args.apply && edits.length) {
    const sorted = edits.slice().sort((a, b) => b.idx - a.idx);
    for (const ed of sorted) {
      content = content.slice(0, ed.idx) + ed.replacement + content.slice(ed.idx + ed.matchLen);
    }
    if (!content.startsWith(`// ${MARK_TOP}`)) {
      content = `// ${MARK_TOP} v${KIT_VERSION} — applied ${new Date().toISOString()}\n` + content;
    }
    const bak = targetPath + '.pre-f105.bak';
    fs.copyFileSync(targetPath, bak);
    fs.writeFileSync(targetPath, content);
    applied = true;
    log(`[OK] التطبيق تم — backup: ${bak}`);
  } else if (args.apply && !edits.length) {
    log('[INFO] --apply ولكن والو تعديل واجد (كلشي SKIP ولا ديجا مطبق) — الملف ما تبدلش.');
  }

  /* ═══ report ═══ */
  rep('');
  rep('═══ الملخص ═══');
  rep(`mode: ${mode} | target: ${path.basename(targetPath)} | sha1: ${sha}`);
  rep(`R1 (PDP projection):  ${results.R1}`);
  rep(`R2 (/related cache):  ${results.R2}`);
  rep(`R4 (truncate SQL):    ${results.R4}`);
  rep(`R3 (feed md5 11.7s):  ${results.R3} — backlog يدوي`);
  rep(`DB: ${dbStatus}`);
  rep('');
  rep('═══ الخطوات الجاية ═══');
  rep('1) إلا كان mode=DRY-RUN و كلشي READY/READY: عاود شغّل بـ --apply');
  rep('2) إلا كان R1=NEEDS-DB: شغّل بـ --db "postgres://…" ولا تأكد .env فيه DATABASE_URL');
  rep('3) من بعد النشر: curl -D - -o /dev/null "https://<backend>/…/related/…"; مرتين — المرة الثانية خاصها X-F105-Cache: HIT');
  rep('4) شغّل f105-truncate-descriptions.sql يدوياً فـ Supabase SQL Editor');
  rep('5) راقب egress فـ Supabase Dashboard بعد 24-48 ساعة');
  rep('6) إلا كان شي NEEDS-MANUAL: صيفط ليا f105-scan-report.txt كامل وناظبط المراسي');
  fs.writeFileSync(reportPath, L.join('\n') + '\n');
  log(`report: ${reportPath}`);

  await (async () => { try { if (db) await db.end(); } catch { /* noop */ } })();
  process.exit(applied ? 0 : 0);
})();
