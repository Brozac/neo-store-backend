#!/usr/bin/env node
// ============================================================
// FLOOD-TEST — F#90 — اختبار حمل آمن (قراءة فقط)
// الاستعمال:  node tank-kit/flood-test.cjs https://neo-store-backend.onrender.com
//             node tank-kit/flood-test.cjs https://api.laclarc.com --secs 20 --phases 10,50,150,300
// ⚠️ قراءة فقط: products/deals/categories/search/settings/currency — عمرو ما يربس
//    مسارات الدفع ولا الدفع (لا create-checkout، لا login، لا أي POST)
// Node 18+ (fetch مدمج)
// ============================================================
'use strict';

const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base)) {
  console.log('الاستعمال: node flood-test.cjs <base-url> [--secs 15] [--phases 10,50,150,300] [--q dress]');
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(base) && !process.argv.includes('--allow-local')) {
  console.log('⚠️ localhost خاصو --allow-local');
  process.exit(1);
}

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const SECS = Math.max(5, parseInt(argVal('--secs', '15'), 10));
const PHASES = argVal('--phases', '10,50,150,300').split(',').map((n) => Math.max(1, parseInt(n, 10) || 0));
const Q = encodeURIComponent(argVal('--q', 'dress'));

// مزيج واقعي للتصفح (أوزان): الرئيسية، الديلز، الكاتيجوري، البحث، الإعدادات، العملة
const ENDPOINTS = [
  { p: `/api/products?limit=40`, w: 3 },
  { p: `/api/products/deals`, w: 2 },
  { p: `/api/categories`, w: 1 },
  { p: `/api/search?q=${Q}`, w: 2 },
  { p: `/api/settings`, w: 1 },
  { p: `/api/currency/detect?usd=9.99&country=DZ`, w: 1 },
];
const BAG = [];
for (const e of ENDPOINTS) for (let i = 0; i < e.w; i++) BAG.push(e.p);

const TIMEOUT_MS = 12000;

async function hitOnce() {
  const path = BAG[Math.floor(Math.random() * BAG.length)];
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const t0 = process.hrtime.bigint();
  try {
    const r = await fetch(base + path, { signal: ac.signal, headers: { 'accept-encoding': 'gzip' } });
    await r.arrayBuffer(); // نستهلك الجسم كامل — قياس صادق
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, code: r.status };
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, code: 0 }; // 0 = تايم آوت/انقطاع
  } finally {
    clearTimeout(t);
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function phase(vus, secs) {
  const lat = [];
  const codes = {};
  const deadline = Date.now() + secs * 1000;
  let reqs = 0;
  await Promise.all(
    Array.from({ length: vus }, async () => {
      while (Date.now() < deadline) {
        const { ms, code } = await hitOnce();
        reqs++;
        lat.push(ms);
        codes[code] = (codes[code] || 0) + 1;
      }
    })
  );
  lat.sort((a, b) => a - b);
  const errCount = (codes[0] || 0) + Object.entries(codes).filter(([c]) => c !== '0' && +c >= 500).reduce((s, [, n]) => s + n, 0);
  return {
    vus,
    reqs,
    rps: +(reqs / secs).toFixed(1),
    p50: Math.round(pct(lat, 50)),
    p90: Math.round(pct(lat, 90)),
    p95: Math.round(pct(lat, 95)),
    p99: Math.round(pct(lat, 99)),
    errPct: +((errCount / Math.max(1, reqs)) * 100).toFixed(1),
    codes,
  };
}

(async () => {
  console.log('🎯 هدف: ' + base + '  |  ' + SECS + 's/مرحلة  |  قراءة فقط\n');
  // تسخين: نبرّد الكاش الحقيقي ونجيب استجابة أولى
  try {
    const warm = await fetch(base + '/health');
    console.log('🔥 /health → ' + warm.status + (warm.ok ? '' : '  ⚠️ /health ماشي مركّب — ركّب الكيت قبل القياس الصادق'));
  } catch (e) {
    console.log('⚠️ السيرفر ما جاوب على /health: ' + e.message);
  }
  console.log('');
  console.log('مرحلة | VUs  | طلبات | RPS   | p50   | p90   | p95   | p99   | أخطاء%');
  console.log('------+------+-------+-------+-------+-------+-------+-------+-------');
  for (const vus of PHASES) {
    const r = await phase(vus, SECS);
    const verdict = r.errPct > 20 ? ' 💀 منهار' : r.errPct > 5 ? ' 🥵 كيتعصر' : r.p95 > 2000 ? ' 🐢 بطيء' : ' ✅ ثابت';
    console.log(
      String(vus).padEnd(5) + ' | ' +
      String(r.vus).padEnd(4) + ' | ' +
      String(r.reqs).padEnd(5) + ' | ' +
      String(r.rps).padEnd(5) + ' | ' +
      String(r.p50).padEnd(5) + ' | ' +
      String(r.p90).padEnd(5) + ' | ' +
      String(r.p95).padEnd(5) + ' | ' +
      String(r.p99).padEnd(5) + ' | ' +
      String(r.errPct).padEnd(5) + verdict
    );
  }
  console.log('');
  console.log('📖 القراءة: p95 = 95% من الطلبات كتجي أسرع من هاد الرقم (ملي ثانية).');
  console.log('   هدف الدبابة: p95 < 800ms و أخطاء < 1% حتى في أثقل مرحلة.');
  console.log('   ملاحظة: القياس من جهازك — النت تاعك ممكن يكون هو الحاجز قبل السيرفر.');
})();
