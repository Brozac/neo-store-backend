// fix_laclarc.js — Laclarc v2 Auto-Patcher (Node)
// يطبق: القتلة ×3 + fulfillCJOrder v2 + كرون Reconcile + كرون Tracking
//       + notifyShipment موحدة + RECOVER10 + اليتامى + limiter + فحص Syntax
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'C:\\Users\\B512\\Desktop\\DRPS\\backend';
const failures = [];
const warns = [];

function rd(p) { return fs.readFileSync(p, 'utf8'); }
function wr(p, t) { fs.writeFileSync(p, t, 'utf8'); }
function ok(n) { console.log('OK   ' + n); }
function skip(n) { console.log('SKIP ' + n + ' (already applied)'); }
function fail(n) { console.log('FAIL ' + n + '  <-- ANCHOR NOT FOUND'); failures.push(n); }
function warn(n) { console.log('WARN ' + n); warns.push(n); }

// exact replace with occurrence report (function-replacement => no $-patterns traps)
function repExact(txt, find, repl, name) {
  if (txt.includes(repl)) { skip(name); return txt; }
  const c = txt.split(find).length - 1;
  if (c === 0) { fail(name); return txt; }
  ok(name + ' [x' + c + ']');
  return txt.split(find).join(repl);
}
function repRx(txt, rx, repl, name) {
  if (!rx.global) { /* single */ }
  const m = txt.match(new RegExp(rx.source, rx.flags.replace('g', '')));
  if (m && txt.includes(repl)) { skip(name); return txt; }
  const rxg = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
  let n = 0;
  const out = txt.replace(rxg, function () { n++; return repl; });
  if (n === 0) { fail(name); return txt; }
  ok(name + ' [x' + n + ']');
  return out;
}
function repCountedExact(txt, find, repl, name, expected) {
  const c = txt.split(find).length - 1;
  if (c === 0 && txt.includes(repl)) { skip(name); return txt; }
  if (c !== expected) { warn(name + ' found x' + c + ' expected x' + expected + ' -> skipped'); return txt; }
  ok(name);
  return txt.split(find).join(repl);
}
function sliceBetween(txt, startAnchor, endAnchor, repl, name) {
  const s = txt.indexOf(startAnchor);
  if (s === -1) {
    if (txt.includes(repl.slice(0, 60))) { skip(name); return txt; }
    fail(name + ' (start)'); return txt;
  }
  const e = txt.indexOf(endAnchor, s + startAnchor.length);
  if (e === -1) { fail(name + ' (end)'); return txt; }
  if (txt.slice(s, s + 60) === repl.slice(0, 60)) { skip(name); return txt; }
  ok(name);
  return txt.slice(0, s) + repl + txt.slice(e);
}

// ============ [1] BACKUPS ============
const FILES = {
  server: path.join(ROOT, 'server.js'),
  pc: path.join(ROOT, 'controllers', 'paymentController.js'),
  cs: path.join(ROOT, 'services', 'cjService.js'),
  cw: path.join(ROOT, 'services', 'cjWebhookService.js'),
  wa: path.join(ROOT, 'services', 'whatsappService.js'),
};
for (const k of ['server', 'pc', 'cs', 'cw']) {
  fs.copyFileSync(FILES[k], FILES[k] + '.bak-v2');
}
console.log('[1] backups done (.bak-v2)\n');

