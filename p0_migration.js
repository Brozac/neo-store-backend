// p0_migration.js — Complete migration bundle (idempotent — آمن للتكرار)
// يجمع كل ما احتاجه النظام من جلستي الإصلاح — شغّله مرة قبل أي deploy
// التشغيل: node p0_migration.js
require('dotenv').config();
const pool = require('./db');

const MIGRATIONS = [
  {
    name: 'exchange_token (Exchange IDOR fix — capability token per order)',
    sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_token UUID NOT NULL DEFAULT gen_random_uuid();`
  },
  {
    name: 'exchange_options (S2 substitutes JSONB)',
    sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_options JSONB;`
  },
  {
    name: 'manual_since (72h clock — S3/Sweep tracking)',
    sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_since TIMESTAMPTZ;`
  },
  {
    name: 'recovery_email_sent_at (Abandoned Cart — FIX#4 spam-cap)',
    sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;`
  },
  {
    name: 'idx: orders.exchange_token (exchange GET/POST lookups)',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_exchange_token ON orders (exchange_token);`
  },
  {
    name: 'idx: orders.manual_since+status (L0 sweep + S3 queries)',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_manual_sweep ON orders (status, manual_since) WHERE status IN ('awaiting_exchange','manual','paid');`
  },
  {
    name: 'idx: orders.recovery_email_sent_at (Abandoned Cart scan)',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_recovery_email ON orders (recovery_email_sent_at) WHERE recovery_email_sent_at IS NULL;`
  },
  {
    name: 'idx: orders.payment_method+status (Reconcile/Sweeper — partial match to existing)',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_pm_status_pending ON orders (payment_method, status) WHERE status = 'pending';`
  },
  {
    name: 'idx: system_events.event_type+order_id (burnedBump persistent memory + audit queries)',
    sql: `CREATE INDEX IF NOT EXISTS idx_sys_events_type_order ON system_events (event_type, order_id);`
  },
  {
    name: 'RECOVER10 coupon seed (سقف أمان 10% — email promises it)',
    sql: `INSERT INTO coupons (code, discount_type, discount_value, is_active)
          VALUES ('RECOVER10', 'percentage', 10, true)
          ON CONFLICT (code) DO NOTHING;`
  },
  {
    name: 'payment_gateways — تأكيد البوابات الأربع موجودة (seed إن كان الجدول فارغاً)',
    sql: `INSERT INTO payment_gateways (gateway_key, display_name, enabled)
          VALUES
            ('stripe', 'Stripe (Card)', true),
            ('paysera', 'Paysera', false),
            ('crypto', 'Crypto (USDT/USDC)', false),
            ('baridimob', 'BaridiMob / CCP', false)
          ON CONFLICT (gateway_key) DO NOTHING;`
  },
];

(async () => {
  console.log('═══ 🩹 P0 Migration — starting ═══\n');
  let ok = 0, skip = 0, fail = 0;

  for (const m of MIGRATIONS) {
    try {
      await pool.query(m.sql);
      console.log(`  [OK  ] ${m.name}`);
      ok++;
    } catch (e) {
      if (e.code === '42P07' || e.code === '42710' || /already exists/i.test(e.message)) {
        console.log(`  [SKIP] ${m.name} (already exists)`);
        skip++;
      } else {
        console.error(`  [FAIL] ${m.name} — ${e.message}`);
        fail++;
      }
    }
  }

  // ─── Verification report ───
  console.log('\n═══ 📋 VERIFICATION ═══\n');
  try {
    const cols = await pool.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'orders'
        AND column_name IN ('exchange_token','exchange_options','manual_since','recovery_email_sent_at')
      ORDER BY column_name
    `);
    console.log('  orders columns:');
    cols.rows.forEach(c => console.log(`    ✅ ${c.column_name} (${c.data_type})`));

    const cov = await pool.query(`
      SELECT COUNT(*) AS total, COUNT(exchange_token) AS tokened FROM orders
    `);
    console.log(`\n  exchange_token coverage: ${cov.rows[0].tokened}/${cov.rows[0].total}`);

    const idx = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'orders' AND indexname LIKE 'idx_orders_%'
      ORDER BY indexname
    `);
    console.log(`\n  orders indexes (${idx.rows.length}):`);
    idx.rows.forEach(r => console.log(`    📑 ${r.indexname}`));

    const gw = await pool.query('SELECT gateway_key, enabled FROM payment_gateways ORDER BY id');
    console.log(`\n  payment_gateways:`);
    gw.rows.forEach(g => console.log(`    ${g.enabled ? '🟢' : '🔴'} ${g.gateway_key}`));

    const cp = await pool.query(`SELECT code FROM coupons WHERE code = 'RECOVER10'`);
    console.log(`\n  RECOVER10: ${cp.rows.length ? '✅ seeded' : '❌ missing'}`);

  } catch (vErr) {
    console.error('⚠️ verification queries failed:', vErr.message);
  }

  console.log(`\n═══ done: ok=${ok} skip=${skip} fail=${fail} ═══`);
  if (fail > 0) process.exit(1);
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });