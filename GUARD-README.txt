﻿══════════════════════════════════════════════════════════════════
 LACLARC — KIT الوقاية من كراشات الديبلوي (F#86)
 neo-store-backend · Render · 2026-11-04
══════════════════════════════════════════════════════════════════

■ الحالة اليوم (خبر باهي)
- الإصلاح تاع F#85 تدفع: commit 77009e8 (15:05) "Fix: restore backend package.json"
- الباك رجع يخدم على https://neo-store-backend.onrender.com (الجذر يرجع 200 ✓)
- الإيميلات SERENE v2 (F#84) راهي حية في الريبو ✓

■ علاش طاح الكراش (بسطر واحد)
- package.json تاع supakit تنسخ بالغلط لجذر الريبو (name=laclarc-supakit · type=module)
- npm بنى شجرة غلط (16 باكاج بدل 275) و Node قرا server.js (المكتوب بـ require) كـ ESM
  → "ReferenceError: require is not defined in ES module scope"

■ القاعدة الذهبية باش ما نرجعوش نطيحو
1. package.json و package-lock.json تاع الباك ما يتنسخو من حتى مشروع آخر
   — supakit يخدم في مجلدو برك، ملفاتو ما يخرجوش منه.
2. أي commit يلمس package.json: قبل الـ commit ديّر:
       git diff --cached package.json
   لازم تشوف: "name": "backend" + "type": "commonjs" + الديبندانسيات الـ21.
   إذا شفت "laclarc-supakit" ولا "type": "module" → وقف، هذي غلط.
3. قبل push كبير:  node smoke-test.cjs
   (يجرب إقلاع السيرفر محليا في 9 ثواني — كراش F#85 طاح في أول ثانية، إذن هذي تحميك 100%)

■ التركيب — 5 دقايق · 3 طبقات حماية
[الملفات] نجمعو الثلاثة لجذر الريبو neo-store-backend (وين كاين server.js):
     check-deploy.cjs   ← الحارس (7 فحوصات على package.json والكود)
     install-guard.cjs  ← مثبت الهوك
     smoke-test.cjs     ← اختبار الإقلاع المحلي

[الطبقة 1 — هوك محلي]  node install-guard.cjs
     من هنا كل git push يشغّل الفحص قبل ما يخرج من الجهاز:
     إذا package.json غالطة → الـ push يوقف ولا يوصلش لـ GitHub أصلا.

[الطبقة 2 — حارس Render، الأقوى]
     Render Dashboard → neo-store-backend → Settings → Build Command
     بدّلها لـ:
         npm install && node check-deploy.cjs
     → حتى لو فات الفحص من جهاز آخر، Render يوقف البيلد قبل التشغيل
       والنسخة القديمة تظل خدامة (صفر downtime — عكس كراش التشغيل).

[الطبقة 3 — يدوية]  قبل أي push كبير:  node smoke-test.cjs

■ كيفاش يبان الفحص
سليم:
     ✓ الاسم = "backend"   ✓ type: "commonjs"   ✓ الديبندانسيات كاملة (21/21)
     ✓ lock: 275 باكاج   ✓ فحص الكود: 24 ملف سليمين
     ✅ SAFE TO DEPLOY
خايب (حالة F#85):
     ✗ package.json نتاع supakit تنسخ بالغلط لجذر الباك!
     ✗ type: "module" → كراش "require is not defined in ES module scope"
     🛑 DEPLOY BLOCKED  (+ سطر الإصلاح السريع جاهز تحت الرسالة)

■ إذا طاح كراش في الديبلوي مستقبلا — بروتوكول 3 خطوات
1. اقرا آخر سطر في لوج Render — هوكي يحكي المشكل بالضبط.
2. شكون مس package.json؟
       git log -p -3 -- package.json
3. الإصلاح الفوري (النسخة السليمة تاع 27 أكتوبر اللي خدمت 8 أيام):
       git checkout 506522ea -- package.json
       git commit -m "restore package.json"
       git push

■ ملاحظات
- باش تتخطى الفحص في حالة الضرورة:  git push --no-verify  (على مسؤوليتك).
- smoke-test يحتاج .env مملوء محليا؛ إذا طاح على مشكل DATABASE/ENV = كونفيغ محلي،
  ماشي مشكل الكود (على Render الـ env vars موجودة عندك).
- check-deploy.cjs بامتداد .cjs عمدا: يبقى CommonJS حتى لو package.json تبدل بالغلط —
  الحارس ما يطيحش مع الحارس (نفس الحيلة اللي اقترحها لوج Render نفسو).
- التركيب في ويندوز: يخدم عادي مع Git for Windows (الأوامر تتفذّى في Git Bash).

══════════════════════════════════════════════════════════════════
 خلاصة: هوك يوقف الغلط في جهازك · Render Build يوقفو في السحابة (بلا downtime)
 · سموك تيست يجرب الإقلاع محليا — الكراش تاع F#85 ولّى مستحيل يعاود بلا ما تفحصه 3 مرات.
══════════════════════════════════════════════════════════════════
