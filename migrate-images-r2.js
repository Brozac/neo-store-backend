#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   migrate-images-r2.js — F#105 PHASE 2: Supabase Storage → Cloudflare R2  v1.0
   ═══════════════════════════════════════════════════════════════════════════
   الهدف: أي صورة خادمة من Supabase Storage (تاكل من egress تاع 5GB)
          تترحّل لـ R2 (egress مجاني) والـ URLs فقاعدة البيانات تتقاد.

   🔍 discovery-first: السكربت ما كيقتلش على افتراضات — كيفحص قاعدة البيانات
      server-side (ILIKE، بلا سحب TOAST) ويحصي بالضبط فين كاينين URLs تاع
      Supabase Storage، في أي جدول وأي عمود. الـ dry-run كيبين كلشي قبل أي حركة.

   الاستعمال:
     node migrate-images-r2.js                ← DISCOVERY: فحص + تقرير، بلا تعديل
     node migrate-images-r2.js --apply        ← ترحيل فعلي (download → R2 → rewrite)
     node migrate-images-r2.js --apply --limit 20   ← تطبيق على أول 20 سطر فقط (تجربة)
     node migrate-images-r2.js --selftest     ← اختبار R2 فقط (رفع/قراءة/حذف ملف اختبار)
     node migrate-images-r2.js --unit         ← اختبارات وحدة داخلية (بلا DB بلا R2)

   المطلوب فـ .env (نفس مجلد السكربت):
     DATABASE_URL          ← pooler تاع Supabase
     R2_ACCOUNT_ID         ← (أو R2_ENDPOINT كامل) https://<id>.r2.cloudflarestorage.com
     R2_ACCESS_KEY_ID
     R2_SECRET_ACCESS_KEY
     R2_BUCKET             ← laclarc-media
     R2_PUBLIC_BASE_URL    ← https://pub-….r2.dev

   الأمان:
     - dry-run افتراضي — حتى تعديل بلا --apply
     - idempotent: URLs اللي ولو على R2 كيتخطاو؛ objects الموجودة فـ R2 ما كتعاودش تترفع
     - المصدر ما كيتحيدش — Supabase كيبقى فيه نسخة أصلية (تراجع ممكن)
     - كل URL كيترفع ويتحقق (HEAD) قبل ما يتقاد فقاعدة البيانات
     - ما كيطبعش مفاتيح — ACCESS KEY مقصوص، DATABASE_URL مخفي
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const VERSION = '1.0';
const REPORT_NAME = 'migrate-r2-report.txt';
const MAX_OBJ_BYTES = 25 * 1024 * 1024;   // 25MB — فوق هادا كيتسجل FAIL
const BATCH = 100;                         // سطور لكل دفعة DB
// نمط URL تاع Supabase Storage (public/sign) — كيستعمل فالاكتشاف والاستخراج
const SB_LIKE = '%supabase.co/storage/v1/object/%';
const SB_URL_RE = /https?:\/\/[a-z0-9][a-z0-9.-]*\.supabase\.(?:co|in|com|net)\/storage\/v1\/object\/(?:public|sign)\/[^\s"'<>\\)]+/gi;
const TEXT_TYPES = ['text', 'character varying', 'character', 'json', 'jsonb'];
const CT_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

/* ── CLI ─────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const a = { apply: false, selftest: false, unit: false, db: null, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--apply') a.apply = true;
    else if (x === '--selftest') a.selftest = true;
    else if (x === '--unit') a.unit = true;
    else if (x.startsWith('--limit=')) a.limit = Number(x.slice(8)) || 0;
    else if (x === '--limit') { const n = Number(argv[i + 1]); if (n > 0) { a.limit = n; i++; } }
    else if (x.startsWith('--db=')) a.db = x.slice(5);
    else if (x === '--db' && argv[i + 1] && !argv[i + 1].startsWith('--')) { a.db = argv[i + 1]; i++; }
  }
  return a;
}

function maskUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.hostname}${x.pathname}`; }
  catch { return '(unparsable)'; }
}

function loadEnvFile(dir) {
  const out = {};
  try {
    const p = path.join(dir, '.env');
    if (!fs.existsSync(p)) return out;
    for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* ignore */ }
  return out;
}
function envGet(name, fileEnv) { return (process.env[name] && process.env[name].trim()) || fileEnv[name] || ''; }

