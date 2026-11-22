# Phase I — جرد كامل ديال Endpoints ديال اللوحة (OpsCenter)

> **الهدف:** نقل كل endpoints اللي كتستعملها لوحة الإدارة من Express (Render · `rpc.laclarc.com`)
> إلى **RPC (SECURITY DEFINER)** أو **Next routes عبر نمط الجسر** — باش اللوحة تخدم 100% بلا Render
> وبلا cold starts، وبنفس المنهجية المثبتة في Phase C (الجسر + `laclarc_rw` + دوال مضيقة).
>
> **المنهج:** الجرد تدار من كود المستهلكين الحقيقيين (صفحات `app/admin/*` في neo-store-frontend)
> سطر بسطر — ماشي من ذاكرة ولا من تخمين. كل endpoint مفهوص بمصدره.
>
> **الرقم الحقيقي: 43 endpoint** (الخطة القديمة كانت كتقول ~30 — الجرد الكامل طلّق 13 زيادة).

---

## 1. خريطة البنية الحالية (مؤكدة من الكود)

| الطبقة | التفاصيل |
|---|---|
| لوحة الإدارة | `app/admin/*` (Next.js 16 · CF Workers) — 11 صفحة |
| الكلاينت API | `app/utils/adminApi.ts` — axios · `baseURL = NEXT_PUBLIC_API_URL \|\| https://rpc.laclarc.com` + `/api` · `withCredentials` |
| Backend القديم | Express · `server.js` (336KB) + `routes/{paymentGateways,webauthn,cjLiveBridge}.js` · مستضاف على **Render** (cold start موثق في صفحة login) |
| المصادقة | `POST /api/admin/login` (Express) → كوكي `admin_token` httpOnly ~4h · `admin_hint=1` علامة UI فقط (middleware.ts) |
| الجسر الموجود | `app/api/phasec-db/route.ts` — 20 action · حارس `X-PhaseC-Key` · postgres.js بدور `laclarc_rw` · دوال `phasec_*` / `phasef_*` SECURITY DEFINER |
| Phase H v2 | ✨ راه **خدام أصلاً** في `adminApi.ts`: purge فوري عبر `/api/edge-cache-purge` بعد كل تعديل كاطالوگ (regex `CATALOG_MUTATION_RE`) |

**الدوال المضيقة الموجودة (18 مأكدة من الكود — التحقق الحي من DB pending):**
`phasec_exchange_pick` · `phasec_exchange_defer` · `phasec_exchange_cj_context` · `phasec_exchange_booked` · `phasec_exchange_burn` · `phasec_webhook_find_order` · `phasec_webhook_order_mutate` · `phasec_webhook_event` · `phasec_webhook_heartbeat` · `phasec_webhook_heartbeat_get` · `phasec_set_setting` · `phasef_regular_cj_context` · `phasef_regular_booked` · `phasef_regular_defer` · `phasef_reconcile_pick` · `phasef_review_invite_pick` · `phasef_review_invite_mark` · `phasef_user_by_email`

---

## 2. الجرد الكامل — 43 endpoint (المصدر: صفحات `app/admin/*`)

الأحرف: `[DB]` = قاعدة البيانات مباشرة (جاهز للـ RPC) · `[CJ]` = بروكسي CJ API · `[EXT]` = خدمة خارجية · `[AUTH]` = مصادقة

