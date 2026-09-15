/**
 * node test_ctxmap3.js — السيناريو العكسي: fulfillment بلا أي ctx
 * (webhook كيربح القفل قبل الزبون يوصل /success — ولا reconcile cron)
 * المطلوب: fbp/fbc = undefined — صفر بصمات مختلقة
 */
require('dotenv').config();
const https = require('https');
https.request = function () { throw new Error('NETWORK_BLOCKED_FOR_TEST'); };

const { sendPurchaseConversion } = require('./services/conversionService');

(async () => {
  try {
    // ⚠️ لا setConversionContext نهائياً — orderId جديد عمره ما شاف /success
    await sendPurchaseConversion({
      orderId: 888,
      value: 9.99,
      items: [{ productId: 33, quantity: 1, price: 9.99 }],
      email: 'backlog@test.com',
      phone: '+213555333444',
      customerName: 'Backlog Path',
      city: 'Constantine',
    });
  } catch (e) {
    console.log(`(متوقع: ${e.message.slice(0, 60)})`);
  }
  process.exit(0);
})();