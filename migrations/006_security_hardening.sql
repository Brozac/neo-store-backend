-- ═══════════════════════════════════════════════════════════════════
-- 006_security_hardening.sql — تقرير التدقيق الشامل 2026-11-18
-- Supabase PostgreSQL (laclarc) — إصلاحات قاعدة البيانات
-- ═══════════════════════════════════════════════════════════════════
-- السياق:
--   · التطبيق يتصل بـ postgres مباشرة (pooler) — لا يستعمل Supabase API/PostgREST
--   · auth.users فارغ (0) — Supabase Auth غير مستخدم إطلاقاً
--   · كل جداول public عليها RLS:ON + صفر policies = deny-all عبر PostgREST (سليم)
--   · لكن GRANTs على anon/authenticated كانت واسعة جداً (حتى TRUNCATE!)
--     → إذا تُركت، أي تسريب مستقبلي لأنون-كي يصبح ساقط الحماية عند أول policy
--       أو أول تعطيل RLS. الإصلاح: صلاحيات صفرية (zero-trust).
--
-- ⚠️ تشغيل: Supabase SQL Editor (بصلاحيات postgres) — أو psql بحساب postgres.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1) إزالة كل الصلاحيات عن anon/authenticated (zero-trust) ───────────
--   service_role يبقى (لا يستخدم حالياً لكنه دور Supabase الخادمي القياسي).
--   الـ backend يعمل بحساب postgres (owner) — غير متأثر بأي REVOCke هنا.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
REVOKE USAGE ON SCHEMA public FROM anon;
REVOKE USAGE ON SCHEMA public FROM authenticated;

-- ─── 2) الافتراضي للجداول المستقبلية — نفس الصرامة ──────────────────────
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM authenticated;

-- ─── 3) أعمدة حدود الكوبونات (B-M5 — couponHelper يعتمدها) ──────────────
--   nullable → الكوبونات القديمة تخدم بلا تغيير (NULL = بلا حد).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS max_uses INTEGER
  CHECK (max_uses IS NULL OR max_uses >= 1);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0;

-- فهرس خفيف لفحص الصلاحية السريع في checkout
CREATE INDEX IF NOT EXISTS idx_coupons_code_active
  ON coupons (code) WHERE is_active = true;

COMMIT;

-- ─── 4) تحقق بعد التطبيق (شغله يدوياً بعد COMMIT) ───────────────────────
--   a) لا GRANTs متبقية لـ anon/authenticated:
--      SELECT table_name, grantee FROM information_schema.role_table_grants
--      WHERE table_schema='public' AND grantee IN ('anon','authenticated');
--      → يجب أن يرجع صفر صفوف.
--   b) أعمدة الكوبونات:
--      SELECT column_name FROM information_schema.columns
--      WHERE table_name='coupons' AND column_name IN ('expires_at','max_uses','used_count');
--      → يجب أن يرجع 3 صفوف.
--   c) RLS ما زال ON على كل الجداول:
--      SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--      WHERE n.nspname='public' AND relkind='r' AND NOT relrowsecurity;
--      → يجب أن يرجع صفر صفوف.

-- ─── 5) إغلاق الدائرة: جداول i18n المُشار إليها في الكود كانت مفقودة ─────
--   lib/i18nEngine.js يقرأ/يكتب i18n_cache + product_translations — كانت
--   غير موجودة في DB (server.js:3185 يوثق "استعلام فاشل"). الإصلاح: الإنشاء
--   (نفس تعريف create_i18n_tables.js — Mission #20) → التخزين المؤقت للترجمة يعمل.
CREATE TABLE IF NOT EXISTS i18n_cache (
  cache_key TEXT PRIMARY KEY,
  target_lang VARCHAR(10) NOT NULL,
  original TEXT,
  translated TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS product_translations (
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  lang VARCHAR(10) NOT NULL,
  title TEXT,
  description TEXT,
  PRIMARY KEY (product_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_prod_trans ON product_translations(product_id, lang);
CREATE INDEX IF NOT EXISTS idx_i18n_lang ON i18n_cache(target_lang);
