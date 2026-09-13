'use strict';
// cj_sandbox_e2e.js — اختبار السلسلة الذهبية كاملة بالساندبوكس (Option A النهائية)
// الاستخدام: node cj_sandbox_e2e.js STORE-62
// الخطوات: فحص → (delete+recreate إلا عالقة) → simulatePay → trackNumber → 400 → 500 SHIPPED
require('dotenv').config();
const axios = require('axios');
const pool = require('./db');
const { cjRequest, fulfillCJOrder, deleteCJOrder } = require('./services/cjService');

const API = 'https://developers.cjdropshipping.com/api2.0/v1';
const key = process.argv[2];
if (!key) { console.log('Usage: node cj_sandbox_e2e.js <STORE-x>'); process.exit(1); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// نجربو كل المعرّفات الممكنة (orderId الرقمي / SD... / STORE-x) حتى واحد ينجح
async function tryCandidates(candidates, fn) {
  let last = null;
  for (const v of candidates.filter(Boolean)) {
    try {
      const res = await fn(String(v));
      if (res.data?.code === 200) return { ok: true, res };
      last = `${res.data?.message} (code ${res.data?.code})`;
    } catch (e) {
      last = (e.response?.data?.message) || e.message;
    }
    await sleep(1300);
  }
  return { ok: false, reason: last };
}

async function queryOrder() {
  const res = await cjRequest((t) => axios.post(`${API}/shopping/order/getOrderDetailBatch`,
    { orderIds: [key] },
    { headers: { 'CJ-Access-Token': t, 'Content-Type': 'application/json' } }));
  if (res.data?.code !== 200) { console.log('❌ Batch:', res.data?.message); return null; }
  return (res.data.data || []).find(x =>
    String(x.orderNum || '').toLowerCase() === key.toLowerCase() ||
    String(x.cjOrderCode || '').toLowerCase() === key.toLowerCase()) || null;
}

async function main() {
  console.log('🧪 [E2E] بداية الاختبار على:', key, '\n');
  let d = await queryOrder();

  // ===== [1] الطلب موجود؟ =====
  if (!d) {
    console.log('ℹ️ ما ترجعتش من CJ — نتحققو من DB ونعيدو الإنشاء...');
    const oRes = await pool.query('SELECT * FROM orders WHERE id = $1', [key.replace(/^STORE-/i, '')]);
    if (!oRes.rows.length) { console.log('❌ حتى فالـ DB ما كاينة'); process.exit(1); }
  }

  // ===== 🛡️ حارس الأمان: ساندبوكس برك! =====
  if (d && d.isSandbox !== 1) {
    console.log('🛑 STOP! هادا طلب حقيقي (isSandbox=' + d.isSandbox + ') — الساندبوكس APIs ممنوعين عليه!');
    process.exit(1);
  }

  // ===== [2] عالقة CREATED بلا شحن؟ → delete + recreate =====
  d = await queryOrder();
  if (d && d.orderStatus === 'CREATED' && !d.logisticName && !d.paymentDate) {
    console.log('🔧 [2] عالقة بلا شحن — حذف (1.8) + إعادة إنشاء...');
    const del = await deleteCJOrder(d.orderId, d.cjOrderCode, key);
    console.log('   delete:', del.ok ? '✅' : '❌ ' + del.reason);
    if (!del.ok) { console.log('   ما نقدروش نكملو على النسخة القديمة — جرب من بعد'); process.exit(1); }
    const id = parseInt(key.replace(/^STORE-/i, ''), 10);
    await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1", [id]).catch(() => {});
    const oRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const full = oRes.rows[0];
    const iRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
    let addr = {};
    try { addr = JSON.parse(full.shipping_address); } catch (e) { addr = { line1: full.shipping_address, country: 'US' }; }
    const r = await fulfillCJOrder(id, full.customer_name, {
      address: addr, phone: full.customer_phone || '', email: full.customer_email || '', name: full.customer_name
    }, iRes.rows);
    console.log('   recreate:', JSON.stringify(r).slice(0, 150));
    await sleep(2500);
    d = await queryOrder();
    if (!d) { console.log('❌ النسخة الجديدة ما بانتش — شوف اللوج'); process.exit(1); }
  }

  console.log(`\n📋 الحالة: ${d.orderStatus} | sub: ${d.subStatus} | شحن: ${d.logisticName || '—'} | paid: ${d.paymentDate || '—'} | track: ${d.trackNumber || '—'} | sandbox: ${d.isSandbox}`);
  const cands = [d.orderId, d.cjOrderCode, key];

  // ===== [3] ما مدفوعاش؟ → SimulatePay (1.11) =====
  if (!d.paymentDate) {
    console.log('\n💳 [3] SimulatePay (1.11)...');
    const pay = await tryCandidates(cands, (v) => cjRequest((t) => axios.post(`${API}/shopping/sandbox/simulatePay`,
      { orderId: v }, { headers: { 'CJ-Access-Token': t, 'Content-Type': 'application/json' } })));
    console.log('   pay:', pay.ok ? '✅ مدفوع (وهمي)' : '❌ ' + pay.reason);
    if (!pay.ok) process.exit(1);
    await sleep(2500);
    d = await queryOrder();
    console.log('   بعد الدفع:', d.orderStatus, '| sub:', d.subStatus);
  } else console.log('\n💳 [3] ديجا مدفوعة — تخطى');

  // ===== [4] trackNumber (1.15) — قبل ما ندفعو الحالة لـ SHIPPED =====
  if (!d.trackNumber) {
    console.log('\n📦 [4] UpdateTrackNumber (1.15)...');
    const tn = 'SBX-E2E-' + Date.now();
    const tr = await tryCandidates(cands, (v) => cjRequest((t) => axios.post(`${API}/shopping/sandbox/updateTrackNumber`,
      { orderId: v, trackNumber: tn }, { headers: { 'CJ-Access-Token': t, 'Content-Type': 'application/json' } })));
    console.log('   track:', tr.ok ? `✅ ${tn}` : '❌ ' + tr.reason);
    if (!tr.ok) {
      console.log('   ⚠️ 820؟ = logistics مازال — شغّل كرون Auto-Heal وجرب مرة أخرى');
      process.exit(1);
    }
  } else console.log('\n📦 [4] track موجود:', d.trackNumber);

  // ===== [5] دفع الحالة: 400 → 500 (SHIPPED) — لا تخطي (القاعدة 300→400→500) =====
  console.log('\n🚚 [5] UpdateStatus (1.12): 400 ثم 500...');
  const s400 = await tryCandidates(cands, (v) => cjRequest((t) => axios.post(`${API}/shopping/sandbox/updateStatus`,
    { orderId: v, targetStatus: 400 }, { headers: { 'CJ-Access-Token': t, 'Content-Type': 'application/json' } })));
  console.log('   400:', s400.ok ? '✅' : '⚠️ ' + s400.reason + ' (يمكن ديجا فوقت)');
  const s500 = await tryCandidates(cands, (v) => cjRequest((t) => axios.post(`${API}/shopping/sandbox/updateStatus`,
    { orderId: v, targetStatus: 500 }, { headers: { 'CJ-Access-Token': t, 'Content-Type': 'application/json' } })));
  console.log('   500:', s500.ok ? '✅ SHIPPED!' : '❌ ' + s500.reason);
  if (!s500.ok) process.exit(1);

  await sleep(2500);
  const fin = await queryOrder();
  if (fin) console.log(`\n📊 النهائية: ${fin.orderStatus} | track: ${fin.trackNumber || '—'} | carrier: ${fin.logisticName || '—'}`);

  console.log('\n' + '='.repeat(60));
  console.log('🎯 SHIPPED مصنوعة! راقب اللوج دابا على:');
  console.log('   📦 [ORDER] ... SHIPPED        ← إلا الويب هوك طلق (فوري)');
  console.log('   🚀 [CJ Dispatched] ...        ← إلا الكرون لقاها (≤30 دقيقة)');
  console.log('   📲 واتساب + 📧 [direct-email] ← النتيجة النهائية للزبون');
  console.log('='.repeat(60));
  console.log('\n💡 من بعد: node cj_sandbox_e2e.js نفس الأمر يعاود — وينفع تاني لتجربة 600 (DELIVERED→completed)');
  process.exit(0);
}
main().catch(e => { console.error('ERR:', e.response?.data || e.message); process.exit(1); });