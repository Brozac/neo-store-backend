// emails/preview.js — renders all 5 Laclarc emails to preview/*.html (NO sending)
// Run:  node emails/preview.js   →   open preview/ in a browser

'use strict';

const fs = require('fs');
const path = require('path');
const T = require('./templates');

const outDir = path.join(__dirname, 'preview');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const SITE = process.env.FRONTEND_URL || 'https://laclarc.com';

const fakeItems = [
  { title: 'Wireless Earbuds Pro — Noise Cancelling', quantity: 1, price_at_purchase: 33.99, image_url: '' },
  { title: 'Unisex Luxury Quartz Watch — Stainless Steel', quantity: 2, price_at_purchase: 24.50, image_url: '' },
];

const emails = [
  ['01-order-confirmation', T.orderConfirmation({
    orderId: 97, orderNumber: 'LC-2026-00097', total: 82.99, customerName: 'Adem', items: fakeItems,
  }), T.orderSubject('LC-2026-00097', 97)],

  ['02-verify-email', T.verifyEmail({
    name: 'Adem', verifyUrl: `${SITE}/auth/verify-email?token=DEMO_TOKEN`,
  }), 'Confirm your email — Welcome to Laclarc'],

  ['03-password-reset', T.passwordReset({
    resetUrl: `${SITE}/auth/reset-password?token=DEMO_TOKEN`,
  }), 'Reset your password — Laclarc'],

  ['04-abandoned-cart', T.abandonedCart({
    customerName: 'Adem', orderId: 105, orderNumber: 'LC-2026-00105', items: fakeItems,
  }), 'Still there? Your cart + exclusive 10% OFF inside'],

  ['05-review-invite', T.reviewInvite({
    customerName: 'Adem', orderId: 97, orderNumber: 'LC-2026-00097',
    reviewUrl: `${SITE}/review/97?t=DEMO_TOKEN`,
    product: { title: 'Wireless Earbuds Pro', image_url: '' },
  }), 'How was your order? Get 5% off your next one ⭐'],
];

for (const [name, html, subject] of emails) {
  fs.writeFileSync(path.join(outDir, `${name}.html`), html, 'utf8');
  console.log(`✓ preview/${name}.html  (subject: ${subject})`);
}
console.log(`\nDone — ${emails.length} previews in ${outDir}`);
