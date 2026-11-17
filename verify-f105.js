#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   F#105 — verify-f105.js — كيتأكد بلي server.js فالحالة الصحيحة
   Usage:  node verify-f105.js server.js
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const file = process.argv.slice(2).find(a => !a.startsWith('--')) || 'server.js';
if (!fs.existsSync(file)) { console.error('❌ File not found: ' + file); process.exit(1); }
const S = fs.readFileSync(file, 'utf8');

const checks = [
  // [id, label, regex/string, category]
  ['R1-helpers',  'F105 R1: كولونات مضمونة (PDP_COLS_GUARANTEED)', 'PDP_COLS_GUARANTEED', 'F105'],
  ['R1-project',  'F105 R1: fetchProductProjected معرّف', 'function fetchProductProjected', 'F105'],
  ['R1-hook',     'F105 R1: clearProductsCache كينقّي الكاشات', /function\s+clearProductsCache[\s\S]{0,300}pdpCache\.clear\(\)|function\s+clearProductsCache[\s\S]{0,300}__pdpCache\.clear\(\)/, 'F105'],
  ['R2-limit',    'F105 R2: ريفيوزات بسقف LIMIT 50', 'ORDER BY created_at DESC LIMIT 50', 'F105'],
  ['R2-count',    'F105 R2: COUNT متوازٍ', 'COUNT(*)::int AS n FROM reviews', 'F105'],
  ['R2-meta',     'F105 R2: meta صادق (countLocal)', 'local: countLocal', 'F105'],
  ['R2-cache',    'F105 R2: Cache-Control فالريفiezات', "res.set('Cache-Control', 'public, s-maxage=120", 'F105'],
  ['R4-project',  'F105 R4: PDP كيخدم بـ fetchProductProjected', 'await fetchProductProjected(pid)', 'F105'],
  ['R4-nostar',   'F105 R4: SELECT * تبخر من PDP', 'SELECT * FROM products WHERE id = $1', 'F105-neg', true],
  ['F69-pdp',     'F#69: __pdpCache موجود (كاش PDP)', '__pdpCache', 'F69'],
  ['F69-rel',     'F#69: __relCache موجود (كاش /related)', '__relCache', 'F69'],
];

let pass = 0, fail = 0;
console.log('\n🐺 verify-f105 — ' + file);
console.log('   bytes: ' + S.length + ' · EOL: ' + (S.includes('\r\n') ? 'CRLF' : 'LF') + '\n');
for (const [id, label, pat, cat, neg] of checks) {
  const found = typeof pat === 'string' ? S.includes(pat) : pat.test(S);
  const ok = neg ? !found : found;
  if (cat === 'F69') {
    // F#69 معلوماتية برك — F105 عندو طبقة كاش خاصة بيه إلا ما كانش F#69
    const badge = ok ? 'ℹ️ ' : 'ℹ️ ';
    console.log('  ' + badge + ' ' + id.padEnd(12) + ' ' + label + (ok ? '  (F#69 موجود)' : '  (F#69 ما كاينش — F105 كيغطي بطبقتو)'));
    continue;
  }
  const badge = ok ? '✅' : '❌';
  console.log('  ' + badge + ' ' + id.padEnd(12) + ' ' + label + (ok ? '' : (neg ? '  ← مازال كاين! (خاص إصلاح)' : '  ← ناقص!')));
  if (ok) pass++; else fail++;
}

// صياغة
try {
  execFileSync('node', ['--check', file], { stdio: 'pipe' });
  console.log('  ✅ syntax        node --check PASS');
} catch (e) {
  console.log('  ❌ syntax        node --check FAIL ← رجع .bak-f105!');
  fail++;
}

console.log('\n── الحكم ──');
if (fail === 0) {
  console.log('  ✅ كلشي واجد (' + pass + '/' + checks.length + ') — الملف كامل وجاهز للـ push.');
  console.log('  👉 git add server.js && git commit -m "F105: egress projection + reviews cap" && git push');
} else {
  console.log('  ⚠️ ' + fail + ' مشكل/مشاكل فوق — صيفط لي هاد المخرجات كاملة.');
}
console.log('');
process.exit(fail ? 1 : 0);
