require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ==========================================
// 🗂️ ميغراسيون: جدول categories كيعكس شجرة CJ الرسمية (3 مستويات)
// + عمود cj_category_id فـ products باش نخزنو الـ categoryId الأصلي جاي من CJ
// (بدل ما نستنتجو الفئة من الكلمات فالعنوان)
// ==========================================
const migrate = async () => {
  try {
    console.log('⏳ Starting categories migration...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        level SMALLINT NOT NULL,                 -- 1, 2 أو 3 (3 = leaf، فيها cj_category_id حقيقي)
        name VARCHAR(255) NOT NULL,               -- الاسم الأصلي كيفما جاي من CJ (بالإنجليزية)
        slug VARCHAR(255) NOT NULL,               -- نسخة slug مولدة من الاسم
        parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        cj_category_id VARCHAR(100) UNIQUE,       -- ⚠️ CJ كيعطي ID غير للمستوى 3 (leaf)؛ NULL للمستوى 1 و2
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_cj_id ON categories(cj_category_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_level_slug ON categories(level, slug);`);
    console.log('✅ Table "categories" ready.');

    console.log('⏳ Adding cj_category_id to products...');
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cj_category_id VARCHAR(100);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_cj_category ON products(cj_category_id);`);
    console.log('✅ Column "cj_category_id" ready on products.');

    console.log('🎉 Categories migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration error:', err);
    process.exit(1);
  }
};

migrate();