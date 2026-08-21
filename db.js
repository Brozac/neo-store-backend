// db.js
// ✨ Pool واحد مشترك لكل التطبيق (server.js + services/*.js).
// قبل، كل ملف (server.js, services/cjService.js, services/categoryService.js)
// كان كيدير new Pool() ديالو بوحدو، يعني حتى لـ 50 اتصال (20+10+20) يقدر يتفتحو
// فنفس الوقت لنفس الداتابيز. هذا يقدر يتجاوز الحد الأقصى ديال اتصالات كتوفرو
// أغلب خطط Neon/Render، ويخلق أخطاء "too many clients already" تحت الضغط.
// الحل: pool واحد يتصدر من هنا، وكلشي يستورده.

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20, // أقصى عدد اتصالات في نفس اللحظة لكامل التطبيق
  idleTimeoutMillis: 30000, // إغلاق أي اتصال خامل بعد 30 ثانية
  connectionTimeoutMillis: 5000 // مهلة الاتصال: إذا لم يتصل خلال 5 ثوانٍ، يرمي خطأ بدل أن يعلق السيرفر
});

pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL pool error:', err);
});

module.exports = pool;