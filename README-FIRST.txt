════════════════════════════════════════════════════════════
 KIT: topsellers-fix-v26  —  2026-11-06
════════════════════════════════════════════════════════════

شنو كاين فهاد الـ KIT:
  1) server.js          = النسخة الجديدة ديالك (log throttle) + إصلاح BUG ديال
                          كرون TopSellers (sales_count توصلها "true" بدل رقم
                          → "invalid input syntax for type integer" كل يوم 5ص).
  2) services/cjService.js = النسخة الجديدة ديالك (jitter + circuit breaker +
                          QPS-body retry + points fix) — بلا تعديل زائد.

⚠️ مهم: التعديلات ديالك (الجديدة) كلها صحيحة ومقبولة — الإصلاح الوحيد الزائد
   هو سطر واحد فمصفوفة الـ INSERT ديال TopSellers (سطر ~4065).

────────────────────────────────────────────
 خطوات النشر (من ~/Desktop/DRPS/backend):
────────────────────────────────────────────
  1)  cd ~/Desktop/DRPS/backend
  2)  git status --short
  3)  cp server.js server.js.backup
      cp services/cjService.js services/cjService.js.backup
  4)  powershell -Command 'Expand-Archive -Force "$env:USERPROFILE\Downloads\laclarc-topsellers-fix-kit.zip" "$env:USERPROFILE\Downloads\kit-v26"'
  5)  cp ~/Downloads/kit-v26/laclarc-topsellers-fix-kit/server.js server.js
      cp ~/Downloads/kit-v26/laclarc-topsellers-fix-kit/services/cjService.js services/cjService.js
  6)  node --check server.js && node --check services/cjService.js && echo "SYNTAX OK"
  7)  git add server.js services/cjService.js
      git commit -m "topsellers-fix-v26: sales_count int bug (cron dead since M#26) + admin-log throttle + CJ QPS breaker"
      git push
  8)  Render → Manual Deploy → "Deploy latest commit"
      (Auto-Deploy عندك ماشي مفعل — كل مرة دير يدوي)

────────────────────────────────────────────
 التحقق من بعد الـ deploy (5 دقايق):
────────────────────────────────────────────
  A) الماركر:
     curl -s https://raw.githubusercontent.com/Brozac/neo-store-backend/main/server.js | grep -c "topsellers-fix-v26"
     → خاصها ترجع 1

  B) الـ visibility (الميزة ديال الإخفاء) باقة خدامة — ما تبدل والو:
     GET /api/settings  → غادي يبقى يرجع {show_reels:...} حتى دير أول SAVE
     من لوحة التحكم (Visibility) — هادا طبيعي، الحفظ كيخلق الصف فالـ DB.

  C) كرون TopSellers غادي يجي تلقائياً كل يوم 5ص UTC — إلا بغيتي تجربتو دابا،
     قولها لينا باش نعطيك طريقة تشغيلها يدوي بـ endpoint مؤقت.

  D) خطأ "EAUTHQUERY auth_query secret check timed out": ماشي من الكود ديالك
     (ما كاينش فلا كود ولا فتاريخ الـ repo كامل) — هادا من Render Postgres
     (الـ DB كيفقى من البرود فالخطة المجانية). كيتصلح بوحدو. إلا عاود بزاف،
     معناها الـ DB كيبقى بارد — ما عندك ما تصلح فالكود.
