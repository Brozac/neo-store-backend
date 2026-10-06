// global_upgrade_migration_v2.js — 🌍 M#34 Complete Migration Bundle
// كل الأعمدة والفهارس المطلوبة لكل الأنظمة الحية:
//   M#25 Live Bridge · M#26 TopSellers v2 · M#27 Verified Reviews ·
//   M#28 Shipping-Blocked · M#29 Status-Labels · M#32 V2-First · M#34b Precision
// Idempotent — آمن للتكرار
// التشغيل: node global_upgrade_migration_v2.js
require('dotenv').config();
const pool = require('./db');

const MIGRATIONS = [
  // ═══ M#25/26 — Live Bridge + TopSellers v2 (حقول Product List V2) ═══
  { name: 'products.cj_listed_num',        sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS cj_listed_num INTEGER DEFAULT 0;` },
  { name: 'products.warehouse_inventory',  sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS warehouse_inventory INTEGER DEFAULT 0;` },
  { name: 'products.verified_warehouse',   sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS verified_warehouse BOOLEAN DEFAULT false;` },
  { name: 'products.has_video',            sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS has_video BOOLEAN DEFAULT false;` },
  { name: 'products.free_shipping',        sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN DEFAULT false;` },
  { name: 'products.delivery_cycle',       sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS delivery_cycle VARCHAR(20);` },
  { name: 'products.has_ce_cert',          sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS has_ce_cert BOOLEAN DEFAULT false;` },
  { name: 'products.product_type_cj',      sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type_cj VARCHAR(30);` },
  { name: 'products.sales_count',          sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS sales_count INTEGER DEFAULT 0;` },

  // ═══ M#34b — Precision Shipping Data (من Product Details) ═══
  { name: 'products.weight_grams',         sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_grams INTEGER;` },
  { name: 'products.volume_cm3',           sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS volume_cm3 INTEGER;` },
  { name: 'products.product_props',        sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS product_props TEXT[] DEFAULT '{}';` },
  { name: 'products.warehouse_country_codes', sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS warehouse_country_codes TEXT[] DEFAULT '{}';` },

  // ═══ M#28 — Shipping Blocked ═══
  { name: 'products.shipping_blocked',     sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_blocked BOOLEAN DEFAULT false;` },

  // ═══ M#27 — Verified Reviews ═══
  { name: 'orders.delivered_at',           sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;` },
  { name: 'orders.review_token',           sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_token UUID DEFAULT gen_random_uuid();` },
  { name: 'orders.review_invited_at',      sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_invited_at TIMESTAMPTZ;` },
  { name: 'orders.review_submitted_at',    sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMPTZ;` },
  { name: 'reviews.verified_purchase',     sql: `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verified_purchase BOOLEAN DEFAULT false;` },
  { name: 'reviews.source',                sql: `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'local';` },
  { name: 'reviews.cj_review_id',          sql: `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS cj_review_id VARCHAR(100);` },

  // ═══ M#34 — Shipping Matrix (جدول) ═══
  { name: 'shipping_matrix table',         sql: `CREATE TABLE IF NOT EXISTS shipping_matrix (
    country_code VARCHAR(2) PRIMARY KEY,
    country_name VARCHAR(100),
    carriers_count INTEGER DEFAULT 0,
    cheapest_price NUMERIC(10,2),
    cheapest_carrier VARCHAR(100),
    fastest_days VARCHAR(20),
    is_supported BOOLEAN DEFAULT false,
    last_checked TIMESTAMPTZ DEFAULT NOW()
  );` },

  // ═══ COGS Data (M#34 — Analytics) ═══
  { name: 'orders.cogs_data',              sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cogs_data JSONB;` },

  // ═══ الفهارس — كل الاستعلامات الحارة ═══
  { name: 'idx: products.cj_listed_num DESC',   sql: `CREATE INDEX IF NOT EXISTS idx_products_listed_num ON products (cj_listed_num DESC);` },
  { name: 'idx: products.sales_count DESC',     sql: `CREATE INDEX IF NOT EXISTS idx_products_sales_count ON products (sales_count DESC);` },
  { name: 'idx: products.verified_warehouse',   sql: `CREATE INDEX IF NOT EXISTS idx_products_verified_warehouse ON products (verified_warehouse) WHERE verified_warehouse = true;` },
  { name: 'idx: products.free_shipping',        sql: `CREATE INDEX IF NOT EXISTS idx_products_free_shipping ON products (free_shipping) WHERE free_shipping = true;` },
  { name: 'idx: products.has_video',            sql: `CREATE INDEX IF NOT EXISTS idx_products_has_video ON products (has_video) WHERE has_video = true;` },
  { name: 'idx: products.shipping_blocked',     sql: `CREATE INDEX IF NOT EXISTS idx_products_shipping_blocked ON products (shipping_blocked) WHERE shipping_blocked = true;` },
  { name: 'idx: shipping_matrix supported',     sql: `CREATE INDEX IF NOT EXISTS idx_shipping_supported ON shipping_matrix (country_code) WHERE is_supported = true;` },
  { name: 'idx: products.warehouse',            sql: `CREATE INDEX IF NOT EXISTS idx_products_warehouse ON products (id) WHERE warehouse_country_codes != '{}';` },
  { name: 'idx: orders.review_token',           sql: `CREATE INDEX IF NOT EXISTS idx_orders_review_token ON orders (review_token);` },
  { name: 'idx: orders.review-invite scan',     sql: `CREATE INDEX IF NOT EXISTS idx_orders_review_invite ON orders (delivered_at, review_invited_at) WHERE status = 'completed' AND review_invited_at IS NULL;` },
  { name: 'idx: reviews.verified',              sql: `CREATE INDEX IF NOT EXISTS idx_reviews_verified ON reviews (product_id) WHERE verified_purchase = true;` },
  { name: 'idx: reviews.cj dedup',              sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_cj_dedup ON reviews (cj_review_id) WHERE cj_review_id IS NOT NULL;` },
  { name: 'idx: orders.cogs',                   sql: `CREATE INDEX IF NOT EXISTS idx_orders_cogs ON orders (id) WHERE cogs_data IS NOT NULL;` },

  // ═══ SEEDS ═══
  { name: 'NEXT5 coupon (M#27)',           sql: `INSERT INTO coupons (code, discount_type, discount_value, is_active) VALUES ('NEXT5', 'percentage', 5, true) ON CONFLICT (code) DO NOTHING;` },
  { name: 'RECOVER10 coupon',              sql: `INSERT INTO coupons (code, discount_type, discount_value, is_active) VALUES ('RECOVER10', 'percentage', 10, true) ON CONFLICT (code) DO NOTHING;` },
  { name: 'payment_gateways seed',         sql: `INSERT INTO payment_gateways (gateway_key, display_name, enabled) VALUES ('stripe', 'Stripe (Card)', true), ('paysera', 'Paysera', false), ('crypto', 'Crypto (USDT/USDC)', true), ('baridimob', 'BaridiMob / CCP', false) ON CONFLICT (gateway_key) DO NOTHING;` },
];

