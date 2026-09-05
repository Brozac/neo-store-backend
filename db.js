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

// فحص أولي عند الإقلاع
pool.on('connect', () => {
  // اتصال جديد تم تجهيزه بنجاح
});

// ✨ Graceful Shutdown: إغلاق اتصالات قاعدة البيانات بأمان تام عند إعادة تشغيل السيرفر أو عمل Deploy
const cleanUp = async (signal) => {
  console.log(`\n⏳ Received ${signal}. Draining DB connections gracefully...`);
  try {
    await pool.end();
    console.log('✅ DB Pool closed cleanly.');
  } catch (err) {
    console.error('❌ Error closing DB pool:', err);
  }
};

process.on('SIGINT', () => cleanUp('SIGINT'));
process.on('SIGTERM', () => cleanUp('SIGTERM'));

module.exports = pool;