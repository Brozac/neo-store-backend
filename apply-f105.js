#!/usr/bin/env node
'use strict';
/*
====================================================================
 F#105 EGRESS KIT v2 — apply-f105.js
 الهدف: تخفيض Supabase DB egress (6.57GB/شهر => تحت الـ 5GB)

 R1  column projection : SELECT * => قائمة أعمدة صريحة (استعلامات LIST)
     — كيحذف description + variants من استعلامات القوائم فقط
     — PDP / :slug / :id / admin كيبقى كامل (صحة الواجهة قبل كلش)
     — القائمة كيتحسبها أوتوماتيك من الـ DB (information_schema)
       إلا ما وصلش للـ DB: استعمل --cols=a,b,c
 R2  /related cache    : middleware f105Cached(TTL 6h) بمفتاح X-F105-Cache
     — /related = ~600K استدعاء/شهر بلا كاش (حسب pg_stat_statements)
 R4  truncate desc     : description > 2000 حرف => LEFT(description,2000)
     — 15,524 منتج (أقصى 89,112 حرف) — UPDATE على دفعات 1000
     — الفحص/العدّ يدير أوتوماتيك؛ التنفيذ يتطلب --db-apply

 الاستعمال:
   node apply-f105.js server.js              تطبيق R1+R2 + عدّ R4
   node apply-f105.js server.js --db-apply   + تنفيذ R4 UPDATE فالـ DB
   node apply-f105.js server.js --dry-run    فحص فقط — بلا أي كتابة
   node apply-f105.js server.js --restore    رجوع لآخر backup

 أعلام:
   --cols=a,b,c          فرض قائمة الأعمدة يدوي (إلا الـ DB ماشي reachable)
   --desc-limit=N        حد قص الـ description (default 2000)
   --related-ttl-min=N   مدة كاش /related بالدقائق (default 360 = 6 سوايع)
   --keep-desc           خلّي description حتى فقوائم LIST (rollback سريع)

 الأمان:
   backup تلقائي server.js.f105-backup-<timestamp>.js قبل أي كتابة
   node --check بعد الكتابة — إلا فشل كيرجّع الأصلي أوتوماتيك
   تقرير f105-scan-report.txt كيتكتب ديما
   => إلا فشل شي إصلاح (Anchor not found / classification غالطة)
      صيفط الملف f105-scan-report.txt كامل للمعايرة
====================================================================
*/

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'v2.0';
const REPORT_NAME = 'f105-scan-report.txt';
const DROPLIST = ['description', 'variants'];
const SQL_KEYWORDS = new Set(['WHERE','GROUP','ORDER','LIMIT','OFFSET','JOIN','LEFT','RIGHT','INNER',
  'OUTER','FULL','CROSS','UNION','ON','SET','VALUES','RETURNING','FOR','AND','OR','NOT','AS','BY',
  'HAVING','INTO','USING','NATURAL','CASE','WHEN','THEN','ELSE','END','SELECT','FROM','DISTINCT']);

// ─── parsing flags ───
let target = null, dry = false, dbApply = false, restore = false, colsOverride = null;
let descLimit = 2000, relatedTtlMin = 360, keepDesc = false;

function help() {
  console.log(`
F#105 EGRESS KIT ${VERSION} — node apply-f105.js server.js [flags]
  --db-apply          + تنفيذ R4 (قص description) فالـ DB
  --dry-run           فحص فقط بلا كتابة
  --restore           رجوع لآخر backup
  --cols=a,b,c        قائمة أعمدة يدوي (بدون DB)
  --desc-limit=N      حد القص (default 2000)
  --related-ttl-min=N مدة الكاش بالدقائق (default 360)
  --keep-desc         خلّي description فقوائم LIST`);
}

for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') dry = true;
  else if (a === '--db-apply') dbApply = true;
  else if (a === '--restore') restore = true;
  else if (a === '--keep-desc') keepDesc = true;
  else if (a.startsWith('--desc-limit=')) descLimit = parseInt(a.slice(13), 10) || 2000;
  else if (a.startsWith('--related-ttl-min=')) relatedTtlMin = parseInt(a.slice(18), 10) || 360;
  else if (a.startsWith('--cols=')) colsOverride = a.slice(7).split(',').map(s => s.trim()).filter(Boolean);
  else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  else target = a;
}

