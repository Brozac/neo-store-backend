'use strict';
// fix_override.js — fulfillCJOrder يقبل orderNumberOverride اختياري (لإعادة الإنشاء بعد delete)
const fs = require('fs'), vm = require('vm');
const P = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjService.js';
let src = fs.readFileSync(P, 'utf8');
const before = src;

// [1] التوقيع
const OLD1 = 'async function fulfillCJOrder(orderId, customerName, customerDetails, items) {';
const NEW1 = 'async function fulfillCJOrder(orderId, customerName, customerDetails, items, orderNumberOverride = null) {';
if (src.includes(NEW1)) console.log('SKIP [1] signature');
else if (src.split(OLD1).length - 1 !== 1) { console.log('FAIL [1]'); process.exit(1); }
else { src = src.split(OLD1).join(NEW1); console.log('OK   [1] signature + override'); }

// [2] الاستعمال
const OLD2 = 'const targetOrderNumber = `STORE-${orderId}`;';
const NEW2 = 'const targetOrderNumber = orderNumberOverride || `STORE-${orderId}`;';
if (src.includes(NEW2)) console.log('SKIP [2] usage');
else if (src.split(OLD2).length - 1 !== 1) { console.log('FAIL [2] occurrences=' + (src.split(OLD2).length - 1)); process.exit(1); }
else { src = src.split(OLD2).join(NEW2); console.log('OK   [2] targetOrderNumber يحترم override'); }

fs.writeFileSync(P, src, 'utf8');
try { new vm.Script(src, { filename: 'cjService.js' }); console.log('syntax: OK -> ✅ FIXED'); }
catch (e) { console.log('syntax BAD: ' + e.message); fs.writeFileSync(P, before, 'utf8'); console.log('-> restored'); }