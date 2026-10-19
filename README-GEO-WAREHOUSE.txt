================================================================
 LaClarc Kit 29c — GEO WAREHOUSE FIX  (2026-10-20)
================================================================

التشخيص (مؤكد بالتوثيق الرسمي + التجربة اللايفة):

  1) listV2.countryCode ماشي "بلد التوصيل" — هو "بلد المخزن"!
     التوثيق الرسمي: "filter products with inventory in specified
     countries". المغرب ما فيهوش مخازن CJ → countryCode=MA =
     0 نتائج شرعية (US عندها مخزن → 531 نتيجة لـ "led").

  2) الشكل الحقيقي ديال جواب listV2:
        content[ i ] = { productList: [...المنتجات...], keyWord, ... }
     الكود القديم كان كياخد content[i].id (ما كاينش فالمجموعة)
     → كلشي كيتصفى → 0 منتجات حتى مع totalRecords=531!

الحل (v3.2):
  · /product/globalWarehouseList (مجاني) كيتجيب بلدان المخازن
    — كاش 24h — غير ليهم كيتصيفط countryCode (شحن محلي أسرع)
  · البلدان الباقية (بحال المغرب والجزائر...) → كاطالوغ عالمي،
    و"واش كيوصل لبلادي" كيجاوب عليه freightCalculateTip فالـ PDP
    (الثمن المباشر — هادا هو Geo Flow الصحيح)
  · فكّك content[].productList مع حماية للشكل المسطح
  · geo (فيها filterMode: warehouse/worldwide) كتدخل الكاش
  · زايد من kit29b: أخطاء envelope كيتظهرو 502+cjCode

التركيب:
  1. فك الضغط فجذر الـ BACKEND (اللي فيه server.js)
  2. INSTALL_BACKEND.bat   (ولا: python patch_geo_warehouse.py)
  3. commit + push → Render redeploy
  4. python verify_live_pipeline.py
     → متوقع: /search MA يرجع منتجات + mode=worldwide
             ومن بعد freightCalculateTip للثمن المباشر

الملفات:
  patch_geo_warehouse.py    الرقعة (تعويض كامل cjLiveBridge.js v3.2)
  verify_live_pipeline.py   التحقق اللايف v3 (cjCode + totalRecords + filterMode)
  INSTALL_BACKEND.bat       مشغل ويندوز

التوافقية:
  · نفس عقود v1/v3 + حقول زايدة (geo.filterMode) — آمنة للفرونت
  · الـ smoke: 40/40 (30 أصلية + envelope + مخازن)
  · backup تلقائي .bak-kit29c
================================================================
