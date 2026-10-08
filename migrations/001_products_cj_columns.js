// migrations/001_products_cj_columns.js — v1.1 (JS port من النسخة SQL)
// ============================================================
// يحضّر products لـ upsertProductRow (v3.1):
//   • 3 أعمدة دفاعية:  cj_product_id · is_sourced · video_url
//   • 12 عمود v3:      cj_category_id … warehouse_country_codes
//   • original_price:  يُنشأ إذا غائب + DROP NOT NULL (v3.1 كتمرر null — قرار 1)
//   • unique index على cj_product_id — شرط إجباري لـ ON CONFLICT (بلا بيه كل upsert = 42P10)
//   • audit أنواع images/colors/sizes/patterns (P1-3) — fail-closed إذا ماشي TEXT[]
//   • updated_at: تقرير فقط (ما كيتنشأش — قرار مؤجل)
//
// Idempotent — آمن تعاود تشغلو. lock_timeout=5s باش ما يحبسش الاستعلامات الحية
// على Neon (كل ALTER كياخد ACCESS EXCLUSIVE لحظياً — شغلو في وقت هدوء احتياطاً).
//
// تشغيل:   node migrations/001_products_cj_columns.js
// عزل (Tenet #26):  node -e "require('./migrations/001_products_cj_columns')"
// ============================================================
require('dotenv').config();
const pool = require('../db'); // إذا حطيتي الملف في جذر backend بدّل لـ './db'

const INDEX_NAME = 'products_cj_product_id_uidx';

// أعمدة الـ arrays اللي الـ builder كيمرر ليهم raw JS arrays — خاصهم TEXT[] بالضبط (P1-3)
const ARRAY_COLUMNS = ['images', 'colors', 'sizes', 'patterns'];

const EXPECTED_COLUMNS = [
  // ── دفاعية (IF NOT EXISTS = صفر تكلفة إذا موجودين) ──
  { name: 'cj_product_id',           ddl: `ADD COLUMN IF NOT EXISTS cj_product_id TEXT` },
  { name: 'is_sourced',              ddl: `ADD COLUMN IF NOT EXISTS is_sourced BOOLEAN DEFAULT FALSE` },
  { name: 'video_url',               ddl: `ADD COLUMN IF NOT EXISTS video_url TEXT` },
  { name: 'original_price',          ddl: `ADD COLUMN IF NOT EXISTS original_price NUMERIC(10,2)` },
  // ── أعمدة v3.1 ──
  { name: 'cj_category_id',          ddl: `ADD COLUMN IF NOT EXISTS cj_category_id TEXT` },
  { name: 'cj_listed_num',           ddl: `ADD COLUMN IF NOT EXISTS cj_listed_num INTEGER DEFAULT 0` },
  { name: 'warehouse_inventory',     ddl: `ADD COLUMN IF NOT EXISTS warehouse_inventory INTEGER DEFAULT 0` },
  { name: 'verified_warehouse',      ddl: `ADD COLUMN IF NOT EXISTS verified_warehouse BOOLEAN DEFAULT FALSE` },
  { name: 'has_video',               ddl: `ADD COLUMN IF NOT EXISTS has_video BOOLEAN DEFAULT FALSE` },
  { name: 'free_shipping',           ddl: `ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN DEFAULT FALSE` },
  { name: 'delivery_cycle',          ddl: `ADD COLUMN IF NOT EXISTS delivery_cycle TEXT` },
  { name: 'has_ce_cert',             ddl: `ADD COLUMN IF NOT EXISTS has_ce_cert BOOLEAN DEFAULT FALSE` },
  { name: 'product_type_cj',         ddl: `ADD COLUMN IF NOT EXISTS product_type_cj TEXT` },
  { name: 'product_props',           ddl: `ADD COLUMN IF NOT EXISTS product_props TEXT[] DEFAULT ARRAY['COMMON']::TEXT[]` },
  { name: 'weight_grams',            ddl: `ADD COLUMN IF NOT EXISTS weight_grams INTEGER` },
  { name: 'warehouse_country_codes', ddl: `ADD COLUMN IF NOT EXISTS warehouse_country_codes TEXT[] DEFAULT ARRAY[]::TEXT[]` },
];

// ==========================================
// helpers (كلهم schema-only — حتى قراءة من بيانات الجدول)
// ==========================================
const out = (...a) => console.log(...a);

