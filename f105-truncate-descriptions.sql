-- ═══ F105 R4 — قص ذيل الوصف الزائد (فواضل الاستيراد) ═══
-- التشخيص: 15,524 منتج description > 2000 حرف، أقصى واحد 89,112 حرف.
-- الحد هنا: > 4000 حرف ← كيتقص لـ 4000. العرض آمن؛ SEO كيقرا من
-- seo_title / seo_meta_description (أعمدة منفصلة). الاسترجاع: غير عبر massSync.
-- عدد السطور المتوقع: 2038 (count حي من قاعدة البيانات)

-- 1) معاينة (شغلها أولاً):
SELECT count(*) AS oversized FROM products WHERE length(description) > 4000;
SELECT id, name, length(description) AS len
FROM products WHERE length(description) > 4000
ORDER BY len DESC LIMIT 10;

-- 2) الإصلاح (شغله ملي تكون واجد — Supabase SQL Editor):
BEGIN;
UPDATE products SET description = LEFT(description, 4000) WHERE length(description) > 4000;
COMMIT;

-- من بعد: TOAST كيتخف (كان 117MB) وكل القراءات المستقبلية كيصغر egress ديالها.
