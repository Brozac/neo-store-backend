#!/usr/bin/env node
// install-guard.cjs — يركب هوك pre-push في .git/hooks تاع الريبو (F#86)
// من بعد هاد الأمر: كل git push يفحص package.json والكود قبل ما يخرج من الجهاز
// الاستعمال:  node install-guard.cjs            (للتركيب)
//             node install-guard.cjs --uninstall (للحذف)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const gitDir = path.join(ROOT, '.git');
const hooksDir = path.join(gitDir, 'hooks');
const hookPath = path.join(hooksDir, 'pre-push');

if (process.argv.includes('--uninstall')) {
  if (fs.existsSync(hookPath)) {
    fs.unlinkSync(hookPath);
    console.log('🗑️  الهوك تحيّد: ' + hookPath);
  } else {
    console.log('ما كاينش هوك pre-push باش يتحيّد.');
  }
  process.exit(0);
}

if (!fs.existsSync(gitDir)) {
  console.error('❌ ما لقيتش .git هنا — شغّل الأمر من جذر الريبو (وين كاين package.json تاع الباك).');
  process.exit(1);
}

// شيك أن check-deploy.cjs راهي في الجذر (الهوك يستدعيها)
if (!fs.existsSync(path.join(ROOT, 'check-deploy.cjs'))) {
  console.error('❌ check-deploy.cjs ماكاش في جذر الريبو — نجّمعها مع install-guard.cjs في نفس البلاصة قبل التركيب.');
  process.exit(1);
}

const hook = [
  '#!/bin/sh',
  '# laclarc deploy guard (F#86) — يمنع الـ push إذا package.json ماشي نتاع الباك',
  '# يتحيّد بـ: node install-guard.cjs --uninstall',
  'echo ""',
  'echo "[laclarc-guard] فحص سريع قبل الديبلوي..."',
  'if command -v node >/dev/null 2>&1; then',
  '  node check-deploy.cjs',
  '  code=$?',
  '  if [ $code -ne 0 ]; then',
  '    echo ""',
  '    echo "[laclarc-guard] الـ push توقف — صلح المشاكل الفوق وأعد المحاولة."',
  '    echo "[laclarc-guard] باش تتجاهل الفحص (على مسؤوليتك): git push --no-verify"',
  '    exit 1',
  '  fi',
  'else',
  '  echo "[laclarc-guard] node ماكاينش في PATH — الفحص تجاوز."',
  'fi',
  'exit 0',
  '',
].join('\n');

fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(hookPath, hook);
try { fs.chmodSync(hookPath, 0o755); } catch (e) { /* ويندوز ما يحتاجش chmod */ }

console.log('✅ الهوك رُكب: ' + hookPath);
console.log('   من الآن: كل git push يشغّل check-deploy.cjs قبل ما يخرج — إذا package.json غالطة، الـ push يوقف.');
console.log('   تجربة فورية: node check-deploy.cjs');
