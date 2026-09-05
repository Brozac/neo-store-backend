// createTables.js - Laclarc Enterprise Database Schema Setup
require('dotenv').config();
const pool = require('./db'); // ✨ استخدام الـ Pool الموحد والمحصن

const createTables = async () => {
  const client = await pool.connect();
  try {
    console.log('⏳ Starting database setup (Enterprise Architecture)...');
    await client.query('BEGIN');

    // 1. جدول المستخدمين (يجب أن يكون الأول لأن orders و reviews ترتبط به)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_verified BOOLEAN DEFAULT false,
        profile_picture TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
    console.log('✅ 1. Table "users" ready.');

    // 2. جدول شجرة فئات CJ الرسمية (Categories Tree)
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
    console.log('✅ 2. Table "categories" ready with indexes.');

    // 3. جدول المنتجات (مع دعم Lightning Deals و 1688 Sourcing)
    await client.query(`
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
        is_sourced BOOLEAN DEFAULT false, /* ✨ ميزة الـ Lightning Deals وسحب 1688 */
        cj_product_id VARCHAR(100) UNIQUE,
        video_url TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // فهرس للعرض السريع وفهرس العروض
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_display ON products(stock_status, sort_order ASC, id DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_deals ON products(stock_status, is_sourced);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_cj_product_id ON products(cj_product_id);`);
    console.log('✅ 3. Table "products" ready with advanced indexes.');

    // 4. جدول الطلبات (Orders)
    await client.query(`
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
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // فهارس استعلامات الـ Reconcile، Sweeper، والتتبع
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_reconcile ON orders(payment_method, status, created_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders(stripe_session_id);`);
    console.log('✅ 4. Table "orders" ready with indexes.');

    // 5. جدول تفاصيل الطلبات (Order Items)
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        quantity INTEGER NOT NULL,
        price_at_purchase DECIMAL(10, 2) NOT NULL,
        vid VARCHAR(100)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);`);
    console.log('✅ 5. Table "order_items" ready.');

    // 6. جدول الكوبونات (Coupons)
    await client.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        discount_type VARCHAR(20) DEFAULT 'percentage',
        discount_value DECIMAL(10, 2) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);`);
    console.log('✅ 6. Table "coupons" ready.');

    // 7. جدول التقييمات (Reviews)
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author VARCHAR(255) NOT NULL,
        rating INTEGER DEFAULT 5,
        content TEXT NOT NULL,
        country VARCHAR(100) DEFAULT 'United States',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);`);
    console.log('✅ 7. Table "reviews" ready.');

    await client.query('COMMIT');
    console.log('🎉 Enterprise Database setup completed successfully without any conflicts!');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error creating tables:', err);
    process.exit(1);
  } finally {
    client.release();
  }
};

createTables();