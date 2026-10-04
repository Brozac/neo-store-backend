// simulate_delivered_order.js — force an order into 'completed + delivered 7d ago'
// ⚠️ TEST ONLY — استعمل على طلباتك التجريبية فقط (لا طلبات زبائن حقيقيين)
// التشغيل: node simulate_delivered_order.js 70
require('dotenv').config();
const pool = require('./db');

const orderId = parseInt(process.argv[2], 10);
if (!Number.isFinite(orderId)) { console.error('استعمل: node simulate_delivered_order.js <orderId>'); process.exit(1); }

(async () => {
  const upd = await pool.query(`
    UPDATE orders
    SET status = 'completed',
        delivered_at = NOW() - INTERVAL '7 days',
        review_invited_at = NULL,
        review_submitted_at = NULL,
        review_token = gen_random_uuid()
    WHERE id = $1
    RETURNING id, status, customer_email, review_token
  `, [orderId]);

  if (!upd.rowCount) { console.error(`❌ #${orderId} غير موجود`); process.exit(1); }
  const o = upd.rows[0];
  console.log(`✅ #${o.id} → completed (delivered 7d ago)`);
  console.log(`📧 الزبون: ${o.customer_email}`);
  console.log(`\n🔗 رابط المراجعة (للاختبار اليدوي):`);
  console.log(`   ${process.env.FRONTEND_URL || 'https://laclarc.com'}/review/${o.id}?t=${o.review_token}`);
  console.log(`\n⏭️ الآن: node send_review_invite.js ${o.id}   ← يبعث الإيميل فوراً (بلا انتظار 10:00)`);
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
