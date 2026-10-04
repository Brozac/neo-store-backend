// shipping_blocked_migration.js — M#28
// Idempotent — آمن للتكرار
require('dotenv').config();
const pool = require('./db');

(async () => {
  console.log('═══ 🚫 Shipping-Blocked Migration ═══\n');
  let ok = 0, fail = 0;

  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_blocked BOOLEAN DEFAULT false`);
    console.log(`  [OK] products.shipping_blocked column`);
    ok++;
  } catch (e) { console.error(`  [FAIL] column: ${e.message}`); fail++; }

  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_shipping_blocked ON products (shipping_blocked) WHERE shipping_blocked = true`);
    console.log(`  [OK] idx_products_shipping_blocked`);
    ok++;
  } catch (e) { console.error(`  [FAIL] index: ${e.message}`); fail++; }

  // 🩹 حظر المنتجات المسبوبة لمشاكل shipping الحالية (مثل Nail Vacuum من #82)
  try {
    const r = await pool.query(`
      SELECT DISTINCT p.id, p.title FROM products p
      JOIN order_items oi ON oi.product_id = p.id
      JOIN orders o ON o.id = oi.order_id
      WHERE o.id IN (77, 78, 83)
    `);
    if (r.rows.length > 0) {
      console.log(`\n📋 منتجات مرتبطة بطلبات مشمومة — هل تحظرها؟ (تحقق أولاً من العناوين):\n`);
      r.rows.forEach(x => console.log(`   [${x.id}] ${x.title?.slice(0, 60)}`));
      console.log(`\n💡 لتشغيل الحظر: node shipping_blocked_migration.js --block-77-78-83\n`);
    }
  } catch (e) { console.warn(`⚠️ pre-check failed: ${e.message}`); }

  console.log(`\n═══ done: ok=${ok} fail=${fail} ═══`);
  await pool.end();
  fail > 0 ? process.exit(1) : process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
