════════════════════════════════════════════════════════════════
LaClarc — كيت 30 [card-swatches] — سواتشات الصور لكارت المنتج
════════════════════════════════════════════════════════════════
شنو يبدل؟
  · كارت المنتج فاللائحة (الفئات + الهوم + Favorites + البحث) كيولي
    فيه سواتشات صور (بأسلوب Temu): لون = صورة الـ variant ديالو.
    hover = معاينة فورية للصورة · click = تثبيت الاختيار.
  · "Add to Cart" كياخد vid تاع اللون المختار (قبل كان vid خاوي).
  · +N = باقي الألوان. بلا ألوان (أقل من 2) = الكارت كيبان كيما قبل.
  · المصدر: variants JSONB الموجودة فالـ DB (CJ variantKey "Color-Size")
    → صفر نقاط CJ، صفر نداءات إضافية، كاش CDN كيبقى خدام كيفما كان.

ملفات الكيت:
  patch_card_swatches.py   الپاتشر (backend + frontend)
  verify_card_swatches.py  فحص ما بعد التركيب
  INSTALL_BACKEND.bat      تشغيل الپاتشر على الباك
  INSTALL_FRONTEND.bat     تشغيل الپاتشر على الفرونت

التركيب (نفس عائلة كيت 29):
  1) حط الزيب فجذر الباك وفكو، دوبل-كليك INSTALL_BACKEND.bat
     → backup: server.js.bak-kit30 · diag: kit30-diag/
  2) حط الزيب فجذر الفرونت (laclarc frontend)، فكو، دوبل-كليك INSTALL_FRONTEND.bat
     → backup: ProductCard.tsx.bak-kit30
  3) python verify_card_swatches.py --backend . --frontend .  (فكل جذر)
  4) push للـ GitHub → Render/Vercel يديرو redeploy
  5) افتح صفحة فئة → السواتشات خاصهم يبانوا تحت الثمن

ضمانات:
  · fail-closed: أي anchor ما طابق → حتى تبديل ما يصير + kit30-diag/
  · idempotent: تاني تشغيل = skip
  · node --check قبل التسليم (فشل = تراجع أوتوماتيكي للـ backup)
  · الفرع الكامل /api/products (FULL_CAP=5000) بلا سواتشات عمداً (أداء)
  · توافق خلفي 100%: بلا swatches فالپايلود → الكارت كيبان عادي

⚠️ ملاحظات:
  · بعد الفرونت: هارد ريفريش (Ctrl+Shift+R) باش الكاش القديم يمشي.
  · /api/products كيتبدل الپايلود ديالو (يزيد swatches/swMore) — كل
    المستهلكين الحاليين كيقراو الحقول اللي كيعرفوها فقط = آمن.
  · رقعت 5 مواقع: pagination-fئات · pagination-هوم · limit=100 ·
    search/category · by-ids. related/deals/search-dropdown يبقاو للنسخة الجاية.
════════════════════════════════════════════════════════════════
