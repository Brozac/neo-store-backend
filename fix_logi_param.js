'use strict';
// fix_logi_param.js — fulfillCJOrder يقبل logisticName اختياري (الباراميتر السادس)
const fs = require('fs'), vm = require('vm');
const P = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjService.js';
let src = fs.readFileSync(P, 'utf8');
const before = src;

const OLD1 = 'async function fulfillCJOrder(orderId, customerName, customerDetails, items, orderNumberOverride = null) {';
const NEW1 = 'async function fulfillCJOrder(orderId, customerName, customerDetails, items, orderNumberOverride = null, forcedLogisticName = null) {';
if (src.includes(NEW1)) console.log('SKIP [1]');
else if (src.split(OLD1).length - 1 !== 1) { console.log('FAIL [1]'); process.exit(1); }
else { src = src.split(OLD1).join(NEW1); console.log('OK   [1] signature + forcedLogisticName'); }

const OLD2 = "logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Ordinary', 'CJPacket Sensitive', 'YunExpress', '4PX'])];";
const NEW2 = "if (forcedLogisticName) logisticsToTry = [forcedLogisticName]; // ⭐ فرض صريح يتقدم على كولش\n    else logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Ordinary', 'CJPacket Sensitive', 'YunExpress', '4PX'])];";
if (src.includes("if (forcedLogisticName) logisticsToTry")) console.log('SKIP [2]');
else if (src.split(OLD2).length - 1 !== 1) { console.log('FAIL [2]'); process.exit(1); }
else { src = src.split(OLD2).join(NEW2); console.log('OK   [2] forced logistic أول القائمة'); }

fs.writeFileSync(P, src, 'utf8');
try { new vm.Script(src, { filename: 'cjService.js' }); console.log('syntax: OK -> ✅ FIXED'); }
catch (e) { console.log('syntax BAD: ' + e.message); fs.writeFileSync(P, before, 'utf8'); console.log('-> restored'); }