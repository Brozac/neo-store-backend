#!/usr/bin/env node
// smoke-test.cjs — يجرب إقلاع السيرفر محليا قبل الديبلوي (F#86)
// كراش F#85 طاح في أول ثانية من التشغيل — إذن إذا السيرفر عاش 9 ثواني هنا، الديبلوي راهي سليمة.
// يحتاج .env مملوء محليا (DATABASE_URL وغيرها) — إلا ناقص يعطي تحذير كونفيغ ماشي كراش كود.
// الاستعمال:  node smoke-test.cjs
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PORT = 3987;            // بورت مؤقت باش ما يتعارضش مع سيرفر محلي خدام
const WAIT_MS = 9000;         // نستنى 9 ثواني
const EARLY_MS = 1200;        // إلا قال "listening" نسلّم بسرعة

if (!fs.existsSync(path.join(ROOT, 'server.js'))) {
  console.error('❌ ما لقيتش server.js — شغّل من جذر الريبو.');
  process.exit(1);
}

console.log('\n🚀 [laclarc-smoke] نشعل server.js محليا على PORT=' + PORT + ' (أقصى انتظار ' + (WAIT_MS / 1000) + ' ثواني)...\n');

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'development' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let finished = false;
let verdict = null; // 'listening' | 'alive'

function finish(code, msg) {
  if (finished) return;
  finished = true;
  clearTimeout(aliveTimer);
  try { child.kill('SIGTERM'); } catch (e) {}
  setTimeout(function () {
    try { child.kill('SIGKILL'); } catch (e) {}
    console.log('\n' + msg);
    process.exit(code);
  }, 300);
}

const LISTEN_RE = /listen|running|started|up on|port\s*\d+|server is/i;

child.stdout.on('data', function (d) {
  out += d.toString();
  process.stdout.write('  ' + d.toString());
  if (LISTEN_RE.test(out) && !verdict) {
    verdict = 'listening';
    finish(0, '✅ [laclarc-smoke] السيرفر قال أنه سمع — الإقلاع سليم (PASS).');
  }
});

child.stderr.on('data', function (d) {
  out += d.toString();
  process.stdout.write('  ' + d.toString());
});

const aliveTimer = setTimeout(function () {
  verdict = 'alive';
  finish(0, '✅ [laclarc-smoke] السيرفر عاش ' + (WAIT_MS / 1000) + ' ثواني بلا كراش — الإقلاع سليم (PASS).\n'
    + '   (كراش F#85 طاح في أول ثانية — اللي عاش 9 ثواني راهو مبنى مليح)');
}, WAIT_MS);

const earlyTimer = setTimeout(function () {
  if (LISTEN_RE.test(out) && !verdict) {
    verdict = 'listening';
    finish(0, '✅ [laclarc-smoke] عرفنا الإقلاع سليم من اللوج (PASS).');
  }
}, EARLY_MS);

child.on('exit', function (code, signal) {
  clearTimeout(earlyTimer);
  if (verdict) return; // كان حكم عليه بنجاح قبل ما يموت بالـ kill
  finished = true;
  clearTimeout(aliveTimer);

  const tail = out.trim().split('\n').slice(-12).join('\n  ');
  console.log('\n❌ [laclarc-smoke] السيرفر طاح قبل ' + (WAIT_MS / 1000) + ' ثواني (exit code ' + code + '). آخر اللوج:\n  ' + tail + '\n');

  if (/require is not defined|Cannot use import statement|ERR_REQUIRE_ESM|ES module/i.test(out)) {
    console.log('   🔎 التشخيص: نفس عائلة كراش F#85 — مشكل ESM/CommonJS.\n'
      + '   → شغّل: node check-deploy.cjs  ويحلّفك وين المشكل بالضبط.');
  } else if (/MODULE_NOT_FOUND|Cannot find module/i.test(out)) {
    console.log('   🔎 التشخيص: باكاج ناقص محليا (node_modules) — على Render يعمل npm install وحدو.\n'
      + '   → شغّل: npm install  ثم عاود: node smoke-test.cjs');
  } else if (/ECONNREFUSED|ENOTFOUND|password authentication|DATABASE_URL|DATABASE_URL missing|Missing environment|undefined env/i.test(out)) {
    console.log('   🔎 التشخيص: كراش كونفيغ محلي (env / DATABASE) — ماشي مشكل الكود.\n'
      + '   → عمّر .env محليا (DATABASE_URL و STRIPE_SECRET_KEY وغيرها) وعاود المحاولة.\n'
      + '   → على Render الـ env vars موجودة عندك، فالديبلوي ما يتأثرش بهاد النوع.');
  } else {
    console.log('   🔎 التشخيص: كراش في الإقلاع — راجع اللوج الفوق، وشغّل node check-deploy.cjs.');
  }
  process.exit(1);
});
