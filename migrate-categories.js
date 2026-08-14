require('dotenv').config();
const { Pool } = require('pg');

// ✨ 1. إضافة ssl: { rejectUnauthorized: false } للاتصال الآمن بـ Render/Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const migrate = async () => {
  try {
    console.log('⏳ Starting categories migration...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        level SMALLINT NOT NULL,                 
        name VARCHAR(255) NOT NULL,               
        slug VARCHAR(255) NOT NULL,               
        parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        cj_category_id VARCHAR(100) UNIQUE,       
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_cj_id ON categories(cj_category_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_level_slug ON categories(level, slug);`);
    console.log('✅ Table "categories" ready.');

    console.log('⏳ Adding cj_category_id and patterns to products...');
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cj_category_id VARCHAR(100);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_cj_category ON products(cj_category_id);`);
    
    // ✨ 2. التأكد من وجود عمود patterns (مطلوب لسكريبت المزامنة والبحث)
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS patterns TEXT[];`);
    
    console.log('✅ Columns "cj_category_id" and "patterns" ready on products.');

    console.log('🎉 Categories migration completed successfully!');
    
    // ✨ 3. إغلاق الاتصال بأمان
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration error:', err);
    await pool.end();
    process.exit(1);
  }
};

migrate();