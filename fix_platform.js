'use strict';
// fix_platform.js — zid platform: 'others' + retry endpoint للطلبات manual
const fs = require('fs'), vm = require('vm');
const P = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\services\\cjService.js';
const S = 'C:\\Users\\B512\\Desktop\\DRPS\\backend\\server.js';
let cs = fs.readFileSync(P, 'utf8');
let sv = fs.readFileSync(S, 'utf8');
const problems = [];

// [1] زيد platform فالـ basePayload — قبل fromCountryCode
{
  const anchor = "      fromCountryCode: 'CN',";
  if (cs.includes("platform: 'others',")) console.log('SKIP [1] platform موجود');
  else if (!cs.includes(anchor)) { console.log('FAIL [1] basePayload anchor'); problems.push('payload'); }
  else {
    cs = cs.split(anchor).join("      platform: 'others',        // ✨ متجر مخصص — بلا هادا: 5027 Platform null not support\n      fromCountryCode: 'CN',");
    console.log('OK   [1] platform: "others" زيد فالـ payload');
  }
}

// [2] endpoint retry — يرجع الطلبات manual لمحاولة fulfillment جديدة
{
  const anchor = "app.get('/api/admin/failed-orders',";
  if (sv.includes('retry-fulfillment')) console.log('SKIP [2] retry endpoint موجود');
  else if (!sv.includes(anchor)) { console.log('FAIL [2] failed-orders anchor'); problems.push('endpoint'); }
  else {
    const ep = `app.put('/api/admin/retry-fulfillment/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' });
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];
    if (!['manual', 'paid'].includes(order.status)) {
      return res.status(409).json({ error: \`Order is '\${order.status}' — فقط manual أو paid يمكن إعادة إرسالهم\` });
    }
    // تمكين محاولة جديدة: نحيدو cj_order_number القديم (الـ COALESCE ما يسمحش بالكتابة فوق)
    await pool.query("UPDATE orders SET cj_order_number = '' WHERE id = $1 AND status = 'manual'", [id]);
    const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);

    let parsedAddress = {};
    try { parsedAddress = JSON.parse(order.shipping_address); }
    catch (e) { parsedAddress = { line1: order.shipping_address, country: 'US' }; }

    res.json({ message: 'Retry launched — شوف اللوج' });
    (async () => {
      try {
        const customerDetails = {
          address: parsedAddress,
          phone: order.customer_phone || '',
          email: order.customer_email || '',
          name: order.customer_name,
        };
        const r = await fulfillCJOrder(order.id, order.customer_name, customerDetails, itemsRes.rows);
        console.log(\`🔁 [Retry] #\${order.id} ->\`, JSON.stringify(r).slice(0, 200));
      } catch (bgErr) { logger.logError('Retry Fulfillment', bgErr); }
    })();
  } catch (err) {
    logger.logError('Retry Fulfillment Route', err);
    res.status(500).json({ error: 'Server error' });
  }
});

` + anchor;
    sv = sv.replace(anchor, ep);
    console.log('OK   [2] retry-fulfillment endpoint زيد');
  }
}

fs.writeFileSync(P, cs, 'utf8');
fs.writeFileSync(S, sv, 'utf8');

// [3] syntax
console.log('\n[3] syntax:');
let bad = false;
try { new vm.Script(cs, { filename: 'cjService.js' }); console.log('  OK   cjService.js'); }
catch (e) { console.log('  BAD  ' + e.message); fs.writeFileSync(P, cs.includes('platform:') ? cs : cs, 'utf8'); bad = true; problems.push('syntax-cjService'); }
try { new vm.Script(sv, { filename: 'server.js' }); console.log('  OK   server.js'); }
catch (e) { console.log('  BAD  ' + e.message); bad = true; problems.push('syntax-server'); }

console.log('\n========== RESULT ==========');
console.log(problems.length ? '⚠️ PROBLEMS: ' + problems.join(' | ') : '✅ FIXED — commit & push');