// create_i18n_tables.js — جداول الترجمة الدائمة (Mission #20)
require('dotenv').config();
const pool = require('./db');

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS i18n_cache (
      cache_key TEXT PRIMARY KEY,
      target_lang VARCHAR(10) NOT NULL,
      original TEXT,
      translated TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_translations (
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      lang VARCHAR(10) NOT NULL,
      title TEXT,
      description TEXT,
      PRIMARY KEY (product_id, lang)
    );

    CREATE INDEX IF NOT EXISTS idx_prod_trans ON product_translations(product_id, lang);
    CREATE INDEX IF NOT EXISTS idx_i18n_lang ON i18n_cache(target_lang);
  `);
  console.log('✅ i18n tables ready (i18n_cache + product_translations)');
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });