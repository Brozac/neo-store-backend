// topsellers_v2_migration.js — M#26 v2 — Product List V2 real fields
// Idempotent — آمن للتكرار
require('dotenv').config();
const pool = require('./db');

const MIGRATIONS = [
  { name: 'products.cj_listed_num',            sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS cj_listed_num INTEGER DEFAULT 0;` },
  { name: 'products.warehouse_inventory',      sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS warehouse_inventory INTEGER DEFAULT 0;` },
  { name: 'products.verified_warehouse',       sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS verified_warehouse BOOLEAN DEFAULT false;` },
  { name: 'products.has_video',                sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS has_video BOOLEAN DEFAULT false;` },
  { name: 'products.free_shipping',            sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN DEFAULT false;` },
  { name: 'products.delivery_cycle',           sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS delivery_cycle VARCHAR(20);` },
  { name: 'products.has_ce_cert',              sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS has_ce_cert BOOLEAN DEFAULT false;` },
  { name: 'products.product_type_cj',          sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type_cj VARCHAR(30);` },
  { name: 'idx: cj_listed_num DESC',           sql: `CREATE INDEX IF NOT EXISTS idx_products_listed_num ON products (cj_listed_num DESC);` },
  { name: 'idx: verified_warehouse',           sql: `CREATE INDEX IF NOT EXISTS idx_products_verified_warehouse ON products (verified_warehouse) WHERE verified_warehouse = true;` },
  { name: 'idx: free_shipping',                sql: `CREATE INDEX IF NOT EXISTS idx_products_free_shipping ON products (free_shipping) WHERE free_shipping = true;` },
];

(async () => {
  console.log('═══ 🗄️ M#26 v2 Migration — Product List V2 fields ═══\n');
  let ok = 0, fail = 0;
  for (const m of MIGRATIONS) {
    try { await pool.query(m.sql); console.log(`  [OK  ] ${m.name}`); ok++; }
    catch (e) { console.error(`  [FAIL] ${m.name} — ${e.message}`); fail++; }
  }
  console.log(`\n═══ done: ok=${ok} fail=${fail} ═══`);
  await pool.end();
  fail > 0 ? process.exit(1) : process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
