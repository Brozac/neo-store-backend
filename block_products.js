// block_products.js — حظر المنتجات المثبتة غير-القابلة-للشحن
require('dotenv').config();
const pool = require('./db');

const TO_BLOCK = [8230, 20494, 21715];   // من تجارب #77/#78/#83 الموثقة

(async () => {
  const { rows } = await pool.query(`
    UPDATE products SET shipping_blocked = true
    WHERE id = ANY($1::int[]) RETURNING id, title
  `, [TO_BLOCK]);
  console.log(`🚫 حُظرت ${rows.length} منتج:`);
  rows.forEach(r => console.log(`   [${r.id}] ${r.title?.slice(0, 60)}`));
  console.log(`\n✅ من الآن — أي زبون يحاول شراءها → يُرفض في prepareSecureItems`);
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });