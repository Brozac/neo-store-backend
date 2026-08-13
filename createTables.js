require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const createTables = async () => {
  try {
    console.log('⏳ Starting database setup (Divine Version)...');

    // 1. جدول الأقسام الرسمية (CJ Category Tree)
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
    // ✨ إضافة فهارس لتسريع البحث في الشجرة
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_cj_id ON categories(cj_category_id);`);
    console.log('✅ Table "categories" ready with indexes.');

    // 2. جدول المنتجات
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        original_price DECIMAL(10, 2),
        image_url TEXT,
        images TEXT[],
        variants JSONB,
        colors TEXT[],
        sizes TEXT[],
        patterns TEXT[],
        material VARCHAR(255),
        category VARCHAR(255),
        cj_category_id VARCHAR(100),
        stock_status BOOLEAN DEFAULT true,
        cj_product_id VARCHAR(100) UNIQUE,
        video_url TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // ✨ فهارس لتسريع عرض المنتجات في الموقع
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock_status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_cj_category ON products(cj_category_id);`);
    console.log('✅ Table "products" ready with indexes.');

    // 3. جدول الطلبات
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255),
        customer_phone VARCHAR(50),
        customer_city VARCHAR(100),
        shipping_address TEXT,
        total_amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        payment_method VARCHAR(50),
        payment_status VARCHAR(50) DEFAULT 'pending',
        receipt_url TEXT,
        stripe_session_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table "orders" ready.');

    // 4. جدول عناصر الطلب
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        quantity INTEGER NOT NULL,
        price_at_purchase DECIMAL(10, 2) NOT NULL,
        vid VARCHAR(100)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);`);
    console.log('✅ Table "order_items" ready with indexes.');

    // 5. جدول المستخدمين
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_verified BOOLEAN DEFAULT false,
        profile_picture TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table "users" ready.');

    // 6. جدول الكوبونات
    await pool.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        discount_type VARCHAR(20) DEFAULT 'percentage',
        discount_value DECIMAL(10, 2) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table "coupons" ready.');

    // 7. جدول التقييمات
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author VARCHAR(255) NOT NULL,
        rating INTEGER DEFAULT 5,
        content TEXT NOT NULL,
        country VARCHAR(100) DEFAULT 'United States',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);`);
    console.log('✅ Table "reviews" ready with indexes.');

    console.log('🎉 Database setup (Divine Version) completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error creating tables:', err);
    process.exit(1);
  }
};

createTables();