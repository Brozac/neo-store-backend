-- ============================================================
-- 003_pg_trgm_search_indexes.sql — Task 19-D (P1: بحث سريع على 73k+ منتج)
-- ============================================================
-- المشكل: كل بحث ILIKE '%q%' على title/description = Sequential Scan كامل
--         على 73,597 منتج فكل ضغطة بحث (P95 باهظ مع النمو).
-- الحل: pg_trgm + فهارس GIN — ILIKE '%...%' كيولّي Bitmap Index Scan.
-- التنفيذ (مرة واحدة فقط):
--   psql "$DATABASE_URL" -f migrations/003_pg_trgm_search_indexes.sql
-- ملاحظات:
--   • CONCURRENTLY = بلا قفل على الجدول (آمن على الإنتاج) — ماكيخدمش داخل
--     transaction، وpsel/psql بلا BEGIN كينفذ كل سطر بوحدو. إلا استعملت
--     أداة كتلف كلشي فـ transaction، حيّد CONCURRENTLY.
--   • Neon/Supabase: pg_trgm مدعوم رسمياً (CREATE EXTENSION كيدوز).
--   • category: البحث الحالي كيستعمل prefix (ILIKE 'x%') — trgm كيسرّع
--     حتى هاد النمط + كيغطي '%x%' إلا تبدل مستقبلاً.
-- التحقق من بعد:
--   EXPLAIN ANALYZE SELECT id FROM products WHERE title ILIKE '%phone%';
--   خاصك تشوف Bitmap Index Scan على idx_products_title_trgm.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_title_trgm
  ON products USING gin (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_description_trgm
  ON products USING gin (description gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_category_trgm
  ON products USING gin (category gin_trgm_ops);