async function columnExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'products' AND column_name = $1`,
    [name]
  );
  return r.rowCount > 0;
}

async function columnMeta(client, name) {
  const r = await client.query(
    `SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'products' AND column_name = $1`,
    [name]
  );
  return r.rows[0] || null;
}

// ==========================================
// التنفيذ
// ==========================================
async function run() {
  const client = await pool.connect();
  const blockers = [];
  let added = 0, existed = 0, checks = 0;

  try {
    out(`\n==================================================`);
    out(`🩹 Migration 001 — products CJ columns (v1.1)`);
    out(`==================================================\n`);

    // ── Phase 1: الأعمدة — transaction واحد، additive آمن، all-or-nothing ──
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`); // ما يبقاش معلّق على traffic حي

    for (const col of EXPECTED_COLUMNS) {
      const before = await columnExists(client, col.name);
      await client.query(`ALTER TABLE products ${col.ddl}`);
      if (before) { existed++; out(`  ✓ موجود مسبقاً : ${col.name}`); }
      else        { added++;   out(`  ✚ أُضيف        : ${col.name}`); }
    }

    // v3.1 كتمرر original_price = null (قرار 1) — NOT NULL هنا = كل upsert يفشل 23502
    const opMeta = await columnMeta(client, 'original_price');
    if (opMeta && opMeta.is_nullable === 'NO') {
      await client.query(`ALTER TABLE products ALTER COLUMN original_price DROP NOT NULL`);
      out(`  🔓 original_price : NOT NULL → NULL (مطلوب لبلا strikethrough مزوّر)`);
    }

    await client.query('COMMIT');
    out(`\n  📦 الأعمدة: ${added} جديد · ${existed} موجود مسبقاً — COMMIT ✓`);

    // ── Phase 2: duplicates → unique index (شرط ON CONFLICT) ──
    // مستقل على Phase 1: حتى إذا الفهرس تعطّل، الأعمدة محفوظين
    const dupRes = await client.query(
      `SELECT cj_product_id, COUNT(*)::int AS n FROM products
       WHERE cj_product_id IS NOT NULL
       GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 10`
    );
    if (dupRes.rows.length > 0) {
      blockers.push('duplicates');
      out(`\n  🚫 duplicates في cj_product_id — الفهرس ما تنشاش. أمثلة:`);
      for (const r of dupRes.rows) out(`     ${r.cj_product_id} × ${r.n}`);
      out(`  ↳ خلي الصف الأحدث (id الأكبر) · حوّل orders.product_id قبل الحذف — FKs أولاً. ثم عاود السكريبت.`);
    } else {
      const idx = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'products'
           AND indexdef ILIKE '%cj_product_id%'`
      );
      const full = idx.rows.find((r) => /UNIQUE/i.test(r.indexdef) && !/\bWHERE\b/i.test(r.indexdef));
      const part = idx.rows.find((r) => /UNIQUE/i.test(r.indexdef) && /\bWHERE\b/i.test(r.indexdef));

      if (full) {
        out(`  ✓ unique index موجود: ${full.indexname}`);
        if (/NULLS NOT DISTINCT/i.test(full.indexdef)) {
          out(`  ⚠️ ${full.indexname} = NULLS NOT DISTINCT — منتجات محلية متعددة بـ cj_product_id NULL غادي ترفض!`);
        }
      } else if (part) {
        blockers.push('partial_index');
        out(`  🚫 unique index PARTIAL موجود (${part.indexname}) — ON CONFLICT (cj_product_id) بلا WHERE غادي يرمي 42P10.`);
        out(`  ↳ DROP INDEX ${part.indexname}; ثم عاود هاد السكريبت.`);
      } else {
        const clash = idx.rows.find((r) => r.indexname === INDEX_NAME);
        if (clash) {
          blockers.push('index_name_clash');
          out(`  🚫 '${INDEX_NAME}' موجود لكن ماشي unique — DROP INDEX ${INDEX_NAME}; ثم عاود.`);
        } else {
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} ON products (cj_product_id)`);
          const chk = await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [INDEX_NAME]);
          out(`  🔑 unique index بُني: ${chk.rows[0]?.indexdef || INDEX_NAME}`);
        }
      }
    }

    // ── Phase 3: verification (migrate-categories.js style) ──
    out(`\n  🔍 Verification:`);
    for (const col of EXPECTED_COLUMNS) {
      checks++;
      if (await columnExists(client, col.name)) out(`  ✓ ${col.name}`);
      else { blockers.push(`missing:${col.name}`); out(`  ✗ ${col.name} — مفقود!`); }
    }

    checks++;
    const opAfter = await columnMeta(client, 'original_price');
    if (opAfter?.is_nullable === 'YES') out(`  ✓ original_price nullable (null = بلا strikethrough)`);
    else { blockers.push('original_price_not_nullable'); out(`  ✗ original_price ماشي nullable — upsert v3.1 غادي يفشل 23502`); }

    // أنواع الـ arrays (P1-3) — fail-closed: أي حاجة غير ARRAY = blocker مع سطر الإصلاح
    for (const name of ARRAY_COLUMNS) {
      checks++;
      const meta = await columnMeta(client, name);
      if (!meta) { blockers.push(`array_missing:${name}`); out(`  ✗ ${name} — العمود غائب أصلاً!`); continue; }
      if (meta.data_type === 'ARRAY') {
        out(`  ✓ ${name} = TEXT[]`);
      } else if (meta.data_type === 'jsonb') {
        blockers.push(`array_type:${name}`);
        out(`  🚫 ${name} = JSONB — v3.1 كيمرر raw array → invalid input على كل صف.`);
        out(`     الإصلاح (جرّب على نسخة تجريبية أولاً):`);
        out(`       ALTER TABLE products ALTER COLUMN ${name} TYPE TEXT[]`);
        out(`         USING COALESCE(ARRAY(SELECT jsonb_array_elements_text(${name})), ARRAY[]::TEXT[]);`);
      } else {
        blockers.push(`array_type:${name}`);
        out(`  🚫 ${name} = ${meta.data_type} (خاصو TEXT[]) — raw array غادي يتخزن '{a,b}' كنص = فساد صامت.`);
        out(`     الإصلاح:`);
        out(`       ALTER TABLE products ALTER COLUMN ${name} TYPE TEXT[]`);
        out(`         USING CASE WHEN ${name} IS NULL THEN NULL WHEN ${name} LIKE '{%' THEN ${name}::text[] ELSE ARRAY[${name}] END;`);
      }
    }

    // معلومات فقط (قرارات مؤجلة — لا mutation)
    const vMeta = await columnMeta(client, 'variants');
    if (vMeta) out(`  ℹ️ variants = ${vMeta.data_type} (JSON.stringify يتخزن مزيان في TEXT و JSONB)`);

    const ua = await columnMeta(client, 'updated_at');
    out(ua
      ? `  ℹ️ updated_at موجود — تقدر تفعّل السطر المعلّق في UPSERT_PRODUCT_SQL_V2`
      : `  ℹ️ updated_at غائب — الـ DO UPDATE ما كيحدّثش timestamps (مقبول حالياً — backlog)`);

    // ── الخلاصة ──
    out(`\n==================================================`);
    if (blockers.length === 0) {
      out(`🎯 001_products_cj_columns — PASS (${checks}/${checks} checks ✓ · ${added} عمود جديد · فهرس ✓)`);
      out(`↳ الخطوة الجاية: تنظيف الصفوف القديمة ثم DRY RUN:`);
      out(`   UPDATE products SET original_price = NULL WHERE cj_product_id IS NOT NULL;`);
      out(`   UPDATE products SET material = '' WHERE material = 'Premium Quality';`);
      out(`   SYNC_DRY_RUN=true SYNC_MAX_PRODUCTS=50 node massSync.js`);
    } else {
      out(`🎯 001_products_cj_columns — FAIL (${blockers.length} blocker): ${blockers.join(' · ')}`);
      out(`↳ الأعمدة محفوظة (COMMIT تم) — صلّح الـ blockers فوق وعاود السكريبت (idempotent).`);
    }
    out(`==================================================\n`);

    return blockers.length === 0 ? 0 : 1;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ما كانش transaction مفتوح */ }
    console.error('❌ Migration فشلت — ROLLBACK تم:', e.message);
    if (/lock timeout/i.test(e.message)) {
      console.error('↳ lock_timeout: الجدول مشغول — عاود في وقت هدوء.');
    }
    return 1;
  } finally {
    client.release();
  }
}

// تشغيل يدوي فقط — require ما ينفذ والو (اختبار العزل Tenet #26)
if (require.main === module) {
  run()
    .then((code) => pool.end().then(() => process.exit(code)))
    .catch((e) => { console.error('❌ Fatal:', e); process.exit(1); });
}

module.exports = { run };