if (!target && !restore) {
  help();
  console.log('\n[X] ناقص الملف: node apply-f105.js server.js');
  process.exit(2);
}

const cwd = process.cwd();
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

function writeReport(lines) {
  try { fs.writeFileSync(path.join(cwd, REPORT_NAME), lines.join('\n') + '\n', 'utf8'); } catch (e) {}
}

function syntaxCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || 'syntax error');
}

function loadDotEnv(dir) {
  const p = path.join(dir, '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (let line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function redactDbUrl(u) {
  try {
    const m = /^postgresql?:\/\/[^@]+@([^/?]+)(\/[^?]*)?/i.exec(u);
    return m ? `postgresql://***@${m[1]}${m[2] || ''}` : '(redacted)';
  } catch (e) { return '(redacted)'; }
}

// ─── restore mode ───
if (restore) {
  const abs = path.resolve(cwd, target || 'server.js');
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const files = fs.readdirSync(dir).filter(f => f.startsWith(base + '.f105-backup-')).sort();
  if (!files.length) { console.log('[X] ما كاين حتى backup فـ ' + dir); process.exit(1); }
  const src = path.join(dir, files[files.length - 1]);
  fs.copyFileSync(src, abs);
  console.log(`[OK] رجّعنا: ${files[files.length - 1]}  =>  ${base}`);
  process.exit(0);
}

(async () => {
  const t0 = Date.now();
  const abs = path.resolve(cwd, target);
  const report = [];
  const L = (s = '') => { report.push(s); console.log(s); };

  L('');
  L('═══ F#105 EGRESS KIT ' + VERSION + ' ' + (dry ? '— DRY-RUN (فحص فقط)' : '— APPLY') + ' ═══');
  L('dir: ' + cwd);
  L('target: ' + abs + (fs.existsSync(abs) ? '' : '  [X] ما موجود!'));
  L('flags: ' + JSON.stringify({ dbApply, descLimit, relatedTtlMin, keepDesc, colsOverride: colsOverride ? colsOverride.length + ' cols' : null }));
  L('');

  if (!fs.existsSync(abs)) { writeReport(report); process.exit(2); }

  const original = fs.readFileSync(abs, 'utf8');
  const lines0 = original.split('\n').length;
  L(`[i] ${path.basename(abs)}: ${lines0} سطر، ${(original.length / 1024).toFixed(0)} KB`);

  // ─── baseline syntax check ───
  const baselineErr = syntaxCheck(abs);
  if (baselineErr) {
    L('[X] server.js ماشي سليم قبل أي تعديل (node --check) — وقفنا.');
    L('    ' + String(baselineErr).split('\n')[0]);
    writeReport(report); process.exit(2);
  }
  L('[OK] node --check (قبل التعديل): سليم');

  // ─── .env + DB ───
  const env = { ...loadDotEnv(cwd) };
  if (!env.DATABASE_URL) Object.assign(env, loadDotEnv(path.dirname(abs)));
  const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL || '';

  const db = { ok: false, cols: null, err: null, url: redactDbUrl(dbUrl) };
  const r4 = { count: null, maxLen: null, applied: false, rows: 0, batches: 0, note: '' };

  if (dbUrl) {
    try {
      const pg = require('pg');
      const client = new pg.Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
      });
      await client.connect();
      db.ok = true;
      const c = await client.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='products' AND table_schema=current_schema() ORDER BY ordinal_position"
      );
      db.cols = c.rows.map(r => ({ n: r.column_name, t: r.data_type }));
      L(`[OK] DB متصلة: ${db.url}`);
      L(`[OK] أعمدة products: ${db.cols.length}`);
      if (db.cols.some(x => x.n === 'description')) {
        const q = await client.query(
          'SELECT COUNT(*)::int AS n, COALESCE(MAX(LENGTH(description)),0)::int AS mx FROM products WHERE description IS NOT NULL AND LENGTH(description) > $1',
          [descLimit]
        );
        r4.count = q.rows[0].n; r4.maxLen = q.rows[0].mx;
      } else {
        r4.note = 'عمود description ما كاينش — R4 تخطى';
      }
      if (dbApply) {
        if (!db.cols.some(x => x.n === 'id')) { r4.note = 'عمود id ما كاينش — R4 apply تخطى'; }
        else if (r4.count === 0) { r4.note = 'حتى منتج ماشي فوق الحد — حتى UPDATE'; }
        else {
          let total = 0, batches = 0;
          for (;;) {
            const u = await client.query(
              'UPDATE products SET description = LEFT(description, $1) WHERE id IN (SELECT id FROM products WHERE description IS NOT NULL AND LENGTH(description) > $1 LIMIT 1000)',
              [descLimit]
            );
            total += u.rowCount || 0; batches++;
            if ((u.rowCount || 0) < 1000 || batches >= 200) break;
          }
          r4.applied = true; r4.rows = total; r4.batches = batches;
          try { await client.query('VACUUM ANALYZE products'); r4.note = 'VACUUM ANALYZE: OK'; }
          catch (e) { r4.note = 'VACUUM ANALYZE تخطى: ' + e.message; }
        }
      }
      await client.end();
    } catch (e) {
      db.err = String(e.message || e).split('\n')[0];
      L('[!] DB ما وصلناش: ' + db.err);
    }
  } else {
    db.err = 'DATABASE_URL ما كاينش (process.env ولا .env)';
    L('[!] ' + db.err);
  }
  L('');

  // ─── build whitelist ───
  const allCols = colsOverride ? colsOverride.map(n => ({ n, t: '?' })) : (db.ok && db.cols ? db.cols : null);
  const drops = keepDesc ? DROPLIST.filter(c => c !== 'description') : DROPLIST.slice();
  let listCols = null;
  if (allCols) {
    listCols = allCols.map(c => c.n).filter(n => !drops.includes(String(n).toLowerCase()));
    if (listCols.length < 8) { L('[!] قائمة الأعمدة صغيرة (' + listCols.length + ') — R1 تخطى للسلامة'); listCols = null; }
  }
  if (listCols) {
    L(`[R1] القائمة البيضاء (${listCols.length} عمود، محذوف: ${drops.join(', ')}):`);
    L('     ' + listCols.join(', '));
    L('');
  }

  // ─── route map + classification ───
  const routes = [];
  const routeRe = /\b(?:app|router)\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let rm;
  while ((rm = routeRe.exec(original))) routes.push({ i: rm.index, p: rm[1] });
  L(`[i] routes مكتشفين: ${routes.length}`);

  function regionOf(idx) {
    let best = null;
    for (const r of routes) { if (r.i <= idx) best = r; else break; }
    return best;
  }
  function classifyRoute(p) {
    const s = String(p).toLowerCase();
    if (s.includes('admin')) return 'ADMIN';
    if (s.includes('related') || s.includes('feed')) return 'LIST';
    const segs = s.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    if (last.startsWith(':')) return 'PDP';
    if (/^(product|p|item|detail)s?$/.test(segs[0] || '')) return 'PDP';
    return 'LIST';
  }
  function parseTrailingAlias(after) {
    const m1 = /^\s+as\s+([a-z_][\w$]*)/i.exec(after);
    if (m1) return m1[1];
    const m2 = /^\s+([a-z_][\w$]*)/.exec(after);
    if (m2 && !SQL_KEYWORDS.has(m2[1].toUpperCase())) return m2[1];
    return null;
  }
  // window محدود بآخر الـ string literal تاع SQL — باش ما يعبرش للسطر/الاستعلام الجاي
  function sqlWindow(after) {
    const q = /['"`]/.exec(after);
    const w = q ? after.slice(0, q.index) : after.slice(0, 500);
    return w.length > 500 ? w.slice(0, 500) : w;
  }
  function isSingleRowLookup(after) {
    const w = sqlWindow(after);
    if (/\b(?:slug|sku)\s*=\s*\$?\w/i.test(w)) return true;
    if (/\bid\s*=\s*\$?\d/i.test(w)) return true;
    return false;
  }

  // ─── R1: column projection ───
  L('═══ R1 — column projection ═══');
  const edits = [];
  let r1Total = 0, r1Rewritten = 0, skipPdp = 0, skipAdmin = 0, skipSingle = 0, skipNoCols = 0, skipNoRoute = 0;
  const censusStar = (original.match(/select\s+(?:[a-z_][\w$]*\s*\.\s*\*|\*)/gi) || []).length;
  const re = /select\s+(?:([a-z_][\w$]*)\s*\.\s*\*|\*)\s+from\s+(?:public\.)?products\b/gi;
  let m;
  while ((m = re.exec(original))) {
    r1Total++;
    const lineNo = original.slice(0, m.index).split('\n').length;
    const starAlias = m[1] || null;
    const after = original.slice(m.index + m[0].length);
    const alias = parseTrailingAlias(after) || starAlias;
    const reg = regionOf(m.index);
    const routePath = reg ? reg.p : '(خارج route)';
    const cls = reg ? classifyRoute(reg.p) : 'UNKNOWN';
    if (!listCols) { skipNoCols++; L(`  [SKIP] سطر ${lineNo} — حتى قائمة أعمدة (--cols ولا DB)`); continue; }
    if (!reg || cls === 'UNKNOWN') { skipNoRoute++; L(`  [SKIP] سطر ${lineNo} — خارج route ظاهر | ${m[0].slice(0, 50)}`); continue; }
    if (cls === 'ADMIN') { skipAdmin++; L(`  [SKIP] سطر ${lineNo} — route admin كيبقى كامل | ${routePath}`); continue; }
    if (cls === 'PDP') { skipPdp++; L(`  [SKIP] سطر ${lineNo} — PDP كيبقى كامل (description+variants محتاجين) | ${routePath}`); continue; }
    if (isSingleRowLookup(after)) { skipSingle++; L(`  [SKIP] سطر ${lineNo} — single-row lookup كيبقى كامل | ${routePath}`); continue; }
    const newHead = `SELECT ${listCols.map(c => alias ? alias + '.' + c : c).join(', ')} FROM products`;
    edits.push({ i: m.index, len: m[0].length, to: newHead });
    r1Rewritten++;
    L(`  [REWRITE] سطر ${lineNo} | route ${routePath} | alias=${alias || '-'} | => ${listCols.length} أعمدة`);
  }
  L(`  ── R1: ${r1Rewritten} rewritten / ${r1Total} products-SELECT-* من أصل ${censusStar} SELECT-* فالملف` +
    ` (PDP:${skipPdp} admin:${skipAdmin} single:${skipSingle} خارج-route:${skipNoRoute} بلا-cols:${skipNoCols})`);
  L('');

  let code = original;
  for (const e of edits.sort((a, b) => b.i - a.i)) {
    code = code.slice(0, e.i) + e.to + code.slice(e.i + e.len);
  }

  // ─── R2: /related cache ───
  L('═══ R2 — cache /related ═══');
  const ttlMs = relatedTtlMin * 60 * 1000;
  let r2count = 0, r2already = 0;
  const r2paths = [];
  code = code.replace(
    /((?:app|router)\s*\.\s*get\s*\(\s*)(['"`])([^'"`]*related[^'"`]*)\2(\s*,)/gi,
    (full, head, q, p, comma, off, s) => {
      const rest = s.slice(off + full.length, off + full.length + 60);
      if (/^\s*f105Cached/.test(rest)) { r2already++; r2paths.push(p + ' (مطبق من قبل)'); return full; }
      r2count++; r2paths.push(p);
      return `${head}${q}${p}${q}${comma} f105Cached(${ttlMs}),`;
    }
  );
  if (r2count || r2already) {
    L(`  [OK] middleware مركّب على: ${r2paths.join(' | ')} (جديد:${r2count} موجود:${r2already})`);
    L(`  TTL: ${relatedTtlMin} دقيقة | مفتاح التحقق: X-F105-Cache: HIT/MISS`);
  } else {
    L('  [FAIL] ما لقيتش حتى route فيه /related — صيفط التقرير للمعايرة');
  }
  L('');

  const HELPER = [
    '',
    '',
    '// ═══ F#105 R2: in-memory cache middleware (auto-injected ' + stamp + ') ═══',
    'function f105Cached(ttlMs) {',
    '  const store = new Map();',
    '  const MAX_ENTRIES = 3000;',
    '  return function (req, res, next) {',
    '    try {',
    '      const key = req.originalUrl || req.url || String(Date.now());',
    '      const hit = store.get(key);',
    '      if (hit && (Date.now() - hit.t) < ttlMs) {',
    "        res.setHeader('X-F105-Cache', 'HIT');",
    '        return res.status(hit.status).json(hit.body);',
    '      }',
    '      if (store.size >= MAX_ENTRIES) {',
    '        const oldest = store.keys().next().value;',
    '        if (oldest !== undefined) store.delete(oldest);',
    '      }',
    '      const origJson = res.json.bind(res);',
    '      res.json = function (body) {',
    '        try {',
    '          if (res.statusCode === 200) store.set(key, { t: Date.now(), status: 200, body: body });',
    "          res.setHeader('X-F105-Cache', 'MISS');",
    '        } catch (e) { /* noop */ }',
    '        return origJson(body);',
    '      };',
    '    } catch (e) { /* noop */ }',
    "    if (typeof next === 'function') next();",
    '  };',
    '}',
  ].join('\n');

  if ((r2count > 0 || r2already > 0) && !code.includes('function f105Cached')) code += HELPER;

  // ─── R4 report ───
  L('═══ R4 — truncate description (> ' + descLimit + ' حرف) ═══');
  if (r4.count !== null) {
    L(`  [i] منتجات فوق الحد: ${r4.count} | أقصى طول: ${r4.maxLen}`);
    if (r4.applied) L(`  [OK] UPDATE تنفذ: ${r4.rows} صف فـ ${r4.batches} دفعة | ${r4.note}`);
    else if (dbApply) L(`  [SKIP] ${r4.note || 'ما تنفذش'}`);
    else L(`  [i] للتنفيذ: node apply-f105.js server.js --db-apply`);
  } else {
    L(`  [SKIP] ${r4.note || 'DB ما وصلش — العدّ ما تمش'}`);
  }
  L('');

  // ─── write + verify ───
  const changed = code !== original;
  L('═══ الكتابة ═══');
  if (dry) {
    L('[DRY-RUN] حتى كتابة ما تمت — هاد كان فحص فقط.');
  } else if (!changed) {
    L('[i] ما كاينش تعديل جديد (مطبق من قبل ولا حتى anchor ما لقاش) — الملف ما تبدلش.');
  } else {
    const backupName = `${path.basename(abs)}.f105-backup-${stamp}.js`;
    const backupAbs = path.join(path.dirname(abs), backupName);
    fs.writeFileSync(backupAbs, original);
    fs.writeFileSync(abs, code);
    const err = syntaxCheck(abs);
    if (err) {
      fs.writeFileSync(abs, original);
      L('[X] node --check فشل من بعد التعديل — رجّعنا الأصلي أوتوماتيك. التفاصيل:');
      L(String(err).split('\n').slice(0, 8).join('\n'));
      writeReport(report); process.exit(1);
    }
    L(`[OK] كتبنا ${path.basename(abs)} + node --check: OK`);
    L(`[OK] backup: ${backupName}`);
  }
  L('');

  // ─── summary + next ───
  L('═══ ملخص ═══');
  L(`  R1 projection : ${r1Rewritten} rewritten (${r1Total} products-SELECT-*)`);
  L(`  R2 cache      : ${r2count} مركّب (${r2already} من قبل) على ${r2paths.length} route`);
  L(`  R4 truncate   : ${r4.applied ? r4.rows + ' صف' : (r4.count !== null ? r4.count + ' فوق الحد — ينتظر --db-apply' : 'ما عرفناش (DB)')}`);
  L(`  DB            : ${db.ok ? 'OK (' + (db.cols || []).length + ' أعمدة) ' + db.url : 'FAIL — ' + (db.err || '')}`);
  L('');
  L('NEXT:');
  L('  1) راجع قائمة الأعمدة فوق + كل [REWRITE] — تأكد الـ routes صحيحين');
  L('  2) جرّب محلياً: npm start — شوف /api/products و /related و صفحة منتج');
  L('  3) تحقق من الكاش: curl -sD - "http://localhost:3000<مسار-related>" | grep -i x-f105-cache');
  L('  4) git add server.js && git commit -m "F#105: R1 projection + R2 /related cache" && git push origin main');
  L('  5) راقب egress فـ Supabase Dashboard بعد 24-48 ساعة');
  L('');
  const noFix = (r1Rewritten === 0 && r2count === 0);
  if (noFix) L('  [!!] حتى إصلاح ما تطبق — صيفط ' + REPORT_NAME + ' كامل للمعايرة');
  L('');
  L(`التقرير: ${REPORT_NAME} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  L('');

  writeReport(report);
  process.exit(noFix ? 2 : 0);
})().catch(e => {
  console.error('[X] خطأ كيتوقع الكيت: ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e));
  writeReport(['[X] FATAL: ' + (e && e.message ? e.message : String(e))]);
  process.exit(1);
});
