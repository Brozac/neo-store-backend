'use strict';
// create_fresh.js — يخلق الطلب عند CJ بالرقم الجديد المخزن (STORE-x-R...) عبر fulfillCJOrder + override
require('dotenv').config();
const axios = require('axios');
const pool = require('./db');
const { fulfillCJOrder } = require('./services/cjService');

async function main() {
  const id = parseInt(process.argv[2], 10);
  if (!Number.isFinite(id)) { console.log('Usage: node create_fresh.js <orderId>'); process.exit(1); }

  const oRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  const full = oRes.rows[0];
  if (!full) { console.log('❌ ما كاينش فالـ DB'); process.exit(1); }

  const stored = String(full.cj_order_number || '').trim();
  const override = /^STORE-\d+-R\d+$/i.test(stored) ? stored : ('STORE-' + id + '-R' + String(Date.now()).slice(-6));
  if (override !== stored) {
    await pool.query('UPDATE orders SET cj_order_number = $1 WHERE id = $2', [override, id]);
    console.log('ℹ️ ولّدت رقم جديد:', override);
  } else console.log('ℹ️ نستعملو الرقم المخزن:', override);

  const iRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
  let addr = {};
  try { addr = JSON.parse(full.shipping_address); } catch (e) { addr = { line1: full.shipping_address, country: 'US' }; }

  console.log('🚀 الإنشاء بـ override:', override);
  const r = await fulfillCJOrder(id, full.customer_name, {
    address: addr, phone: full.customer_phone || '', email: full.customer_email || '', name: full.customer_name
  }, iRes.rows, override);
  console.log('النتيجة:', JSON.stringify(r).slice(0, 200));
  console.log('\nالتالي: node cj_sandbox_e2e.js ' + override);
  process.exit(0);
}
main().catch(e => { console.error('ERR:', e.response?.data || e.message); process.exit(1); });