/* ── R2 client — SigV4 يدوي، بلا مكتبات ─────────────────────────────────── */
class R2 {
  constructor(cfg) {
    let host = '';
    if (cfg.endpoint) {
      try { host = new URL(cfg.endpoint).host; } catch { host = ''; }
    }
    if (!host && cfg.accountId) host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    if (!host) throw new Error('R2 endpoint مفقود — حط R2_ACCOUNT_ID ولا R2_ENDPOINT فـ .env');
    if (!cfg.bucket) throw new Error('R2_BUCKET مفقود فـ .env');
    if (!cfg.accessKey || !cfg.secretKey) throw new Error('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY ناقصين فـ .env');
    if (!cfg.publicBase) throw new Error('R2_PUBLIC_BASE_URL مفقود فـ .env (فعّل Public Dev URL من الـ dashboard)');
    this.host = host;
    this.bucket = cfg.bucket;
    this.accessKey = cfg.accessKey;
    this.secretKey = cfg.secretKey;
    this.publicBase = cfg.publicBase.replace(/\/+$/, '');
  }
  encPath(key) { return '/' + this.bucket + '/' + key.split('/').map(encodeURIComponent).join('/'); }
  publicUrl(key) { return `${this.publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`; }
  _sign(method, key, payloadSha, contentType) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const canonicalUri = this.encPath(key);
    const headers = { host: this.host, 'x-amz-content-sha256': payloadSha, 'x-amz-date': amzDate };
    if (contentType) headers['content-type'] = contentType;
    const sorted = Object.keys(headers).sort();
    const canonicalHeaders = sorted.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = sorted.join(';');
    // ⚠️ R2 quirk (مثبت تجريبياً 2026-11-17): الـ canonical request كيتحسب بالصيغة
    // join('\n') — اللي كتخلق سطر فارغ بين الهيدرات و SignedHeaders (بعكس S3 الكلاسيكي).
    // الصيغة القياسية (سطر واحد) كترجع 403 SignatureDoesNotMatch من R2.
    const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadSha].join('\n');
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const k = (key2, data) => crypto.createHmac('sha256', key2).update(data).digest();
    // سلسلة SigV4: 4 مستويات فقط (date → region → service → aws4_request)
    // ثم HMAC الأخير بالـ stringToSign — أي مستوٍ زايد = توقيع مزدوج = 403
    const kDate = k('AWS4' + this.secretKey, dateStamp);
    const kSigning = k(k(k(kDate, 'auto'), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const h = { ...headers };
    h.Authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { host: this.host, pth: canonicalUri, headers: h,
      dbg: { canonicalRequest, stringToSign, amzDate, scope } };
  }
  request(method, key, body, contentType) {
    const emptySha = crypto.createHash('sha256').update('').digest('hex');
    const payloadSha = body ? crypto.createHash('sha256').update(body).digest('hex') : emptySha;
    const s = this._sign(method, key, payloadSha, contentType);
    if (process.env.F105_DEBUG) {
      console.error('[DBG]', method, s.pth);
      console.error('[DBG] payloadSha:', payloadSha);
      console.error('[DBG] canonical:', JSON.stringify(s.dbg.canonicalRequest));
      console.error('[DBG] stringToSign:', JSON.stringify(s.dbg.stringToSign));
      console.error('[DBG] amzDate:', s.dbg.amzDate, '| scope:', s.dbg.scope);
      console.error('[DBG] auth:', s.headers.Authorization.replace(/Signature=[a-f0-9]{16}[a-f0-9]*/, 'Signature=<…>'));
    }
    return new Promise((resolve, reject) => {
      const req = https.request(
        { method, host: s.host, path: s.pth, headers: s.headers, timeout: 60000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }
      );
      req.on('timeout', () => req.destroy(new Error(`timeout R2 ${method} ${key}`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  put(key, buf, contentType) { return this.request('PUT', key, buf, contentType); }
  head(key) { return this.request('HEAD', key, null, null); }
  del(key) { return this.request('DELETE', key, null, null); }
}

/* ── HTTP GET مع redirects — للتنزيل من Supabase والتحقق من الـ public URL ── */
function httpGet(url, redirects) {
  const left = (redirects === undefined) ? 3 : redirects;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`bad url: ${String(url).slice(0, 80)}`)); }
    const req = https.get(u, { timeout: 45000, headers: { 'User-Agent': 'f105-r2-migrate' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, u).toString(), left - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout GET ${u.host}`)));
    req.on('error', reject);
  });
}

/* ── URL utilities ───────────────────────────────────────────────────────── */
function parseSbUrl(u) {
  const m = u.match(/^https?:\/\/[^/]+\/storage\/v1\/object\/(public|sign)\/([^/?#]+)\/([^?#]+)/i);
  if (!m) return null;
  let p;
  try { p = decodeURIComponent(m[3]); } catch { p = m[3]; }
  return { mode: m[1].toLowerCase(), bucket: m[2], path: p };
}
function contentTypeFor(u, respHeaders) {
  if (respHeaders && respHeaders['content-type']) {
    const ct = String(respHeaders['content-type']).split(';')[0].trim();
    if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  }
  const ext = (u.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1];
  return (ext && CT_MAP[ext.toLowerCase()]) || 'application/octet-stream';
}
function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  let m;
  const re = new RegExp(SB_URL_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return [...new Set(out)];
}
/* إعادة كتابة URL واحد داخل قيمة عمود (text ولا jsonb::text) */
function rewriteValue(colText, fromUrl, toUrl) {
  if (!colText || colText.indexOf(fromUrl) === -1) return { text: colText, hits: 0 };
  return { text: colText.split(fromUrl).join(toUrl), hits: colText.split(fromUrl).length - 1 };
}
function isAlreadyR2(u, publicBase) {
  try { return new URL(u).host === new URL(publicBase).host; } catch { return false; }
}

/* ── DB ──────────────────────────────────────────────────────────────────── */
class DB {
  constructor(url) { this.url = url; this.pool = null; }
  async connect() {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: this.url,
      ssl: { rejectUnauthorized: false }, // B-M4: مشفر — للتحقق الصارم زيد CA (انظر db.js resolvePgSsl)
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 15000,
      statement_timeout: 60000,
      application_name: 'f105-r2-migrate',
    });
    await this.pool.query('SELECT 1');
  }
  /* كل الجداول النصية فـ public — الاكتشاف عام، بلا افتراض أسماء */
  async tables() {
    const { rows } = await this.pool.query(
      `SELECT table_name AS t FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`);
    return rows.map((r) => r.t);
  }
  async textColumns(table) {
    const { rows } = await this.pool.query(
      `SELECT column_name AS c, data_type AS d FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
    return rows.filter((r) => TEXT_TYPES.includes(r.d));
  }
  async pkColumn(table) {
    try {
      const { rows } = await this.pool.query(
        `SELECT a.attname AS c FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = ($1 || '')::regclass AND i.indisprimary AND a.attnum > 0
         LIMIT 1`, [`"${table}"`]);
      return rows[0] ? rows[0].c : null;
    } catch { return null; }
  }
  /* عدّاد لكل عمود — استعلام واحد لكل جدول، FILTER server-side (بلا سحب بيانات) */
  async census(table, cols) {
    const q = `SELECT ${cols.map((c) =>
      `count(*) FILTER (WHERE "${c.c}"::text ILIKE $1) AS ${JSON.stringify(c.c)}`).join(', ')}
       FROM "${table}"`;
    const { rows } = await this.pool.query(q, [SB_LIKE]);
    return rows[0] || {};
  }
  async end() { try { if (this.pool) await this.pool.end(); } catch { /* noop */ } }
}

/* ═══ SELFTEST — اختبار R2 فقط (بلا DB) ═══ */
async function selftest(r2, log) {
  log('═══ R2 SELFTEST — ' + r2.bucket + ' @ ' + r2.host + ' ═══');
  const key = '_f105-selftest.txt';
  const body = Buffer.from(`F#105 R2 selftest ${new Date().toISOString()}\n`);
  let ok = 0, fail = 0;
  const step = (name, cond, extra) => {
    if (cond) { ok++; log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
    else { fail++; log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
  };
  try {
    const p = await r2.put(key, body, 'text/plain');
    step('PUT (signature + upload)', p.status === 200, `status ${p.status}`);
    const h = await r2.head(key);
    step('HEAD (موجود + الحجم مضبوط)', h.status === 200 && Number(h.headers['content-length']) === body.length,
      `status ${h.status}, len ${h.headers['content-length']}`);
    const pub = await httpGet(r2.publicUrl(key));
    step('GET عبر R2_PUBLIC_BASE_URL (عام)', pub.status === 200 && pub.body.toString('utf8') === body.toString('utf8'),
      `status ${pub.status}`);
    const d = await r2.del(key);
    step('DELETE (تنظيف)', d.status === 204 || d.status === 200, `status ${d.status}`);
    const h2 = await r2.head(key);
    step('HEAD بعد الحذف (تأكيد 404)', h2.status === 404, `status ${h2.status}`);
  } catch (e) {
    fail++;
    log(`  ❌ استثناء: ${e.message}`);
  }
  log(`النتيجة: ${ok}/5 نجاحات — ${fail === 0 ? 'R2 واجد 100% ✅' : 'كاين مشكل ❌ (شوف الرسائل فوق)'}`);
  return fail === 0;
}

/* ═══ UNIT — اختبارات داخلية (بلا DB بلا R2) ═══ */
function unitTests(log) {
  let ok = 0, fail = 0;
  const t = (name, cond, extra) => {
    if (cond) { ok++; log(`  ✅ ${name}`); }
    else { fail++; log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
  };
  // 1) استخراج URLs من jsonb::text (مهرّبة)
  const jsonText = '{"imgs":["https://abc123.supabase.co/storage/v1/object/public/products/a%20b.jpg?dl=1","https://cf.cjdropshipping.com/x.jpg"],"n":1}';
  const urls = extractUrls(jsonText);
  t('extractUrls من jsonb', urls.length === 1 && urls[0] === 'https://abc123.supabase.co/storage/v1/object/public/products/a%20b.jpg?dl=1', JSON.stringify(urls));
  // 2) استخراج متعدد + dedupe
  const multi = 'a https://x.supabase.co/storage/v1/object/public/b/1.png https://x.supabase.co/storage/v1/object/public/b/1.png b';
  t('dedupe URLs', extractUrls(multi).length === 1);
  // 3) parseSbUrl — encoded path + query
  const p = parseSbUrl('https://abc123.supabase.co/storage/v1/object/public/products/a%20b.jpg?dl=1');
  t('parseSbUrl bucket/path', !!(p && p.bucket === 'products' && p.path === 'a b.jpg' && p.mode === 'public'), JSON.stringify(p));
  const ps = parseSbUrl('https://abc123.supabase.co/storage/v1/object/sign/reviews/x.png?token=abc');
  t('parseSbUrl sign mode', !!(ps && ps.mode === 'sign'));
  // 4) rewriteValue — كل التكرارات
  const rw = rewriteValue('["https://x.supabase.co/storage/v1/object/public/b/1.png","https://x.supabase.co/storage/v1/object/public/b/1.png"]',
    'https://x.supabase.co/storage/v1/object/public/b/1.png', 'https://pub-1.r2.dev/b/1.png');
  t('rewriteValue كل التكرارات', rw.hits === 2 && rw.text.indexOf('supabase') === -1 && rw.text.indexOf('pub-1.r2.dev/b/1.png') !== -1);
  // 5) rewriteValue — ما كيبدلش اللي ماشي مطابق
  t('rewriteValue بلا مطابقة', rewriteValue('abc', 'nope', 'zzz').hits === 0);
  // 6) roundtrip jsonb بعد rewrite (نص JSON صالح)
  let valid = true;
  try { JSON.parse(rw.text); } catch { valid = false; }
  t('jsonb نص صالح بعد rewrite', valid);
  // 7) encoding roundtrip
  const enc = (k) => k.split('/').map(encodeURIComponent).join('/');
  const key = 'products/sub dir/a b.jpg';
  t('encoding roundtrip', decodeURIComponent(enc(key)) === key, enc(key));
  // 8) isAlreadyR2
  t('isAlreadyR2 يفرق بين المصدري والـ R2',
    isAlreadyR2('https://pub-1.r2.dev/products/1.png', 'https://pub-1.r2.dev') &&
    !isAlreadyR2('https://abc.supabase.co/storage/v1/object/public/products/1.png', 'https://pub-1.r2.dev'));
  // 9) contentTypeFor من الامتداد
  t('contentTypeFor', contentTypeFor('https://x/pic.webp') === 'image/webp' && contentTypeFor('https://x/pic') === 'application/octet-stream');
  log(`النتيجة: ${ok} اختبارات سليمة — ${fail === 0 ? 'الوحدات كلها ✅' : 'كاين فشل ❌'}`);
  return fail === 0;
}

/* ═══ MAIN ═════════════════════════════════════════════════════════════════ */
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = process.cwd();
  const reportPath = path.join(dir, REPORT_NAME);
  const L = [];
  const log = (s) => { console.log(s); L.push(s); };
  const fileEnv = loadEnvFile(dir);
  const mode = args.unit ? 'UNIT' : args.selftest ? 'SELFTEST' : args.apply ? 'APPLY' : 'DISCOVERY (dry-run)';

  log(`F#105 R2 MIGRATION v${VERSION} — mode: ${mode}`);
  log(`dir: ${dir}`);

  /* ── R2 config ── */
  let r2 = null;
  let r2CfgOk = true;
  try {
    r2 = new R2({
      endpoint: envGet('R2_ENDPOINT', fileEnv),
      accountId: envGet('R2_ACCOUNT_ID', fileEnv),
      accessKey: envGet('R2_ACCESS_KEY_ID', fileEnv),
      secretKey: envGet('R2_SECRET_ACCESS_KEY', fileEnv),
      bucket: envGet('R2_BUCKET', fileEnv),
      publicBase: envGet('R2_PUBLIC_BASE_URL', fileEnv),
    });
    log(`R2: bucket=${r2.bucket} host=${r2.host} public=${new URL(r2.publicBase).host} key=${r2.accessKey.slice(0, 6)}…`);
  } catch (e) {
    r2CfgOk = false;
    log(`[FAIL] R2 config: ${e.message}`);
    if (!args.unit) {
      fs.writeFileSync(reportPath, L.join('\n') + '\n');
      process.exit(1);
    }
  }

  if (args.unit) {
    unitTests(log);
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    process.exit(0);
  }
  if (args.selftest) {
    const ok = r2CfgOk ? await selftest(r2, log) : false;
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    process.exit(ok ? 0 : 1);
  }

  /* ── DB ── */
  const dbUrl = args.db || envGet('DATABASE_URL', fileEnv);
  if (!dbUrl) {
    log('[FAIL] ماكاينش DATABASE_URL (env ولا .env ولا --db)');
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    process.exit(1);
  }
  const db = new DB(dbUrl);
  try {
    await db.connect();
    log(`[OK] DB متصلة: ${maskUrl(dbUrl)}`);
  } catch (e) {
    log(`[FAIL] DB ما قدراتش تتصل: ${e.message}`);
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    process.exit(1);
  }

  /* ═══ DISCOVERY — census لكل جدول/عمود نصي ═══ */
  const plan = []; // {table, col, count, pk}
  log('');
  log('═══ 1) CENSUS — فين كاينين URLs تاع Supabase Storage ═══');
  try {
    const tables = await db.tables();
    for (const t of tables) {
      const cols = await db.textColumns(t);
      if (!cols.length) continue;
      const counts = await db.census(t, cols);
      for (const c of cols) {
        const n = Number(counts[c.c] || 0);
        if (n > 0) plan.push({ table: t, col: c.c, count: n, pk: null });
      }
    }
  } catch (e) {
    log(`[FAIL] census: ${e.message}`);
    await db.end();
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    process.exit(1);
  }
  if (!plan.length) {
    log('  ✅ ما لقيتش حتى URL تاع Supabase Storage فقاعدة البيانات.');
    log('  → الصور خادمة من CDNs خارجية (CJ/aliyuncs) — ما تاكلش egress تاع Supabase.');
    log('  → هاد السكربت كيبقى مفيد ملي يبدا كاين رفع داخلي (reviews/avatars) — وجهّز /api/upload للـ R2 من بعد.');
    log('  → الـ DB egress إذن جاي من الاستعلامات نفسها — الكيت apply-f105.js (R1+R2+R4) هو اللي كيقللو.');
    await db.end();
    L.push('');
    L.push('═══ الخطوات الجاية ═══');
    L.push('1) كمّل مع الكيت apply-f105.js (R1 projection + R2 cache + R4 truncate) — هو فيّاس الـ DB egress');
    L.push('2) راقب egress فـ Supabase Dashboard بعد 24-48 ساعة من النشر');
    L.push('3) ملي تولد حاجة كتتخزن فـ Supabase Storage (صور reviews مثلاً) عاود شغّل هاد السكربت');
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    log(`report: ${reportPath}`);
    process.exit(0);
  }
  for (const p of plan) {
    p.pk = await db.pkColumn(p.table);
    log(`  ${p.table}.${p.col} — ${p.count} سطر${p.pk ? ` (pk: ${p.pk})` : ' (بلا pk → ctid)'}`);
  }

  if (!args.apply) {
    log('');
    log('═══ DISCOVERY كمل — ما تبدل والو ═══');
    log('عاود شغّل بـ --apply باش يترحلو. ولا --apply --limit 20 باش تجربة صغيرة أولاً.');
    log('الـ dry-run ما سحبش محتوى الأعمدة — الـ census تم server-side (egress أدنى).');
    await db.end();
    fs.writeFileSync(reportPath, L.join('\n') + '\n');
    log(`report: ${reportPath}`);
    process.exit(0);
  }

  /* ═══ APPLY — ترحيل لكل (جدول، عمود) ═══ */
  log('');
  log('═══ 2) APPLY — تنزيل → رفع R2 → تحقق → إعادة كتابة ═══');
  const stats = { rows: 0, urls: 0, uploaded: 0, existed: 0, skippedR2: 0, failed: 0, signSkipped: 0 };
  const failures = [];
  const migrated = new Map(); // sbUrl → r2Url (جلسة وحدة — ما كيعاودش نفس الصورة)

  for (const p of plan) {
    log(`— ${p.table}.${p.col} (${p.count} سطر) —`);
    const rowId = p.pk || 'ctid';
    const isJson = ['json', 'jsonb'].includes((await db.textColumns(p.table)).find((c) => c.c === p.col).d);
    const ridSel = rowId === 'ctid' ? 'ctid::text' : `"${rowId}"::text`;
    const whereRid = rowId === 'ctid' ? 'ctid = $1::tid' : `"${rowId}" = $1`;

    /* المرحلة 1 — لائحة كاملة ديال الـ rids المطابقة (rid فقط — خفيف).
       بلا تحديث فهاد المرحلة → مجموعة المطابقة مستقرة → OFFSET صحيح.
       لو كان كنعتمدو OFFSET مع التحديث المباشر، التحديث كيحيد السطر من المطابقة
       والمجموعة كتقلص → النقز فوق سطور ما تاتعالجاتش (bug منطقي). */
    let rids = [];
    let listOffset = 0;
    while (true) {
      let rows;
      try {
        ({ rows } = await db.pool.query(
          `SELECT ${ridSel} AS rid FROM "${p.table}" WHERE "${p.col}"::text ILIKE $1
           ORDER BY ${rowId === 'ctid' ? 'ctid' : `"${rowId}"`} LIMIT 500 OFFSET ${listOffset}`, [SB_LIKE]));
      } catch (e) {
        log(`  [FAIL] rid listing offset=${listOffset}: ${e.message}`);
        break;
      }
      if (!rows.length) break;
      rids.push(...rows.map((r) => r.rid));
      listOffset += rows.length;
      if (rids.length >= 200000) { log('  [WARN] حاجز أمان 200k سطر — نوقفو اللائحة هنا'); break; }
    }
    if (args.limit && rids.length > args.limit) rids = rids.slice(0, args.limit);
    log(`  لائحة: ${rids.length} سطر${args.limit && p.count > args.limit ? ` (محدود بـ --limit ${args.limit} من أصل ${p.count})` : ''}`);

    /* المرحلة 2 — معالجة سطر بسطر: SELECT val → migrate URLs → UPDATE */
    let done = 0;
    for (const rid of rids) {
      let rows;
      try {
        ({ rows } = await db.pool.query(`SELECT "${p.col}"::text AS val FROM "${p.table}" WHERE ${whereRid}`, [rid]));
      } catch (e) {
        failures.push(`${p.table}.${p.col} rid=${rid} → SELECT: ${e.message}`);
        continue;
      }
      if (!rows.length) continue; // تبدل بين اللائحة والمعالجة (نادر)
      stats.rows++;
      done++;
      const val0 = rows[0].val;
      const urls = extractUrls(val0);
      if (!urls.length) continue;
      let val = val0;
      let changed = false;
      for (const u of urls) {
        stats.urls++;
        if (isAlreadyR2(u, r2.publicBase)) { stats.skippedR2++; continue; }
        const info = parseSbUrl(u);
        if (!info) { stats.failed++; failures.push(`${u} → unparsable`); continue; }
        if (info.mode === 'sign') { stats.signSkipped++; L.push(`  [WARN] sign URL متخطى (يتطلب token): ${u.slice(0, 90)}`); continue; }
        const key = `${info.bucket}/${info.path}`;
        try {
          let r2Url = migrated.get(u);
          if (!r2Url) {
            // تحقق من الوجود أولاً — idempotent
            const h = await r2.head(key);
            if (h.status === 200) {
              stats.existed++;
              r2Url = r2.publicUrl(key);
              migrated.set(u, r2Url);
            } else {
              const dl = await httpGet(u);
              if (dl.status !== 200 || !dl.body.length) {
                stats.failed++; failures.push(`${u} → download status ${dl.status}`);
                continue;
              }
              if (dl.body.length > MAX_OBJ_BYTES) {
                stats.failed++; failures.push(`${u} → أكبر من ${Math.floor(MAX_OBJ_BYTES / 1024 / 1024)}MB (${dl.body.length}B)`);
                continue;
              }
              const ct = contentTypeFor(u, dl.headers);
              const up = await r2.put(key, dl.body, ct);
              if (up.status !== 200 && up.status !== 204) {
                stats.failed++; failures.push(`${u} → R2 PUT status ${up.status} ${up.body.toString('utf8').slice(0, 120)}`);
                continue;
              }
              const vh = await r2.head(key);
              if (vh.status !== 200) {
                stats.failed++; failures.push(`${u} → R2 verify HEAD ${vh.status}`);
                continue;
              }
              stats.uploaded++;
              r2Url = r2.publicUrl(key);
              migrated.set(u, r2Url);
              if (stats.uploaded % 25 === 0) log(`    … ${stats.uploaded} مرفوعة / ${stats.existed} موجودة / ${stats.failed} فاشلة`);
            }
          }
          const rw = rewriteValue(val, u, r2Url);
          if (rw.hits > 0) { val = rw.text; changed = true; }
        } catch (e) {
          stats.failed++; failures.push(`${u} → ${e.message}`);
        }
      }
      if (changed) {
        const setter = isJson ? `"${p.col}" = $2::jsonb` : `"${p.col}" = $2`;
        try {
          await db.pool.query(`UPDATE "${p.table}" SET ${setter} WHERE ${whereRid}`, [rid, val]);
        } catch (e) {
          failures.push(`${p.table}.${p.col} rid=${rid} → UPDATE: ${e.message}`);
        }
      }
    }
    log(`  ✓ كمل ${p.table}.${p.col} — ${done}/${rids.length} سطر عولجو`);
  }

  log('');
  log('═══ 3) الملخص ═══');
  log(`سطور تفحصو: ${stats.rows} | URLs لقيطو: ${stats.urls}`);
  log(`مرفوعة جديدة: ${stats.uploaded} | موجودة من قبل (تخطت): ${stats.existed} | على R2 أصلاً: ${stats.skippedR2}`);
  log(`sign URLs متخطاو: ${stats.signSkipped} | فاشلين: ${stats.failed}`);
  if (failures.length) {
    log('');
    log('═══ الفشلات (أول 30) ═══');
    for (const f of failures.slice(0, 30)) log(`  ✗ ${f.slice(0, 160)}`);
    if (failures.length > 30) log(`  … و ${failures.length - 30} أخرى فالتقرير`);
  }
  log('');
  log('═══ الخطوات الجاية ═══');
  log('1) افتح صفحة منتج/بروفايل فيها صورة كانت من Supabase — تأكد كتبان (URL ديالها ولو pub-….r2.dev)');
  log('2) عاود شغّل node migrate-images-r2.js (dry-run) — خاص census يرجع 0 ولا غير المتبقي');
  log('3) إلا بقاو فشلات: re-run كيعاود غير اللي فشلو (idempotent)');
  log('4) المصدر باق كامل فـ Supabase Storage — الترجع ممكن ب revert ديال URLs');
  log('5) بعد يوم/جوج قارن egress فـ Supabase Dashboard');
  await db.end();
  fs.writeFileSync(reportPath, L.join('\n') + '\n');
  log(`report: ${reportPath}`);
  process.exit(stats.failed > 0 ? 2 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
