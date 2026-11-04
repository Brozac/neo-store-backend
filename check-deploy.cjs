#!/usr/bin/env node
// check-deploy.cjs — حارس الديبلوي تاع laclarc-backend (F#86)
// الامتداد .cjs مقصود: يبقى CommonJS دائما حتى لو package.json تبدل بالغلط لـ "type":"module"
// يخدم في 3 بلايص: هوك الجيت (pre-push) · Render Build Command · يدويا قبل الديبلوي
// الاستعمال:  node check-deploy.cjs     (من جذر الريبو)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const problems = [];
const warns = [];
const goods = [];

function fail(msg) { problems.push(msg); }
function warn(msg) { warns.push(msg); }
function good(msg) { goods.push(msg); }

const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
const noColor = !process.stdout.isTTY;
function paint(code, s) { return noColor ? s : code + s + C.reset; }

console.log(paint(C.cyan + C.bold, '\n🛡️  [laclarc-guard] فحص قبل الديبلوي — ' + ROOT + '\n'));

// ---------- 1) package.json موجود ويتقرا ----------
const pkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) {
  console.error(paint(C.red, '❌ ما كاينش package.json في جذر الريبو!'));
  process.exit(1);
}
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  good('package.json يتقرا (JSON سليم)');
} catch (e) {
  console.error(paint(C.red, '❌ package.json مكسور (JSON خايب): ' + e.message));
  process.exit(1);
}

// ---------- 2) الاسم = backend (ماشي supakit!) ----------
if (pkg.name === 'backend') {
  good('الاسم = "backend" ✓');
} else if (pkg.name === 'laclarc-supakit') {
  fail('package.json نتاع supakit تنسخ بالغلط لجذر الباك (name="laclarc-supakit")!');
} else {
  fail('الاسم ماشي "backend" (راهي: "' + pkg.name + '") — يعني package.json نتاع مشروع آخر');
}

// ---------- 3) type = commonjs (درس F#85) ----------
const type = pkg.type;
if (type === 'commonjs') {
  good('type: "commonjs" ✓ — require() خدام');
} else if (type === undefined) {
  good('ما كاينش "type" — Node يفهم CommonJS (سليم)');
} else if (type === 'module') {
  fail('type: "module" — Node يقرا server.js (المكتوب بـ require) كـ ESM → كراش '
    + '"ReferenceError: require is not defined in ES module scope" (نفس كراش F#85)\n'
    + '   → الحل: حيد سطر "type": "module" ولا بدلو لـ "type": "commonjs"');
} else {
  fail('type غريب: "' + type + '" — حط "commonjs"');
}

// ---------- 4) الديبندانسيات الحرجة (21 تاع النسخة السليمة 506522ea) ----------
const REQUIRED_DEPS = [
  '@google/generative-ai', '@sentry/node', 'axios', 'bcrypt', 'cheerio', 'cloudinary',
  'cookie-parser', 'cors', 'dotenv', 'express', 'express-rate-limit', 'jsonwebtoken',
  'multer', 'multer-storage-cloudinary', 'node-cron', 'nodemailer', 'pg',
  'puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth', 'stripe',
];
const deps = pkg.dependencies || {};
const missing = REQUIRED_DEPS.filter(function (d) { return !deps[d]; });
if (missing.length === 0) {
  good('الديبندانسيات كاملة (' + REQUIRED_DEPS.length + '/' + REQUIRED_DEPS.length + ') ✓');
} else {
  fail('ديبندانسيات ناقصة (' + missing.length + '): ' + missing.join(', ')
    + '\n   → package.json ماشي نتاع الباك، استرجع نسخة سليمة');
}

// ---------- 5) scripts.start يشير لملف موجود ----------
const startCmd = pkg.scripts && pkg.scripts.start;
const startFile = startCmd ? String(startCmd).replace(/^node\s+/, '').trim() : null;
if (startFile && fs.existsSync(path.join(ROOT, startFile))) {
  good('scripts.start: "' + startCmd + '" ✓ والملف موجود');
} else {
  fail('scripts.start غلط ولا الملف ما كاين: "' + startCmd + '"');
}

