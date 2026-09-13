'use strict';
// reset_62.js — تعيير الطلب 62: cj_order_number نضيف لاحقة جديدة، باش fulfillCJOrder يخلق طلب جديد عند CJ
require('dotenv').config();
const pool = require('./db');

async function main() {
  const id = parseInt(process.argv[2] || '62', 10);
  const suffix = Date.now().toString().slice(-6);
  const newNum = `STORE-${id}-R${suffix}`; // رقم جديد كلياً — CJ ما عرفوش
  const res = await pool.query(
    "UPDATE orders SET cj_order_number = $1 WHERE id = $2 RETURNING id, cj_order_number",
    [newNum, id]
  );
  if (!res.rows.length) { console.log('❌ الطلب غير موجود فالـ DB'); process.exit(1); }
  console.log('✅ الطلب #' + id + ' تحيّن الرقم CJ تاعو:', newNum);
  console.log('   الدورة الجاية (fulfillCJOrder ولا Auto-Heal) غادي تخلق نسخة CJ جديدة بهاد الرقم.');
  console.log('   ثم جرب: node cj_sandbox_e2e.js ' + newNum);
  process.exit(0);
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });