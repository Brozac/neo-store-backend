🚦 laclarc-supakit — النقل Neon → Supabase (F#33)
═══════════════════════════════════════════════════

الدليل الكامل: MIGRATION-SUPABASE.md (في نفس مجلد التحميل)

التشغيل السريع:
  1) فك الضغط في أي مجلد
  2) PowerShell داخل المجلد:
        npm install
  3) فحص صحة النيون (شوف واش الكوتا سالات ولا لا):
        node migrate.mjs --check --from '<NEON_URL>'
  4) النقل:
        node migrate.mjs --from '<NEON_URL>' --to '<SUPABASE_URL>'

ما كتخدمش بلا:
  - NEON_URL   : console.neon.tech → Connection string (pooled، فيه sslmode=require)
  - SUPABASE_URL: supabase.com → Settings → Database → Session pooler (port 5432)
    الشكل: postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require

⚠️ الرموز الخاصة في كلمة السر قادهم بـ URL-encoding (@ → %40 ...)

السكريبت:
  - كيقرا برك من النيون (لا كتابة عليه والو)
  - كيصايب في Supabase: enums + sequences + الجداول + الداتا + السيكانسات + FKs + الفهارس
  - كيتحقق: عدادات + هاش MD5 لكل جدول — أي ❌ = راجع الرسالة وعاود بـ --truncate
  - حمايات: كيرفض Neon كهدف، وكيرفض هدف معمّر بلا --truncate

متكريش تحذف node_modules من الارشيف ديالك — npm install كيجيبهم
