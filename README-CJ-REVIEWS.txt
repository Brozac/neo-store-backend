═══════════════════════════════════════════════════════════════════
  LaClarc — كيت 34 [cj-reviews]
  ريفيوزات CJ الحقيقية داخل صفحات المنتجات — بلا أي تعديل فرونت
═══════════════════════════════════════════════════════════════════

📦 شنو يدير هاد الكيت؟
  الـ PDP تاع laclarc.com عنددها أصلاً قسم «Customer Reviews» كيقرا من
  GET /api/reviews/:productId (جدول reviews المحلي — تنضّف الوهمي من قبل).

  هاد الكيت كيزيد ريفيوزات CJ الحقيقية (من مشتري CJ الفعليين — أسماء
  مقنّعة F***o + صور حقيقية + بلدان) داخل نفس الجواب:

      المحليون أولاً (زبائن حقيقية) ← ثم ريفيوزات CJ (كاش 6 ساعات)

  الفرونت كيعرضهم أوتوماتيكياً: النجوم، الاسم، البلد، النص، وحتى صور
  المشترين (كليك = الصورة الكاملة) — صفر تعديل فرونت، صفر كتابة في DB.

🗂️ الملفات اللي كيتبدلو (backend فقط — 2):
  1. routes/cjLiveBridge.js  ← v3.4 [cj-reviews]:
       · fetchCjReviews() — productComments GET + كاش 6 ساعات
       · 🛡️ precision-fix: commentId (19 خانة) كيتحفظ كنص — JSON.parse
         تاع Node كيقصّو بصمت (درس من قراية الوثيقة سطر بسطر)
       · 🔍 envelope hardened: النجاح success:true / الخطأ result:false
         (فخ الوثيقة) — التحقق بـ code===0 + رفض result:false
       · راوت جديد GET /api/cj-live/reviews/:pid?page=&size=&score=
  2. server.js               ← getCjMergedReviews() + سطر الدمج
       · كيقرا cj_product_id من جدول products (SELECT فقط)
       · أي فشل → ريفيوزات محلية فقط (تدهور صامت — الصفحة ما تكسرش)

🚀 التركيب:
  1. حلّ هاد الـ zip داخل جذر الـ backend (المجلد اللي فيه server.js)
  2. شغّل:  python patch_cj_reviews.py     (ولا PATCH-CJ-REVIEWS.bat)
     · fail-closed: إلا الأنكورز تبدلو → ما يكتب والو + مجلد kit34-diag
       فيه الملفات الحالية بصيغة .txt — صيفطو للمطوّر ورقعة مخصصة تجي
  3. تحقق:  node --check server.js routes/cjLiveBridge.js
  4. git add . && git commit -m "kit34: cj reviews merge" && git push
  5. Render redeploy (أو أوتوماتيك)
  6. python verify_cj_reviews.py     ← التحقق اللايف

🔍 التحقق (--check):  python patch_cj_reviews.py --check
     RAW = نقي وجاهز · PATCHED = مركب من قبل · UNKNOWN = انجراف (ما يكتبش)

↩️ التراجع (بلا خوف):
     copy routes\cjLiveBridge.js.bak-kit34 routes\cjLiveBridge.js
     copy server.js.bak-kit34 server.js
   الـ backup هو النسخة الأصلية الأولى — ما كيتخطاش أبداً.

💰 اقتصاد النقاط:
  · productComments كيتطلب نقاط (كيما باقي endpoints) — كيتضرب غير
    مرة/منتج/6 ساعات (كاش مشترك بين الدمج والراوت المباشر)
  · منتج بلا cj_product_id → صفر نداءات CJ نهائياً
  · منتج CJ بلا ريفيوزات → نداء واحد + total=0 مركب 6 ساعات

⚠️ حدود v1 (مقصودين):
  · كيجيب أول 20 ريفيوز من CJ (الكارت كيعرض 6 — كافي)
  · عداد العنوان = عدد الريفيوزات المحمّلة (ماشي الإجمالي عند CJ)
  · ماكانش "Load more" — الراوت المباشر /reviews/:pid جاهز للصفحات
    الجاية (page/score parameters خدّامين)

🧪 الاختبارات قبل التسليم: 20/20 سموك (محاكاة CJ كاملة) + 29/29 باتشر
═══════════════════════════════════════════════════════════════════
