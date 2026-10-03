// migrate-categories.js - Laclarc Enterprise DB Migration Script (FULL BUNDLE)
// يجمع كل ما احتاجه النظام: categories/products/orders الأصلية + كل جلستي الإصلاح
// Idempotent — آمن للتكرار (IF NOT EXISTS / ON CONFLICT / DO blocks)
// التشغيل: node migrate-categories.js
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

    // ================================================================
    // 🩹 5. SESSION 2026-10-02 — Exchange + Sweep + Recovery (P0 bundle)
    // ================================================================
    console.log('⏳ Applying session-hardening columns...');

    // 🔑 Exchange IDOR fix — capability token لكل طلب (القديمة تتغلف تلقائياً)
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_token UUID NOT NULL DEFAULT gen_random_uuid();`);

    // S2 substitutes (بدائل JSONB)
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_options JSONB;`);

    // ساعة 72h — S3/Sweep tracking
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_since TIMESTAMPTZ;`);

    // 🩹 FIX#4 — Abandoned Cart spam-cap (إيميل واحد لكل طلب للأبد)
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;`);
    console.log('✅ 4. Session columns verified (exchange_token / exchange_options / manual_since / recovery_email_sent_at).');

    // ================================================================
    // 🩹 6. SESSION INDEXES — أداء الاستعلامات الحارة (كلها من الجلستين)
    // ================================================================
    console.log('⏳ Applying session performance indexes...');

    // Exchange GET/POST lookups (بواسطة token)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_exchange_token ON orders (exchange_token);`);

    // L0 sweep + S3 queries (كل ساعتين — كان seq-scan)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_manual_sweep ON orders (status, manual_since)
                        WHERE status IN ('awaiting_exchange','manual','paid');`);

    // Abandoned Cart scan (كل ساعة — partial: فقط غير المرسل)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_recovery_email ON orders (recovery_email_sent_at)
                        WHERE recovery_email_sent_at IS NULL;`);

    // Reconcile (كل 15د) + Sweeper (كل ساعة) — pending فقط
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_pm_status_pending ON orders (payment_method, status)
                        WHERE status = 'pending';`);

    // ⚡ الأهم أداءً: loadBurnedBump يقرأ 200 حدث لكل fulfillment
    //    + كل audit queries — بلا هذا الفهرس = seq-scan على system_events المتضخمة
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sys_events_type_order ON system_events (event_type, order_id);`);

    // Tracking cron + SelfHeal batch (طلبات بلا tracking)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_tracking_pending ON orders (status, created_at)
                        WHERE status IN ('paid','fulfilled') AND tracking_number IS NULL;`);
    console.log('✅ 5. Session indexes verified (6 indexes — hot-path queries covered).');

    // ================================================================
    // 🩹 7. SEEDS — RECOVER10 + payment_gateways (درع ضد قاعدة نظيفة)
    // ================================================================
    console.log('⏳ Applying seeds...');

    // RECOVER10 — وعد إيميلات الاسترجاع (سقف أمان 10%)
    await client.query(`
      INSERT INTO coupons (code, discount_type, discount_value, is_active)
      VALUES ('RECOVER10', 'percentage', 10, true)
      ON CONFLICT (code) DO NOTHING;
    `);

    // payment_gateways — البوابات الأربع (حالتك الحالية: stripe+crypto ON)
    // ⚠️ ON CONFLICT DO NOTHING — لا يمس قراراتك اليدوية الموجودة (مثل crypto true)
    await client.query(`
      INSERT INTO payment_gateways (gateway_key, display_name, enabled)
      VALUES
        ('stripe',    'Stripe (Card)',      true),
        ('paysera',   'Paysera',            false),
        ('crypto',    'Crypto (USDT/USDC)', true),
        ('baridimob', 'BaridiMob / CCP',    false)
      ON CONFLICT (gateway_key) DO NOTHING;
    `);
    console.log('✅ 6. Seeds verified (RECOVER10 + payment_gateways).');

    await client.query('COMMIT');

    // ================================================================
    // 📋 8. VERIFICATION REPORT — الحكم النهائي مطبوع
    // ================================================================
    console.log('\n📋 VERIFICATION REPORT:');
    try {
      const cols = await client.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'orders'
          AND column_name IN ('exchange_token','exchange_options','manual_since','recovery_email_sent_at')
        ORDER BY column_name
      `);
      cols.rows.forEach(c => console.log(`  ✅ orders.${c.column_name} (${c.data_type})`));

      const cov = await client.query(`SELECT COUNT(*) AS total, COUNT(exchange_token) AS tokened FROM orders`);
      console.log(`  🔑 exchange_token coverage: ${cov.rows[0].tokened}/${cov.rows[0].total}`);

      const idx = await client.query(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'orders' AND indexname LIKE 'idx_%'
        ORDER BY indexname
      `);
      console.log(`  📑 orders indexes (${idx.rows.length}):`);
      idx.rows.forEach(r => console.log(`     • ${r.indexname}`));

      const gw = await client.query('SELECT gateway_key, enabled FROM payment_gateways ORDER BY id');
      gw.rows.forEach(g => console.log(`  ${g.enabled ? '🟢' : '🔴'} gateway: ${g.gateway_key}`));

      const cp = await client.query(`SELECT code FROM coupons WHERE code = 'RECOVER10'`);
      console.log(`  🎟️ RECOVER10: ${cp.rows.length ? '✅' : '❌'}`);
    } catch (vErr) {
      console.warn('⚠️ verification queries failed:', vErr.message);
    }

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