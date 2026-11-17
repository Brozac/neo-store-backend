#!/usr/bin/env node
'use strict';
/*
====================================================================
 F#105 UPLOAD KIT v1.1 — apply-f105-upload.js
 (v1.1: idempotency صارمة — يكشف غير route مسجّل فعلاً ولا helpers تاع الكيت،
  ما يغلطش مع سطر عرضي فيه '/api/upload' بحال comment ولا جدول proxy)
 الهدف: حقن route /api/upload فـ server.js — الرفع الداخلي (reviews/
        avatars/banners/products) يمشي لـ Cloudflare R2، ماشي Supabase.
        بلا مكتبات زايدة: SigV4 يدوي بـ crypto + fetch (Node >= 18).
        صور المنتجات الأساسية تبقى من CJ/aliyuncs (قرار F#105).

 شنو يحقن:
   POST /api/upload?folder=X   رفع صورة
        - raw : body = الملف مباشرة + Content-Type: image/*
        - json: { filename, contentType, dataBase64 }
        - X   = banners  → ADMIN_PASSWORD إجباري
                reviews | avatars | products | uploads → مفتوح + rate-limit
                30/ساعة/IP + hook f105UserAuth (تربطو بنظام المستخدمين بعدها)
        - الحدود: image/jpeg|png|webp|gif|avif — max 10MB
        - المخرجات: { ok:true, url, key, contentType, size }
   GET  /api/upload            حالة الـ config (admin)
   GET  /api/upload?selftest=1 يرفع ملف تجريبي ويرجع URL — تحقق كامل

 الاستعمال:
   node apply-f105-upload.js server.js            حقن
   node apply-f105-upload.js server.js --dry-run  فحص فقط بلا كتابة
   node apply-f105-upload.js server.js --restore  رجوع لآخر backup

 الأمان: backup تلقائي server.js.f105upload-backup-<stamp>.js
         node --check بعد الكتابة (فشل => رجوع أوتوماتيك للأصلي)
         تقرير f105-upload-report.txt — إلا فشل شي حاجة صيفطو كامل
         idempotent: إلا كان /api/upload كاين، ما يبدل والو
====================================================================
*/

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPORT_NAME = 'f105-upload-report.txt';

let target = null, dry = false, restore = false;
for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') dry = true;
  else if (a === '--restore') restore = true;
  else if (a === '--help' || a === '-h') { console.log('F#105 UPLOAD KIT — node apply-f105-upload.js server.js [--dry-run|--restore]'); process.exit(0); }
  else target = a;
}
if (!target && !restore) { console.log('F#105 UPLOAD KIT — node apply-f105-upload.js server.js [--dry-run|--restore]'); console.log('\n[X] ناقص الملف: node apply-f105-upload.js server.js'); process.exit(2); }

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

// ─── restore ───
if (restore) {
  const abs = path.resolve(cwd, target || 'server.js');
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const files = fs.readdirSync(dir).filter(f => f.startsWith(base + '.f105upload-backup-')).sort();
  if (!files.length) { console.log('[X] ما كاين حتى backup تاع upload-kit فـ ' + dir); process.exit(1); }
  fs.copyFileSync(path.join(dir, files[files.length - 1]), abs);
  console.log(`[OK] رجّعنا: ${files[files.length - 1]}  =>  ${base}`);
  process.exit(0);
}

