// cleanup_fake_reviews.js — fake-reviews purge (pre-campaign cleanup)
// ⚠️ التصنيف: مراجعة بلا user_id = وهمية (Seeder/admin) · بـ user_id = حقيقية (مستخدم مسجل)
// المرحلة 1: node cleanup_fake_reviews.js            → معاينة كاملة، صفر حذف
// المرحلة 2: node cleanup_fake_reviews.js --delete   → تنفيذ الحذف بعد المعاينة
require('dotenv').config();
const pool = require('./db');

const DRY_RUN = !process.argv.includes('--delete');

(async () => {
  console.log(`═══ 🧹 Fake-Reviews Cleanup — ${DRY_RUN ? '🔍 DRY RUN (معاينة فقط)' : '🗑️ DELETE MODE'} ═══\n`);

  // ─── 1. الإحصاء الكامل — التصنيف حسب المصدر ───
  const { rows: stats } = await pool.query(`
    SELECT
      COALESCE(user_id IS NULL, true) AS is_fake,
      COUNT(*) AS count,
      ROUND(AVG(rating)::numeric, 2) AS avg_rating
    FROM reviews
    GROUP BY 1
    ORDER BY 1 DESC
  `);
  console.log('📊 التصنيف الكامل:');
  stats.forEach(s => {
    console.log(`   ${s.is_fake ? '🎭 وهمية (بلا user_id)' : '✅ حقيقية (مستخدم مسجل)'}: ${s.count} — متوسط ⭐ ${s.avg_rating}`);
  });

  const { rows: total } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE user_id IS NULL) AS fake,
      COUNT(*) FILTER (WHERE user_id IS NOT NULL) AS real,
      COUNT(*) AS all_reviews,
      COUNT(DISTINCT product_id) FILTER (WHERE user_id IS NULL) AS products_affected
    FROM reviews
  `);
  const t = total[0];
  console.log(`\n📈 الملخص: ${t.all_reviews} إجمالي → 🎭 ${t.fake} وهمية ستُحذف → ✅ ${t.real} حقيقية تبقى`);
  console.log(`   المنتجات المتأثرة: ${t.products_affected} من 17,833\n`);

  // ─── 2. عينات من الـ fake (قبل الحذف — تصوير الوثيقة) ───
  const { rows: samples } = await pool.query(`
    SELECT id, product_id, author, rating, content, created_at
    FROM reviews
    WHERE user_id IS NULL
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('🎭 عينة من ما سيُحذف (آخر 5):');
  samples.forEach(s => {
    console.log(`   [${s.id}] ${s.author} ⭐${s.rating} — "${String(s.content).slice(0, 40)}" — ${s.created_at?.toISOString?.()?.slice(0, 10)}`);
  });

  // ─── 3. عينات من الـ REAL — تأكيد أن الحقيقي محمي ───
  const { rows: realSamples } = await pool.query(`
    SELECT id, product_id, author, rating, created_at
    FROM reviews
    WHERE user_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 3
  `);
  console.log(`\n✅ عينة من المحمي (real): ${realSamples.length > 0 ? '' : '(لا يوجد بعد — طبيعي في test mode)'}`);
  realSamples.forEach(s => {
    console.log(`   [${s.id}] ${s.author} ⭐${s.rating} — ${s.created_at?.toISOString?.()?.slice(0, 10)}`);
  });

  // ─── 4. التنفيذ — فقط في وضع --delete ───
  if (!DRY_RUN) {
    console.log('\n🗑️ DELETE MODE — executing...');
    const del = await pool.query('DELETE FROM reviews WHERE user_id IS NULL RETURNING id');
    console.log(`✅ ${del.rowCount} مراجعة وهمية حُذفت.`);

    // products بلا أي مراجعة بعد التنظيف — يفيد لو أعدت بناء عرض النجوم
    const orphaned = await pool.query(`
      SELECT COUNT(*) AS c FROM products p
      WHERE p.stock_status = true
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = p.id)
    `);
    console.log(`ℹ️ منتجات بلا أي مراجعة بعد التنظيف: ${orphaned.rows[0].c} — طبيعي، المراجعات الحقيقية تبني بالوقت.`);
  } else {
    console.log('\nℹ️ DRY RUN — لم يُحذف شيء. للتنفيذ الفعلي:');
    console.log('   node cleanup_fake_reviews.js --delete');
    console.log('\n⚠️ تأكد قبل التنفيذ:');
    console.log('   1. Seeder cron معطّل (وإلا ترجع تُزرع من جديد كل ليلة)');
    console.log('   2. الوقت مناسب: يفضّل قبل أول حملة إعلانية، ليس وسط ترافيك');
  }

  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });