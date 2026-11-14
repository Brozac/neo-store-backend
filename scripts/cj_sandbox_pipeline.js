#!/usr/bin/env node
// scripts/cj_sandbox_pipeline.js — F#79 SANDBOX HARNESS (دوك shopping 1.11/1.12/1.15)
// ============================================================
// تيست كامل للپايپلاين فالساندبوكس — صفر تهمة، صفر شحن حقيقي:
//   createOrderV2 (isSandbox=1) → simulatePay (1.11) → updateStatus
//   300→400→500→600→700 (1.12، بلا تخطي ولا رجوع — الدوك) →
//   updateTrackNumber عند 500 (1.15) → getOrderDetail asserts.
//
// 🛡️ حراس صارمين (الحماية من الدفع الحقيقي):
//   1) CJ_SANDBOX_MODE=true إجباري (غير هي كتخلي isSandbox=1 فالإنشاء)
//   2) NODE_ENV !== 'production' إجباري
//   3) --yes صريح إجباري (ما كيتشغلش بالخطأ)
//   4) الطلب كيتخلق sandbox حصرياً — إلا CJ رفض، الخدمة كتوقف قبل أي simulatePay
//
// تشغيل:  CJ_SANDBOX_MODE=true node scripts/cj_sandbox_pipeline.js --yes
// ============================================================
require('dotenv').config();

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

function die(msg) {
  console.error('🛑 ' + msg);
  process.exit(1);
}

// ─── الحراس (قبل حتى ما نستوردو cjService باش ما نطلقش شي cron جانبي) ───
if (process.env.NODE_ENV === 'production') die('NODE_ENV=production ممنوع — هادا harness ساندبوكس فقط');
if (process.env.CJ_SANDBOX_MODE !== 'true') die('CJ_SANDBOX_MODE=true مطلوب — بلاه الطلب يولي حقيقي ويخلص بالفلوس الحقيقية');
if (!process.argv.includes('--yes')) die('زد --yes باش تأكد بصراحة — CJ_SANDBOX_MODE=true node scripts/cj_sandbox_pipeline.js --yes');

let pool, cjRequest, getCJToken;
try {
  pool = require('../db');
  ({ cjRequest, getCJToken } = require('../services/cjService'));
} catch (e) {
  die('استيراد فشل: ' + e.message);
}

const axios = require('axios');
const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail: detail || '' });
  console.log((ok ? '✅' : '❌') + ' [' + step + ']' + (detail ? ' — ' + detail : ''));
}

async function call(method, path, body, params) {
  const res = await cjRequest((token) =>
    axios.request({
      method,
      url: BASE + path,
      data: body || undefined,
      params: params || undefined,
      headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' },
      timeout: 30000,
    })
  );
  return res.data || {};
}

