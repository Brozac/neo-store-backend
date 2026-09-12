'use strict';
// fix_sandbox_guard.js — منع sandbox فالإنتاج + تحذير صريح
const fs = require('fs'), vm = require('vm');
const P = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjService.js';
let src = fs.readFileSync(P, 'utf8');
const before = src;

const OLD = "const isSandbox = process.env.CJ_SANDBOX_MODE === 'true' ? 1 : 0;";
const NEW = `// 🛡️ حماية الإنتاج: الساندبوكس مسموح فقط فالتطوير المحلي — الطلبات الساندبوكس ما تُشحنش أبداً!
    const isSandbox = (process.env.CJ_SANDBOX_MODE === 'true' && process.env.NODE_ENV !== 'production') ? 1 : 0;
    if (isSandbox) console.warn('🧪 [SANDBOX] طلب #' + orderId + ' كيتخلق sandbox — ما غاديش يشحن!');`;

if (src.includes("process.env.NODE_ENV !== 'production'")) {
  console.log('SKIP — الحارس راه موجود');
} else {
  const cnt = src.split(OLD).length - 1;
  if (cnt !== 1) { console.log('FAIL occurrences=' + cnt + ' (متوقع 1) — ما بدلت والو، صيفط الـ output'); process.exit(1); }
  src = src.split(OLD).join(NEW);
  console.log('OK   sandbox guard حطيت');
}

fs.writeFileSync(P, src, 'utf8');
try {
  new vm.Script(src, { filename: 'cjService.js' });
  console.log('syntax: OK -> ✅ FIXED — commit & push');
  fs.writeFileSync(P, src, 'utf8');
} catch (e) {
  console.log('syntax BAD: ' + e.message);
  fs.writeFileSync(P, before, 'utf8');
  console.log('-> restored، بلا ضرر');
}