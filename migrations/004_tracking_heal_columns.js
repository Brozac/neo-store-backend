// migrations/004_tracking_heal_columns.js — F#77 TRACKING HEAL (دوك logistic 2.2)
// ============================================================
// عمود واحد على orders:
//   • track_heal_checked_at — آخر مرة فحصنا الرقم عبر 2.2 getOrderTrackHistory
//     (guard 24h — الرقم السليم ما يعاودش يحرق النقاط كل جولة كرون)
//
// ليش عمود ماشي جدول؟ الفحص حالة تاع الطلب نفسه (الرقم تاعو) — عمود
// أبسط من جدول جانبي، والفهرسة ما نحتاجوهاش (الطلب دايماً بالid).
//
// الhealer عندو ضمان ذاتي (ALTER IF NOT EXISTS داخل shipTruth.ensureHealColumns)
// — هادي نسخة الترحيل الرسمية نفس النمط تاع 003: تشغيل واحد مرة، idempotent
// آمن تعاود تشغلو، lock_timeout باش ما يحبسش الاستعلامات الحية على Neon.
//
// تشغيل:   node migrations/004_tracking_heal_columns.js
// ============================================================
require('dotenv').config();
const pool = require('../db');

(async () => {
  await pool.query(`SET lock_timeout = '5s'`);
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_heal_checked_at TIMESTAMPTZ
  `);
  console.log('✅ 004 — orders.track_heal_checked_at ready (Tracking Heal F#77)');
  await pool.end();
})().catch((e) => { console.error('❌ 004 failed:', e.message); process.exit(1); });
