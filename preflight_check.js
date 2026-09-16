/**
 * preflight_check.js — node preflight_check.js
 * فحص شامل قبل الـ push: تحميل، عقود مالية، بنية، env، وحدات حرجة
 * Exit 0 = آمن للـ push | Exit 1 = توقف وأصلح
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const results = [];
let critical = 0, warnings = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r === true) { results.push(`✅ ${name}`); }
    else if (typeof r === 'string') { results.push(`🟡 ${name}: ${r}`); warnings++; }
    else { results.push(`✅ ${name}`); }
  } catch (e) {
    results.push(`🚨 ${name}: ${e.message}`);
    critical++;
  }
}

function checkAsync(name, promise) {
  return promise.then(r => {
    if (r === true) results.push(`✅ ${name}`);
    else if (typeof r === 'string') { results.push(`🟡 ${name}: ${r}`); warnings++; }
    else results.push(`✅ ${name}`);
  }).catch(e => {
    results.push(`🚨 ${name}: ${e.message}`);
    critical++;
  });
}

console.log('🔍 ═══════ PRE-FLIGHT CHECK — Laclarc Backend ═══════\n');

// ══════════════ 1. تحميل الوحدات (Syntax/Import sanity) ══════════════
check('Module: cjService.js loads', () => {
  delete require.cache[require.resolve('./services/cjService')];
  const svc = require('./services/cjService');
  return typeof svc.fulfillCJOrder === 'function'
      && typeof svc.financialGate === 'function'
      && typeof svc.selfHealStuckOrders === 'function'
      && typeof svc.payCJOrderBalance === 'function'
      && typeof svc.deleteCJOrder === 'function';
});

check('Module: conversionService.js loads', () => {
  const c = require('./services/conversionService');
  return typeof c.sendPurchaseConversion === 'function' && typeof c.setConversionContext === 'function';
});

check('Module: paymentController.js loads', () => {
  require('./controllers/paymentController');
  return true;
});

check('Module: cjWebhookService.js loads', () => {
  require('./services/cjWebhookService');
  return true;
});

// ══════════════ 2. العقد المالي — financialGate structure ══════════════
check('FinancialGate: cryptoPaymentGuard محيّسة (no remnants)', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  const leftover = src.match(/cryptoPaymentGuard/g);
  if (leftover && leftover.length > 0) throw new Error(`cryptoPaymentGuard مازال مذكور ${leftover.length} مرة — يجب حذف الكل`);
  return true;
});

check('FinancialGate: fulfillCJOrder wired على financialGate', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  if (!src.includes('await financialGate(orderId)')) throw new Error('fulfillCJOrder ما يستدعيش financialGate');
  return true;
});

check('FinancialGate: fail-closed (catch → DENY)', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  const fnStart = src.indexOf('async function financialGate');
  const fnEnd = src.indexOf('\n}', fnStart);
  const body = src.slice(fnStart, fnEnd);
  if (!body.includes("reason: 'gate_error'")) throw new Error('catch تاع financialGate ما يرجعش gate_error');
  if (!body.includes('unknown_method')) throw new Error('لا يوجد deny للطرق غير المعروفة');
  return true;
});

check('FinancialGate: Stripe dispute-check حاضر', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  const fnStart = src.indexOf('async function financialGate');
  const body = src.slice(fnStart, src.indexOf('\n}', fnStart));
  if (!body.includes('disputed')) throw new Error('لا فحص dispute في مسار Stripe');
  return true;
});

check('FinancialGate: unknown method DENY', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  const fnStart = src.indexOf('async function financialGate');
  const body = src.slice(fnStart, src.indexOf('\n}', fnStart));
  if (!body.includes('unknown_method')) throw new Error('الطرق غير المعروفة تمر بلا رفض!');
  return true;
});

// ══════════════ 3. Self-Heal — البنية والحمايات ══════════════
check('SelfHeal: attemptRefulfill has financialGate guard', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  const fnStart = src.indexOf('async function attemptRefulfill');
  const body = src.slice(fnStart, src.indexOf('\n}', fnStart));
  if (!body.includes('financialGate(oid)')) throw new Error('attemptRefulfill ما يمرش عبر البوابة المالية!');
  if (!body.includes('DENIED by financialGate')) throw new Error('لا لوج للرفض (Tenet #14)');
  return true;
});

check('SelfHeal: HEAL_MAX_ATTEMPTS حارس ضد الحلقات', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  if (!src.includes('HEAL_MAX_ATTEMPTS')) throw new Error('لا عدّاد محاولات — خطر loop لا نهائي');
  if (!src.includes('healAttempts')) throw new Error('لا خريطة محاولات');
  return true;
});

check('SelfHeal: wallet-alert مرة واحدة لكل دورة', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  if (!src.includes('walletAlerted')) throw new Error('نفاد المحفظة قد يرسل إيميلات متتالية — spam risk');
  return true;
});

check('SelfHeal: GC interval على healAttempts (memory-leak defense)', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  if (!src.includes('healAttempts')) throw new Error('healAttempts ما كاينش');
  // منع التسرب: يجب وجود setInterval + حذف من healAttempts في أي صيغة
  const hasInterval = /setInterval\s*\(/.test(src);
  const hasDelete = /healAttempts\.delete/.test(src);
  if (!hasInterval || !hasDelete) {
    throw new Error(`GC مكسور: setInterval=${hasInterval}, delete=${hasDelete}`);
  }
  return true;
});

// ══════════════ 4. Tenet #14 — لا catch صامت في الملفات الحرجة ══════════════
check('Tenet#14: لا catch(() => {}) في cjService (المسار المالي)', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  const silent = src.match(/\.catch\(\(\) => \{\}\)/g);
  if (silent && silent.length > 0) throw new Error(`${silent.length} catch صامت مازال — راجع`);
  return true;
});

check('Tenet#14: لا catch (e) {} في cjService', () => {
  const src = fs.readFileSync('services/cjService.js', 'utf8');
  const silent = src.match(/catch\s*\(\w*\)\s*\{\s*\}/g);
  if (silent && silent.length > 0) throw new Error(`${silent.length} catch فاضي مازال — استثناء موثق فقط مسموح`);
  return true;
});

// ══════════════ 5. CAPI / Dedup — العقد المستقر ══════════════
check('CAPI: purch_ event_id format', () => {
  const src = fs.readFileSync('services/conversionService.js', 'utf8');
  if (!src.includes('`purch_${orderId}`')) throw new Error('event_id format مبدل — dedup سينكسر');
  return true;
});

check('CAPI: لا probes مؤقتة باقية', () => {
  const src = fs.readFileSync('services/conversionService.js', 'utf8');
  const probes = src.match(/sendMeta ENTRY|sendMeta UD|payload probe/g);
  if (probes) throw new Error(`${probes.length} probe مؤقت مازال — امسحو قبل الإنتاج`);
  return true;
});

check('CAPI: fbp/fbc wired في sendMeta userData', () => {
  const src = fs.readFileSync('services/conversionService.js', 'utf8');
  if (!src.includes('userData.fbp') || !src.includes('userData.fbc')) throw new Error('fbp/fbc ما وصلوش userData');
  return true;
});

// ══════════════ 6. Webhooks — خريطة الحالات ══════════════
check('Webhook: TRASH إخبارية في الـ map', () => {
  const src = fs.readFileSync('services/cjWebhookService.js', 'utf8');
  if (!src.includes("TRASH: 'paid'")) throw new Error('TRASH ما زالت غير معروفة — سيل تحذيرات');
  return true;
});

check('Webhook: SHIPPED → fulfilled (اللحظة الذهبية)', () => {
  const src = fs.readFileSync('services/cjWebhookService.js', 'utf8');
  if (!src.match(/SHIPPED:\s*'fulfilled'/)) throw new Error('SHIPPED mapping مكسور!');
  return true;
});

// ══════════════ 7. Environment keys — حرجة ══════════════
check('Env: JWT_SECRET', () => {
  const v = process.env.JWT_SECRET;
  if (!v) throw new Error('ما كاينش');
  if (v.length < 40) return `⚠️ طوله ${v.length} (<40) — باكلوغ rotation`;
  return true;
});

check('Env: CJ_API_KEY', () => !!process.env.CJ_API_KEY ? true : (() => { throw new Error('ناقص'); })());
check('Env: NOWPAYMENTS_API_KEY', () => !!process.env.NOWPAYMENTS_API_KEY ? true : (() => { throw new Error('ناقص'); })());
check('Env: NOWPAYMENTS_IPN_SECRET', () => !!process.env.NOWPAYMENTS_IPN_SECRET ? true : (() => { throw new Error('ناقص'); })());
check('Env: STRIPE_SECRET_KEY', () => !!process.env.STRIPE_SECRET_KEY ? true : (() => { throw new Error('ناقص'); })());
check('Env: BREVO_API_KEY', () => !!process.env.BREVO_API_KEY ? true : (() => { throw new Error('ناقص'); })());

check('Env: META_CAPI (token + pixel)', () => {
  if (!process.env.META_CAPI_TOKEN || !process.env.META_CAPI_PIXEL_ID) {
    throw new Error('CAPI معطلة — الأحداث السيرفريون ما يتبعتوش');
  }
  return true;
});

check('Env: TEST_EVENT_CODES فارغة (إنتاج)', () => {
  const m = process.env.META_TEST_EVENT_CODE;
  const t = process.env.TIKTOK_TEST_EVENT_CODE;
  if (m || t) return 'مفعّلين — مقصود فقط للاختبار، فرّغهم قبل live';
  return true;
});

// ══════════════ 8. Git hygiene ══════════════
check('Git: .env غير متتبع', () => {
  const { execSync } = require('child_process');
  try {
    execSync('git ls-files --error-unmatch .env', { stdio: 'pipe' });
    throw new Error('.env متتبع في Git! 🚨🚨');
  } catch (e) {
    if (e.message.includes('متتبع')) throw e;
    return true; // ls-files يفشل = غير متتبع = صح
  }
});

check('Git: لا .bak متتبع', () => {
  const { execSync } = require('child_process');
  try {
    const out = execSync('git ls-files "*.bak*"', { stdio: 'pipe' }).toString().trim();
    if (out) throw new Error(`backups متتبعة: ${out}`);
    return true;
  } catch (e) {
    if (e.message.includes('backups')) throw e;
    return true;
  }
});

// ══════════════ 9. Async: DB connection sanity ══════════════
const dbCheck = checkAsync('DB: الاتصال + جداول حرجة', (async () => {
  const pool = require('./db');
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='orders') as orders,
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='order_items') as items,
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='products') as products
  `);
  if (rows[0].orders === 0 || rows[0].items === 0 || rows[0].products === 0) {
    throw new Error('جدول حرج ناقص!');
  }
  await pool.end();
  return true;
})());

// ══════════════ التقرير النهائي ══════════════
dbCheck.finally(() => {
  console.log(results.join('\n'));
  console.log('\n' + '═'.repeat(55));
  console.log(`📊 النتيجة: ${results.filter(r => r.startsWith('✅')).length} PASS | ${warnings} WARN | ${critical} CRITICAL`);
  console.log('═'.repeat(55));

  if (critical > 0) {
    console.log('\n🚨 توقف — أصلح الـ CRITICAL قبل الـ push!');
    process.exit(1);
  }
  if (warnings > 0) {
    console.log('\n🟡 تحذيرات موجودة — راجعهم وقرر (بعضها مقصود مثل test codes في الاختبار)');
    process.exit(0);
  }
  console.log('\n🏁 كلش نقي — آمن للـ push!');
  process.exit(0);
});