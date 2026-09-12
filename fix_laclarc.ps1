# ============================================================
# fix_laclarc.ps1 — Laclarc v2 Auto-Patcher
# يطبق: 3 قتلة + كرون Reconcile + كرون Tracking + fulfillCJOrder v2
#       + اليتامى + RECOVER10 + limiter + التوقيع الذكي للواتساب
# ============================================================
 $ErrorActionPreference = 'Stop'
 $root = "C:\Users\B512\Desktop\DRPS\backend"
 $script:failures = @()

function Read-Utf8([string]$p) { [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) }
function Write-Utf8([string]$p, [string]$t) { [IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false))) }

function Replace-Exact([string]$text, [string]$find, [string]$repl, [string]$name) {
  if ($text.Contains($repl)) { Write-Host "SKIP  $name  (déjà appliqué)"; return $text }
  if (-not $text.Contains($find)) { Write-Host "FAIL  $name  (ancre introuvable !)"; $script:failures += $name; return $text }
  Write-Host "OK    $name"
  return $text.Replace($find, $repl)
}
function Replace-Rx([string]$text, [string]$pattern, [string]$repl, [string]$name) {
  if ($text.Contains($repl)) { Write-Host "SKIP  $name  (déjà appliqué)"; return $text }
  $rx = New-Object System.Text.RegularExpressions.Regex($pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if (-not $rx.IsMatch($text)) { Write-Host "FAIL  $name  (ancre introuvable !)"; $script:failures += $name; return $text }
  Write-Host "OK    $name"
  return $rx.Replace($text, { param($m) $repl })
}

# ---------- [0] Backup ----------
foreach ($f in @('server.js','controllers\paymentController.js','services\cjService.js','services\cjWebhookService.js')) {
  Copy-Item (Join-Path $root $f) ("{0}.bak" -f (Join-Path $root $f)) -Force
}
Write-Host "=== [0] Backups OK (.bak) ===`n"

# ---------- [1] كشف توقيع الواتساب ----------
 $waPath = Join-Path $root 'services\whatsappService.js'
 $wa = Read-Utf8 $waPath
 $mw = [regex]::Match($wa, 'sendOrderTrackingWhatsApp\s*=?\s*(?:async\s+)?function\s*\(|sendOrderTrackingWhatsApp\s*=\s*(?:async\s*)?\(|function\s+sendOrderTrackingWhatsApp\s*\(')
 $after = ''
if ($mw.Success) { $after = $wa.Substring($mw.Index + $mw.Length).TrimStart() }
 $isObj = $after.StartsWith('{')
Write-Host ("=== [1] whatsappService: signature = {0} ===`n" -f $(if ($isObj) {'OBJECT ({ phone, ... })'} else {'POSITIONAL (phone, name, id, track)'}))

# ---------- [2] cjService.js — fulfillCJOrder v2 ----------
 $csPath = Join-Path $root 'services\cjService.js'
 $cs = Read-Utf8 $csPath

 $fnV2 = @'
async function fulfillCJOrder(orderId, customerName, customerDetails, items) {
  const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
  let cjCreated = false; // الـ fatal catch ما كيديرش manual إلا إلا ما وصل حتى إرسال لـ CJ
  try {
    const addr = customerDetails?.address || {};
    const isSandbox = process.env.CJ_SANDBOX_MODE === 'true' ? 1 : 0;

    let safeCustomerName = (customerName || '').trim();
    if (!safeCustomerName || safeCustomerName.toLowerCase() === 'guest customer' || !safeCustomerName.includes(' ')) {
      safeCustomerName = safeCustomerName ? `${safeCustomerName} Customer` : 'Valued Customer';
    }

    // V3 كيطلب إيميل صالح — fallback مؤسسي للطلبات بلا إيميل
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
          vid,
          quantity: item.quantity || 1,
          storeLineItemId: item.id ? String(item.id) : `item-${orderId}-${cjProducts.length}`,
        });
      }
    }

    if (cjProducts.length === 0) {
      console.warn(`⚠️ Order #${orderId} contains no valid CJ variants. Marked as manual.`);
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
      return { success: false, reason: 'NO_CJ_VARIANTS' };
    }

    let logisticsToTry = [];
    try {
      const freightRes = await cjRequest((token) =>
        axios.post(`${CJ_API}/logistic/freightCalculate`, {
          startCountryCode: 'CN',
          endCountryCode: addr.country || 'US',
          products: cjProducts.map(p => ({ vid: p.vid, quantity: p.quantity }))
        }, { headers: { 'CJ-Access-Token': token } })
      );
      if (freightRes.data.code === 200 && freightRes.data.data?.length > 0) {
        logisticsToTry = freightRes.data.data.sort((a, b) => a.logisticPrice - b.logisticPrice).map(l => l.logisticName);
      }
    } catch (e) {}

    logisticsToTry = [...new Set([...logisticsToTry, 'CJPacket Ordinary', 'CJPacket Sensitive', 'YunExpress', '4PX'])];

    let orderSuccess = false;
    let lastError = null;
    let needsSplitting = false;
    let successfulCJOrderNumber = null;

    let safeLine1 = (addr.line1 || 'Main Street 1').trim();
    if (!/\d/.test(safeLine1)) safeLine1 += ' 1';

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
      isSandbox: isSandbox,
    };

    function extractCjNumber(dataObj) {
      const d = dataObj || {};
      return d.orderNumber || d.cjOrderId || d.orderId || d.cjOrderNumber || null;
    }
    function sampleOnce(tag, obj) {
      const key = `_cjSample_${tag}`;
      if (!global[key]) {
        global[key] = true;
        console.log(`🔬 [Sample ${tag}]`, JSON.stringify(obj || {}).slice(0, 600));
      }
    }

    // حفظ آمن — عمرو ما كيطمش BT موجود بـ STORE-x
    async function saveCjNumber(num) {
      if (!num) return;
      await pool.query(
        `UPDATE orders SET cj_order_number = COALESCE(NULLIF(cj_order_number,''), NULLIF($1,'')) WHERE id = $2`,
        [String(num), orderId]
      ).catch(() => {});
    }

    // 1. الإرسال المجمّع
    for (const logisticName of logisticsToTry) {
      const targetOrderNumber = `STORE-${orderId}`;
      const cjOrderPayload = { ...basePayload, orderNumber: targetOrderNumber, logisticName, products: cjProducts };

      try {
        await new Promise(r => setTimeout(r, 1200));
        const cjResponse = await cjRequest((token) =>
          axios.post(`${CJ_API}/shopping/order/createOrderV3`, cjOrderPayload,
            { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
        );

        if (cjResponse.data.code === 200) {
          console.log(`🚀 Order #${orderId} sent to CJ via V3 API (logistic: ${logisticName})!`);
          orderSuccess = true;
          cjCreated = true;
          sampleOnce('V3-Create', cjResponse.data?.data);
          successfulCJOrderNumber = extractCjNumber(cjResponse.data?.data) || targetOrderNumber;
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }

        lastError = cjResponse.data;

        if (lastError.code === 1603000 || (lastError.message || '').includes('100230')) {
          console.log(`⚠️ Order #${orderId} needs Auto-Split (different warehouses)...`);
          needsSplitting = true;
          break;
        }

        // 1603003 = موجود أصلاً — نجاح منطقي + استرجاع BT الحقيقي
        if (lastError.code === 1603003) {
          console.log(`ℹ️ [CJ] Order #${orderId} already exists — logical success.`);
          orderSuccess = true;
          cjCreated = true;
          successfulCJOrderNumber = targetOrderNumber;
          try {
            await new Promise(r => setTimeout(r, 1200));
            const detail = await cjRequest((token) =>
              axios.get(`${CJ_API}/shopping/order/getOrderDetail`, {
                params: { orderNumber: targetOrderNumber },
                headers: { 'CJ-Access-Token': token },
              })
            );
            const dd = detail.data?.data || {};
            sampleOnce('OrderDetail', dd);
            const realCj = extractCjNumber(dd) || extractCjNumber(dd.orderInfo);
            if (realCj && realCj !== targetOrderNumber) {
              successfulCJOrderNumber = realCj;
              console.log(`🔗 [CJ] #${orderId} -> رقم CJ الحقيقي: ${realCj}`);
            }
          } catch (e) {
            console.warn(`⚠️ [CJ] ما قدرناش نجيبو رقم CJ الحقيقي لـ #${orderId}:`, (e.response?.data && e.response.data.message) || e.message);
          }
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }

        // 1605001 = محفظة فارغة -> orderFlow:0 (ينتظر الدفع فـ CJ dashboard)
        if (lastError.code === 1605001) {
          console.warn(`💰 [CJ] #${orderId} محفظة فارغة — محاولة orderFlow:0...`);
          try {
            await new Promise(r => setTimeout(r, 1200));
            const retry = await cjRequest((token) =>
              axios.post(`${CJ_API}/shopping/order/createOrderV3`,
                { ...cjOrderPayload, orderFlow: 0 },
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
            );
            if (retry.data.code === 200) {
              orderSuccess = true;
              cjCreated = true;
              successfulCJOrderNumber = extractCjNumber(retry.data?.data) || targetOrderNumber;
              await saveCjNumber(successfulCJOrderNumber);
              console.log(`✅ [CJ] #${orderId} تسجل بـ orderFlow=0 — عمّر المحفظة باش يمشي`);
            }
          } catch (e) { /* للفشل العادي */ }
          break;
        }

        if (lastError.code === 1600200) break; // QPS — backoff داخل cjRequest
      } catch (err) {
        if (err.response?.data?.code === 1603003) {
          console.log(`ℹ️ [CJ] Order #${orderId} already exists (exception) — success.`);
          orderSuccess = true;
          cjCreated = true;
          successfulCJOrderNumber = targetOrderNumber;
          await saveCjNumber(successfulCJOrderNumber);
          break;
        }
        lastError = (err.response && err.response.data) || err.message;
      }
    }

    // 2. Auto-Split
    if (!orderSuccess && needsSplitting) {
      console.log(`📦 Executing Auto-Split V3 for Order #${orderId}...`);
      let successfulSplits = 0;
      const splitOrdersCreated = [];

      for (let i = 0; i < cjProducts.length; i++) {
        const product = cjProducts[i];
        let itemSuccess = false;

        for (const logisticName of logisticsToTry) {
          const splitOrderNum = `STORE-${orderId}-S${i + 1}`;
          const splitPayload = { ...basePayload, orderNumber: splitOrderNum, logisticName, products: [product] };

          try {
            await new Promise(r => setTimeout(r, 1200));
            const splitRes = await cjRequest((token) =>
              axios.post(`${CJ_API}/shopping/order/createOrderV3`, splitPayload,
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
            );

            if (splitRes.data.code === 200) {
              console.log(`✅ Split [${i + 1}/${cjProducts.length}] sent via ${logisticName}!`);
              itemSuccess = true; successfulSplits++; splitOrdersCreated.push(splitOrderNum); cjCreated = true;
              const splitCj = extractCjNumber(splitRes.data?.data);
              if (splitCj && splitCj !== splitOrderNum) await saveCjNumber(splitCj);
              break;
            }
            if (splitRes.data.code === 1603003) {
              console.log(`ℹ️ [CJ Split] ${splitOrderNum} already exists (body).`);
              itemSuccess = true; successfulSplits++; splitOrdersCreated.push(splitOrderNum); cjCreated = true;
              break;
            }
          } catch (err) {
            if (err.response?.data?.code === 1603003) {
              console.log(`ℹ️ [CJ Split] ${splitOrderNum} already exists (exception).`);
              itemSuccess = true; successfulSplits++; splitOrdersCreated.push(splitOrderNum); cjCreated = true;
              break;
            }
          }
        }
      }

      if (successfulSplits === cjProducts.length) {
        console.log(`🎉 All ${successfulSplits} split shipments succeeded for Order #${orderId}!`);
        orderSuccess = true;
        successfulCJOrderNumber = splitOrdersCreated.join(', ');
      } else if (successfulSplits > 0) {
        console.error(`🚨 Partial fulfillment on Order #${orderId}: ${successfulSplits}/${cjProducts.length} shipped.`);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
        const { sendEmail } = require('../controllers/paymentController');
        sendEmail({
          to: process.env.BREVO_USER,
          subject: `🚨 CJ Partial Fulfillment — Order #${orderId} (${successfulSplits}/${cjProducts.length})`,
          html: `<p>Splits الناجحين: <code>${splitOrdersCreated.join(', ')}</code></p>
                 <p>راجع CJ dashboard وأكمل العناصر الناقصة يدوياً — العميل مستنى!</p>`
        }).catch(() => {});
        return { success: false, partial: true, error: 'Partial fulfillment' };
      }
    }

    // 3. النتيجة النهائية — الحاسم: تبقى 'paid'! الويب هوك SHIPPED هو اللي كيرفع + يصيفط واتساب
    if (orderSuccess) {
      await pool.query(
        "UPDATE orders SET status = 'paid' WHERE id = $1 AND status IN ('pending','processing')",
        [orderId]
      );
      console.log(`📤 [CJ] #${orderId} مقبول (${successfulCJOrderNumber}) — ننتظر ORDER/SHIPPED webhook للإشعار اللحظي`);
      return { success: true, orderNumber: successfulCJOrderNumber };
    }

    console.error(`❌ CJ Order Fulfillment Failed for #${orderId}. Reason:`, lastError);
    await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]);
    return { success: false, error: lastError };

  } catch (err) {
    logger.logError(`CJ Fulfillment Fatal Error #${orderId}`, err);
    if (!cjCreated) {
      await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [orderId]).catch(() => {});
    }
    return { success: false, error: err.message };
  }
}
'@
if ($cs.Contains('function extractCjNumber')) {
  Write-Host 'SKIP  [02] fulfillCJOrder v2 (déjà appliqué)'
} else {
  $rx = New-Object System.Text.RegularExpressions.Regex('(?s)async function fulfillCJOrder\(orderId, customerName, customerDetails, items\) \{.*?return \{ success: false, error: err\.message \};\s*\}\s*\}', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($rx.IsMatch($cs)) { $cs = $rx.Replace($cs, { param($m) $fnV2 }); Write-Host 'OK    [02] fulfillCJOrder v2' }
  else { Write-Host 'FAIL  [02] fulfillCJOrder (ancre introuvable)'; $script:failures += 'cjService-fulfillCJOrder' }
}
Write-Utf8 $csPath $cs

# ---------- [3] cjWebhookService.js ----------
 $cwPath = Join-Path $root 'services\cjWebhookService.js'
 $cw = Read-Utf8 $cwPath

# 3a. notifyShipment موجودة؟ إلا لا — نحقنوها مستقلة (كافية للكرون)
if ($cw -notmatch 'function notifyShipment') {
  $waCall = if ($isObj) {
    "await sendOrderTrackingWhatsApp({ phone: order.customer_phone, customerName: order.customer_name, orderId: order.id, trackingNumber: trackNumber, email: order.customer_email });"
  } else {
    "await sendOrderTrackingWhatsApp(order.customer_phone, order.customer_name, order.id, trackNumber);"
  }
  $nsFunc = @'

// 🔔 إشعار الشحن الموحد — webhook + كرون Tracking
async function notifyShipment(order, trackNumber, logisticName) {
  try {
    $waCall
  } catch (waErr) { logger.logError('Webhook WhatsApp Notification', waErr); }
  if (order.customer_email && !String(order.customer_email).includes('@laclarc.com')) {
    try {
      const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [order.id]);
      const { sendOrderConfirmationEmail } = require('../controllers/paymentController');
      await sendOrderConfirmationEmail(order.customer_email, order.id, order.total_amount, itemsRes.rows);
    } catch (mailErr) { logger.logError('Webhook Tracking Email', mailErr); }
  }
}
'@
  $cw = $cw.Replace('module.exports =', ($nsFunc + "`nmodule.exports ="))
  Write-Host 'OK    [03a] notifyShipment injectée'
} else {
  Write-Host 'SKIP  [03a] notifyShipment موجودة'
  # إلا التوقيع object والنداء positional — نصلحو
  if ($isObj) {
    $cw = Replace-Exact $cw `
      'await sendOrderTrackingWhatsApp(order.customer_phone, order.customer_name, order.id, trackNumber);' `
      'await sendOrderTrackingWhatsApp({ phone: order.customer_phone, customerName: order.customer_name, orderId: order.id, trackingNumber: trackNumber, email: order.customer_email });' `
      '[03b] WA call -> object form'
  }
}
# 3c. export
 $cw = Replace-Exact $cw `
  'module.exports = { cjWebhookHandler, registerWebhooks, subscribeAllStoreProducts };' `
  'module.exports = { cjWebhookHandler, registerWebhooks, subscribeAllStoreProducts, notifyShipment };' `
  '[03c] export notifyShipment'
Write-Utf8 $cwPath $cw

# ---------- [4] paymentController.js — 3 قتلة ----------
 $pcPath = Join-Path $root 'controllers\paymentController.js'
 $pc = Read-Utf8 $pcPath
 $pc = Replace-Exact $pc `
  'await pool.query("UPDATE orders SET status = ''completed'' WHERE id = $1", [orderId]);' `
  'console.log(`📤 [Crypto] #${orderId} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);' `
  '[04a] crypto killer (orderId)'
 $pc = Replace-Exact $pc `
  'await pool.query("UPDATE orders SET status = ''completed'' WHERE id = $1", [order.id]);' `
  'console.log(`📤 [Crypto] #${order.id} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);' `
  '[04b] crypto killer (order.id)'
Write-Utf8 $pcPath $pc

# ---------- [5] server.js ----------
 $svPath = Join-Path $root 'server.js'
 $sv = Read-Utf8 $svPath

# [05] استيراد الإيميل (شرطي — إلا كان function محلية أو مستورد، نطيحو)
if (($sv -notmatch 'function\s+sendOrderConfirmationEmail') -and ($sv -notmatch 'sendOrderConfirmationEmail\s*=') -and ($sv -notmatch '\{\s*sendOrderConfirmationEmail\s*\}\s*=\s*require')) {
  $sv = Replace-Exact $sv `
    "const paymentRoutes = require('./controllers/paymentController');" `
    "const paymentRoutes = require('./controllers/paymentController');`nconst { sendOrderConfirmationEmail } = require('./controllers/paymentController');" `
    '[05] import sendOrderConfirmationEmail'
} else { Write-Host 'SKIP  [05] import email (موجودة أصلاً)' }

# [06] notifyShipment require
 $sv = Replace-Exact $sv `
  "const { cjWebhookHandler } = require('./services/cjWebhookService');" `
  "const { cjWebhookHandler, notifyShipment } = require('./services/cjWebhookService');" `
  '[06] require notifyShipment'

# [07] trackLimiter
 $sv = Replace-Rx $sv `
  '(?m)^const ALL_WORLD_COUNTRIES' `
  "const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many tracking requests.' } });`nconst ALL_WORLD_COUNTRIES" `
  '[07] trackLimiter'

# [08] Stripe WH — orderId guard
 $sv = Replace-Rx $sv `
  'const orderId = session\.metadata\?\.orderId;\s*if \(!orderId\) return;' `
  "const orderId = parseInt(session.metadata?.orderId, 10);`n    if (!Number.isFinite(orderId)) return;" `
  '[08] Stripe WH orderId guard'

# [09] القاتلة #1
 $sv = Replace-Rx $sv `
  'if \(cjResponse && cjResponse\.success\) \{\s*await pool\.query\("UPDATE orders SET status = ''completed'' WHERE id = \$1", \[orderId\]\);\s*\}' `
  @'
if (cjResponse && cjResponse.success) {
          // v2 — بلا 'completed': الحالة تبقى paid + cj_order_number محفوظ داخل fulfillCJOrder
          console.log(`📤 [Stripe WH] #${orderId} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
        } else {
          console.error(`❌ [Stripe WH] CJ fulfillment فشل لـ #${orderId} → manual داخل fulfillCJOrder`);
        }
'@
  '[09] killer #1 (Stripe WH)'

# [10] RECOVER10
 $sv = Replace-Rx $sv `
  "(?m)^(.*Recovery coupon LACLARC10 ensured in DB\..*)$" `
  @'
 $1

    // 🎟️ RECOVER10 — إيميلات السلات المتروكين كيوعدو بيه (كان ناقص من DB!)
    await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, is_active)
       VALUES ('RECOVER10', 'percentage', 10, true)
       ON CONFLICT (code) DO NOTHING`
    );
    console.log('🎟️ Recovery coupon RECOVER10 ensured (abandoned-cart emails promise it).');
'@
  '[10] seed RECOVER10'

# [11] QPS توحيد
 $sv = Replace-Exact $sv 'setTimeout(r, 1000)' 'setTimeout(r, 1200)' '[11] QPS 1200ms (runCjProductSync)'

# [12] القاتلة #2 — BaridiMob approve (route كامل)
 $baridiNew = @'
app.put('/api/admin/manual-orders/approve/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' });

    // v2: قفل ذري — pending -> paid فقط (ضغطة ثانية = 409)
    const updateRes = await pool.query(
      "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending' RETURNING *",
      [id]
    );
    if (updateRes.rows.length === 0) {
      const exists = await pool.query('SELECT status FROM orders WHERE id = $1', [id]);
      if (exists.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      return res.status(409).json({ error: `Order is '${exists.rows[0].status}' — already processed` });
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
          name: order.customer_name,
        };

        const cjResponse = await fulfillCJOrder(order.id, order.customer_name, customerDetails, items);

        // v2 — بلا 'completed': الحالة تبقى paid — الويب هوك SHIPPED كيرفع + يصيفط واتساب
        if (cjResponse && cjResponse.success) {
          console.log(`📤 [BaridiMob] #${id} مقبول فـ CJ (${cjResponse.orderNumber}) — ننتظر ORDER/SHIPPED webhook`);
        } else {
          console.error(`❌ [BaridiMob] CJ fulfillment فشل لـ #${id} → manual داخل fulfillCJOrder`);
        }

        if (order.customer_email) {
          const emailItemsRes = await pool.query(
            `SELECT oi.quantity, oi.price_at_purchase, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
            [id]
          );
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

'@
 $sv = Replace-Rx $sv `
  "(?s)app\.put\('/api/admin/manual-orders/approve/:id'.*?(?=app\.put\('/api/admin/manual-orders/reject)" `
  $baridiNew `
  '[12] killer #2 (BaridiMob approve)'

# [13] الطلب اليتيم — create-checkout-session
 $sv = Replace-Exact $sv `
  'const { items: clientItems, origin, couponCode, utm } = req.body;' `
  "let orderId = null; // 🧹 للتنظيف إلا فشل Stripe session`n    const { items: clientItems, origin, couponCode, utm } = req.body;" `
  '[13a] orphan: declare orderId'
 $sv = Replace-Exact $sv `
  'const orderId = orderResult.rows[0].id;' `
  'orderId = orderResult.rows[0].id;' `
  '[13b] orphan: assign orderId'
 $sv = Replace-Exact $sv `
@'
  } catch (err) {
    logger.logError('Create Checkout Session', err);
    res.status(500).json({ error: err.message });
  }
'@
@'
  } catch (err) {
    // 🧹 إلا فشل Stripe session، الـ pending عمرو ما يتخلص
    if (orderId) {
      await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [orderId]).catch(() => {});
    }
    logger.logError('Create Checkout Session', err);
    res.status(500).json({ error: err.message });
  }
'@
  '[13c] orphan: cleanup in catch'

# [14] limiter على التتبع العام
 $sv = Replace-Exact $sv `
  "app.get('/api/track/:trackNumber', async (req, res) => {" `
  "app.get('/api/track/:trackNumber', trackLimiter, async (req, res) => {" `
  '[14] track route limiter'

# [15] القاتلة #3 — كرون Reconcile كامل
 $reconcileNew = @'
cron.schedule('*/15 * * * *', async () => {
  if (isReconciling) return;
  isReconciling = true;

  try {
    const query = `
      SELECT id, stripe_session_id, total_amount
      FROM orders
      WHERE payment_method = 'Stripe'
        AND status IN ('paid', 'reconciling')
        AND stripe_session_id IS NOT NULL
        AND (cj_order_number IS NULL OR cj_order_number = '')
        AND created_at <= NOW() - INTERVAL '10 minutes'
      LIMIT 15;
    `;
    const { rows: pendingOrders } = await pool.query(query);
    if (pendingOrders.length > 0) {
      console.log(`🔄 [Stripe Reconcile v2] ${pendingOrders.length} طلب ما وصلوش لـ CJ — إعادة محاولة...`);
    }

    for (const order of pendingOrders) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);

        if (session.payment_status === 'paid') {
          console.log(`💰 [Stripe Reconcile] Order ${order.id} confirmed paid. Sending to CJ...`);

          const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
          const fullOrder = orderRes.rows[0];
          const itemsRes = await pool.query(`SELECT oi.*, p.title, p.image_url FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`, [order.id]);
          const items = itemsRes.rows;

          let parsedAddress = {};
          try { parsedAddress = JSON.parse(fullOrder.shipping_address); }
          catch (e) { parsedAddress = { line1: fullOrder.shipping_address, country: 'US' }; }
          const customerDetails = {
            address: parsedAddress,
            phone: fullOrder.customer_phone || '0000000000',
            email: fullOrder.customer_email || '',
            name: fullOrder.customer_name,
          };

          const cjResponse = await fulfillCJOrder(order.id, fullOrder.customer_name, customerDetails, items);

          if (cjResponse && cjResponse.success) {
            // v2 — الحالة تبقى paid + cj_order_number محفوظ -> ما يتعاودش أبداً
            console.log(`📤 [Reconcile] #${order.id} مقبول فـ CJ (${cjResponse.orderNumber})`);
            if (fullOrder.customer_email) {
              sendOrderConfirmationEmail(fullOrder.customer_email, order.id, fullOrder.total_amount, items)
                .catch(err => logger.logError('Reconcile Email', err));
            }
          } else {
            await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [order.id]);
          }
        } else {
          // v2 — إلغاء ذري (ما كيمسش طلب متسجل فـ CJ)
          const upd = await pool.query(
            "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status IN ('paid','reconciling') AND (cj_order_number IS NULL OR cj_order_number = '') RETURNING id",
            [order.id]
          );
          if (upd.rows.length) console.log(`⚠️ [Stripe Reconcile] Order ${order.id} unpaid in Stripe. Cancelled.`);
        }
      } catch (error) {
        logger.logError(`Stripe Reconcile Order #${order.id}`, error);
        await pool.query("UPDATE orders SET status = 'manual' WHERE id = $1", [order.id]);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 🧹 تنظيف legacy: 'reconciling' معلقين من النسخة القديمة -> paid
    await pool.query(
      "UPDATE orders SET status = 'paid' WHERE status = 'reconciling' AND (cj_order_number IS NULL OR cj_order_number = '') AND (tracking_number IS NULL OR tracking_number = '')"
    );
  } catch (error) {
    logger.logError('Stripe Reconcile Cron Fatal', error);
  } finally {
    isReconciling = false;
  }
});

'@
 $sv = Replace-Rx $sv `
  "(?s)cron\.schedule\('\*/15 \* \* \* \*', async \(\) => \{.*?(?=// 7\.)" `
  $reconcileNew `
  '[15] killer #3 (Reconcile cron v2)'

# [16] كرون Tracking — T1a: SELECT + cj_order_number
 $sv = Replace-Exact $sv `
  'SELECT id, customer_name, customer_email, customer_phone, shipping_address, total_amount' `
  'SELECT id, customer_name, customer_email, customer_phone, shipping_address, total_amount, cj_order_number' `
  '[16] tracking SELECT + cj_order_number'

# [17] T1b: WHERE
 $sv = Replace-Exact $sv `
  "WHERE (status = 'paid' OR status = 'completed')" `
  "WHERE status IN ('paid', 'fulfilled')" `
  '[17] tracking WHERE v2'

# [18] T2: POST -> GET + cjNum
 $sv = Replace-Rx $sv `
  "const orderInfoRes = await cjRequest\(\(token\) =>\s*axios\.post\(\s*'https://developers\.cjdropshipping\.com/api2\.0/v1/shopping/order/getOrderDetail',\s*\{ orderNumber: \`STORE-\$\{order\.id\}\` \},\s*\{ headers: \{ 'CJ-Access-Token': token, 'Content-Type': 'application/json' \} \}\s*\)\s*\);" `
@'
const stored = String(order.cj_order_number || '').trim();
        const cjNum = (stored || `STORE-${order.id}`).split(',')[0].trim();
        const orderInfoRes = await cjRequest((token) =>
          axios.get(
            'https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail',
            { params: { orderNumber: cjNum }, headers: { 'CJ-Access-Token': token } }
          )
        );
'@
  '[18] tracking POST->GET + cjNum'

# [19] T3: استخراج دفاعي + عينة REST + status gate
 $sv = Replace-Exact $sv `
  'const trackNumber = cjData?.trackNumber || cjData?.trackingNumber;' `
@'
// 🔬 عينة أول قراءة REST — نضبطو الحقول على الواقع
        if (!global._cjSample_OrderDetail) {
          global._cjSample_OrderDetail = true;
          console.log('🔬 [Sample OrderDetail REST]', JSON.stringify(cjData).slice(0, 800));
        }
        const info = cjData.orderInfo || cjData;
        const cjStatus = String(info.orderStatus || info.status || '').toUpperCase();
        if (cjStatus !== 'SHIPPED' && cjStatus !== 'DISPATCHED') continue;
        const trackNumber = info.logisticsShipmentNumber || info.trackNumber || info.trackingNumber
          || (Array.isArray(cjData.products)
            ? cjData.products.map(p => p.logisticsShipmentNumber || p.trackNumber || p.trackingNumber).find(Boolean)
            : null);
'@
  '[19] tracking extraction v2'

# [20] T4: UPDATE بـ guards + RETURNING
 $sv = Replace-Rx $sv `
  "await pool\.query\(\s*""UPDATE orders SET tracking_number = \$1, status = 'fulfilled' WHERE id = \$2"",\s*\[trackNumber\.trim\(\), order\.id\]\s*\);" `
@'
const upd = await pool.query(
            `UPDATE orders
               SET tracking_number = $1, status = 'fulfilled',
                   cj_order_number = COALESCE(NULLIF(cj_order_number,''), $3)
             WHERE id = $2 AND status IN ('paid','fulfilled')
               AND (tracking_number IS NULL OR tracking_number = '')
             RETURNING id`,
            [trackNumber.trim(), order.id, cjNum]
          );
          if (!upd.rows.length) continue; // الويب هوك سبقنا — الإشعار راح من عنده
'@
  '[20] tracking UPDATE guards'

Write-Utf8 $svPath $sv

# ---------- [6] التحقق النهائي ----------
Write-Host "`n=== VERIFICATION ==="
 $k = @(Select-String -Path (Join-Path $root 'server.js'),$pcPath -Pattern "update orders set status = 'completed'").Count
if ($k -eq 0) { Write-Host '✅ القتلة: 0 بقاو' } else { Write-Host "❌ القتلة: $k باقي — صيفط الـ output" }
 $ns = @(Select-String -Path $svPath,$cwPath -Pattern 'notifyShipment').Count
Write-Host ("ℹ️  notifyShipment: {0} مواقع (متوقع ≥4)" -f $ns)
 $g = @(Select-String -Path $svPath,$csPath -Pattern "axios\.get\(\s*'https://developers\.cjdropshipping\.com/api2\.0/v1/shopping/order/getOrderDetail").Count
 $p = @(Select-String -Path $svPath -Pattern "axios\.post\(\s*'https://developers\.cjdropshipping\.com/api2\.0/v1/shopping/order/getOrderDetail").Count
Write-Host ("ℹ️  getOrderDetail: GET={0} (متوقع 2) | POST={1} (متوقع 0)" -f $g, $p)

Write-Host "`n=== SUMMARY ==="
if ($script:failures.Count -eq 0) {
  Write-Host '🎉 كل الباتشات تطبقو! commit + push -> Render deploy تلقائي.'
} else {
  Write-Host ("⚠️ {0} باتش فشلو: {1}" -f $script:failures.Count, ($script:failures -join ' | '))
  Write-Host '❌ ما تسendsاش! Copy الـ output كامل وصيفطو ليا.'
}