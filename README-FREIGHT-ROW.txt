================================================================
 LaClarc Kit 29d — FREIGHT ROW FIX [freight-row]  (2026-10-20)
================================================================

التشخيص (من التوثيق الرسمي logistic 1.2 + الإنتاج):

  freightCalculateTip كان كيرجع HTTP 200 بقنوات خاوية بلا سبب
  → /product كيرجع source=estimate ("CJ ما رجعاتش قناة").

  الأسباب فصف الطلب (مقارنة مع الـ CURL الرسمي):
    1) productProp خاصو تكون مصفوفة ["COMMON"] — الكود القديم
       كيصيفط String
    2) freightTrialSkuList + skuList = Required(Y) فالتوثيق —
       freightTrialSkuList ما كانتش كتصيفط أصلاً
       (التوثيق: "Previously such a request returned an empty
        array with no reason")
    3) volume (Y) + totalGoodsAmount — كيما فالمثال الرسمي

الحل (v3.3 [freight-row]):
  · صف الطلب طبق الأصل من CURL الرسمي ديال freightCalculateTip
  · القنوات خاويين؟ → 1.3 unavailableShippingMethods (10pt)
    بنفس الـ payload — CJ كيقول علاش كل قناة ماشي متاحة:
    2015=no quote for route · 2013=dimensions · 2008=postcode ...
    → الأسباب كيتحطو ف shipping.unavailable (تشخيصي)
  · ?debug=1 فـ /product/:pid كيرجع freightDebug:
    row (الصف المرسل) · envCode · rawType · channelCount · validCount
  · كاش سلبي 10 دقائق — إعادة المحاولة على route خاوي بلا نقاط

التركيب:
  1. فك الضغط فجذر الـ BACKEND (اللي فيه server.js)
  2. INSTALL_BACKEND.bat   (ولا: python patch_freight_row.py)
  3. commit + push → Render redeploy
  4. python verify_live_pipeline.py
     → متوقع: /search MA منتجات (kit29c) + shipping.source=cj-live
       ($ فريت حقيقي + channelName + arrivalTime)
     → إلا بقى estimate، الجواب غادي يبين أسباب 1.3 الرسمية
       (ولا debug=1 للتفاصيل الكاملة)

الملفات:
  patch_freight_row.py      الرقعة (تعويض كامل cjLiveBridge.js v3.3)
  verify_live_pipeline.py   التحقق اللايف v4 (cjCode + أسباب 1.3)
  INSTALL_BACKEND.bat       مشغل ويندوز

ملاحظات نقاط CJ:
  · الدورة العادية: search(كاش=0pt) + product 10pt + freight 10pt
  · مسار الفشل (قنوات خاويين): +10pt للـ 1.3 — مرة وحدة كل 10 دقائق
  · الـ smoke المحلي: 53/53 (34 envelope + مخازن + freight-row + diag)

المرجع: download/CJ_API_Deep_Reference.md §6.2/§6.3
================================================================
