'use strict';
// final_fix.js — إصلاحان جراحيان + فحص نهائي
const fs = require('fs'), vm = require('vm');
const B = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\';
const rd = p => fs.readFileSync(B + p, 'utf8');
const wr = (p, t) => fs.writeFileSync(B + p, t, 'utf8');
let problems = [];

// ============ [1] server.js — التعريف المكرر ============
let sv = rd('server.js');
const hasFn = /\bfunction\s+sendOrderConfirmationEmail\b/.test(sv);
const declRx = /const\s*\{\s*sendOrderConfirmationEmail\s*\}\s*=\s*require\((['"])[^'"]*paymentController\1\);?[ \t]*(\r?\n)?/g;
const decls = [...sv.matchAll(declRx)];
console.log('[1] local function: ' + hasFn + ' | require-decls: ' + decls.length);

if (hasFn && decls.length >= 1) {
  // الفنكشن المحلية هي الأصل — نحيدو كل أسطر require المكررة
  sv = sv.replace(declRx, '');
  console.log('    -> removed ' + decls.length + ' require decl(s), local function kept');
} else if (!hasFn && decls.length > 1) {
  let first = true;
  sv = sv.replace(declRx, m => { if (first) { first = false; return m; } return ''; });
  console.log('    -> kept 1 of ' + decls.length + ' require decls');
} else if (!hasFn && decls.length === 1) {
  console.log('    -> single decl, no conflict (مشكل آخر؟)');
  problems.push('email-decl-mystery');
}

// ============ [2] server.js — orphan cleanup (شرطي) ============
const hasCleanup = sv.includes("UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'");
if (!hasCleanup) {
  const anchor = "logger.logError('Create Checkout Session', err);";
  if (sv.split(anchor).length - 1 === 1) {
    sv = sv.replace(anchor,
      'if (orderId) {\n      await pool.query("UPDATE orders SET status = \'cancelled\' WHERE id = $1 AND status = \'pending\'", [orderId]).catch(() => {});\n    }\n    ' + anchor);
    console.log('[2] orphan cleanup: ADDED');
  } else { console.log('[2] orphan cleanup: anchor ambiguous — سكيفو'); problems.push('orphan-catch'); }
} else console.log('[2] orphan cleanup: موجود ✅');

wr('server.js', sv);

// ============ [3] cjWebhookService.js — WA call -> OBJECT ============
let cw = rd('services\\cjWebhookService.js');
const POS = 'await sendOrderTrackingWhatsApp(order.customer_phone, order.customer_name, order.id, trackNumber);';
const OBJ = 'await sendOrderTrackingWhatsApp({ phone: order.customer_phone, customerName: order.customer_name, orderId: order.id, trackingNumber: trackNumber, email: order.customer_email });';
const posCount = cw.split(POS).length - 1;
console.log('[3] positional WA calls (active, non-comment): ' + posCount);
if (posCount === 1) {
  cw = cw.replace(POS, OBJ);
  wr('services\\cjWebhookService.js', cw);
  console.log('    -> swapped to OBJECT form ✅');
} else if (cw.includes(OBJ + ' //')) { console.log('    -> already object ✅'); }
else { console.log('    -> count=' + posCount + ' غير متوقع!'); problems.push('wa-call'); }

// ============ [4] فحص Syntax نهائي للملفات الأربعة ============
console.log('\n[4] syntax check:');
let bad = false;
for (const f of ['server.js', 'controllers\\paymentController.js', 'services\\cjService.js', 'services\\cjWebhookService.js']) {
  try { new vm.Script(rd(f), { filename: f }); console.log('  OK   ' + f); }
  catch (e) { console.log('  BAD  ' + f + ' -> ' + e.message); bad = true; problems.push('syntax:' + f); }
}

// ============ [5] التحقق النهائي ============
const svF = rd('server.js'), cwF = rd('services\\cjWebhookService.js');
console.log('\n[5] verification:');
console.log('  killers (want 0): ' + ((svF.match(/status = 'completed' WHERE id/g) || []).length));
console.log('  email decls total (want 1): '
  + ((svF.match(/sendOrderConfirmationEmail\s*=\s*require|function\s+sendOrderConfirmationEmail/g) || []).length));
console.log('  WA object call in webhook (want >=1): ' + (cwF.split('sendOrderTrackingWhatsApp({ phone').length - 1));
console.log('  notifyShipment refs server (want >=4): ' + (svF.match(/notifyShipment/g) || []).length);

console.log('\n========== RESULT ==========');
if (!bad && problems.length === 0) {
  console.log('✅ ALL CLEAR — سدّي كلشي!');
  console.log('NEXT: git add -A && git commit -m "v2 order lifecycle complete" && git push');
  console.log('ثم: أول طلب حقيقي وراقب اللوج.');
} else {
  console.log('⚠️ PROBLEMS: ' + problems.join(' | '));
  console.log('-> صيفط هاد الـ output كامل');
}