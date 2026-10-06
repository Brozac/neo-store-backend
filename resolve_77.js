// resolve_77.js — end #77's loop via the system's own S3 path (Stripe → auto refund)
require('dotenv').config();
const pool = require('./db');
const { zeroTouchRecovery } = require('./services/cjService');

(async () => {
  const { rows: before } = await pool.query('SELECT id, status, manual_since FROM orders WHERE id = 77');
  console.log('before:', before[0]);

  // expire the clock (status is awaiting_exchange after the last S2)
  const upd = await pool.query(
    `UPDATE orders SET manual_since = NOW() - INTERVAL '73 hours'
     WHERE id = 77 AND status = 'awaiting_exchange' RETURNING id`
  );
  if (!upd.rowCount) {
    const { rows: s } = await pool.query('SELECT status FROM orders WHERE id = 77');
    console.log(`skip — #77 status=${s[0]?.status} (not awaiting_exchange)`);
    await pool.end(); return process.exit(0);
  }

  // sweep-guard (vids=[] + 72h+) routes directly to executeS3 → Stripe refund
  const res = await zeroTouchRecovery(77, {
    country: 'DZ',
    vids: [],
    totalAmount: 132.72,
    customerEmail: 'mabdoua0797@gmail.com',
    customerPhone: '+213554241005',
    customerName: 'Mebdoua Elhadj Mohamed',
  });
  console.log('result:', res);

  const { rows: after } = await pool.query('SELECT id, status FROM orders WHERE id = 77');
  console.log('final:', after[0]);   // expect: status=refunded
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });