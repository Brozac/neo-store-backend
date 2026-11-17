# حزمة ملفات Backend — Laclarc (منفصلة عن الـ Frontend)

## أين server.js؟
ملف `server.js` (~4,300 سطر — Node.js/Express المنشور على Render)
**موجود فقط على جهازك** في `~/Desktop/DRPS/backend/server.js`.
لا توجد له نسخة في بيئة العمل هنا، وكل الباتشات التي تستهدفه
تُطبَّق على نسختك المحلية ثم تُرفع إلى Render.

## محتويات الحزمة

| الملف | الوصف | طريقة التطبيق |
|---|---|---|
| `db.js` | النسخة المصلحة F#29 (DBFIX): `min: 0` + فحص صحّة عند الإقلاع — يمنع حرق ساعات Neon/Supabase ويُظهر الخطأ الحقيقي في Render Logs | استبدل بها `backend/db.js` ثم أعد النشر |
| `patches/laclarc-backend-dbfix-FROM-lacpro41.patch` | نفس إصلاح F#29 بصيغة git patch | `git apply` داخل مجلد backend — إن كانت مطبقة سابقاً تجاهلها |
| `patches/laclarc-cron-thin-FROM-dbfix.patch` | CRON-THIN: محاذاة كل الكرونات إلى :00 — قاعدة البيانات تستيقظ 1×/ساعة بدل 4× | `git apply` على server.js — إن كانت مطبقة سابقاً تجاهلها |
| `.env.example` | أسماء متغيرات البيئة فقط — بلا أي قيم أو أسرار | انسخ الأسماء إلى Render Env أو `.env` المحلي |

## حالة مهمة F#105 (تخفيض Egress في Supabase — 6.57GB / 5GB)

- التشخيص الحي تم بالأرقام: products = 374MB من أصل 389MB؛
  مسار `/related` بدون تخزين مؤقت ≈ 600 ألف استدعاء/شهر؛
  استعلامات PDP بـ `SELECT *` ≈ 880MB/شهر من الـ Egress.
- كيت `apply-f105.js` (v2) فُقد مع إعادة تدوير بيئة العمل
  وسيُعاد بناؤه عند طلبك، ثم تشغّله محلياً:
  `cd ~/Desktop/DRPS/backend && node apply-f105.js server.js`
  وعند أي فشل في مطابقة المرساة يكتب تلقائياً `f105-scan-report.txt` لإعادة المعايرة.
- مهام قائمة: تخزين مؤقت لـ `/related` · تحسين استعلام feed md5 (11.7s) · نقل صور المنتجات إلى Cloudflare R2.

## متغيرات R2
أسماء المتغيرات في `.env.example` (R2_*). القيم من حسابك في Cloudflare —
تُدخل في Render Env أو `.env` المحلي فقط، ولا تُخزَّن في الكود ولا تُرفع إلى git.
