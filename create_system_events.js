/**
 * node create_system_events.js — جدول سجل الأحداث الآلية
 */
require('dotenv').config();
const pool = require('./db');

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_events (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(50) NOT NULL,
      order_id INTEGER,
      details JSONB DEFAULT '{}',
      severity VARCHAR(10) DEFAULT 'info',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sys_events_type ON system_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sys_events_order ON system_events(order_id);
  `);
  console.log('✅ system_events table ready');
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });