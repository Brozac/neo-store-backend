// scripts/auditImport.js — فحص الـ schema + جودة المنتجات المستوردة
// تشغيل: node scripts/auditImport.js
//  1) يتأكد أن كل الأعمدة اللي يحتاجها upsert موجودة + unique index على cj_product_id
//  2) يعدّ المنتجات الناقصة (صور/وصف/متغيرات/وزن/تصنيف/سعر...)
//  3) يطبع عينة عشوائية 3 منتجات
require('dotenv').config();
const pool = require('../db');

const REQUIRED_COLUMNS = [
  'title', 'price', 'original_price', 'image_url', 'images', 'variants', 'colors', 'sizes',
  'patterns', 'stock_status', 'is_sourced', 'cj_product_id', 'description', 'material',
  'category', 'video_url', 'cj_category_id', 'cj_listed_num', 'warehouse_inventory',
  'verified_warehouse', 'has_video', 'free_shipping', 'delivery_cycle', 'has_ce_cert',
  'product_type_cj', 'product_props', 'weight_grams', 'warehouse_country_codes',
];

async function checkSchema() {
  let ok = true;
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`
  );
  const have = new Set(rows.map((r) => r.column_name));
  const missing = REQUIRED_COLUMNS.filter((c) => !have.has(c));
  if (missing.length) {
    ok = false;
    console.log(`❌ Missing columns: ${missing.join(', ')}\n   → شغّل migrations/001_products_cj_columns.sql`);
  } else {
    console.log('✅ All required columns exist');
  }

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'products' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(cj_product_id)%'`
  );
  if (idx.rows.length) {
    console.log(`✅ Unique index on cj_product_id (${idx.rows[0].indexname})`);
  } else {
    ok = false;
    console.log('❌ No UNIQUE index on cj_product_id — ON CONFLICT will fail (see SQL file footer)');
  }

  const dup = await pool.query(
    `SELECT cj_product_id, COUNT(*) AS n FROM products
     WHERE cj_product_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 5`
  );
  if (dup.rows.length) {
    ok = false;
    console.log('❌ Duplicate cj_product_id:', dup.rows);
  }
  return ok;
}

async function checkQuality() {
  const checks = {
    'no main image':      `(image_url IS NULL OR image_url = '')`,
    'no gallery images':  `(images IS NULL OR images::text IN ('{}', '[]', ''))`,
    'single image only':  `(images::text NOT IN ('{}', '[]', '') AND images::text NOT LIKE '%,%')`,
    'short description':  `(description IS NULL OR LENGTH(REGEXP_REPLACE(description, '<[^>]*>', '', 'g')) < 50)`,
    'no variants':        `(variants IS NULL OR variants::text IN ('[]', ''))`,
    'bad price':          `(price IS NULL OR price <= 0)`,
    'no weight':          `(weight_grams IS NULL OR weight_grams = 0)`,
    "category = 'other'": `(category IS NULL OR category = 'other')`,
    'no warehouse info':  `(warehouse_country_codes IS NULL OR cardinality(warehouse_country_codes) = 0)`,
  };

  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM products WHERE cj_product_id IS NOT NULL`)).rows[0].n;
  console.log(`\n📊 CJ products in DB: ${total}`);
  if (!total) return;

  for (const [label, cond] of Object.entries(checks)) {
    try {
      const n = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM products WHERE cj_product_id IS NOT NULL AND ${cond}`
      )).rows[0].n;
      console.log(`${n === 0 ? '✅' : '⚠️ '} ${label}: ${n} (${((n / total) * 100).toFixed(1)}%)`);
    } catch (e) {
      console.log(`❓ ${label}: check failed (${e.message})`);
    }
  }

  const sample = await pool.query(
    `SELECT cj_product_id, title, price, category, weight_grams, image_url, LENGTH(description) AS desc_len
     FROM products WHERE cj_product_id IS NOT NULL ORDER BY RANDOM() LIMIT 3`
  );
  console.log('\n🔎 Random sample:');
  sample.rows.forEach((r) => console.log(r));
}

(async () => {
  let code = 0;
  try {
    const ok = await checkSchema();
    if (!ok) code = 1;
    await checkQuality();
  } catch (e) {
    console.error('❌ Audit failed:', e.message);
    code = 1;
  } finally {
    await pool.end();
    process.exit(code);
  }
})();