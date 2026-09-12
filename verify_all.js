'use strict';
// verify_all.js — يتحقق من كل الباتشات: المطبقين المؤكدين + المجهولين + التكرارات
const fs = require('fs'), vm = require('vm');
const B = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\';
const rd = p => fs.readFileSync(B + p, 'utf8');
let problems = [];
console.log('=========== VERIFY ALL PATCHES ===========\n');

const cw = rd('services\\cjWebhookService.js');
const cs = rd('services\\cjService.js');
const sv = rd('server.js');
const pc = rd('controllers\\paymentController.js');

function chk(name, found, file, critical) {
  const icon = found ? '[OK]  ' : (critical ? '[MISS]' : '[opt] ');
  console.log(icon + name + (found ? '' : '  <-- ' + file));
  if (!found && critical) problems.push(name);
}

// ===== المؤكدين (باش نتأكدو ما تبدلش والو) =====
console.log('--- CONFIRMED EARLIER ---');
chk('golden: isOurEcho (extract v2)', cs.includes('isOurEcho'), 'cjService.js', true);
chk('golden: let orderInfoRes', sv.includes('let orderInfoRes'), 'server.js', true);
chk('golden: tracking fallback', sv.includes('fallback'), 'server.js', true);
chk('sandbox guard (NODE_ENV check)', cs.includes("process.env.NODE_ENV !== 'production'"), 'cjService.js', true);
chk('sendAdminEmail (makeup)', cw.includes('async function sendAdminEmail'), 'cjWebhookService.js', true);
chk('sendEmailDirect (customer)', cw.includes('async function sendEmailDirect'), 'cjWebhookService.js', true);
chk('notifyShipment unified', cw.includes('async function notifyShipment'), 'cjWebhookService.js', true);
chk('cjPace QPS gate', cs.includes('cjPace'), 'cjService.js', true);
chk('sendAdminAlert (cjService)', cs.includes('async function sendAdminAlert'), 'cjService.js', true);
chk('platform others (5027 fix)', cs.includes("platform: 'others'"), 'cjService.js', true);

// ===== المجهولين (الأهم!) =====
console.log('\n--- UNKNOWN (files deleted - patches applied?) ---');
chk('OFFICIAL status map (UNSHIPPED)', cw.includes('UNSHIPPED'), 'cjWebhookService.js', true);
chk('BATCH tracking cron v3 (getOrderDetailBatch in server)', sv.includes('getOrderDetailBatch'), 'server.js', true);
chk('1.7 lesson: recovery orderId param', cs.includes('orderId: targetOrderNumber'), 'cjService.js', true);
chk('1.7 lesson: cjOrderCode first', cs.includes('if (d.cjOrderCode) return d.cjOrderCode'), 'cjService.js', true);

// ===== auto-heal (الجدد) =====
console.log('\n--- AUTO-HEAL (new) ---');
chk('autoRepairLogistics fn', cs.includes('async function autoRepairLogistics'), 'cjService.js', true);
chk('deleteCJOrder (1.8)', cs.includes('async function deleteCJOrder'), 'cjService.js', true);
chk('payCJOrderBalance (2.2)', cs.includes('async function payCJOrderBalance'), 'cjService.js', true);
chk('logisticsMiss prevention [B]', cs.includes('logisticsMiss === true'), 'cjService.js', true);
chk('Auto-Heal cron [C2]', sv.includes('Auto-Heal cron'), 'server.js', true);
chk('full import (8 names)', sv.includes('deleteCJOrder, payCJOrderBalance'), 'server.js', true);
chk('final exports (8 names)', cs.includes('deleteCJOrder, payCJOrderBalance };'), 'cjService.js', true);

// ===== فحص التكرار =====
console.log('\n--- REDUNDANCY CHECK ---');
const createdBranchInTracking = sv.indexOf("status === 'CREATED' && !d.logisticName && !d.paymentDate");
const firstCron = sv.indexOf("cron.schedule('30 * * * *'");
const healCron = sv.indexOf('Auto-Heal cron');
if (createdBranchInTracking > -1 && createdBranchInTracking < healCron && createdBranchInTracking > firstCron) {
  console.log('[WARN] فرع CREATED قديم (من fix_autoheal) داخل كرون التتبع + كرون Auto-Heal جديد = تكرار');
  console.log('       محمي بالأعلام (_cjRecreate_) ولكن الأنظف: نحيدو القديم من بعد التأكيد');
  problems.push('REDUNDANT-CREATED-BRANCH');
} else console.log('[OK]   لا تكرار — فرع واحد برك');

// ===== syntax =====
console.log('\n--- SYNTAX ---');
for (const f of ['server.js', 'services\\cjService.js', 'services\\cjWebhookService.js', 'controllers\\paymentController.js']) {
  try { new vm.Script(rd(f), { filename: f }); console.log('[OK]   ' + f); }
  catch (e) { console.log('[BAD]  ' + f + ' -> ' + e.message); problems.push('syntax:' + f); }
}

console.log('\n=========== RESULT ===========');
if (problems.length) {
  console.log('⚠️ ناقصين/مشاكل: ' + problems.join(' | '));
  console.log('-> صيفط هاد الـ output كامل ونصلحو ناقص واحد واحد');
} else {
  console.log('🏆 كل الباتشات فيهم — حتى المجهولين كانو مطبقين! push & rest');
}