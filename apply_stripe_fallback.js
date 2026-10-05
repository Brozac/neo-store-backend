// apply_stripe_fallback.js — M#33 Stripe address fallback
const fs = require('fs');
const file = 'server.js';
let raw = fs.readFileSync(file, 'utf8');
let count = 0;

// 1) verify-session — old pattern
const oldVS = `const customerPhone = session.customer_details?.phone || '';
    const addr = session.customer_details?.address;`;
const newVS = `const customerPhone = session.customer_details?.phone
                       || session.collected_information?.shipping_details?.phone
                       || session.collected_information?.phone_number
                       || '';
    const addr = session.customer_details?.address
              || session.collected_information?.shipping_details?.address
              || null;`;

if (raw.includes(oldVS)) {
  raw = raw.replace(oldVS, newVS);
  count++;
  console.log('  ✅ verify-session patched');
} else if (raw.includes('collected_information')) {
  console.log('  [SKIP] verify-session (already patched)');
} else {
  console.log('  ⚠️ verify-session pattern not found');
}

// 2) supplier-webhook — old pattern
const oldWH = `const customerPhone = session.customer_details?.phone || '';
        const addr = session.customer_details?.address;`;
const newWH = `const customerPhone = session.customer_details?.phone
                           || session.collected_information?.shipping_details?.phone
                           || session.collected_information?.phone_number
                           || '';
        const addr = session.customer_details?.address
                  || session.collected_information?.shipping_details?.address
                  || null;`;

if (raw.includes(oldWH)) {
  raw = raw.replace(oldWH, newWH);
  count++;
  console.log('  ✅ supplier-webhook patched');
} else if (raw.includes('collected_information')) {
  console.log('  [SKIP] supplier-webhook (already patched)');
} else {
  console.log('  ⚠️ supplier-webhook pattern not found');
}

fs.writeFileSync(file, raw);
console.log(`\n  --- ${count} patched ---`);
if (count === 0) process.exit(1);