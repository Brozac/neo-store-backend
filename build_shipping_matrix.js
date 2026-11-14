// build_shipping_matrix.js — v4 (smart reference product + test mode + 🩹 F#77 --tip)
// F#77 — دوك logistic 1.2 freightCalculateTip: أسعار/مدة لكل طريقة (arrivalTime "12-50"
//   + wrapPostage + taxesFee/tariff) بدل الملخص 1.1 برك. اختياري: --tip
//   (10 نقاط/دولة زيادة — وزن/حجم/prop حقيقيين من cjProductDetailsService،
//   إلا ما كانوش = الدولة تتسجل بـ 1.1 وتتقفز — الدوك: حقول موثقة فاشلة بـ 1600300)
require('dotenv').config();
const axios = require('axios');
const pool = require('./db');
const { cjRequest } = require('./services/cjService');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
const TEST_MODE = process.argv.includes('--test');
const TIP_MODE = process.argv.includes('--tip');   // F#77 — تخصيب 1.2 (حقيقي: وزن/حجم/prop)

const ALL_COUNTRIES = ['AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ'];
const COUNTRIES_TO_SCAN = TEST_MODE ? ['US', 'GB', 'DZ'] : ALL_COUNTRIES;

const COUNTRY_NAMES = { US: 'United States', GB: 'United Kingdom', DZ: 'Algeria', FR: 'France', DE: 'Germany', AE: 'UAE', CA: 'Canada', AU: 'Australia', ES: 'Spain', IT: 'Italy' };


// 🩹 F#77 — أعمدة 1.2 Tip (اختيارية — tip_* ما كيتلمسوش من /api/shipping/estimate)
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_matrix (
      country_code VARCHAR(2) PRIMARY KEY,
      country_name VARCHAR(100),
      carriers_count INTEGER DEFAULT 0,
      cheapest_price NUMERIC(10,2),
      cheapest_carrier VARCHAR(100),
      fastest_days VARCHAR(20),
      is_supported BOOLEAN DEFAULT false,
      last_checked TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE shipping_matrix
      ADD COLUMN IF NOT EXISTS tip_cheap_price NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS tip_cheap_method VARCHAR(150),
      ADD COLUMN IF NOT EXISTS tip_min_days INTEGER,
      ADD COLUMN IF NOT EXISTS tip_max_days INTEGER,
      ADD COLUMN IF NOT EXISTS tip_taxes_fee NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS tip_last_checked TIMESTAMPTZ
  `);
  console.log('✅ shipping_matrix table ready\n');
}

// 🩹 F#77 — parse arrivalTime "12-50" → { min: 12, max: 50 } (دوك 1.2)
function parseArrivalDays(v) {
  const m = String(v || '').match(/\d+/g);
  if (!m || !m.length) return { min: null, max: null };
  return { min: parseInt(m[0], 10), max: m.length > 1 ? parseInt(m[1], 10) : parseInt(m[0], 10) };
}

// 🩹 F#77 — السعر الحقيقي للحط فالأرض: totalPostageFee = wrapPostage + taxesFee
//   + clearanceOperationFee + tariff (الدوك 1.2 حرفياً) — fallback wrapPostage/discountFee/postage
function tipPriceOf(r) {
  const t = Number(r && r.totalPostageFee);
  if (Number.isFinite(t) && t > 0) return t;
  const w = Number(r && (r.wrapPostage ?? r.discountFee ?? r.postage));
  return Number.isFinite(w) ? w : Infinity;
}

// 🩹 Warm-up retry — Neon suspend يستيقظ على المحاولة الثانية عادة
async function warmUp() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔥 [Warm-up] attempt ${attempt}/3...`);
      const start = Date.now();
      await pool.query('SELECT 1');
      const took = Date.now() - start;
      console.log(`✅ [Warm-up] connected (${took}ms)${took > 3000 ? ' — Neon woke from suspend' : ''}\n`);
      return;
    } catch (e) {
      console.warn(`⚠️ [Warm-up] failed: ${e.message}`);
      if (attempt < 3) {
        console.log('   ⏳ waiting 5s for Neon wake-up...');
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw new Error('Neon unresponsive after 3 attempts — check DATABASE_URL or retry in a minute');
      }
    }
  }
}