### أطابور الطلبات
| # | Method | Endpoint | الصفحة | النوع | مصدر البيانات |
|---|---|---|---|---|---|
| 1 | GET | `/admin/manual-orders` | orders · dashboard · baridimob | [DB] | `orders` (BaridiMob pending) |
| 2 | GET | `/admin/failed-orders` | orders · dashboard · failed-orders | [DB] | `orders` (halted) + `halt_details` |
| 3 | GET | `/admin/disputes` | orders · dashboard · disputes | [CJ] | CJ arbitration list |
| 4 | GET | `/admin/track/:id` | orders · disputes | [CJ] | CJ logistics tracking |
| 5 | GET | `/orders/:id/items?email=` | orders · failed-orders | [DB] | `order_items` + `products` (IDOR guard M#49) |
| 6 | PUT | `/admin/manual-orders/approve/:id` | baridimob | [DB] | UPDATE `orders` + audit `system_events` (v2 verified_amount) |
| 7 | PUT | `/admin/manual-orders/reject/:id` | baridimob · failed-orders | [DB] | UPDATE `orders` (سبب إجباري) |
| 8 | PUT | `/admin/retry-fulfillment/:id` | failed-orders | [CJ]+[DB] | إعادة dispatch CJ |

### النزاعات والمالية
| # | Method | Endpoint | الصفحة | النوع | مصدر البيانات |
|---|---|---|---|---|---|
| 9 | POST | `/admin/disputes/create` | disputes | [CJ] | CJ dispute filing |
| 10 | POST | `/admin/cogs` | advanced | [CJ] | CJ COGS invoice |
| 11 | POST | `/admin/merge/match` | advanced | [CJ] | CJ parcel matching |
| 12 | POST | `/admin/merge/submit` | advanced | [CJ] | CJ merge submission |
| 13 | GET | `/admin/makeup/list` | advanced | [CJ] | CJ carrier makeup bills |

### المنتجات والكاطالوگ
| # | Method | Endpoint | الصفحة | النوع | مصدر البيانات |
|---|---|---|---|---|---|
| 14 | GET | `/admin/search-products?q=` | manage | [DB] | SELECT `products` (آخر 30) |
| 15 | GET | `/categories` | manage · dashboard · visibility | [DB] | شجرة `categories` |
| 16 | PUT | `/admin/update-product/:id` | manage | [DB] | UPDATE `products` (+ purge H v2) |
| 17 | PUT | `/admin/update-category/:id` | manage | [DB] | UPDATE `products.category` |
| 18 | PUT | `/admin/toggle-deal/:id` | manage | [DB] | UPDATE `products.is_sourced` |
| 19 | DELETE | `/admin/delete-product/:id` | manage | [DB] | إخفاء منتج (SELFHEAL pattern) |
| 20 | POST | `/admin/add-product` | dashboard | [DB] | INSERT `products` |
| 21 | POST | `/admin/add-review` | manage | [DB] | INSERT `reviews` |
| 22 | POST | `/admin/sourcing/create` | manage · dashboard | [CJ] | CJ sourcing agents |
| 23 | GET | `/admin/videos` | dashboard | [DB] | `products` حيث `video_url` ≠ NULL |
| 24 | DELETE | `/admin/videos/:id` | dashboard | [DB] | UPDATE `products.video_url = NULL` |
| 25 | POST | `/admin/sync-videos` | dashboard | [CJ] | CJ video hunt (~15min) |
| 26 | POST | `/admin/auto-categorize` | manage | [CJ]+[DB] | AI categorization |
| 27 | POST | `/admin/sync-categories` | dashboard | [CJ]+[DB] | CJ categories tree |
| 28 | POST | `/admin/backfill-categories` | dashboard | [CJ]+[DB] | backfill كاطالوگ كامل |
| 29 | GET | `/sync-cj-products` | dashboard | [CJ]+[DB] | Mass sync (حتى 1200 منتج) |
| 30 | POST | `/admin/sync-single-product` | dashboard | [CJ]+[DB] | Ingest PID + Lightning Deal |
| 31 | POST | `/admin/scrape-product` | dashboard | [EXT] | سكرايب خارجي (Alibaba/AliExpress) |

### البوابات والإعدادات والأحداث
| # | Method | Endpoint | الصفحة | النوع | مصدر البيانات |
|---|---|---|---|---|---|
| 32 | GET | `/admin/payment-gateways` | payment-settings | [DB] | SELECT `payment_gateways` |
| 33 | PATCH | `/admin/payment-gateways/:key` | payment-settings | [DB] | UPDATE `payment_gateways` |
| 34 | GET | `/admin/settings` | settings · visibility · dashboard | [DB] | `store_settings` (show_reels · hidden_routes · hidden_sections) |
| 35 | PUT | `/admin/settings/show_reels` | settings · dashboard | [DB] | `phasec_set_setting` **موجودة أصلاً** |
| 36 | PUT | `/admin/settings/hidden_routes` | visibility | [DB] | نفس الدالة · سقف 100 |
| 37 | PUT | `/admin/settings/hidden_sections` | visibility | [DB] | نفس الدالة |
| 38 | GET | `/admin/system-events?limit=&type=` | dashboard | [DB] | SELECT `system_events` (جسر عندو `system_events` action) |
| 39 | POST | `/admin/webhook/register` | settings | [CJ] | CJ webhooks |
| 40 | POST | `/admin/webhook/subscribe` | settings | [CJ] | CJ subscriptions |

### أدوات وأصول ومصادقة
| # | Method | Endpoint | الصفحة | النوع | مصدر البيانات |
|---|---|---|---|---|---|
| 41 | POST | `/admin/upload` | dashboard | [EXT] | Cloudinary upload |
| 42 | POST | `/admin/add-coupon` | dashboard | [EXT]+[DB] | Stripe coupon + INSERT `coupons` |
| 43 | POST | `/admin/login` | login | [AUTH] | Express · bcrypt · كوكي `admin_token` 4h |

**الحصيلة: 22 [DB] · 14 [CJ] · 3 [EXT/هجين] · 1 [AUTH] — المجموع 43 · صفر نقطة عمياء**

---

## 3. خطة التنفيذ — 3 مراحل (الجسر زيادة فقط · crons والـ RPCs القديمة ما يتلمسوش)

### Stage A — القراءات [DB] (9 endpoints · أخف خطر · أسرع ربح)
`#1 #2 #5 #14 #15 #23 #32 #34 #38`

- ملف جديد: `app/api/admin-db/route.ts` (منفصل على phasec-db — عقد مستقل، صفر خطورة على الجسر الحي)
- الحارس: مفتاح جلسة أدمن جديد (كوكي موقّع — شوف §4) + rate limit بنمط `pb-limiter`
- القراءة: `laclarc_rw` SELECT مباشر مضيق (نفس نمط `settings_get` في الجسر) — بلا دوال جديدة هنا
- `#34` و `#38` يعاودو يستعملو نفس شكل actions الموجودين (`settings_get` · `system_events`)
- النتيجة: الصفحات اليومية (الطلبات · المنتجات · الإعدادات) ما عاش بغاتش Render

### Stage B — الكتابات [DB] (13 endpoint · دوال جديدة `phasei_*`)
`#6 #7 #16 #17 #18 #19 #20 #21 #24 #33 #35 #36 #37`

- SQL جديد: كل دالة `SECURITY DEFINER` + `REVOKE ALL FROM anon, authenticated` + `GRANT EXECUTE TO laclarc_rw` فقط
- حراس داخل الدوال: سقوف القيم (price floor $9.99 · MAX_ITEMS 100 · أسباب الإدارية إجبارية · audit `system_events`)
- `#35 #36 #37` كيستعملو `phasec_set_setting` الموجودة (بلا تكرار)
- بعد كل كتابة ناجحة: نفس purge H v2 (الكلاينت كيديرها أصلاً عبر `adminApi`)

### Stage C — CJ بروكسيز + خارجية + المصادقة (21 endpoint)
`#3 #4 #8 #9 #10 #11 #12 #13 #22 #25 #26 #27 #28 #29 #30 #31 #39 #40 #41 #42 #43`

- Next routes جديدة كتحمل مفاتيح CJ / Cloudinary / Stripe كـ CF secrets (ما كيتسربش للباندل)
- المهام التقيلة (mass sync · video hunt · backfill) كتبقى fire-and-forget + `waitUntil`
- `#43`: login جديد في Next → تحقق bcrypt عبر دالة مضيقة → كوكي موقّع (بدّل كوكي Render تدريجياً)
- **فترة تشغيل مزدوجة:** endpoints القديمة في Express كتبقى حية حتى تأكيد 43/43 — التبديل صفحة بصفحة

### معايير القبول (Zero Blind Spots)
1. جدول اختبار 43/43: كل endpoint = اختبار إيجابي (استدعاء حقيقي + نتيجة متوقعة) + اختبار سلبي (بدون جلسة أدمن → 401/404)
2. لا دالة جديدة بلا `REVOKE FROM anon` · لا route جديد بلا حارس جلسة
3. crons الثلاثة (SUPA-BACKUP · IMG-HEALTH · F#67-watch) والـ RPCs القديمة: لمسة صفر
4. التراجع: كل stage commit مستقل — إرجاع branch = إلغاء آمن

---

## 4. سؤال المصادقة الحاسم (خاصو تحقق قبل Stage A)

كوكي `admin_token` كيصدره Express على `rpc.laclarc.com`. باش routes ديال Next على `laclarc.com` يقدرو يتحققو من الجلسة، خاصنا نعرفو **domain ديال الكوكي** (`.laclarc.com` = كيتوصل لجوج النطاقات، ولا `rpc.laclarc.com` فقط = Next ما كيشوفوش):

- **إلا كان `.laclarc.com`:** routes ديال Next كيقراو الكوكي من request (httpOnly كيتقرى server-side بلا مشكل) وكيقبلو بتوقيع نفس السر
- **إلا كان مقصور على API domain:** login جديد في Next (Stage C) كيصدر كوكي خاص بـ `laclarc.com` — واللوحة كتخدم بالنطاقين خلال الفترة الانتقالية

القرار فالتنفيذ: يتفحص الـ `Set-Cookie` header ديال `/api/admin/login` قبل كتابة أول حارس.

---

*الجرد تدار 2026-11-23 · المصدر: `app/admin/{page,orders,manage,disputes,baridimob,failed-orders,payment-settings,settings,visibility,advanced,login}` + `app/utils/adminApi.ts` + `routes/paymentGateways.js` · branch: `phase-i/inventory`*
