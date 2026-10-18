// ============================================================
// run-trgm-migration.js — Task 19-E (P1: تسريع البحث على 73k+ منتج)
// ============================================================
// سكريبت JS واحد — بلا psql بلا DBeaver — كيتحقن مباشرة فـ Neon.
// كل استعلام كيتنفذ بوحدو (بلا transaction) => CONCURRENTLY خدامة 100%.
//
// التشغيل من جوا فولدر الـ backend (فين كاين node_modules):
//   node scripts/run-trgm-migration.js
// أو بتمرير الاتصال يدوياً:
//   node scripts/run-trgm-migration.js "postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require"
// ============================================================
require('dotenv').config({ quiet: true }); // quiet: بلا إعلانات dotenv الفارغة
const { Pool } = require('pg');

// ─── 1) مصدر الاتصال: أرگيومونت > .env ───
let connString = process.argv[2] || process.env.DATABASE_URL;
if (!connString) {
  console.error('❌ ما لقيتش DATABASE_URL');
  console.error('   الحل: حطو فـ backend/.env ولا مرّرو مباشرة:');
  console.error('   node scripts/run-trgm-migration.js "postgresql://user:pass@host/db?sslmode=require"');
  process.exit(1);
}

// ─── 2) أمان: Neon "-pooler" كيكسّر CONCURRENTLY (PgBouncer transaction mode) ───
if (/-pooler\./.test(connString)) {
  connString = connString.replace('-pooler.', '.');
  console.log('🔁 لقيت "-pooler" فالعنوان — انتقلت للاتصال المباشر (CONCURRENTLY كيحتاج direct)');
}

let u;
try {
  u = new URL(connString);
} catch {
  console.error('❌ سلسلة الاتصال ماشي صحيحة (تأكد من الشكل postgresql://user:pass@host/db)');
  process.exit(1);
}
console.log(`🎯 الهدف: ${u.hostname}${u.port ? ':' + u.port : ''}/${u.pathname.replace(/^\//, '')} (المستخدم: ${u.username})`);

// ─── 3) الاتصال — SSL إجباري للسحابة، بلا SSL للمحلي ───
const pool = new Pool({
  connectionString: connString,
  application_name: 'laclarc-trgm-migration',
  ssl: /localhost|127\.0\.0\.1/.test(u.hostname) ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 30000, // وقت كافٍ باش تفيق Neon من الـ suspend
});

const STEPS = [
  ['extension pg_trgm',
   `CREATE EXTENSION IF NOT EXISTS pg_trgm`],
  ['idx_products_title_trgm',
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_title_trgm ON products USING gin (title gin_trgm_ops)`],
  ['idx_products_description_trgm',
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_description_trgm ON products USING gin (description gin_trgm_ops)`],
  ['idx_products_category_trgm',
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_category_trgm ON products USING gin (category gin_trgm_ops)`],
];

// إلا فشل CREATE INDEX CONCURRENTLY كيخلي فهرس INVALID — هادا كينقّيهم (idempotent)
async function dropInvalidTrgmIndexes() {
  const { rows } = await pool.query(`
    SELECT c.relname AS name
    FROM pg_index x
    JOIN pg_class c ON c.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    WHERE t.relname = 'products' AND NOT x.indisvalid
      AND c.relname LIKE 'idx_products_%_trgm'`);
  for (const r of rows) {
    await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS "${r.name}"`);
    console.log(`   🧹 نقيّت الفهرس الخاسر (INVALID): ${r.name}`);
  }
  return rows.length;
}

(async () => {
  // ─── 4) فحص الاتصال + الجدول قبل أي شيء ───
  const t0 = Date.now();
  let n;
  try {
    ({ rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM products`));
  } catch (e) {
    if (e.code === '42P01') {
      console.error('❌ جدول products ما كاينش فهاد القاعدة — هادي قاعدة خاوية!');
      console.error('   خاصك أولاً تسترجع الـ schema + البيانات، ومن بعد trgm. عيّط ليا.');
    } else {
      console.error(`❌ فشل الاتصال [${e.code || '—'}]: ${e.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✅ الاتصال ناجح — products فيها ${n.toLocaleString('en-US')} منتج (${dur}s${Number(dur) > 5 ? ' — Neon تفيق من الـ suspend' : ''})`);

  // ─── 5) التنفيذ خطوة بخطوة (كل استعلام بوحدو = CONCURRENTLY خدامة) ───
  for (const [label, sql] of STEPS) {
    const s = Date.now();
    process.stdout.write(`⏳ ${label} ... `);
    try {
      await pool.query(sql);
      console.log(`✅ (${((Date.now() - s) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.log(`❌\n   الكود: ${e.code || '—'} — ${e.message}`);
      if (/cannot run inside a transaction block/.test(e.message)) {
        console.error('   💡 السبب: اتصال عبر PgBouncer transaction mode — خاصك direct connection.');
      }
      const cleaned = await dropInvalidTrgmIndexes().catch(() => 0);
      if (cleaned) console.error('   🧹 تنقّت الفهارس الخاسرة — عاود شغل السكريبت (idempotent).');
      process.exitCode = 1;
      return;
    }
  }

  // ─── 6) التحقق النهائي ───
  const { rows: idx } = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'products' AND indexname LIKE 'idx_products_%_trgm'
    ORDER BY 1`);
  console.log(`\n📁 الفهارس trgm المثبتة (${idx.length}/3):`);
  idx.forEach(r => console.log('   • ' + r.indexname));

  const { rows: plan } = await pool.query(
    `EXPLAIN ANALYZE SELECT id FROM products WHERE title ILIKE '%phone%'`);
  const first = r => String(Object.values(r)[0]);
  const planText = plan.map(first).join('\n');
  console.log('\n🔬 EXPLAIN كامل (البحث %phone%):');
  plan.forEach(r => console.log('   ' + first(r))); // الخطة كاملة — الـ Index Scan كيجي فسطر ما بعد الأول
  if (/Bitmap Index Scan on idx_products_title_trgm/.test(planText)) {
    console.log('\n🚀 البركة! البحث ولّى Bitmap Index Scan — ماشي Sequential Scan على 73k+ منتج.');
  } else {
    console.log('\n⚠️ الفهارس موجودة ولكن الـ planner مازال كيمشي بـ Seq Scan — عيّط ليا نشوف العلة.');
  }
})()
  .catch(e => { console.error('❌ خطأ غير متوقع:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
