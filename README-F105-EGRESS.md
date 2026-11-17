# F#105-EGRESS — إصلاح حرق Egress ديال Supabase

**التاريخ:** 2026-11-16 · **التشخيص:** مباشر على الداتابيز (pooler) — ماشي تخمين

---

## 📊 التشخيص الحقيقي (ربطت نيشان بـ Supabase)

### الميزانية ديال الداتابيز
| المقياس | القيمة | الحكم |
|---|---|---|
| حجم الداتابيز | **389 MB** من 500 MB | ✅ ما كاينش أزمة حجم |
| products | 374 MB (heap 182 + TOAST 117 + فهارس 75) | الجدول الوحيد الثقيل |
| dead tuples | 324 برك | ✅ لا bloat · **VACUUM FULL ما محتاجاش** |
| reviews | **سطر واحد برك** (السيد مشى فالميجراسيون) | لا تنظيف هنا |
| system_events | 360 صف · 192KB | رمزية |

### 🔥 الحرق — pg_stat_statements (الحقيقة، ماشي التخمين)

| # | الاستعلام | النداءات/شهر | التكلفة |
|---|---|---|---|
| **1** | `/related`: `WHERE category = $2 … LIMIT 8` + هوبت `SELECT category` | **299,094 + 299,285 = 600k نداء** · متوسط **112ms** · CPU **9.3 ساعات/شهر** | ~750MB egress |
| **2** | PDP: `SELECT * FROM products WHERE id = $1` | **~304k نداء** × 2.9KB/صف | **~880MB egress** |
| 3 | الفيد: `ORDER BY md5(category‖id) LIMIT 24` | 1,468 نداء · **متوسط 11.7 ثانية!!** | CPU 4.8h/شهر (egress صغير) |
| 4 | `UPDATE products SET stock_status` | 21k · 48ms | طبيعي (cron) |

الصف الكامل = **2,891B**: description 979B + variants 853B + images 399B = 77% من الوزن.
→ الـ endpoint ديال `/related` كان **بلا كاش نهائي**: كل مشاهدة منتج = 2 استعلامات زايدة.

---

## 🛠️ الإصلاحات (apply-f105.js v2)

| Fix | شنو كيدير | شنو كيقتل |
|---|---|---|
| **R1** | كاش LRU (300 × 10 دقائق) لـ PDP + related + projection بأعمدة مضمونة (19، كلهم verified) + أعمدة اختياريين تُكتشفو مرة واحدة | الحرق #2 |
| **R2** | ريفيوزات: LIMIT 50 + COUNT متوازٍ + Cache-Control 120s + meta صادق | نظافة |
| **R3** | كاش LRU فـ `/related` (cache-first) | **الحرق #1** |
| **R4** | PDP: cache-first + projection بدل `SELECT *` | الحرق #2 |

**الحماية من البيع:** `cj_product_id` محفوظ (DeliveryEstimator) · `seo_*` محفوظين (generateMetadata) · فشل الكشف → fallback للأعمدة المضمونة — **عمرو ما كيدير 500** · `clearProductsCache` كينقّي كل الكاشات (freshness ما كتخسرش) · TTL 10 دقائق < ISR 24h → الداتا تكون أحدث من قبل.

**العقد مُختبر:** 13/13 smoke (LRU، TTL، eviction، probe، fallbacks) · node --check PASS · idempotent · backup تلقائي `.bak-f105` · EOL CRLF محفوظ.

---

## 🚀 التشغيل (3 خطوات)

```bash
cd ~/Desktop/DRPS/backend
node apply-f105.js server.js
node verify-f105.js server.js
```

- كل fix مستقل: فشل واحد ما كيوقفش الباقي (غادي تشوف ✅/⏭️/❌ لكل واحد).
- **إلا ظهر ❌ حتا واحد**: تولد أوتوماتيك `f105-scan-report.txt` — **صيفطه ليا كامل** ونأپتّي الـ anchors على نسختك.
- غير باغي تشوف واش الـ anchors كاينين بلا ما تبدل شي حاجة؟ `node apply-f105.js server.js --scan`

من بعد: `git add server.js && git commit -m "F105: egress cache+projection" && git push` → Render deploy → راقب Egress فـ 48 ساعة (المتوقع: **نقص 1.5GB+/شهر**، والـ CPU ديال الداتابيز طاح بش Force).

## 🤝 التعايش مع F#69 EGRESSGUARD (مهم!)

النسخة ديالك ديال `main` فيها أصلاً **F#69 EGRESSGUARD** (`__pdpCache` LRU 10د + `__relCache` LRU 6 سوايع). الـ applier كيتعامل مع هادشي:
- **R3 كيتخطى أوتوماتيك** (F#69 كيغطي كاش /related — ما محتاجاش نزيدو طبقة ثانية)
- R1 كيزيد **projection + كولونات مضمونة** فوق الكاش ديال F#69
- R4 كيبدل `SELECT *` داخل الـ loader ديال `__pdpCache` بـ `fetchProductProjected` — طبقة كاش دبلومة (ما فيها حتى ضرر، غير فائض أمان)
- `verify-f105.js` كيأكد 11 نقطة + الصياغة — الفحوصات ديال F#69 معلوماتية برك

**ليه الإحصائيات (304k SELECT * / 299k related فـ 3 أسابيع) باقي كبار مع F#69؟** نافذة `pg_stat_statements` كتبدا من **2026-10-27** — الأرقام مجمعة. الاحتمالات: F#69 مازال ما دپلاياش، ولا كاين `clearProductsCache()` كيتعيط من cron/massSync وكيمحي الكاشات ديال F#69 مع كل sync (فحص مستقبلي F#106: تدقيق محلي granular بدل المحي الكامل). بعد الـ deploy، عاود `01-diagnose.sql` قسم H — إلا `SELECT *` بقا فيندياء كثيف، المشكل فالـ wipes.

## ↩️ الرجوع
```bash
cp server.js.bak-f105 server.js
```

---

## 📌 بعد الميجراسيون — ملاحظات صادقة
1. **الريفيوزات المحلية مشاو**: جدول reviews فيه غير 1 سطر (1 مستخدم حقيقي). CJ reviews باقة كتخدم (هي لي كتبان فالواجهة). إلا كان عندك backup ديال Neon القديم وريفيوزات الزبائن مهمين — خاص استيراد منفصل.
2. **الباسوورد ديال الداتابيز دار فـ الشات**: ملى تسالي المهمة، بدّلو من Supabase → Settings → Database → Reset password (Render environment var كتحتاج تحديث أيضاً).
3. **السعة**: 389/500MB — عندك ~110MB هامش. الفرصة الكبيرة لإستعادة مساحة (وصفات CJ HTML → نص صافي، ~60-90MB) موثقة فـ `03-cleanup-db.sql` المرحلة 5 — قرار بزنس، ماشي عاجل.
4. **Backlog**: فيد الـ md5 (متوسط 11.7s) كيحرق CPU واخا egress ديالو صغير — الحل الدائم: عمود shuffle bucket يُحسب فـ massSync (نفس عائلة F#78).