// ─── الكود اللي غادي يحقن ───
const BLOCK = [
  '',
  '// ═══ F#105 UPLOAD: /api/upload → Cloudflare R2 (رفع داخلي — حقن ' + stamp + ') ═══',
  'const F105_IMG_TYPES = { \'image/jpeg\': \'.jpg\', \'image/png\': \'.png\', \'image/webp\': \'.webp\', \'image/gif\': \'.gif\', \'image/avif\': \'.avif\' };',
  'const F105_ADMIN_FOLDERS = [\'banners\'];',
  'const F105_USER_FOLDERS = [\'reviews\', \'avatars\', \'uploads\', \'products\'];',
  '',
  'function f105AdminAuth(req, res) {',
  '  const crypto = require(\'crypto\');',
  '  const expected = String(process.env.ADMIN_PASSWORD || \'\');',
  '  if (!expected) { res.status(500).json({ ok: false, error: \'ADMIN_PASSWORD ما محيّتش فالـ env\' }); return false; }',
  '  const got = String(req.get(\'x-admin-password\') || String(req.get(\'authorization\') || \'\').replace(/^Bearer\\s+/i, \'\'));',
  '  const a = Buffer.from(got), b = Buffer.from(expected);',
  '  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.status(401).json({ ok: false, error: \'unauthorized\' }); return false; }',
  '  return true;',
  '}',
  '',
  '// ←←← HOOK: ملي تربط نظام المستخدمين حط هنا فحص الجلسة/JWT تاعك (حالياً: مسموح + rate-limit)',
  'function f105UserAuth(req) { return true; }',
  '',
  'const f105RateMap = new Map();',
  'function f105RateOk(ip) {',
  '  const now = Date.now(), win = 60 * 60 * 1000, max = 30;',
  '  const arr = (f105RateMap.get(ip) || []).filter(t => now - t < win);',
  '  if (arr.length >= max) { f105RateMap.set(ip, arr); return false; }',
  '  arr.push(now); f105RateMap.set(ip, arr);',
  '  if (f105RateMap.size > 5000) f105RateMap.clear();',
  '  return true;',
  '}',
  '',
  'function f105R2Config() {',
  '  const accountId = process.env.R2_ACCOUNT_ID || \'\';',
  '  const bucket = process.env.R2_BUCKET || \'\';',
  '  const pub = String(process.env.R2_PUBLIC_BASE_URL || \'\').replace(/\\/+$/, \'\');',
  '  if (!accountId || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !pub) return null;',
  '  return { host: accountId + \'.r2.cloudflarestorage.com\', bucket: bucket, pub: pub, keyId: process.env.R2_ACCESS_KEY_ID, secret: process.env.R2_SECRET_ACCESS_KEY };',
  '}',
  '',
  'async function f105R2PutObject(key, body, contentType) {',
  '  const cfg = f105R2Config();',
  '  if (!cfg) throw new Error(\'R2 config ناقصة فالـ env\');',
  '  const crypto = require(\'crypto\');',
  '  const payloadHash = crypto.createHash(\'sha256\').update(body).digest(\'hex\');',
  '  const amzDate = new Date().toISOString().replace(/[:-]|\\.\\d{3}/g, \'\');',
  '  const dateStamp = amzDate.slice(0, 8);',
  '  const canonicalUri = \'/\' + cfg.bucket + \'/\' + key.split(\'/\').map(encodeURIComponent).join(\'/\');',
  '  const canonicalHeaders = \'content-type:\' + contentType + \'\\nhost:\' + cfg.host + \'\\nx-amz-content-sha256:\' + payloadHash + \'\\nx-amz-date:\' + amzDate + \'\\n\';',
  '  const signedHeaders = \'content-type;host;x-amz-content-sha256;x-amz-date\';',
  '  const canonicalRequest = [\'PUT\', canonicalUri, \'\', canonicalHeaders, signedHeaders, payloadHash].join(\'\\n\');',
  '  const scope = dateStamp + \'/auto/s3/aws4_request\';',
  '  const stringToSign = [\'AWS4-HMAC-SHA256\', amzDate, scope, crypto.createHash(\'sha256\').update(canonicalRequest).digest(\'hex\')].join(\'\\n\');',
  '  const kDate = crypto.createHmac(\'sha256\', \'AWS4\' + cfg.secret).update(dateStamp).digest();',
  '  const kRegion = crypto.createHmac(\'sha256\', kDate).update(\'auto\').digest();',
  '  const kService = crypto.createHmac(\'sha256\', kRegion).update(\'s3\').digest();',
  '  const kSigning = crypto.createHmac(\'sha256\', kService).update(\'aws4_request\').digest();',
  '  const signature = crypto.createHmac(\'sha256\', kSigning).update(stringToSign).digest(\'hex\');',
  '  const r = await fetch(\'https://\' + cfg.host + canonicalUri, {',
  '    method: \'PUT\',',
  '    headers: {',
  '      \'content-type\': contentType,',
  '      \'x-amz-date\': amzDate,',
  '      \'x-amz-content-sha256\': payloadHash,',
  '      Authorization: \'AWS4-HMAC-SHA256 Credential=\' + cfg.keyId + \'/\' + scope + \', SignedHeaders=\' + signedHeaders + \', Signature=\' + signature,',
  '    },',
  '    body: body,',
  '  });',
  '  if (!r.ok) throw new Error(\'R2 PUT \' + r.status + \': \' + (await r.text()).slice(0, 300));',
  '  return cfg.pub + \'/\' + key;',
  '}',
  '',
  'async function f105UploadHandler(req, res) {',
  '  const folder = String(req.query.folder || \'uploads\');',
  '  const isAdminFolder = F105_ADMIN_FOLDERS.includes(folder);',
  '  if (!F105_ADMIN_FOLDERS.concat(F105_USER_FOLDERS).includes(folder)) return res.status(400).json({ ok: false, error: \'folder غير مسموح: \' + folder });',
  '  if (isAdminFolder) { if (!f105AdminAuth(req, res)) return; }',
  '  else if (!f105UserAuth(req)) return res.status(401).json({ ok: false, error: \'unauthorized\' });',
  '  else if (!f105RateOk((req.headers[\'x-forwarded-for\'] || \'\').split(\',\')[0].trim() || req.ip || \'x\')) return res.status(429).json({ ok: false, error: \'كثيرة بزاف — عاود من بعد ساعة\' });',
  '',
  '  let buf = null, ct = \'\';',
  '  if (Buffer.isBuffer(req.body)) { buf = req.body; ct = String(req.headers[\'content-type\'] || \'\').split(\';\')[0].trim(); }',
  '  else if (req.body && req.body.dataBase64) { buf = Buffer.from(String(req.body.dataBase64), \'base64\'); ct = String(req.body.contentType || \'image/jpeg\').split(\';\')[0].trim(); }',
  '  if (!buf || !buf.length) return res.status(400).json({ ok: false, error: \'بلا ملف — صيفط image/* مباشرة ولا JSON {filename, contentType, dataBase64}\' });',
  '  const ext = F105_IMG_TYPES[ct];',
  '  if (!ext) return res.status(415).json({ ok: false, error: \'نوع غير مدعوم: \' + ct, allowed: Object.keys(F105_IMG_TYPES) });',
  '  if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ ok: false, error: \'الملف > 10MB\' });',
  '  try {',
  '    const d = new Date();',
  '    const key = folder + \'/\' + d.getFullYear() + \'/\' + String(d.getMonth() + 1).padStart(2, \'0\') + \'/\' + Date.now() + \'-\' + require(\'crypto\').randomBytes(5).toString(\'hex\') + ext;',
  '    const url = await f105R2PutObject(key, buf, ct);',
  '    res.json({ ok: true, url: url, key: key, contentType: ct, size: buf.length });',
  '  } catch (e) {',
  '    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });',
  '  }',
  '}',
  '',
  '// حالة الـ config + selftest (admin برك):',
  '__APP__.get(\'/api/upload\', async (req, res) => {',
  '  if (!f105AdminAuth(req, res)) return;',
  '  const cfg = f105R2Config();',
  '  if (!cfg) return res.status(500).json({ ok: false, error: \'R2 env ناقصة\', need: [\'R2_ACCOUNT_ID\', \'R2_BUCKET\', \'R2_ACCESS_KEY_ID\', \'R2_SECRET_ACCESS_KEY\', \'R2_PUBLIC_BASE_URL\'] });',
  '  if (req.query.selftest === \'1\') {',
  '    try {',
  '      const key = \'test/selftest-\' + Date.now() + \'.txt\';',
  '      const url = await f105R2PutObject(key, Buffer.from(\'F105 selftest \' + new Date().toISOString()), \'text/plain\');',
  '      return res.json({ ok: true, selftest: url, bucket: cfg.bucket, publicBase: cfg.pub });',
  '    } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }',
  '  }',
  '  res.json({ ok: true, bucket: cfg.bucket, publicBase: cfg.pub, folders: { admin: F105_ADMIN_FOLDERS, user: F105_USER_FOLDERS } });',
  '});',
  "__APP__.post('/api/upload', __EX__.raw({ type: 'image/*', limit: '10mb' }), __EX__.json({ limit: '12mb' }), (req, res) => f105UploadHandler(req, res));",
  '// ═══ نهاية F#105 UPLOAD ═══',
].join('\n');