(async () => {
  console.log('═══ 🌍 M#34 Global Migration v2 — Complete Bundle ═══\n');
  let ok = 0, fail = 0;

  for (const m of MIGRATIONS) {
    try { await pool.query(m.sql); console.log(`  [OK  ] ${m.name}`); ok++; }
    catch (e) { console.error(`  [FAIL] ${m.name} — ${e.message}`); fail++; }
  }

  // ═══ 📋 VERIFICATION REPORT ═══
  console.log('\n═══ 📋 VERIFICATION REPORT ═══\n');
  try {
    const prodCols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products'
        AND column_name IN ('cj_listed_num','warehouse_inventory','verified_warehouse',
                            'has_video','free_shipping','delivery_cycle','has_ce_cert',
                            'product_type_cj','sales_count','weight_grams','volume_cm3',
                            'product_props','warehouse_country_codes','shipping_blocked')
      ORDER BY column_name
    `);
    console.log(`  📦 products columns (${prodCols.rows.length}/14):`);
    prodCols.rows.forEach(r => console.log(`     ✅ ${r.column_name}`));

    const orderCols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'orders'
        AND column_name IN ('delivered_at','review_token','review_invited_at',
                            'review_submitted_at','cogs_data','exchange_token')
      ORDER BY column_name
    `);
    console.log(`\n  📦 orders columns (${orderCols.rows.length}/6):`);
    orderCols.rows.forEach(r => console.log(`     ✅ ${r.column_name}`));

    const revCols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'reviews'
        AND column_name IN ('verified_purchase','source','cj_review_id')
      ORDER BY column_name
    `);
    console.log(`\n  📦 reviews columns (${revCols.rows.length}/3):`);
    revCols.rows.forEach(r => console.log(`     ✅ ${r.column_name}`));

    const sm = await pool.query('SELECT COUNT(*) AS c FROM shipping_matrix');
    console.log(`\n  🗺️ shipping_matrix rows: ${sm.rows[0].c} (ستُملأ من build_shipping_matrix.js)`);

    const coupons = await pool.query(`SELECT code FROM coupons WHERE code IN ('RECOVER10','NEXT5') ORDER BY code`);
    console.log(`\n  🎟️ coupons: ${coupons.rows.map(c => c.code).join(', ')}`);

  } catch (vErr) {
    console.error('⚠️ verification failed:', vErr.message);
  }

  console.log(`\n═══ done: ok=${ok} fail=${fail} ═══`);
  await pool.end();
  fail > 0 ? process.exit(1) : process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });