// send_review_invite.js — إرسال دعوة المراجعة فوراً لطلب واحد
// التشغيل: node send_review_invite.js 70
require('dotenv').config();
const axios = require('axios');
const pool = require('./db');

const orderId = parseInt(process.argv[2], 10);
if (!Number.isFinite(orderId)) { console.error('استعمل: node send_review_invite.js <orderId>'); process.exit(1); }

(async () => {
  const { rows } = await pool.query(`
    SELECT id, customer_name, customer_email, review_token, delivered_at
    FROM orders WHERE id = $1 AND status = 'completed' AND review_token IS NOT NULL
  `, [orderId]);
  const order = rows[0];
  if (!order) { console.error(`❌ #${orderId} غير مؤهل (لازم completed + review_token)`); process.exit(1); }

  const reviewUrl = `${process.env.FRONTEND_URL || 'https://laclarc.com'}/review/${order.id}?t=${order.review_token}`;

  const itemsRes = await pool.query(`
    SELECT p.title, p.image_url FROM order_items oi
    JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1
  `, [order.id]);
  const product = itemsRes.rows[0];

  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'Laclarc Support', email: process.env.BREVO_USER },
    to: [{ email: order.customer_email }],
    subject: `⭐ How was your ${product?.title || 'order'}? Get 5% off!`,
    htmlContent: `
      <div style="font-family:Arial;max-width:550px;margin:auto;background:#F9F8FC;padding:25px;border-radius:16px;border:1px solid #E5E7EB;">
        <div style="text-align:center;margin-bottom:20px;">
          <h1 style="color:#1D1E3C;margin:0;font-size:24px;">Laclarc</h1>
          <p style="color:#8B78C6;font-weight:bold;font-size:12px;margin:4px 0 0;">Your opinion matters 💜</p>
        </div>
        <p style="color:#4B5563;font-size:14px;line-height:1.6;">
          Hello <strong>${order.customer_name || 'there'}</strong>,<br>
          Your order <strong>#${order.id}</strong> has been delivered! 🎉<br><br>
          We'd love to hear about your experience.
        </p>
        ${product?.image_url ? `<div style="text-align:center;margin:20px 0;"><img src="${product.image_url}" style="max-width:200px;border-radius:12px;border:1px solid #E5E7EB;" /></div>` : ''}
        <div style="background:#FFF;border:2px dashed #8B78C6;padding:15px;border-radius:12px;text-align:center;margin-bottom:25px;">
          <p style="margin:0 0 5px;color:#1D1E3C;font-size:12px;font-weight:bold;">WRITE A REVIEW & GET:</p>
          <span style="display:inline-block;background:#8B78C6;color:#fff;padding:6px 16px;border-radius:6px;font-weight:bold;font-size:15px;">5% OFF NEXT ORDER</span>
        </div>
        <div style="text-align:center;">
          <a href="${reviewUrl}" style="display:inline-block;background:#8B78C6;color:#fff;padding:14px 32px;border-radius:30px;font-weight:bold;text-decoration:none;font-size:14px;">Write My Review ⭐</a>
        </div>
      </div>`
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    timeout: 10000
  });

  await pool.query('UPDATE orders SET review_invited_at = NOW() WHERE id = $1', [order.id]);
  console.log(`📧 الدعوة خرجت ✓ — #${order.id} → ${order.customer_email}`);
  console.log(`🔗 ${reviewUrl}`);
  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌', e.response?.data || e.message); process.exit(1); });