(async () => {
  const abs = path.resolve(cwd, target);
  const report = [];
  const L = (s = '') => { report.push(s); console.log(s); };

  L('');
  L('═══ F#105 UPLOAD KIT v1.1 ' + (dry ? '— DRY-RUN (فحص فقط)' : '— APPLY') + ' ═══');
  L('target: ' + abs);
  if (!fs.existsSync(abs)) { L('[X] الملف ما موجود'); writeReport(report); process.exit(2); }

  const original = fs.readFileSync(abs, 'utf8');
  L(`[i] ${path.basename(abs)}: ${original.split('\n').length} سطر`);

  const baselineErr = syntaxCheck(abs);
  if (baselineErr) {
    L('[X] server.js ماشي سليم قبل التعديل — وقفنا: ' + String(baselineErr).split('\n')[0]);
    writeReport(report); process.exit(2);
  }
  L('[OK] node --check (قبل التعديل): سليم');

  // ─── idempotency (v1.1 صارمة: غير route مسجّل ولا helpers تاع الكيت) ───
  const f105RouteExists = /\.(?:get|post|put|all|use)\s*\(\s*['"`]\/api\/upload['"`]/.test(original)
    || /f105UploadHandler|f105R2PutObject|F105_IMG_TYPES/.test(original);
  if (f105RouteExists) {
    L('[i] route /api/upload كاين من قبل — حتى كتابة ما تمت (idempotent).');
    L('    إلا بغيت تعاود من الصفر: node apply-f105-upload.js server.js --restore ثم عاود.');
    writeReport(report); process.exit(0);
  }

  // ─── detect var names ───
  let ex = 'express', appVar = 'app';
  const exM = /(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]express['"]\s*\)/.exec(original);
  if (exM) ex = exM[1]; else L('[!] ما لقيتش require(\'express\') — نستعملو "express" (راجع من بعد)');
  const exEsc = ex.replace(/[$]/g, '\\$');
  if (new RegExp('(?:const|var|let)\\s+app\\s*=\\s*' + exEsc + '\\s*\\(\\s*\\)').test(original)) {
    appVar = 'app';
  } else {
    const appM = new RegExp('(?:const|var|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' + exEsc + '\\s*\\(\\s*\\)').exec(original);
    if (appM) appVar = appM[1]; else L('[!] ما لقيتش ' + ex + '() — نستعملو "app"');
  }
  L(`[i] متغيرات مكتشفين: express=${ex}, app=${appVar}`);

  // ─── env sanity (تقرير برك — القيم ما تتطبعش) ───
  const envDir = fs.existsSync(path.join(cwd, '.env')) ? cwd : path.dirname(abs);
  const env = loadDotEnv(envDir);
  const missing = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BASE_URL']
    .filter(k => !env[k] && !process.env[k]);
  if (missing.length) L('[!] نواقص فالـ env (' + envDir + '/.env ولا Render): ' + missing.join(', ') + ' — الـ route يركب لكن الرفع ما يخدمش حتى يكملو');
  if (!env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD) L('[!] ADMIN_PASSWORD ما كاينش — auth تاع banners/selftest ما يخدمش حتى تزيدو');
  L('');

  // ─── injection point: قبل app.listen الأول ───
  const appEsc = appVar.replace(/[$]/g, '\\$');
  const listenRe = new RegExp('\n[ \\t]*' + appEsc + '\\.listen\\s*\\(');
  const listenM = listenRe.exec(original);
  let code;
  const blockCode = BLOCK.split('__APP__').join(appVar).split('__EX__').join(ex);
  if (listenM) {
    code = original.slice(0, listenM.index) + '\n' + blockCode + original.slice(listenM.index);
    L(`[OK] نقطة الحقن: قبل ${appVar}.listen (سطر ${original.slice(0, listenM.index).split('\n').length})`);
  } else {
    code = original + '\n' + blockCode;
    L('[i] ما لقيتش ' + appVar + '.listen — حقنّا فآخر الملف (سليم برك)');
  }

  // ─── write ───
  L('');
  if (dry) {
    L('[DRY-RUN] حتى كتابة ما تمت.');
    L('  المخطط: حقن route POST/GET /api/upload + helpers (auth/rate-limit/SigV4/selftest)');
  } else {
    const backupName = `${path.basename(abs)}.f105upload-backup-${stamp}.js`;
    fs.writeFileSync(path.join(path.dirname(abs), backupName), original);
    fs.writeFileSync(abs, code);
    const err = syntaxCheck(abs);
    if (err) {
      fs.writeFileSync(abs, original);
      L('[X] node --check فشل من بعد الحقن — رجّعنا الأصلي أوتوماتيك. التفاصيل:');
      L(String(err).split('\n').slice(0, 8).join('\n'));
      writeReport(report); process.exit(1);
    }
    L(`[OK] كتبنا ${path.basename(abs)} + node --check: OK`);
    L(`[OK] backup: ${backupName}`);
    L('');
    L('NEXT:');
    L('  1) node --check ' + path.basename(abs) + ' (زادة) && npm start');
    L('  2) curl -s "http://localhost:3000/api/upload?selftest=1" -H "x-admin-password: <ADMIN_PASSWORD>"');
    L('  3) افتح الـ URL تاع selftest فالمتصفح — لازم يبان نص الملف (توثيق+bucket+public access)');
    L('  4) git add ' + path.basename(abs) + ' && git commit -m "F#105: /api/upload -> R2 (internal uploads)" && git push origin main');
    L('  5) فالواجهة: lib/upload-r2.js — uploadToR2(file, \'reviews\'|\'avatars\'|\'banners\', authHeaders)');
  }
  L('');
  writeReport(report);
  process.exit(0);
})().catch(e => {
  console.error('[X] FATAL: ' + (e && e.message ? e.message : e));
  writeReport(['[X] FATAL: ' + (e && e.message ? e.message : String(e))]);
  process.exit(1);
});