// ---------- 6) شجرة الـ lock كاملة (الباك ≈ 275 · supakit ≈ 16) ----------
const lockPath = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const n = Object.keys(lock.packages || {}).length;
    if (n >= 100) {
      good('package-lock.json: ' + n + ' باكاج (شجرة الباك الكاملة) ✓');
    } else {
      fail('package-lock.json فيها غير ' + n + ' باكاج — شجرة مشروع آخر (supakit ≈ 16)!\n'
        + '   → استرجع lock تاع الباك أو يمحي (Render يعاود يبنيه من dependencies)');
    }
  } catch (e) {
    warn('package-lock.json ما تقراش: ' + e.message);
  }
} else {
  warn('ما كاينش package-lock.json — npm يبني من dependencies (مقبول، لكن الأفضل يكون موجود)');
}

// ---------- 7) فحص الكود: require داخل ESM / import داخل CJS ----------
const cjsHint = /\brequire\s*\(|\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\b__dirname\b|\b__filename\b/;
const esmHint = /^\s*import\s+[\w'"{$]|^\s*export\s+(?:default|const|let|var|function|class|async|\{|\*)/m;

const BOOT_CHAIN = [
  'server.js', 'db.js', 'logger.js',
  'routes', 'controllers', 'middleware', 'services', 'lib', 'utils', 'emails',
];

function collectJs(absPath, relPath, out, depth) {
  let st;
  try { st = fs.statSync(absPath); } catch (e) { return; }
  if (st.isDirectory()) {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(absPath); } catch (e) { return; }
    entries.forEach(function (name) {
      if (name === 'node_modules' || name.startsWith('.')) return;
      collectJs(path.join(absPath, name), path.join(relPath, name), out, depth + 1);
    });
  } else if (/\.js$/.test(absPath) && !/\.cjs$|\.mjs$/.test(absPath)) {
    out.push(relPath);
  }
}

const scanned = [];
BOOT_CHAIN.forEach(function (t) { collectJs(path.join(ROOT, t), t, scanned, 0); });

let cjsFiles = 0;
scanned.forEach(function (rel) {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return; }
  if (cjsHint.test(src)) cjsFiles++;
  if (esmHint.test(src) && type !== 'module') {
    fail(rel + ' فيه syntax ESM (import/export) والمشروع CommonJS → يكراش وقت التشغيل\n'
      + '   → حوّلو لـ require() ولا بدل امتداده لـ .mjs');
  }
});

if (type === 'module' && cjsFiles > 0) {
  fail('في الكود ' + cjsFiles + ' ملف .js مكتوب بـ require() (CommonJS) و"type": "module" مفعّل → يكراشو مع بعض\n'
    + '   → الحل الموحد: حيد "type": "module" من package.json');
}
if (scanned.length > 0 && problems.length === 0) {
  good('فحص الكود: ' + scanned.length + ' ملف في سلسلة الإقلاع (server/db/routes/controllers/...) — لا require في ESM ولا import في CJS ✓');
}

// ---------- النتيجة ----------
console.log('');
goods.forEach(function (g) { console.log(paint(C.green, '  ✓  ') + g); });
warns.forEach(function (w) { console.log(paint(C.yellow, '  ⚠  ') + w); });
problems.forEach(function (p) {
  console.log(paint(C.red, '\n  ✗  ' + p));
});

if (problems.length > 0) {
  console.log(paint(C.red + C.bold, '\n🛑 DEPLOY BLOCKED — صلح المشاكل الفوق قبل الـ push\n'));
  console.log(paint(C.dim, '   الإصلاح السريع المعروف:  git checkout 506522ea -- package.json && git commit -m "restore package.json" && git push\n'));
  process.exit(1);
}

console.log(paint(C.green + C.bold, '\n✅ SAFE TO DEPLOY — package.json والكود متوافقين، الديبلوي راهي سليمة\n'));
process.exit(0);
