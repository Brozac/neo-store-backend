// wipe_old_catalog.js — 🗑️ Full Delete — old catalog + related reviews/favorites
// ⚠️ IRREVERSIBLE — تأكد قبل التشغيل
require('dotenv').config();
const pool = require('./db');

(async () => {
  console.log('═══ 🗑️ Catalog Wipe — Full Delete ═══\n');

  // ─── 1. الإحصاء قبل الحذف ───
  const { rows: before } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM order_items) AS order_items,
      (SELECT COUNT(*) FROM orders) AS orders
  `);
  const b = before[0];
  console.log(`📊 قبل الحذف:`);
  console.log(`   Products: ${b.products}`);
  console.log(`   Reviews: ${b.reviews}`);
  console.log(`   Order Items: ${b.order_items}`);
  console.log(`   Orders (محفوظة — لا تُمس): ${b.orders}\n`);

  // ─── 2. حذف المنتجات القديمة (غير المرتبطة بطلبات delivered/completed) ───
  //  نحفظ المنتجات المرتبطة بطلباتك المالية (fulfilled/completed/refunded/paid)
  const { rows: protectedProducts } = await pool.query(`
    SELECT DISTINCT oi.product_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('paid','fulfilled','completed','refunded')
  `);
  const protectedIds = protectedProducts.map(r => r.product_id);
  console.log(`🛡️ منتجات محمية (مرتبطة بطلبات مالية): ${protectedIds.length}\n`);

  // ─── 3. حذف المراجعات الوهمية (user_id IS NULL) ───
  const delReviews = await pool.query(`
    DELETE FROM reviews WHERE user_id IS NULL RETURNING id
  `);
  console.log(`🗑️ Reviews وهمية محذوفة: ${delReviews.rowCount}`);

  // ─── 4. حذف المفضلات المرتبطة بمنتجات ستُحذف ───
  //  favorites جدول مستقل — لا CASCADE — نحذف يدوياً
  //  (لو عندك جدول favorites — عدّل هذا)

  // ─── 5. حذف المنتجات — غير المحمية ───
  //  CASCADE يحذف: reviews · order_items · favorites المرتبطة تلقائياً
  let deletedProducts = 0;

  // 5a. حذف دفعات — 500 في كل مرة (أداء)
  const batchSize = 500;
  let batch = 0;
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
  }

  // ─── 6. تنظيف يدوي — منتجات MANUAL_ (أضفتها يدوياً سابقاً) ───
  //  (اختياري — احذف التعليق إذا أردت)
  //  const delManual = await pool.query(`
  //    DELETE FROM products WHERE cj_product_id LIKE 'MANUAL_%' RETURNING id
  //  `);
  //  console.log(`🗑️ Manual products deleted: ${delManual.rowCount}`);

  // ─── 7. النتيجة النهائية ───
  const { rows: after } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM orders) AS orders
  `);
  const a = after[0];
  console.log(`\n📊 بعد الحذف:`);
  console.log(`   Products: ${a.products}`);
  console.log(`   Reviews: ${a.reviews}`);
  console.log(`   Orders: ${a.orders} (محفوظة ✓)`);

  console.log(`\n═══ ✅ Wipe Complete — DB نظيف، جاهز للاستيراد ═══`);
  console.log(`   الخطوة التالية: node smart_clone.js\n`);
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
