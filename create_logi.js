'use strict';
// create_logi.js — مثل create_fresh + logisticName صريح (أرخص من freightCalculate أو fallback)
require('dotenv').config();
const axios = require('axios');
const pool = require('./db');
const { fulfillCJOrder, cjRequest } = require('./services/cjService');

async function pickLogistic(products, country) {
  try {
    const fr = await cjRequest((t) => axios.post(
      'https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate',
      { startCountryCode: 'CN', endCountryCode: country,
        products: products.map(p => ({ vid: p.vid || undefined, quantity: p.quantity || 1 })) },
      { headers: { 'CJ-Access-Token': t } }));
    if (fr.data?.code === 200 && Array.isArray(fr.data.data) && fr.data.data.length) {
      const cheapest = fr.data.data.sort((a,b) => a.logisticPrice - b.logisticPrice)[0];
      return cheapest.logisticName;
    }
  } catch (e) { /* fallback */ }
  return 'CJPacket Ordinary'; // fallback الرسمي
}

async function main() {
  const id = parseInt(process.argv[2], 10);
  const oRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  const full = oRes.rows[0];
  if (!full) { console.log('❌ ما كاينش'); process.exit(1); }
  const iRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);

  let addr = {};
  try { addr = JSON.parse(full.shipping_address); } catch (e) { addr = { line1: full.shipping_address, country: 'US' }; }
  const country = addr.country || 'US';
  const logistic = await pickLogistic(iRes.rows, country);
  console.log('🚚 شحن مختار صراحة:', logistic, '| وجهة:', country);

  const override = 'STORE-' + id + '-L' + String(Date.now()).slice(-6);
  await pool.query('UPDATE orders SET cj_order_number = $1 WHERE id = $2', [override, id]);
  console.log('🆔 رقم جديد:', override);

  const r = await fulfillCJOrder(id, full.customer_name, {
    address: addr, phone: full.customer_phone || '', email: full.customer_email || '', name: full.customer_name
  }, iRes.rows, override, logistic);   // ⭐ باراميتر سادس: logisticName
  console.log('النتيجة:', JSON.stringify(r).slice(0, 200));
  console.log('\nالتالي: node cj_sandbox_e2e.js ' + override);
  process.exit(0);
}
main().catch(e => { console.error('ERR:', e.response?.data || e.message); process.exit(1); });