async function main() {
  console.log(`═══ 🌍 Shipping Matrix v3 — ${TEST_MODE ? '🧪 TEST MODE (3 دول)' : 'FULL SCAN'} ═══\n`);
  await warmUp();
  await ensureTable();

  // 🩹 v3 — منتج مرجعي ذكي (حديث + بسيط + بفئة عامة)
  const { rows: products } = await pool.query(`
    SELECT id, variants, title, cj_product_id FROM products
    WHERE stock_status = true
      AND variants IS NOT NULL AND variants != '[]' AND variants != 'null'
      AND cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%'
      AND (video_url IS NULL OR video_url = '')
      AND category ILIKE '%consumer%'
    ORDER BY created_at DESC LIMIT 1
  `);
  if (!products.length) {
    // fallback — أي منتج حديث
    const { rows: fallback } = await pool.query(`
      SELECT id, variants, title, cj_product_id FROM products
      WHERE stock_status = true AND variants IS NOT NULL AND variants != '[]' AND variants != 'null'
        AND cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%'
      ORDER BY created_at DESC LIMIT 1
    `);
    if (!fallback.length) { console.error('❌ لا منتجات'); process.exit(1); }
    products.push(...fallback);
  }
  const variants = typeof products[0].variants === 'string' ? JSON.parse(products[0].variants) : products[0].variants;
  const vid = variants?.[0]?.vid;
  if (!vid) { console.error('❌ لا vid'); process.exit(1); }

  console.log(`📦 منتج مرجعي: #${products[0].id} — "${products[0].title?.slice(0, 60)}"`);
  console.log(`📦 vid: ${vid}`);
  console.log(`🌍 مسح ${COUNTRIES_TO_SCAN.length} دولة...${TIP_MODE ? ' + تخصيب 1.2 Tip' : ''}\n`);

  // 🩹 F#77 — بيانات الشحن الدقيقة للمنتج المرجعي (وزن/حجم/prop/sku) — شروط الدوك 1.2:
  //   weight>0 + productProp موثقين (فاشلين = 1600300 كيسمّي السطر) — إلا ناقصين = تخصيب معطل
  //   ومنتج بلا أحد صالح للدولة، 1.1 كيسجلها عادي — ما كاين نقاط ضايعة
  let tipData = null;
  if (TIP_MODE) {
    try {
      const precisionSvc = require('./services/cjProductDetailsService');
      const sd = await precisionSvc.getShippingData(String(products[0].cj_product_id));
      const sku = sd.ok && (sd.variantData?.[0]?.variantSku || variants?.[0]?.variantSku || variants?.[0]?.sku) || '';
      if (sd.ok && sd.shippingWeightG > 0 && sku) {
        tipData = {
          weight: sd.shippingWeightG,
          wrapWeight: sd.shippingWeightG,             // الوزن بالتغليف — دوك 1.2 (Y)
          volume: sd.volumeCm3,                        // cm³ — دوك 1.2 (Y)
          productProp: (sd.productProp && sd.productProp.length) ? sd.productProp : ['COMMON'],
          sku,
        };
        console.log(`🔬 [Tip] وزن=${tipData.weight}g · حجم=${tipData.volume}cm³ · prop=${JSON.stringify(tipData.productProp)} · sku=${sku}`);
      } else {
        console.log('⚠️ [Tip] بيانات الشحن الدقيقة ناقصة (وزن ولا sku) — التخصيب 1.2 معطل، 1.1 برك');
      }
    } catch (e) {
      console.log(`⚠️ [Tip] ${e.message} — التخصيب معطل، 1.1 برك`);
    }
  }

  let supported = 0, unsupported = 0, errors = 0, tipped = 0;

  for (let i = 0; i < COUNTRIES_TO_SCAN.length; i++) {
    const cc = COUNTRIES_TO_SCAN[i];
    const name = COUNTRY_NAMES[cc] || cc;

    try {
      const res = await cjRequest((token, config) =>
        axios.post(`${CJ_API}/logistic/freightCalculate`, {
          startCountryCode: 'CN',
          endCountryCode: cc,
          products: [{ vid, quantity: 1 }]
        }, { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
      );

      const code = res.data?.code;
      const raw = res.data?.data;

      if (code !== 200) {
        console.error(`\n⚠️ [${cc}] code=${code} — ${res.data?.message?.slice(0, 80)}`);
        errors++;
        continue;
      }

      const carriers = Array.isArray(raw) ? raw : [];
      const isSupported = carriers.length > 0;
      const cheapest = carriers.slice().sort((a, b) => a.logisticPrice - b.logisticPrice)[0];
      const fastest = carriers.slice().sort((a, b) => parseInt(a.logisticAging) - parseInt(b.logisticAging))[0];

      await pool.query(`
        INSERT INTO shipping_matrix
          (country_code, country_name, carriers_count, cheapest_price, cheapest_carrier, fastest_days, is_supported, last_checked)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (country_code) DO UPDATE SET
          country_name = EXCLUDED.country_name, carriers_count = EXCLUDED.carriers_count,
          cheapest_price = EXCLUDED.cheapest_price, cheapest_carrier = EXCLUDED.cheapest_carrier,
          fastest_days = EXCLUDED.fastest_days, is_supported = EXCLUDED.is_supported, last_checked = NOW()
      `, [cc, name, carriers.length,
          cheapest?.logisticPrice ?? null, cheapest?.logisticName ?? null,
          fastest?.logisticAging ?? null, isSupported]);

      isSupported ? supported++ : unsupported++;

      // 🩹 F#77 — تخصيب 1.2 Tip: أسعار/مدة لكل طريقة + الرسوم (الدولة مدعومة برك)
      if (tipData && isSupported) {
        try {
          const tipRes = await cjRequest((token, config) =>
            axios.post(`${CJ_API}/logistic/freightCalculateTip`, {
              reqDTOS: [{
                srcAreaCode: 'CN',
                destAreaCode: cc,
                weight: tipData.weight,
                wrapWeight: tipData.wrapWeight,
                volume: tipData.volume,
                productProp: tipData.productProp,
                skuList: [tipData.sku],
                freightTrialSkuList: [{ sku: tipData.sku, skuQuantity: 1, skuWeight: tipData.weight }],
              }]
            }, { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } })
          );
          const tipRows = tipRes.data?.code === 200 && Array.isArray(tipRes.data.data) ? tipRes.data.data : [];
          if (tipRows.length) {
            const cheapestTip = tipRows.slice().sort((a, b) => tipPriceOf(a) - tipPriceOf(b))[0];
            const fastestTip = tipRows.slice().sort((a, b) =>
              ((parseArrivalDays(a.arrivalTime).min ?? 1e9) - (parseArrivalDays(b.arrivalTime).min ?? 1e9)))[0];
            const fd = parseArrivalDays(fastestTip?.arrivalTime);
            const taxes = Number(cheapestTip?.taxesFee);
            await pool.query(`
              UPDATE shipping_matrix SET
                tip_cheap_price = $2, tip_cheap_method = $3,
                tip_min_days = $4, tip_max_days = $5,
                tip_taxes_fee = $6, tip_last_checked = NOW()
              WHERE country_code = $1
            `, [cc, tipPriceOf(cheapestTip),
                String(cheapestTip?.option?.enName || cheapestTip?.channel?.enName || '').slice(0, 150),
                fd.min, fd.max, Number.isFinite(taxes) ? taxes : null]);
            tipped++;
          } else {
            // دوك 1.3 — قلّ من الطرق/خاوية؟ نفس الpayload على unavailableShippingMethods كيعطي السبب
            console.log(`\n⚠️ [${cc}] Tip: ${tipRes.data?.code || '?'} ${String(tipRes.data?.message || '').slice(0, 80)}`);
          }
        } catch (e) {
          console.log(`\n⚠️ [${cc}] Tip failed: ${String(e.message).slice(0, 80)}`);
        }
      }

      // 🩹 DEBUG — أول 3 دول بالتفصيل (للتشخيص الحي)
      if (i < 3) {
        console.log(`\n🔍 DEBUG [${cc}]: code=${code} · carriers=${carriers.length} · sample=${JSON.stringify(carriers[0] || {}).slice(0, 200)}\n`);
      }

      process.stdout.write(`\r[${i + 1}/${COUNTRIES_TO_SCAN.length}] ${isSupported ? '✅' : '❌'} ${cc} ${name.padEnd(18)} ${carriers.length} carriers${cheapest ? ` — $${cheapest.logisticPrice}` : ''}${' '.repeat(15)}`);

    } catch (e) {
      errors++;
      console.error(`\n⚠️ [${cc}] EXCEPTION: ${e.message?.slice(0, 100)}`);
    }
  }

  console.log(`\n\n⏱️ done — ✅ ${supported} · ❌ ${unsupported} · ⚠️ ${errors}${TIP_MODE ? ` · 🔬 tip ${tipped}` : ''}\n`);

  const { rows: report } = await pool.query(`
    SELECT country_code, country_name, carriers_count, cheapest_price, cheapest_carrier,
           tip_cheap_price, tip_cheap_method, tip_min_days, tip_max_days
    FROM shipping_matrix WHERE is_supported = true ORDER BY cheapest_price ASC NULLS LAST
  `);
  console.log(`═══ ✅ المدعومة (${report.length}) ═══`);
  report.forEach((r, i) => console.log(`  ${i+1}. ${r.country_code} ${r.country_name || ''} — ${r.carriers_count} carriers — $${r.cheapest_price}` +
    (r.tip_cheap_price != null ? ` · tip $${r.tip_cheap_price} (${r.tip_cheap_method || '?'}${r.tip_min_days != null ? ` · ${r.tip_min_days}-${r.tip_max_days}d` : ''})` : '')));

  const { rows: unsup } = await pool.query(`SELECT country_code FROM shipping_matrix WHERE is_supported = false`);
  if (unsup.length) console.log(`\n═══ ❌ غير المدعومة (${unsup.length}) ═══\n  ${unsup.map(r => r.country_code).join(' · ')}`);

  await pool.end(); process.exit(0);
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });