// wipe_old_catalog_v3.js — 🗑️ Full Delete — v3 (corrected FK handling)
require('dotenv').config();
const pool = require('./db');

(async () => {
  console.log('═══ 🗑️ Catalog Wipe v3 — Smart Delete (FK-aware) ═══\n');

  // ─── 1. الإحصاء قبل ───
  const { rows: before } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM order_items) AS order_items,
      (SELECT COUNT(*) FROM orders) AS orders
  `);
  const b = before[0];
  console.log(`📊 قبل:`);
  console.log(`   Products: ${b.products}`);
  console.log(`   Reviews: ${b.reviews}`);
  console.log(`   Order Items: ${b.order_items}`);
  console.log(`   Orders: ${b.orders}\n`);

  // ─── 2. المنتجات المحمية — لها order_items (أي حالة) ───
  //    🔑 القاعدة: FK يمنع حذفها — فنستثنيها من الـ DELETE
  const { rows: protectedProducts } = await pool.query(`
    SELECT DISTINCT product_id FROM order_items
  `);
  const protectedIds = protectedProducts.map(r => r.product_id);
  console.log(`🛡️ منتجات محمية (مرتبطة بـ order_items): ${protectedIds.length}\n`);

  // ─── 3. الحذف — على دفعات، تجاوز المحمية ───
  let deletedProducts = 0;
  let batch = 0;
  const batchSize = 500;

  while (true) {
    const { rows: batchProducts } = await pool.query(`
      SELECT id FROM products
      WHERE id NOT IN (${protectedIds.length ? protectedIds.join(',') : '0'})
        AND cj_product_id IS NOT NULL
        AND cj_product_id NOT LIKE 'MANUAL_%'
      LIMIT ${batchSize}
    `);
    if (batchProducts.length === 0) break;

    const ids = batchProducts.map(p => p.id);
    const del = await pool.query(`
      DELETE FROM products WHERE id = ANY($1::int[]) RETURNING id
    `, [ids]);
    deletedProducts += del.rowCount;
    batch++;
    console.log(`   🗑️ batch ${batch}: ${del.rowCount} حذف...`);

    if (del.rowCount < batchSize) break;
  }

  // ─── 4. حذف المراجعات الوهمية ───
  const delReviews = await pool.query(`
    DELETE FROM reviews WHERE user_id IS NULL RETURNING id
  `);
  console.log(`🗑️ Reviews وهمية محذوفة: ${delReviews.rowCount}`);

  // ─── 5. النتيجة ───
  const { rows: after } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM orders) AS orders
  `);
  const a = after[0];
  console.log(`\n📊 بعد:`);
  console.log(`   Products: ${a.products}`);
  console.log(`   Reviews: ${a.reviews}`);
  console.log(`   Orders: ${a.orders} (محفوظة ✓)`);

  console.log(`\n═══ ✅ Wipe v3 Complete ═══`);
  console.log(`   🗑️ حذف: ${deletedProducts} منتج`);
  console.log(`   🛡️ محمي: ${protectedIds.length} منتج (مرتبط بـ order_items)`);
  console.log(`   الخطوة التالية: node smart_clone.js\n`);
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });