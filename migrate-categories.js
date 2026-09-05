// migrate-categories.js - Laclarc Enterprise DB Migration Script
require('dotenv').config();
const pool = require('./db'); // ✨ استخدام الـ Pool الموحد

const migrate = async () => {
  const client = await pool.connect();
  try {
    console.log('\n==================================================');
    console.log('⏳ Starting Enterprise Database Migration...');
    console.log('==================================================\n');

    await client.query('BEGIN');

    // 1. التأكد من وجود جدول شجرة الفئات وفهارسه
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        level SMALLINT NOT NULL,                 
        name VARCHAR(255) NOT NULL,               
        slug VARCHAR(255) NOT NULL,               
        parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        cj_category_id VARCHAR(100) UNIQUE,       
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_categories_cj_id ON categories(cj_category_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_categories_level_slug ON categories(level, slug);`);
    console.log('✅ 1. Categories table & indexes verified.');

    // 2. تحديث جدول المنتجات بكافة الأعمدة الحديثة
    console.log('⏳ Updating products table schema...');
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cj_category_id VARCHAR(100);`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS patterns TEXT[];`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_sourced BOOLEAN DEFAULT false;`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS video_url TEXT;`);

    // 3. إضافة فهارس السرعة القصوى للمتجر (High-Performance Indexes)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_cj_category ON products(cj_category_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_display ON products(stock_status, sort_order ASC, id DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_deals ON products(stock_status, is_sourced);`);
    console.log('✅ 2. Products table columns & speed indexes verified.');

    // 4. التأكد من فهارس جدول الطلبات لتسريع الـ Reconcile والـ Sweeper
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_reconcile ON orders(payment_method, status, created_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders(stripe_session_id);`);
    console.log('✅ 3. Orders table indexes verified.');

    await client.query('COMMIT');

    console.log('\n==================================================');
    console.log('🎉 Database Migration Completed Successfully!');
    console.log('==================================================\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
};

migrate();