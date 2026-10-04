// review_invitation_migration.js — M#27 Verified-Purchase Review system
// Idempotent — آمن للتكرار
require('dotenv').config();
const pool = require('./db');

const MIGRATIONS = [
  { name: 'orders.delivered_at', sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;` },
  { name: 'orders.review_token', sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_token UUID DEFAULT gen_random_uuid();` },
  { name: 'orders.review_invited_at', sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_invited_at TIMESTAMPTZ;` },
  { name: 'orders.review_submitted_at', sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMPTZ;` },
  { name: 'idx: orders.review_token', sql: `CREATE INDEX IF NOT EXISTS idx_orders_review_token ON orders (review_token);` },
  { name: 'idx: review-invite cron scan', sql: `CREATE INDEX IF NOT EXISTS idx_orders_review_invite ON orders (delivered_at, review_invited_at) WHERE status = 'completed' AND review_invited_at IS NULL;` },
  { name: 'idx: real reviews (user_id NOT NULL)', sql: `CREATE INDEX IF NOT EXISTS idx_reviews_real ON reviews (product_id) WHERE user_id IS NOT NULL;` },
  { name: 'NEXT5 coupon seed', sql: `INSERT INTO coupons (code, discount_type, discount_value, is_active) VALUES ('NEXT5', 'percentage', 5, true) ON CONFLICT (code) DO NOTHING;` },
];

(async () => {
  console.log('═══ 🌟 Verified-Review Migration ═══\n');
  let ok = 0, fail = 0;
  for (const m of MIGRATIONS) {
    try { await pool.query(m.sql); console.log(`  [OK  ] ${m.name}`); ok++; }
    catch (e) { console.error(`  [FAIL] ${m.name} — ${e.message}`); fail++; }
  }
  console.log(`\n═══ done: ok=${ok} fail=${fail} ═══`);
  await pool.end();
  fail > 0 ? process.exit(1) : process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
