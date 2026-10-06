require('dotenv').config();
const pool = require('./db');
(async () => {
  const c = await pool.query('SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM reviews) AS reviews');
  console.log('📊 سلامة البيانات:', c.rows[0]);
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_token UUID NOT NULL DEFAULT gen_random_uuid()');
  const t = await pool.query('SELECT COUNT(*) AS total, COUNT(exchange_token) AS tokened FROM orders');
  console.log('🔑 Migration:', t.rows[0]);
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });