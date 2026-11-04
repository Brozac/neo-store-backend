#!/usr/bin/env node
// ============================================================
// TANK-APPLY — F#90
// كيركّب طبقة التحصين في server.js أوتوماتيكياً — بلا dependencies
// الاستعمال (من جذر الريبو الباك):  node tank-kit/tank-apply.cjs
// آمن للإعادة: إلا كان مركّب من قبل، ما يدير والو ويخرج بسلام
// Backup دايماً: server.js.bak-TANK-<وقت>
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const SERVER = path.join(ROOT, 'server.js');
const HARDENING = path.join(ROOT, 'tank-kit', 'tank-hardening.cjs');
const MARKER = '[TANK:v1]';
// المرتكز: سطر express.urlencoded الحقيقي في server.js تاع laclarc (فريد في الملف)
const ANCHORS = [
  "app.use(express.urlencoded({ limit: '2mb', extended: true }));",
  "app.use(express.json({ limit: '2mb' }));", // احتياطي إلا تبدل الأول
];

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!fs.existsSync(SERVER)) fail('server.js ماشي هنا — خدم من جذر الريبو الباك (وين كاين server.js)');
if (!fs.existsSync(HARDENING)) fail('tank-kit/tank-hardening.cjs ناقص — فك الـzip كامل في جذر الريبو الباك');

const src = fs.readFileSync(SERVER, 'utf8');

if (src.includes(MARKER)) {
  console.log('✅ [TANK] مركّب من قبل — ما كاين ما يتبدل (idempotent).');
  console.log('   تحقق حي:  curl -s http://localhost:5000/health');
  process.exit(0);
}

// نلقى المرتكز الوحيد
let anchor = null;
let idx = -1;
for (const a of ANCHORS) {
  const count = src.split(a).length - 1;
  if (count === 1) { anchor = a; idx = src.indexOf(a); break; }
  if (count > 1) fail('المرتكز "' + a.slice(0, 40) + '..." تكرر ' + count + ' مرات — ركّب السطر يدوياً (شوف TANK-README.txt §4)');
}
if (idx === -1) fail('ما لقيتش مرتكز الإدخال (express.urlencoded/json) — ركّب السطر يدوياً (TANK-README.txt §4)');

const insertAt = idx + anchor.length;
const injection =
  '\n\n// ' + MARKER + ' طبقة التحصين — /health + gzip + edge-cache(singleflight) + idempotency(checkout)\n' +
  "// ⚠️ خاصها تبقى قبل أول app.get (ترتيب الميدلوير) — ما تتحركش من بلاصتها\n" +
  "// ⚠️ الامتداد .cjs إجباري في require — Node ما كيحلّش .cjs بلا امتداد\n" +
  "require('./tank-kit/tank-hardening.cjs')(app, { pool });\n";

// Backup بطابع زمني
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bak = path.join(ROOT, 'server.js.bak-TANK-' + stamp);
fs.writeFileSync(bak, src, 'utf8');

const out = src.slice(0, insertAt) + injection + src.slice(insertAt);
fs.writeFileSync(SERVER, out, 'utf8');

// فحص syntax فوري — إلا فشل رجعنا الأصل أوتوماتيكياً
const check = spawnSync(process.execPath, ['--check', 'server.js'], { encoding: 'utf8' });
if (check.status !== 0) {
  fs.writeFileSync(SERVER, src, 'utf8'); // استرجاع
  console.error('❌ فحص node --check فشل — رجّعت server.js الأصلي. تفاصيل:');
  console.error(check.stderr || check.stdout || '(بلا تفاصيل)');
  process.exit(1);
}

console.log('✅ [TANK] التحصين تركّب بنجاح في server.js');
console.log('   🔒 Backup:      ' + path.basename(bak));
console.log('   ✅ node --check: سليم');
console.log('');
console.log('   الجاي:');
console.log('   1) git add server.js tank-kit && git commit -m "tank: /health + gzip + edge-cache + idempotency" && git pull && git push');
console.log('   2) Render → Settings → Health Check Path = /health');
console.log('   3) تحقق حي بعد الديبلوي:  curl -s https://neo-store-backend.onrender.com/health');
console.log('   التراجع الكامل:  copy "' + path.basename(bak) + '" server.js  (ثم commit/push)');
