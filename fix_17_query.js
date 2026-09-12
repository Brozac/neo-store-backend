'use strict';
// fix_17_query.js — درس 1.7: param=orderId + extractCjNumber يفضل cjOrderCode (SD)
const fs = require('fs'), vm = require('vm');
const C = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjService.js';
let src = fs.readFileSync(C, 'utf8');
const before = src;
const problems = [];

// [1] مسار استرجاع 1603003: orderNumber -> orderId (درس "orderId must be not empty")
{
  const OLD = 'params: { orderNumber: targetOrderNumber },';
  const NEW = 'params: { orderId: targetOrderNumber }, // ⭐ 1.7: اسم الـ param هو orderId — ويقبل STORE-x مباشرة';
  if (src.includes(NEW)) console.log('SKIP [1] recovery param');
  else {
    const cnt = src.split(OLD).length - 1;
    if (cnt !== 1) { console.log('FAIL [1] occurrences=' + cnt); problems.push('recovery-param'); }
    else { src = src.split(OLD).join(NEW); console.log('OK   [1] 1603003 recovery: orderId param'); }
  }
}

// [2] extractCjNumber: cjOrderCode (SD) أولاً — حيت query responses فيه orderId رقمي!
{
  const OLD = 'if (d.orderId && !isOurEcho(d.orderId)) return d.orderId;';
  const NEW = 'if (d.cjOrderCode) return d.cjOrderCode; // ⭐ 1.7/1.16: SD... هو اللي كييجي فالويب هوكات\n      if (d.orderId && !isOurEcho(d.orderId)) return d.orderId;';
  if (src.includes('if (d.cjOrderCode) return d.cjOrderCode')) console.log('SKIP [2] extractCjNumber');
  else {
    const cnt = src.split(OLD).length - 1;
    if (cnt !== 1) { console.log('FAIL [2] occurrences=' + cnt); problems.push('extract'); }
    else { src = src.split(OLD).join(NEW); console.log('OK   [2] cjOrderCode أولاً (SD...)'); }
  }
}

fs.writeFileSync(C, src, 'utf8');
console.log('\n[syntax]:');
try { new vm.Script(src, { filename: 'cjService.js' }); console.log('  OK   cjService.js -> ✅ FIXED — commit & push'); }
catch (e) { console.log('  BAD  ' + e.message); fs.writeFileSync(C, before, 'utf8'); console.log('  -> restored'); problems.push('syntax'); }
if (problems.length) console.log('PROBLEMS: ' + problems.join(' | '));