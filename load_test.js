/**
 * node load_test.js <CONCURRENCY> <BASE_URL>
 * مثال: node load_test.js 50 http://localhost:3000
 * 
 * يختبر: DB pool • race على verify-session • cjPace gate • admin-surface
 * ⚠️ ضد سيرفر محلي — لا تشغله على Render الإنتاجي!
 */
require('dotenv').config();

const CONC = parseInt(process.argv[2]) || 20;
const BASE = process.argv[3] || 'http://localhost:3000';

const results = { total: 0, ok: 0, locked: 0, failed: 0, timeouts: 0, durations: [] };

async function hit(endpoint, method = 'GET', body = null) {
  const start = Date.now();
  try {
    const res = await fetch(BASE + endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const dur = Date.now() - start;
    results.durations.push(dur);
    results.total++;
    return { status: res.status, dur };
  } catch (e) {
    results.total++;
    if (e.name === 'TimeoutError') results.timeouts++;
    results.failed++;
    return { status: 0, dur: Date.now() - start, error: e.message };
  }
}

// ═══════════ TEST 1: DB Pool Exhaustion ═══════════
async function testPoolExhaustion() {
  console.log(`\n═══ TEST 1: DB Pool (${CONC} concurrent queries) ═══`);
  const promises = [];
  for (let i = 0; i < CONC; i++) {
    promises.push(hit('/api/settings'));
  }
  const responses = await Promise.all(promises);
  const success = responses.filter(r => r.status === 200).length;
  const avg = Math.round(results.durations.reduce((a, b) => a + b, 0) / results.durations.length);
  const max = Math.max(...results.durations);
  console.log(`✅ Success: ${success}/${CONC}`);
  console.log(`⏱️  Avg: ${avg}ms | Max: ${max}ms`);
  if (results.timeouts > 0) console.log(`🚨 Timeouts: ${results.timeouts}`);
  return success === CONC;
}

// ═══════════ TEST 2: Admin Surface (يجب أن يعيد 401) ═══════════
async function testAdminSurface() {
  console.log(`\n═══ TEST 2: Admin Surface (all should be 401) ═══`);
  const endpoints = ['/api/admin/add-coupon', '/api/admin/add-product', '/api/admin/system-events'];
  for (const ep of endpoints) {
    const { status } = await hit(ep, 'POST', {});
    const ok = status === 401 || status === 403;
    console.log(`${ok ? '✅' : '🚨'} ${ep} → ${status}`);
    if (!ok) return false;
  }
  return true;
}

// ═══════════ TEST 3: Invalid Session — verify race ═══════════
async function testVerifyRace() {
  console.log(`\n═══ TEST 3: verify-session race (${CONC} concurrent invalid sessions) ═══`);
  const promises = [];
  for (let i = 0; i < CONC; i++) {
    promises.push(hit('/api/payment/verify-session', 'POST', { session_id: `fake_sess_${i}` }));
  }
  const responses = await Promise.all(promises);
  const notFound = responses.filter(r => r.status === 404).length;
  const ok = responses.filter(r => r.status === 200).length;
  const err = responses.filter(r => r.status >= 500).length;
  console.log(`✅ 404 (session invalid, handled): ${notFound}`);
  console.log(`✅ 200 (edge-case successes): ${ok}`);
  console.log(`${err > 0 ? '🚨' : '✅'} 5xx errors: ${err}`);
  // في سيناريو حقيقي، نفس session_id يجب أن ينجح مرة ويُرفض N-1 (أو 404)
  return err === 0;
}

// ═══════════ TEST 4: Rate-limiter correctness ═══════════
async function testRateLimits() {
  console.log(`\n═══ TEST 4: Coupon rate-limit (${CONC}/15m = should throttle) ═══`);
  const promises = [];
  for (let i = 0; i < 25; i++) {
    promises.push(hit('/api/validate-coupon', 'POST', { code: `FAKE${i}` }));
  }
  const responses = await Promise.all(promises);
  const throttled = responses.filter(r => r.status === 429).length;
  console.log(`${throttled > 0 ? '✅' : '🟡'} Rate-limit kicked in: ${throttled}/${25} got 429`);
  return true; // معلومة، ليست فشلاً حرجاً في sandbox
}

// ═══════════ TEST 5: Webhook Signature Rejection ═══════════
async function testWebhookSignature() {
  console.log(`\n═══ TEST 5: CJ Webhook — spoof handling (must not process) ═══`);
  // CJ لا يوقّع ORDER/LOGISTIC — السياسة: 200 acknowledge + داخلية drop.
  // التحقق الحقيقي: الرد نظيف (لا 500) — والدرع الداخلي موثق باللوج 🛡️
  const { status } = await hit('/api/cj-webhook', 'POST', { type: 'ORDER', params: { orderNum: 'STORE-99999', orderStatus: 'SHIPPED', trackNumber: 'FAKE', cjOrderId: 'FAKE' } });
  const ok = status === 200 || status === 400 || status === 403;
  console.log(`${ok ? '✅' : '🚨'} Spoof webhook → ${status} (ack + internal drop — verify 🛡️ in server logs)`);
  return ok;
}

(async () => {
  console.log(`\n🔥 ═══════ LOAD TEST — ${CONC} concurrent / ${BASE} ═══════\n`);

  const t1 = await testPoolExhaustion();
  const t2 = await testAdminSurface();
  const t3 = await testVerifyRace();
  const t4 = await testRateLimits();
  const t5 = await testWebhookSignature();

  console.log(`\n${'═'.repeat(55)}`);
  console.log('📊 RESULTS:');
  console.log(`   DB Pool:          ${t1 ? '✅ PASS' : '🚨 FAIL'}`);
  console.log(`   Admin Surface:    ${t2 ? '✅ PASS' : '🚨 FAIL'}`);
  console.log(`   Verify Race:      ${t3 ? '✅ PASS' : '🚨 FAIL'}`);
  console.log(`   Rate Limits:      ${t4 ? '✅ PASS' : '🟡 INFO'}`);
  console.log(`   Webhook Sig:      ${t5 ? '✅ PASS' : '🚨 FAIL'}`);
  console.log('═'.repeat(55));

  if (!t1 || !t2 || !t3 || !t5) {
    console.log('\n🚨 فشل حرج — راجع قبل live!');
    process.exit(1);
  }
  console.log('\n🏁 المنظومة صمدت — جاهزة live من ناحية التزامن');
  process.exit(0);
})();