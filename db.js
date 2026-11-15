// db.js - Laclarc Enterprise Database Connection
// ═══ 🔥 DBFIX (F#29) — إصلاح حرق Neon ═══
// ═══ 🩹 F#96 (LACLARC-SERVER-D / SERVER-15 — EMAXCONNSESSION) ═══
// Neon session-pooler كيحد الجلسات المتزامنة: "max clients are limited to pool_size: 15".
// السيناريوهات اللي كتعدّي الحد بpool واحد max=10:
//   1) deploy overlap — العملية القديمة مازال شادّة حتى 10 جلسات + الجديدة كتحتاج 10 → 20 > 15
//      (برهان: SERVER-D أول حدث 2026-10-26 02:30:00 بالضبط = لحظة cron الليلي،
//       وأحدث اندفاع اليوم 12:34:41→44 = نافذة deploy — الاثنين لحظات تزامن)
//   2) cron الليلي + طلبات حية في نفس الثانية
// الحل: max أصغر بحساب السيناريو الأسوأ (عمليتين متراكبتين): 6×2=12 ≤ 15 مع 3 جلسات احتياط
//   للكونسول/الأدوات، + تصريف أسرع للجلسات الخاملة (idle 45s→30s).
// الأداء ما كيتضرش: الطلبات كتتردّف داخلياً فـ pg-pool، والـ single-flight caches (F#95)
//   قصّو الاستعلامات المتزامنة فالمسارات الساخنة (products/categories/settings).
// ✨ Tunable من Render بلا نشر جديد: PGPOOL_MAX (default 6) — إلا درت transaction-mode
//   فـ Neon pooler يقدر ترجعو 10-12، والجلسة الصيانية هي الطريق الطويل.
// المشكل القديم: min: 2 = اتصالان حيّان 24/7 → Neon Compute عمرو ما طفى
//   → الساعات المجانية (~192h/شهر) تسالي في وسط الشهر → Compute يتطفي
//   → كل الـ endpoints كيرجعو 500 فوراً (~0.85s = رفض فوري، ماشي cold-start)
// الإصلاح: min: 0 — النيون ينام ملي ماكينش حاجة خدامة، كيصحي أوتوماتيك مع الطلب
//   (ساعات الاستعمال يهبطو من 744h/شهر الممكنة لـ دقائق/سوايع حسب السير الحقيقي)
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL is not set in environment variables!');
  process.exit(1);
}

// ✨ إعدادات متقدمة مخصصة لـ Neon Serverless + Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'laclarc-backend', // ✨ يبان في Neon Dashboard عند تتبع الاستعلامات
  ssl: {
    rejectUnauthorized: false // مطلوب للاتصال السحابي الآمن مع Neon
  },
  // 🩹 F#96 — 6 بدل 10: الـ 15 جلسة تاع Neon session-pooler كتتقسم علينا حتى ف deploy overlap
  //   (10+10=20 كان كيقتلها). PGPOOL_MAX من Render إلا حبيت تغيّر بلا code deploy.
  max: Number(process.env.PGPOOL_MAX) || 6,
  min: 0,  // 🔥 DBFIX — كان 2: Neon ماكانش كينام = حرق الكوتا = 500 في كلشي. 0 = سرد أساسي
  // 🩹 F#96 — 45s→30s: الجلسات الخاملة كتتحرر أسرع → نافذة deploy overlap كتطول أقل
  //   (الأداء مقبول: burst reuse كيبقى فعّال، والـ caches كتغطي التكرار)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000, // 🔥 DBFIX — 15s كافية لصحوة Neon من Compute Suspend حتى والـ ذروة
  keepAlive: true, // يمنع انقطاع الاتصال المفاجئ من جدار حماية Render
  keepAliveInitialDelayMillis: 10000
});

// 🩹 F#96 — بيان البداية: التكوين الفعلي كيبان فـ Render Logs عند كل boot
//   (باش تتأكد من الدوران: "pool: max=6 idle=30000" = النشر الجاي عايش)
console.log(`[DBFIX] pool: max=${pool.options.max || 6} idle=${pool.options.idleTimeoutMillis}ms connect=${pool.options.connectionTimeoutMillis}ms (Neon session cap 15 — F#96)`);

// مراقبة الأخطاء الطارئة على الاتصالات الخاملة
pool.on('error', (err) => {
  console.error('❌ Unexpected idle PostgreSQL client error:', err.message);
  // لا نوقف السيرفر هنا، فالمكتبة ستستبدل الاتصال التالف تلقائياً
});

// ═══ 🔍 DBFIX — فحص صحّة عند الإقلاع: الخطأ الحقيقي كيبان فـ Render Logs ═══
// (بدل "Server error" العمياء — هنا كتعرف مباشرة واش Neon: كوتا سالات / credentials غالطين / branch محيّد)
pool.query('SELECT 1 AS ok')
  .then(() => console.log('✅ [DBFIX] Neon reachable — DB OK'))
  .catch((e) => {
    console.error('❌ [DBFIX] Neon probe FAILED — code:', e.code || 'N/A');
    console.error('❌ [DBFIX] message:', e.message);
    if (/quota|usage|exceed|maximum|compute|suspend|scale to zero/i.test(e.message)) {
      console.error('🔴 [DBFIX] Neon Compute hours/quotas exhausted → console.neon.tech → Project → Billing/Usage');
    } else if (/password|authentication|role/i.test(e.message)) {
      console.error('🔴 [DBFIX] Credentials rejected → check DATABASE_URL in Render Env');
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(e.message + ' ' + (e.code || ''))) {
      console.error('🔴 [DBFIX] Host unreachable → Neon branch/project deleted أو hostname تبدل');
    }
  });

// ⚠️ ملاحظة معمارية: SIGTERM/SIGINT handlers كاينين حصراً في server.js
// (ملكية واحدة للـ Graceful Shutdown — pool.end() مرة وحدة فقط عند الإيقاف)

module.exports = pool;