// ============ [2] detect WhatsApp signature ============
const waSrc = rd(FILES.wa);
const sigM = waSrc.match(/sendOrderTrackingWhatsApp\s*=?\s*(?:async\s+)?(?:function)?\s*\(([\s\S]{0,120}?)\)\s*(?:=>)?\s*\{/)
  || waSrc.match(/function\s+sendOrderTrackingWhatsApp\s*\(([\s\S]{0,120}?)\)\s*\{/);
const isObj = sigM ? /^\s*\{/.test(sigM[1]) : false;
console.log('[2] WhatsApp signature = ' + (isObj ? 'OBJECT ({ phone, ... })' : 'POSITIONAL (phone, name, id, track)') + (sigM ? '' : '  (NOT DETECTED - assuming positional)') + '\n');
const WA_OBJ = "await sendOrderTrackingWhatsApp({ phone: order.customer_phone, customerName: order.customer_name, orderId: order.id, trackingNumber: trackNumber, email: order.customer_email });";
const WA_POS = "await sendOrderTrackingWhatsApp(order.customer_phone, order.customer_name, order.id, trackNumber);";
const WA_CALL = isObj ? WA_OBJ : WA_POS;

// ============ [3] cjService.js : fulfillCJOrder v2 ============
{
  let cs = rd(FILES.cs);
  if (cs.includes('function extractCjNumber')) {
    skip('[3] fulfillCJOrder v2');
  } else {
    const FN_V2 = `async function fulfillCJOrder(orderId, customerName, customerDetails, items) {
  const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
  let cjCreated = false; // fatal catch: no 'manual' unless nothing reached CJ
  try {
    const addr = customerDetails?.address || {};
    const isSandbox = process.env.CJ_SANDBOX_MODE === 'true' ? 1 : 0;

    let safeCustomerName = (customerName || '').trim();
    if (!safeCustomerName || safeCustomerName.toLowerCase() === 'guest customer' || !safeCustomerName.includes(' ')) {
      safeCustomerName = safeCustomerName ? safeCustomerName + ' Customer' : 'Valued Customer';
    }
    const safeEmail = (customerDetails?.email || '').trim() || 'orders@laclarc.com';

    const cjProducts = [];
    for (const item of items) {
      let vid = item.vid;
      if (!vid && item.product_id) {
        const res = await pool.query('SELECT variants FROM products WHERE id = $1', [item.product_id]);
        if (res.rows.length > 0 && res.rows[0].variants) {
          const variants = typeof res.rows[0].variants === 'string' ? JSON.parse(res.rows[0].variants) : res.rows[0].variants;
          if (Array.isArray(variants) && variants.length > 0) vid = variants[0].vid;
        }
      }
      if (vid) {
        cjProducts.push({
          vid: vid,
          quantity: item.quantity || 1,
          storeLineItemId: item.id ? String(item.id) : 'item-' + orderId + '-' + cjProducts.length
        });
      }
    }
    if (cjProducts.length === 0) {
      console.warn('[CJ] Order #' + orderId + ' has no valid CJ variants. Marked manual.');
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
      return { success: false, reason: 'NO_CJ_VARIANTS' };
    }

    let logisticsToTry = [];
    try {
      const freightRes = await cjRequest((token) =>
        axios.post(CJ_API + '/logistic/freightCalculate', {
          startCountryCode: 'CN',
          endCountryCode: addr.country || 'US',
          products: cjProducts.map(function (p) { return { vid: p.vid, quantity: p.quantity }; })
        }, { headers: { 'CJ-Access-Token': token } })
      );
      if (freightRes.data.code === 200 && freightRes.data.data?.length > 0) {
        logisticsToTry = freightRes.data.data.sort(function (a, b) { return a.logisticPrice - b.logisticPrice; }).map(function (l) { return l.logisticName; });
      }
    } catch (e) {}
    logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Ordinary', 'CJPacket Sensitive', 'YunExpress', '4PX'])];

    let orderSuccess = false, lastError = null, needsSplitting = false, successfulCJOrderNumber = null;

    let safeLine1 = (addr.line1 || 'Main Street 1').trim();
    if (!/\\d/.test(safeLine1)) safeLine1 += ' 1';

    const basePayload = {
      shippingCustomerName: safeCustomerName,
      shippingCountry: addr.country || 'United States',
      shippingCountryCode: addr.country || 'US',
      shippingProvince: addr.state || addr.city || 'State',
      shippingCity: addr.city || 'City',
      shippingAddress: safeLine1,
      shippingAddress2: addr.line2 || '',
      shippingZip: addr.postal_code || '10001',
      shippingPhone: customerDetails?.phone || '1234567890',
      email: safeEmail,
      fromCountryCode: 'CN',
      orderFlow: 1,
      shopLogisticsType: 3,
      isSandbox: isSandbox
    };

    function extractCjNumber(dataObj) {
      const d = dataObj || {};
      return d.orderNumber || d.cjOrderId || d.orderId || d.cjOrderNumber || null;
    }
    function sampleOnce(tag, obj) {
      const key = '_cjSample_' + tag;
      if (!global[key]) { global[key] = true; console.log('[Sample ' + tag + ']', JSON.stringify(obj || {}).slice(0, 600)); }
    }
    async function saveCjNumber(num) {
      if (!num) return;
      await pool.query("UPDATE orders SET cj_order_number = COALESCE(NULLIF(cj_order_number,''), NULLIF($1,'')) WHERE id = $2", [String(num), orderId]).catch(function () {});
    }

    // 1) batch attempt
    for (const logisticName of logisticsToTry) {
      const targetOrderNumber = 'STORE-' + orderId;
      const cjOrderPayload = Object.assign({}, basePayload, { orderNumber: targetOrderNumber, logisticName: logisticName, products: cjProducts });
      try {
        await new Promise(function (r) { setTimeout(r, 1200); });
        const cjResponse = await cjRequest((token) =>
          axios.post(CJ_API + '/shopping/order/createOrderV3', cjOrderPayload,
            { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
        );
        if (cjResponse.data.code === 200) {
          console.log('[CJ] Order #' + orderId + ' sent via V3 (' + logisticName + ')');
          orderSuccess = true; cjCreated = true;
          sampleOnce('V3-Create', cjResponse.data?.data);
          successfulCJOrderNumber = extractCjNumber(cjResponse.data?.data) || targetOrderNumber;
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }
        lastError = cjResponse.data;

        if (lastError.code === 1603000 || (lastError.message || '').includes('100230')) {
          console.log('[CJ] Order #' + orderId + ' needs Auto-Split');
          needsSplitting = true; break;
        }
        if (lastError.code === 1603003) {
          console.log('[CJ] Order #' + orderId + ' already exists - logical success');
          orderSuccess = true; cjCreated = true;
          successfulCJOrderNumber = targetOrderNumber;
          try {
            await new Promise(function (r) { setTimeout(r, 1200); });
            const detail = await cjRequest((token) =>
              axios.get(CJ_API + '/shopping/order/getOrderDetail', {
                params: { orderNumber: targetOrderNumber },
                headers: { 'CJ-Access-Token': token }
              })
            );
            const dd = detail.data?.data || {};
            sampleOnce('OrderDetail', dd);
            const realCj = extractCjNumber(dd) || extractCjNumber(dd.orderInfo);
            if (realCj && realCj !== targetOrderNumber) {
              successfulCJOrderNumber = realCj;
              console.log('[CJ] #' + orderId + ' real CJ number: ' + realCj);
            }
          } catch (e) {
            console.warn('[CJ] could not fetch real CJ number for #' + orderId + ':', (e.response?.data && e.response.data.message) || e.message);
          }
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }
        if (lastError.code === 1605001) {
          console.warn('[CJ] #' + orderId + ' empty wallet - retry orderFlow=0');
          try {
            await new Promise(function (r) { setTimeout(r, 1200); });
            const retry = await cjRequest((token) =>
              axios.post(CJ_API + '/shopping/order/createOrderV3',
                Object.assign({}, cjOrderPayload, { orderFlow: 0 }),
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
            );
            if (retry.data.code === 200) {
              orderSuccess = true; cjCreated = true;
              successfulCJOrderNumber = extractCjNumber(retry.data?.data) || targetOrderNumber;
              await saveCjNumber(successfulCJOrderNumber);
              console.log('[CJ] #' + orderId + ' registered orderFlow=0 - top up wallet to ship');
            }
          } catch (e) {}
          break;
        }
        if (lastError.code === 1600200) break;
      } catch (err) {
        if (err.response?.data?.code === 1603003) {
          console.log('[CJ] Order #' + orderId + ' already exists (exception) - success');
          orderSuccess = true; cjCreated = true;
          successfulCJOrderNumber = targetOrderNumber;
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }
        lastError = (err.response && err.response.data) || err.message;
      }
    }

    // 2) auto-split
    if (!orderSuccess && needsSplitting) {
      console.log('[CJ] Auto-Split V3 for Order #' + orderId);
      let successfulSplits = 0;
      const splitOrdersCreated = [];
      for (let i = 0; i < cjProducts.length; i++) {
        const product = cjProducts[i];
        let itemSuccess = false;
        for (const logisticName of logisticsToTry) {
          const splitOrderNum = 'STORE-' + orderId + '-S' + (i + 1);
          const splitPayload = Object.assign({}, basePayload, { orderNumber: splitOrderNum, logisticName: logisticName, products: [product] });
          try {
            await new Promise(function (r) { setTimeout(r, 1200); });
            const splitRes = await cjRequest((token) =>
              axios.post(CJ_API + '/shopping/order/createOrderV3', splitPayload,
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
            );
            if (splitRes.data.code === 200) {
              console.log('[CJ] Split ' + (i + 1) + '/' + cjProducts.length + ' via ' + logisticName);
              itemSuccess = true; successfulSplits++; splitOrdersCreated.push(splitOrderNum); cjCreated = true;
              const splitCj = extractCjNumber(splitRes.data?.data);
              if (splitCj && splitCj !== splitOrderNum) await saveCjNumber(splitCj);
              break;
            }
            if (splitRes.data.code === 1603003) {
              console.log('[CJ] Split ' + splitOrderNum + ' already exists (body)');
              itemSuccess = true; successfulSplits++; splitOrdersCreated.push(splitOrderNum); cjCreated = true;
              break;
            }
          } catch (err) {
            if (err.response?.data?.code === 1603003) {
              console.log('[CJ] Split ' + splitOrderNum + ' already exists (exception)');
              itemSuccess = true; successfulSplits++; splitOrdersCreated.push(splitOrderNum); cjCreated = true;
              break;
            }
          }
        }
      }
      if (successfulSplits === cjProducts.length) {
        console.log('[CJ] All ' + successfulSplits + ' splits succeeded for #' + orderId);
        orderSuccess = true;
        successfulCJOrderNumber = splitOrdersCreated.join(', ');
      } else if (successfulSplits > 0) {
        console.error('[CJ] PARTIAL fulfillment #' + orderId + ': ' + successfulSplits + '/' + cjProducts.length);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
        try {
          const pc = require('../controllers/paymentController');
          if (pc.sendEmail) pc.sendEmail({
            to: process.env.BREVO_USER,
            subject: 'CJ Partial Fulfillment - Order #' + orderId + ' (' + successfulSplits + '/' + cjProducts.length + ')',
            html: '<p>Splits OK: <code>' + splitOrdersCreated.join(', ') + '</code></p><p>Complete missing items in CJ dashboard.</p>'
          }).catch(function () {});
        } catch (e) {}
        return { success: false, partial: true, error: 'Partial fulfillment' };
      }
    }

    // 3) final - stays 'paid'; SHIPPED webhook raises status + sends WhatsApp/email
    if (orderSuccess) {
      await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1 AND status IN ('pending','processing')", [orderId]);
      console.log('[CJ] #' + orderId + ' accepted (' + successfulCJOrderNumber + ') - waiting for ORDER/SHIPPED webhook');
      return { success: true, orderNumber: successfulCJOrderNumber };
    }
    console.error('[CJ] Fulfillment FAILED for #' + orderId, lastError);
    await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
    return { success: false, error: lastError };
  } catch (err) {
    logger.logError('CJ Fulfillment Fatal Error #' + orderId, err);
    if (!cjCreated) {
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]).catch(function () {});
    }
    return { success: false, error: err.message };
  }
}`;
    const start = cs.indexOf('async function fulfillCJOrder(orderId, customerName, customerDetails, items)');
    if (start === -1) { fail('[3] fulfillCJOrder (start anchor)'); }
    else {
      const eol = cs.includes('\r\n') ? '\r\n' : '\n';
      const endMarker = 'return { success: false, error: err.message };' + eol + '  }' + eol + '}';
      let end = cs.indexOf(endMarker, start);
      if (end === -1) {
        const ret = cs.indexOf('return { success: false, error: err.message };', start);
        end = ret === -1 ? -1 : cs.indexOf('}', cs.indexOf('}', ret) + 1) + 1;
      }
      if (end === -1) { fail('[3] fulfillCJOrder (end anchor)'); }
      else { cs = cs.slice(0, start) + FN_V2 + cs.slice(end + endMarker.length); ok('[3] fulfillCJOrder v2'); }
    }
  }
  wr(FILES.cs, cs);
}

// ============ [4] cjWebhookService.js ============
{
  let cw = rd(FILES.cw);
  if (!/function notifyShipment/.test(cw)) {
    const NS = '\n// Unified shipment notification (webhook + tracking cron)\nasync function notifyShipment(order, trackNumber, logisticName) {\n  try {\n    ' + WA_CALL + '\n  } catch (waErr) { logger.logError("Webhook WhatsApp Notification", waErr); }\n  if (order.customer_email && String(order.customer_email).indexOf("@laclarc.com") === -1) {\n    try {\n      const itemsRes = await pool.query("SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1", [order.id]);\n      const { sendOrderConfirmationEmail } = require("../controllers/paymentController");\n      await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, itemsRes.rows);\n    } catch (mailErr) { logger.logError("Webhook Tracking Email", mailErr); }\n  }\n}\n\n';
    const idx = cw.indexOf('module.exports');
    if (idx === -1) { fail('[4a] notifyShipment inject (no module.exports)'); }
    else { cw = cw.slice(0, idx) + NS + cw.slice(idx); ok('[4a] notifyShipment injected'); }
  } else {
    skip('[4a] notifyShipment exists');
    // unify WA call form with detected signature
    if (isObj) cw = repExact(cw, WA_POS, WA_OBJ, '[4b] WA call -> object form');
  }
  if (/module\.exports\s*=\s*\{[^}]*notifyShipment/.test(cw)) skip('[4c] export notifyShipment');
  else cw = repExact(cw,
    'module.exports = { cjWebhookHandler, registerWebhooks, subscribeAllStoreProducts };',
    'module.exports = { cjWebhookHandler, registerWebhooks, subscribeAllStoreProducts, notifyShipment };',
    '[4c] export notifyShipment');
  wr(FILES.cw, cw);
}

// ============ [5] paymentController.js ============
{
  let pc = rd(FILES.pc);
  const rxBlock = /if \(cjResponse && cjResponse\.success\) \{\s*await pool\.query\("UPDATE orders SET status = 'completed' WHERE id = \$1", \[(orderId|order\.id)\]\);\s*\}/g;
  let n = 0;
  pc = pc.replace(rxBlock, function (mm, v) {
    n++;
    return 'if (cjResponse && cjResponse.success) {\n            console.log("[Crypto] #' + v + ' accepted by CJ (" + cjResponse.orderNumber + ") - waiting for SHIPPED webhook");\n          }';
  });
  if (n > 0) ok('[5] crypto killers replaced [x' + n + '] (expected 3)');
  else {
    const rxInner = /await pool\.query\("UPDATE orders SET status = 'completed' WHERE id = \$1", \[(orderId|order\.id)\]\);/g;
    let m = 0;
    pc = pc.replace(rxInner, function (mm, v) { m++; return 'console.log("[Crypto] #' + v + ' accepted by CJ - waiting for SHIPPED webhook");'; });
    if (m > 0) ok('[5-fallback] crypto killer inner lines [x' + m + ']');
    else fail('[5] crypto killers (paymentController)');
  }
  wr(FILES.pc, pc);
}

// ============ [6] server.js ============
{
  let sv = rd(FILES.server);

  // 6.1 import sendOrderConfirmationEmail (guarded)
  if (sv.includes('sendOrderConfirmationEmail')) {
    const hasDef = /function\s+sendOrderConfirmationEmail|sendOrderConfirmationEmail\s*=\s*(async\s*)?\(/.test(sv);
    const hasImp = /\{\s*sendOrderConfirmationEmail\s*\}\s*=\s*require/.test(sv);
    if (hasDef || hasImp) skip('[6.1] email fn already available');
    else sv = repExact(sv,
      "const paymentRoutes = require('./controllers/paymentController');",
      "const paymentRoutes = require('./controllers/paymentController');\nconst { sendOrderConfirmationEmail } = require('./controllers/paymentController');",
      '[6.1] import sendOrderConfirmationEmail');
  } else warn('[6.1] sendOrderConfirmationEmail not found anywhere?!');

  // 6.2 require notifyShipment
  sv = repExact(sv,
    "const { cjWebhookHandler } = require('./services/cjWebhookService');",
    "const { cjWebhookHandler, notifyShipment } = require('./services/cjWebhookService');",
    '[6.2] require notifyShipment');

  // 6.3 trackLimiter
  sv = repRx(sv, /^const ALL_WORLD_COUNTRIES/m,
    "const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many tracking requests.' } });\nconst ALL_WORLD_COUNTRIES",
    '[6.3] trackLimiter');

  // 6.4 Stripe WH orderId guard
  sv = repRx(sv, /const orderId = session\.metadata\?\.orderId;\s*if \(!orderId\) return;/,
    "const orderId = parseInt(session.metadata?.orderId, 10);\n    if (!Number.isFinite(orderId)) return;",
    '[6.4] Stripe WH orderId guard');

  // 6.5 killer #1
  sv = repRx(sv, /if \(cjResponse && cjResponse\.success\) \{\s*await pool\.query\("UPDATE orders SET status = 'completed' WHERE id = \$1", \[orderId\]\);\s*\}/,
    'if (cjResponse && cjResponse.success) {\n          console.log("[Stripe WH] #" + orderId + " accepted by CJ (" + cjResponse.orderNumber + ") - waiting for SHIPPED webhook");\n        } else {\n          console.error("[Stripe WH] CJ fulfillment failed for #" + orderId + " (marked manual)");\n        }',
    '[6.5] killer #1 (Stripe WH)');

  // 6.6 RECOVER10 seed
  sv = repRx(sv, /Recovery coupon LACLARC10 ensured in DB\./,
    "Recovery coupon LACLARC10 ensured in DB.');\n\n    // RECOVER10 - abandoned-cart emails promise it (was missing in DB!)\n    await pool.query(\"INSERT INTO coupons (code, discount_type, discount_value, is_active) VALUES ('RECOVER10', 'percentage', 10, true) ON CONFLICT (code) DO NOTHING\");\n    console.log('[coupons] RECOVER10 ensured",
    '[6.6] seed RECOVER10');

  // 6.7 QPS unify
  sv = repExact(sv, 'setTimeout(r, 1000)', 'setTimeout(r, 1200)', '[6.7] QPS 1200ms');

  // 6.8 killer #2 - BaridiMob route (slice)
  const BARIDI = `app.put('/api/admin/manual-orders/approve/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' });

    // v2: atomic lock - pending->paid only (double click = 409)
    const updateRes = await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING *", [id]);
    if (updateRes.rows.length === 0) {
      const exists = await pool.query('SELECT status FROM orders WHERE id = $1', [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      return res.status(409).json({ error: "Order is '" + exists.rows[0].status + "' - already processed" });
    }
    const order = updateRes.rows[0];

    res.json({ message: 'Order approved. Sending to CJ in background...' });

    (async () => {
      try {
        const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
        const items = itemsRes.rows;

        let parsedAddress = {};
        try { parsedAddress = JSON.parse(order.shipping_address); }
        catch (e) { parsedAddress = { line1: order.shipping_address, country: 'DZ' }; }

        const customerDetails = {
          address: parsedAddress,
          phone: order.customer_phone,
          email: order.customer_email || '',
          name: order.customer_name
        };

        const cjResponse = await fulfillCJOrder(order.id, order.customer_name, customerDetails, items);

        // v2 - no 'completed': stays paid; SHIPPED webhook raises + notifies
        if (cjResponse && cjResponse.success) {
          console.log('[BaridiMob] #' + id + ' accepted by CJ (' + cjResponse.orderNumber + ') - waiting for SHIPPED webhook');
        } else {
          console.error('[BaridiMob] CJ fulfillment failed for #' + id + ' (marked manual)');
        }

        if (order.customer_email) {
          const emailItemsRes = await pool.query('SELECT oi.quantity, oi.price_at_purchase, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1', [id]);
          await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, emailItemsRes.rows);
        }
      } catch (bgErr) {
        logger.logError('Approve BaridiMob Order (Background)', bgErr);
      }
    })();
  } catch (err) {
    logger.logError('Approve BaridiMob Order', err);
    res.status(500).json({ error: 'Server error' });
  }
});

`;
  sv = sliceBetween(sv,
    "app.put('/api/admin/manual-orders/approve/:id'",
    "app.put('/api/admin/manual-orders/reject/:id'",
    BARIDI, '[6.8] killer #2 (BaridiMob approve)');

  // 6.9 orphan order cleanup
  sv = repExact(sv,
    "app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {",
    "app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {\n  let orderId = null; // orphan cleanup anchor",
    '[6.9a] orphan: declare orderId');
  sv = repExact(sv, 'const orderId = orderResult.rows[0].id;', 'orderId = orderResult.rows[0].id;', '[6.9b] orphan: assign orderId');
  sv = repRx(sv, /\} catch \(err\) \{\s*logger\.logError\('Create Checkout Session', err\);\s*res\.status\(500\)\.json\(\{ error: err\.message \}\);\s*\}/,
    "} catch (err) {\n    if (orderId) {\n      await pool.query(\"UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'\", [orderId]).catch(() => {});\n    }\n    logger.logError('Create Checkout Session', err);\n    res.status(500).json({ error: err.message });\n  }",
    '[6.9c] orphan: cleanup catch');

  // 6.10 track limiter on public route
  sv = repExact(sv, "app.get('/api/track/:trackNumber', async (req, res) => {",
    "app.get('/api/track/:trackNumber', trackLimiter, async (req, res) => {",
    '[6.10] track route limiter');

  // 6.11 killer #3 - Reconcile cron (slice to '// 7.')
  const RECONCILE = `cron.schedule('*/15 * * * *', async () => {
  if (isReconciling) return;
  isReconciling = true;
  try {
    const query = "SELECT id, stripe_session_id, total_amount FROM orders WHERE payment_method = 'Stripe' AND status IN ('paid', 'reconciling') AND stripe_session_id IS NOT NULL AND (cj_order_number IS NULL OR cj_order_number = '') AND created_at <= NOW() - INTERVAL '10 minutes' LIMIT 15";
    const { rows: pendingOrders } = await pool.query(query);
    if (pendingOrders.length > 0) {
      console.log('[Reconcile v2] ' + pendingOrders.length + ' order(s) not yet in CJ - retrying...');
    }
    for (const order of pendingOrders) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
        if (session.payment_status === 'paid') {
          console.log('[Reconcile] Order ' + order.id + ' confirmed paid. Sending to CJ...');
          const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
          const fullOrder = orderRes.rows[0];
          const itemsRes = await pool.query('SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1', [order.id]);
          const items = itemsRes.rows;
          let parsedAddress = {};
          try { parsedAddress = JSON.parse(fullOrder.shipping_address); }
          catch (e) { parsedAddress = { line1: fullOrder.shipping_address, country: 'US' }; }
          const customerDetails = {
            address: parsedAddress,
            phone: fullOrder.customer_phone || '0000000000',
            email: fullOrder.customer_email || '',
            name: fullOrder.customer_name
          };
          const cjResponse = await fulfillCJOrder(order.id, fullOrder.customer_name, customerDetails, items);
          if (cjResponse && cjResponse.success) {
            console.log('[Reconcile] #' + order.id + ' accepted by CJ (' + cjResponse.orderNumber + ') - stays paid');
            if (fullOrder.customer_email) {
              sendOrderConfirmationEmail(fullOrder.customer_email, order.id, fullOrder.total_amount, items)
                .catch(function (err) { logger.logError('Reconcile Email', err); });
            }
          } else {
            await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [order.id]);
          }
        } else {
          const upd = await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status IN ('paid','reconciling') AND (cj_order_number IS NULL OR cj_order_number = '') RETURNING id", [order.id]);
          if (upd.rows.length) console.log('[Reconcile] Order ' + order.id + ' unpaid in Stripe. Cancelled.');
        }
      } catch (error) {
        logger.logError('Stripe Reconcile Order #' + order.id, error);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [order.id]);
      }
      await new Promise(function (resolve) { setTimeout(resolve, 1000); });
    }
    // legacy cleanup: stuck 'reconciling' from old version -> paid
    await pool.query("UPDATE orders SET status = 'paid' WHERE status = 'reconciling' AND (cj_order_number IS NULL OR cj_order_number = '') AND (tracking_number IS NULL OR tracking_number = '')");
  } catch (error) {
    logger.logError('Stripe Reconcile Cron Fatal', error);
  } finally {
    isReconciling = false;
  }
});

`;
  sv = sliceBetween(sv, "cron.schedule('*/15", '// 7.', RECONCILE, '[6.11] killer #3 (Reconcile v2)');

  // 6.12 Tracking cron - targeted patches
  sv = repExact(sv,
    'SELECT id, customer_name, customer_email, customer_phone, shipping_address, total_amount',
    'SELECT id, customer_name, customer_email, customer_phone, shipping_address, total_amount, cj_order_number',
    '[6.12a] tracking SELECT + cj_order_number');
  sv = repExact(sv,
    "WHERE (status = 'paid' OR status = 'completed')",
    "WHERE status IN ('paid', 'fulfilled')",
    '[6.12b] tracking WHERE v2');
  sv = repRx(sv,
    /const orderInfoRes = await cjRequest\(\(token\) =>\s*axios\.post\(\s*'https:\/\/developers\.cjdropshipping\.com\/api2\.0\/v1\/shopping\/order\/getOrderDetail',\s*\{ orderNumber: `STORE-\$\{order\.id\}` \},\s*\{ headers: \{ 'CJ-Access-Token': token, 'Content-Type': 'application\/json' \} \}\s*\)\s*\);/,
    "const stored = String(order.cj_order_number || '').trim();\n        const cjNum = (stored || ('STORE-' + order.id)).split(',')[0].trim();\n        const orderInfoRes = await cjRequest((token) =>\n          axios.get(\n            'https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail',\n            { params: { orderNumber: cjNum }, headers: { 'CJ-Access-Token': token } }\n          )\n        );",
    '[6.12c] tracking POST->GET + cjNum');
  sv = repExact(sv,
    'const trackNumber = cjData?.trackNumber || cjData?.trackingNumber;',
    "if (!global._cjSample_OrderDetail) {\n          global._cjSample_OrderDetail = true;\n          console.log('[Sample OrderDetail REST]', JSON.stringify(cjData).slice(0, 800));\n        }\n        const info = cjData.orderInfo || cjData;\n        const cjStatus = String(info.orderStatus || info.status || '').toUpperCase();\n        if (cjStatus !== 'SHIPPED' && cjStatus !== 'DISPATCHED') continue;\n        const trackNumber = info.logisticsShipmentNumber || info.trackNumber || info.trackingNumber\n          || (Array.isArray(cjData.products)\n            ? cjData.products.map(function (p) { return p.logisticsShipmentNumber || p.trackNumber || p.trackingNumber; }).find(Boolean)\n            : null);",
    '[6.12d] tracking extraction v2 + REST sample');
  sv = repRx(sv,
    /await pool\.query\(\s*"UPDATE orders SET tracking_number = \$1, status = 'fulfilled' WHERE id = \$2",\s*\[trackNumber\.trim\(\), order\.id\]\s*\);/,
    "const upd = await pool.query(\n            \"UPDATE orders SET tracking_number = $1, status = 'fulfilled', cj_order_number = COALESCE(NULLIF(cj_order_number,''), $3) WHERE id = $2 AND status IN ('paid','fulfilled') AND (tracking_number IS NULL OR tracking_number = '') RETURNING id\",\n            [trackNumber.trim(), order.id, cjNum]\n          );\n          if (!upd.rows.length) continue; // webhook won the race - already notified\n          await notifyShipment(order, trackNumber.trim(), info.logisticName);",
    '[6.12e] tracking UPDATE guards + notifyShipment');
  // disable old notify blocks inside tracking cron (they are now unified in notifyShipment)
  sv = repCountedExact(sv, 'if (order.customer_phone) {', 'if (false) { // [v2] disabled - notifyShipment unified', '[6.12f] disable old WA block', 1);
  sv = repCountedExact(sv, "if (order.customer_email && !order.customer_email.includes('@laclarc.com')) {", 'if (false) { // [v2] disabled - notifyShipment unified', '[6.12g] disable old email block', 1);

  wr(FILES.server, sv);
}

// ============ [7] Syntax check (vm compile) + auto-restore on failure ============
console.log('\n[7] syntax check:');
let syntaxBad = false;
for (const k of ['server', 'pc', 'cs', 'cw']) {
  try { new vm.Script(rd(FILES[k]), { filename: FILES[k] }); console.log('  OK   ' + path.basename(FILES[k])); }
  catch (e) {
    console.log('  BAD  ' + path.basename(FILES[k]) + ' -> ' + e.message);
    fs.copyFileSync(FILES[k] + '.bak-v2', FILES[k]);
    console.log('       restored from .bak-v2');
    syntaxBad = true;
  }
}

// ============ [8] Final verification ============
console.log('\n[8] verification:');
const svF = rd(FILES.server), pcF = rd(FILES.pc), csF = rd(FILES.cs), cwF = rd(FILES.cw);
const killers = (svF.match(/status = 'completed' WHERE id/g) || []).length
  + (pcF.match(/status = 'completed' WHERE id/g) || []).length;
console.log('  remaining killers (expect 0): ' + killers);
const gets = (svF.match(/axios\.get\(\s*'https:\/\/developers\.cjdropshipping\.com\/api2\.0\/v1\/shopping\/order\/getOrderDetail/g) || []).length
  + (csF.match(/axios\.get\('https:\/\/developers\.cjdropshipping\.com\/api2\.0\/v1\/shopping\/order\/getOrderDetail/g) || []).length;
const posts = (svF.match(/axios\.post\(\s*'https:\/\/developers\.cjdropshipping\.com\/api2\.0\/v1\/shopping\/order\/getOrderDetail/g) || []).length;
console.log('  getOrderDetail GET (expect 2): ' + gets + ' | POST (expect 0): ' + posts);
console.log('  notifyShipment refs (expect >=4): '
  + (svF.match(/notifyShipment/g) || []).length + ' server, '
  + (cwF.match(/notifyShipment/g) || []).length + ' webhook');
console.log('  saveCjNumber in cjService: ' + ((csF.match(/saveCjNumber/g) || []).length > 0 ? 'YES' : 'NO'));

// ============ SUMMARY ============
console.log('\n========== SUMMARY ==========');
if (syntaxBad || failures.length > 0) {
  console.log('RESULT: DO NOT DEPLOY');
  if (failures.length) console.log('failed patches: ' + failures.join(' | '));
  console.log('-> copy this ENTIRE output and send it back.');
} else {
  console.log('RESULT: ALL PATCHES APPLIED ✔');
  if (warns.length) console.log('warnings: ' + warns.join(' | '));
  console.log('NEXT: git add -A && git commit -m "v2 order lifecycle" && git push');
  console.log('Then: place a REAL test order and watch Render logs for:');
  console.log('  [Sample V3-Create] -> [CJ] accepted -> [Sample ORDER] -> SHIPPED -> WhatsApp');
}