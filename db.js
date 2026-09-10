// db.js - Laclarc Enterprise Database Connection
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
  min: 2,  // إبقاء اتصالين جاهزين دائماً للاستجابة الفورية وتفادي بطء أول طلب
  idleTimeoutMillis: 30000, // إغلاق الاتصال الخامل بعد 30 ثانية
  connectionTimeoutMillis: 10000, // مهلة 10 ثوانٍ كافية لاستيقاظ Neon من وضع الـ Compute Suspend بأمان
  keepAlive: true, // يمنع انقطاع الاتصال المفاجئ من جدار حماية Render
  keepAliveInitialDelayMillis: 10000
});

// مراقبة الأخطاء الطارئة على الاتصالات الخاملة
pool.on('error', (err) => {
  console.error('❌ Unexpected idle PostgreSQL client error:', err.message);
  // لا نوقف السيرفر هنا، فالمكتبة ستستبدل الاتصال التالف تلقائياً
});

// ⚠️ ملاحظة معمارية: SIGTERM/SIGINT handlers كاينين حصراً في server.js
// (ملكية واحدة للـ Graceful Shutdown — pool.end() مرة وحدة فقط عند الإيقاف)

module.exports = pool;