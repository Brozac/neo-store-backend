// migrations/005_merge_recon_columns.js — F#79 MERGE PARENT + RECON REPORTS
// ============================================================
// 1) orders.cj_parent_order_number — رقم الأب المدموج (دوك shopping 5.4:
//    submitMergeOrderBatchV3 كيرجع newOrderCodeList — الأطفال كيموتو عند CJ
//    بعد الدمج وكل lookups كيتجاوزو للوالد). parent_merged_at = وين ربط.
//
// 2) cj_recon_reports — تقارير الفحوصات المالية/التشغيلية (wallet 2.4 +
//    orphan 1.6). INSERT-only — القرارات البشرية كتقراها من هنا.
//
// الhealer والkronات عندهم ضمان ذاتي (ALTER/CREATE IF NOT EXISTS داخل
// mergeTracker.ensureMergeColumns / reconService.ensureReconTable) — هادي
// نسخة الترحيل الرسمية، نفس النمط تاع 004: idempotent آمن، lock_timeout.
//
// تشغيل:   node migrations/005_merge_recon_columns.js
// ============================================================
require('dotenv').config();
const pool = require('../db');

(async () => {
  await pool.query(`SET lock_timeout = '5s'`);
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cj_parent_order_number TEXT NOT NULL DEFAULT ''
  `);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_merged_at TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cj_recon_reports (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      window_start TEXT,
      window_end TEXT,
      stats JSONB NOT NULL DEFAULT '{}'::jsonb,
      anomalies JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  console.log('✅ 005 — orders.cj_parent_order_number + cj_recon_reports ready (Merge/Recon F#79)');
  await pool.end();
})().catch((e) => { console.error('❌ 005 failed:', e.message); process.exit(1); });
