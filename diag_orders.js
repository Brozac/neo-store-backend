'use strict';
// diag_orders.js — تشخيص حي: واش #61 و#62 راهم وكيفين عند CJ؟
require('dotenv').config();
const axios = require('axios');
const { cjRequest } = require('./services/cjService');

async function main() {
  const list = process.argv.slice(2).length ? process.argv.slice(2) : ['STORE-61', 'STORE-62'];
  console.log('Querying:', list.join(', '), '\n');

  const res = await cjRequest((token) =>
    axios.post('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetailBatch',
      { orderIds: list },
      { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
    )
  );
  console.log('code:', res.data.code, '|', res.data.message);
  const arr = Array.isArray(res.data.data) ? res.data.data : [];
  console.log('رجع CJ:', arr.length, 'من', list.length, '\n');

  for (const d of arr) {
    console.log('---');
    console.log('orderNum   :', d.orderNum, '| cjOrderCode:', d.cjOrderCode);
    console.log('status     :', d.orderStatus, '| subStatus:', d.subStatus);
    console.log('logistic   :', d.logisticName || '(مازال!)', '| track:', d.trackNumber || '(مازال)');
    console.log('postage    :', d.postageAmount, '| orderAmount:', d.orderAmount);
    console.log('warehouse  :', d.storageName || '(مازال)');
    console.log('created    :', d.createDate, '| paid:', d.paymentDate);
  }
  const found = new Set(arr.map(d => String(d.orderNum || '').toLowerCase()));
  for (const k of list) if (!found.has(k.toLowerCase())) console.log('⚠️ ما ترجعش:', k);
  process.exit(0);
}
main().catch(e => { console.error('ERR:', e.response?.data || e.message); process.exit(1); });