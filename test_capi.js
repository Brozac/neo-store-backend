/**
 * Smoke Test — node test_capi.js
 * يطلق Purchase وحدا لكل منصة عبر الـ test codes.
 * المتوقع: meta events_received=1 | tiktok code=0
 * ثم يشوفهم فـ Test Events تاع كل منصة بعلامة 🖥️ Server.
 */
require('dotenv').config();
const { sendPurchaseConversion } = require('./services/conversionService');

(async () => {
  const ts = Date.now();
  try {
    const summary = await sendPurchaseConversion({
      orderId: `SMOKE_${ts}`,
      value: 19.99,
      items: [{ productId: 1, quantity: 1, price: 19.99 }],
      email: 'smoke.test@example.com',
      phone: '+213555000000',
      customerName: 'Smoke Test',
      city: 'Alger',
      clientIp: '41.102.0.1',
      userAgent: 'laclarc-smoke-test/1.0',
    });
    console.log('✅ SUMMARY:', JSON.stringify(summary, null, 2));
    console.log('→ Meta Test Events + TikTok Test Events لازم يبانوا دابا');
  } catch (e) {
    console.error('❌ FAILED:', e.message);
    process.exit(1);
  }
})();