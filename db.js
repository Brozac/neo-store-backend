// db.js - Laclarc Enterprise Database Connection
// ═══ 🔥 DBFIX (F#29) — إصلاح حرق Neon ═══
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
  max: 10, // 10 اتصالات تكفي لمعالجة آلاف الطلبات في Node.js وتمنع استنزاف موارد Neon
  min: 0,  // 🔥 DBFIX — كان 2: Neon ماكانش كينام = حرق الكوتا = 500 في كلشي. 0 = سرد أساسي
  idleTimeoutMillis: 45000, // 🔥 DBFIX — 30s كانت تقصّ النوم قبل استفادة كاملة من الـ suspend
  connectionTimeoutMillis: 15000, // 🔥 DBFIX — 15s كافية لصحوة Neon من Compute Suspend حتى والـ ذروة
  keepAlive: true, // يمنع انقطاع الاتصال المفاجئ من جدار حماية Render
  keepAliveInitialDelayMillis: 10000
});

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
