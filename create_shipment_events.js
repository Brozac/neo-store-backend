// create_shipment_events.js — شغله مرة واحدة
require('dotenv').config();
const pool = require('./db');

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipment_events (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      event_type VARCHAR(50),          -- CREATED/SHIPPED/IN_TRANSIT/CUSTOMS/OUT_FOR_DELIVERY/DELIVERED
      status_raw VARCHAR(100),         -- الحالة الخام من CJ
      location VARCHAR(200),           -- المدينة/المستودع
      country_code VARCHAR(5),
      description TEXT,                — الوصف من CJ (مترجم لاحقًا)
      carrier VARCHAR(100),
      tracking_number VARCHAR(100),
      event_time TIMESTAMPTZ,
      raw_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ship_events_order ON shipment_events(order_id, event_time);
    CREATE INDEX IF NOT EXISTS idx_ship_events_type ON shipment_events(event_type);
  `);
  console.log('✅ shipment_events ready');
  await pool.end();
})();