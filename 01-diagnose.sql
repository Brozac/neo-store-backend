-- ═══════════════════════════════════════════════════════════════
-- F#105-EGRESS — 01-diagnose.sql (كلشي READ-ONLY — آمن 100%)
-- ═══════════════════════════════════════════════════════════════
-- خُدم بيه فـ Supabase SQL Editor. النتائج اللي خرجات فـ 2026-11-16
-- مكتوبة فـ README-F105-EGRESS.md — هاد الملف باقي للمرجع/إعادة التشخيص.
-- ═══════════════════════════════════════════════════════════════

-- A) حجم الداتابيز
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size,
       pg_database_size(current_database()) AS db_bytes;

-- B) الجداول: الحجم + TOAST + dead tuples
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       pg_size_pretty(pg_relation_size(relid)) AS heap_size,
       pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid) - pg_indexes_size(relid)) AS toast_size,
       n_live_tup, n_dead_tup, last_autovacuum, seq_scan
FROM pg_stat_user_tables
WHERE n_live_tup > 0 OR n_dead_tup > 0
ORDER BY pg_total_relation_size(relid) DESC LIMIT 15;

-- C) كولونات products
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='products' ORDER BY ordinal_position;

-- D) وزن الكولونات (عينة 300 صف) — bytes متوسطين
SELECT 'description' col, round(avg(pg_column_size(description))::numeric,0) avg_bytes FROM (SELECT description FROM products LIMIT 300) s
UNION ALL SELECT 'variants', round(avg(pg_column_size(variants))::numeric,0) FROM (SELECT variants FROM products LIMIT 300) s
UNION ALL SELECT 'images', round(avg(pg_column_size(images))::numeric,0) FROM (SELECT images FROM products LIMIT 300) s
UNION ALL SELECT 'seo_meta_description', round(avg(pg_column_size(seo_meta_description))::numeric,0) FROM (SELECT seo_meta_description FROM products LIMIT 300) s
UNION ALL SELECT 'image_url', round(avg(pg_column_size(image_url))::numeric,0) FROM (SELECT image_url FROM products LIMIT 300) s
UNION ALL SELECT 'category', round(avg(pg_column_size(category))::numeric,0) FROM (SELECT category FROM products LIMIT 300) s
UNION ALL SELECT 'title', round(avg(pg_column_size(title))::numeric,0) FROM (SELECT title FROM products LIMIT 300) s
UNION ALL SELECT 'seo_title', round(avg(pg_column_size(seo_title))::numeric,0) FROM (SELECT seo_title FROM products LIMIT 300) s
ORDER BY 2 DESC NULLS LAST;

-- E) متوسط الصف الكامل (اللي كيمشي فـ SELECT *)
SELECT pg_size_pretty(avg(row_bytes)::numeric) AS avg_full_row_bytes
FROM (SELECT pg_column_size(products) AS row_bytes FROM products LIMIT 300) s;

-- F) reviews — واش كاينين الريفيوزات المحليين
SELECT count(*) AS reviews_total,
       count(*) FILTER (WHERE user_id IS NULL) AS reviews_null_user,
       count(*) FILTER (WHERE user_id IS NOT NULL) AS reviews_real_user
FROM reviews;

-- G) system_events — الحجم والمدى الزمني
SELECT count(*) AS se_rows, pg_size_pretty(pg_total_relation_size('system_events')) AS se_size,
       min(created_at) AS oldest, max(created_at) AS newest FROM system_events;

-- H) ⭐ pg_stat_statements — الأستعلامات بالنداءات (الحرق الحقيقي)
SELECT calls, rows, round(total_exec_time::numeric,0) AS total_ms,
       round(mean_exec_time::numeric,1) AS mean_ms,
       left(query, 120) AS query_head
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat%'
ORDER BY calls DESC LIMIT 15;

-- H2) الأبطأ مجموعاً (CPU time)
SELECT round(total_exec_time::numeric/1000,0) AS total_seconds,
       calls, round(mean_exec_time::numeric,1) AS mean_ms,
       left(query, 120) AS query_head
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat%'
ORDER BY total_exec_time DESC LIMIT 10;

-- I) seq scans — واش كاين جداول كتمشي بلا فهرسة
SELECT relname, seq_scan, seq_tup_read, n_live_tup,
       pg_size_pretty(pg_total_relation_size(relid)) AS size, idx_scan
FROM pg_stat_user_tables WHERE seq_scan > 0
ORDER BY seq_tup_read DESC LIMIT 12;

-- J) فهارس products (اللي كاينين دابا)
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='products' ORDER BY indexname;

-- K) وصفات CJ الطويلة (فرصة تنظيف مستقبلية — بزاف ثقيلة)
SELECT count(*) AS desc_over_2000,
       round(avg(length(description))::numeric,0) AS avg_len,
       max(length(description)) AS max_len
FROM products WHERE length(description) > 2000;