async function main() {
  console.log('🧪 SANDBOX PIPELINE — CJ_SANDBOX_MODE=true · NODE_ENV=' + (process.env.NODE_ENV || '(unset)'));

  // 0) منتج من DB — vid حقيقي خاص بالساندبوكس (ما كيخلصش)
  const { rows: prods } = await pool.query(`
    SELECT p.cj_product_id, p.variants FROM products p
    WHERE p.cj_product_id IS NOT NULL AND p.cj_product_id NOT LIKE 'MANUAL_%'
      AND p.stock_status = true
    ORDER BY p.id ASC LIMIT 5
  `);
  let vid = process.env.CJ_SANDBOX_VID || '';
  if (!vid) {
    for (const p of prods) {
      try {
        const vs = typeof p.variants === 'string' ? JSON.parse(p.variants) : p.variants;
        const v = Array.isArray(vs) && vs.find((x) => x && (x.vid || x.variantId));
        if (v) { vid = String(v.vid || v.variantId); break; }
      } catch (e) { /* variants مش JSON — التالي */ }
    }
  }
  if (!vid) die('ما لقيتش variant vid (حدد CJ_SANDBOX_VID أو زيد variants فDB)');
  record('vid', true, vid);

  const storeNum = 'STORE-SBX-' + Date.now();
  const addr = {
    addressFirst: '123 Sandbox St', addressSecond: '', city: 'Avalon', prov: 'NJ',
    country: 'US', zip: '08202', contactName: 'Sandbox Tester', phone: '17872208692',
  };

  // 1) createOrderV2 sandbox — payType=2 balance، isSandbox=1 (نفس الإنتاج)
  const created = await call('POST', '/shopping/order/createOrderV2', {
    orderNumber: storeNum,
    shippingCountryCode: addr.country,
    logisticsName: process.env.CJ_SANDBOX_LOGISTICS || 'CJPacket Ordinary',
    products: [{ vid, count: 1 }],
    fromCountryCode: 'CN',
    address: addr,
    payType: 2,
    isSandbox: 1,
  });
  if (created.code !== 200 || !created.data) {
    die('createOrderV2 sandbox فشل: ' + JSON.stringify(created).slice(0, 300) + '\n   (جرّب CJ_SANDBOX_LOGISTICS=<اسم لوجستيك متاح عندك>)');
  }
  const d0 = created.data;
  const cjCode = d0.cjOrderCode || d0.orderId || d0.orderNumber;
  const orderId = d0.orderId || cjCode;
  record('createOrderV2', true, 'orderNumber=' + storeNum + ' cj=' + cjCode + ' isSandbox=' + (d0.isSandbox != null ? d0.isSandbox : '?'));

  // حارس: الطلب خاصو يكون sandbox فعلاً — إلا لا، وقف هنا (قبل أي simulatePay)
  const det0 = await call('GET', '/shopping/order/getOrderDetail', null, { orderId: cjCode });
  const info0 = (det0.data && det0.data.orderInfo) || det0.data || {};
  if (Number(info0.isSandbox) !== 1) {
    die('الطلب ما هوش sandbox (isSandbox=' + info0.isSandbox + ') — توقف قبل الدفع المحاكى. حيدو يدوياً من CJ!');
  }
  record('isSandbox=1 verified', true, 'status=' + info0.orderStatus);

  // 2) simulatePay (1.11) — الدفع المحاكى
  const pay = await call('POST', '/shopping/sandbox/simulatePay', { orderId: String(orderId) });
  record('simulatePay', pay.code === 200 && pay.data === true, JSON.stringify(pay).slice(0, 160));

  // 3) updateStatus (1.12) — السيل 300→400→500→600→700 بلا تخطي (الدوك)
  for (const st of [400, 500, 600, 700]) {
    const u = await call('POST', '/shopping/sandbox/updateStatus', { orderId: String(orderId), targetStatus: st });
    record('updateStatus ' + st, u.code === 200 && u.data === true, JSON.stringify(u).slice(0, 120));
    // 4) عند 500 (SHIPPED) — updateTrackNumber (1.15)
    if (st === 500) {
      const t = await call('POST', '/shopping/sandbox/updateTrackNumber', {
        orderId: String(orderId),
        trackNumber: 'SBXTRACK' + Date.now(),
      });
      record('updateTrackNumber', t.code === 200, JSON.stringify(t).slice(0, 120));
    }
  }

  // 5) assert النهائي — الحالة 700 CLOSED + التتبع مسجل
  const detF = await call('GET', '/shopping/order/getOrderDetail', null, { orderId: cjCode });
  const infoF = (detF.data && detF.data.orderInfo) || detF.data || {};
  const finalStatus = String(infoF.orderStatus || '').toUpperCase();
  record('final detail', finalStatus === 'CLOSED' || finalStatus === 'COMPLETED', 'status=' + finalStatus + ' track=' + (infoF.trackNumber || '—'));

  // الخلاصة
  const fails = results.filter((r) => !r.ok);
  console.log('\n════════════════════════════════');
  console.log('SANDBOX PIPELINE: ' + (results.length - fails.length) + '/' + results.length + ' passed');
  if (fails.length) {
    console.log('الخطوات الفاشلة: ' + fails.map((f) => f.step).join(', '));
    process.exitCode = 1;
  } else {
    console.log('🧪 الپايپلاين كامل خدام: إنشاء sandbox → دفع محاكى → سيل الحالات → تتبع → إغلاق.');
  }
  await pool.end().catch(() => {});
}

main().catch((e) => {
  console.error('🛑 pipeline threw:', e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
  process.exit(1);
});
