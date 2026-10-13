// migrations/002_order_numbers.js - Laclarc Order Number System (v1)
// 🩹 M#52-followup — Order Number منفصل عن Database ID:
//   • order_number = 'LC-' + year + '-' + zero-padded serial
//   • backfill لكل الطلبات الموجودة (89 → LC-2026-00089)
//   • generation trigger للأوردرات الجاية (بلا كود تطبيق)
//   • unique index
// تشغيل: node migrations/002_order_numbers.js
require('dotenv').config();
const pool = require('../db');

async function run() {
  const client = await pool.connect();
  const blockers = [];
  try {
    console.log('\n══════════════════════════════════════════════════');
    console.log('🩹 Migration 002 — Order Number System');
    console.log('══════════════════════════════════════════════════\n');

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);

    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT`);
    console.log('  ✓ order_number column');

    const { rows: existing } = await client.query(
      `SELECT id, created_at FROM orders WHERE order_number IS NULL ORDER BY created_at ASC`
    );
    console.log(`  📦 Backfill: ${existing.length} طلب`);

    for (const order of existing) {
      const year = new Date(order.created_at).getFullYear();
      const { rows: seqRes } = await client.query(
        `SELECT COUNT(*)::int AS n FROM orders
         WHERE EXTRACT(YEAR FROM created_at) = $1 AND created_at <= $2`,
        [year, order.created_at]
      );
      const serialInYear = seqRes[0].n;
      const orderNumber = `LC-${year}-${String(serialInYear).padStart(5, '0')}`;
      await client.query(`UPDATE orders SET order_number = $1 WHERE id = $2`, [orderNumber, order.id]);
    }
    console.log(`  ✅ Backfill — ${existing.length} ترقمو`);

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number)`);
    console.log('  ✓ unique index');

    await client.query(`
      CREATE OR REPLACE FUNCTION generate_order_number()
      RETURNS TRIGGER AS $$       BEGIN
        IF NEW.order_number IS NULL OR NEW.order_number = '' THEN
          NEW.order_number = 'LC-' || EXTRACT(YEAR FROM COALESCE(NEW.created_at, NOW()))::text || '-' ||
            LPAD(
              (SELECT COUNT(*)::text FROM orders
               WHERE EXTRACT(YEAR FROM COALESCE(NEW.created_at, NOW())) = EXTRACT(YEAR FROM COALESCE(NEW.created_at, NOW()))
              )::text, 5, '0'
            );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_generate_order_number ON orders`);
    await client.query(`CREATE TRIGGER trg_generate_order_number
      BEFORE INSERT ON orders
      FOR EACH ROW
      EXECUTE FUNCTION generate_order_number()`);
    console.log('  ✅ trigger: توليد تلقائي');

    await client.query('COMMIT');
    console.log('\n  ✅ COMMIT — Migration ناجحة\n');

    const { rows: samples } = await client.query(
      `SELECT id, order_number, created_at FROM orders ORDER BY id DESC LIMIT 5`
    );
    console.log('  🔍 Samples:');
    samples.forEach(s => console.log(`     #${s.id} → ${s.order_number} (${new Date(s.created_at).getFullYear()})`));

    const { rows: dup } = await client.query(
      `SELECT order_number, COUNT(*)::int AS n FROM orders GROUP BY order_number HAVING COUNT(*) > 1`
    );
    if (dup.length > 0) {
      console.log(`  🚨 DUPLICATES: ${dup.length}`);
      blockers.push('duplicates');
    } else {
      console.log('  ✓ صفر duplicates');
    }

    return blockers.length === 0 ? 0 : 1;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Migration فشلت — ROLLBACK:', e.message);
    return 1;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  run().then((code) => pool.end().then(() => process.exit(code)))
       .catch((e) => { console.error('❌ Fatal:', e); process.exit(1); });
}
module.exports = { run };
