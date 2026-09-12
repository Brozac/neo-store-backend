'use strict';
// cleanup_redundant.js — حيد فرع CREATED الضعيف من كرون التتبع (المالك: كرون Auto-Heal الكامل)
const fs = require('fs'), vm = require('vm');
const S = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\server.js';
let src = fs.readFileSync(S, 'utf8');
const before = src;

const START = "} else if (status === 'CREATED' && !d.logisticName && !d.paymentDate) {";
const END = "} else if (status === 'DELIVERED') {";

if (!src.includes(START)) { console.log('SKIP — الفرع القديم راهو محيّا'); process.exit(0); }
if (!src.includes(END)) { console.log('FAIL — DELIVERED anchor غير موجود'); process.exit(1); }

const s = src.indexOf(START);
const e = src.indexOf(END, s);
if (e === -1 || e <= s) { console.log('FAIL — ترتيب غالط'); process.exit(1); }

// كيحيد الكل ما بين بداية فرع CREATED وبداية فرع DELIVERED، ويخلي DELIVERED كما هو
src = src.slice(0, s) + END + src.slice(e + END.length);

fs.writeFileSync(S, src, 'utf8');
try {
  new vm.Script(src, { filename: 'server.js' });
  console.log('OK   فرع CREATED الضعيف تحيّا — DELIVERED سليم');
  console.log('syntax: OK -> ✅ FIXED — commit & push');
} catch (e) {
  console.log('syntax BAD: ' + e.message);
  fs.writeFileSync(S, before, 'utf8');
  console.log('-> restored، بلا ضرر');
}