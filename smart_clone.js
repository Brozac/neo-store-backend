// smart_clone.js — 🌍 M#35 — Smart Catalog Rebuild v2
// استيراد آلي لمنتجات CJ الممولة والجودة العالية — مبني على listV2
require('dotenv').config();
const axios = require('axios');
const pool = require('./db');
const { cjRequest } = require('./services/cjService');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
const DAILY_LIMIT = 5000;    // هدف الاستيراد
const MIN_INVENTORY = 100;   // مخزون أدنى
const MIN_LISTED = 20;       // listings أدنى (إثبات طلب)

// 🏷️ الفئات المستهدفة — استراتيجية التنويع
const CATEGORY_STRATEGIES = [
  { label: 'trending-hot',        params: { productFlag: 0, size: 100, verifiedWarehouse: 1, startWarehouseInventory: 200 } },
  { label: 'trending-warm',       params: { productFlag: 0, size: 100, verifiedWarehouse: 1, startWarehouseInventory: 100, page: 2 } },
  { label: 'new-arrivals',        params: { productFlag: 1, size: 100, verifiedWarehouse: 1, startWarehouseInventory: 100 } },
  { label: 'free-shipping',       params: { addMarkStatus: 1, size: 100, verifiedWarehouse: 1, startWarehouseInventory: 100 } },
  { label: 'video-products',      params: { productType: 10, size: 50, verifiedWarehouse: 1, startWarehouseInventory: 50 } },
  { label: 'ce-certified',        params: { hasCertification: 1, size: 50, verifiedWarehouse: 1, startWarehouseInventory: 100 } },
];

(async () => {
  console.log('═══ 🌍 Smart Clone v2 — CJ-verified Catalog Rebuild ═══\n');

  // ─── 0. Warm-up ───
  for (let i = 1; i <= 3; i++) {
    try { await pool.query('SELECT 1'); console.log(`🔥 Warm-up ${i}/3 OK`); break; }
    catch (e) { console.log(`⚠️ Retry ${i}/3...`); await new Promise(r => setTimeout(r, 5000)); }
  }

  // ─── 1. أرشفة الكتالوج الحالي ───
  const archive = await pool.query(`
    UPDATE products
    SET stock_status = false
    WHERE stock_status = true
      AND cj_product_id IS NOT NULL
      AND cj_product_id NOT LIKE 'MANUAL_%'
    RETURNING id
  `);
  console.log(`📦 أُرشف ${archive.rowCount} منتج (مخفي من المتجر — محفوظ في DB)\n`);

  // ─── 2. مسح CJ بكل الاستراتيجيات ───
  let imported = 0, deduped = 0, rejected = 0, errors = 0;
  const startedAt = Date.now();
  const importedPids = new Set();

  for (const strategy of CATEGORY_STRATEGIES) {
    if (imported >= DAILY_LIMIT) {
      console.log(`⚠️ حد يومي (${DAILY_LIMIT}) — توقف`);
      break;
    }

    console.log(`\n═══ 🔍 ${strategy.label} ═══`);

    try {
      const res = await cjRequest((token, config) =>
        axios.get(`${CJ_API}/product/listV2`, {
          ...config,
          headers: { 'CJ-Access-Token': token },
          params: { ...strategy.params, page: 1 },
        })
      );

      if (res.data?.code !== 200) {
        console.warn(`⚠️ code=${res.data?.code} — skip`);
        continue;
      }

      const content = res.data?.data?.content || [];
      const productList = (content[0]?.productList || [])
        .filter(p => p.saleStatus === '3' && p.bigImage?.startsWith('http'));

      console.log(`   📦 ${productList.length} منتج مؤهل`);

      for (const p of productList) {
        if (imported >= DAILY_LIMIT) break;
        const pid = p.id;
        if (!pid || importedPids.has(pid)) { deduped++; continue; }

        await new Promise(r => setTimeout(r, 800));

        try {
          // 🩹 فلتر الجودة النهائي — من listV2 مباشرة
          const inventory = p.warehouseInventoryNum || 0;
          const verified = p.verifiedWarehouse === 1;
          const listedNum = p.listedNum || 0;
          const cjPrice = parseFloat(p.discountPrice || p.sellPrice) || 0;

          if (inventory < MIN_INVENTORY) { rejected++; continue; }
          if (listedNum < MIN_LISTED) { rejected++; continue; }
          if (cjPrice < 0.5) { rejected++; continue; }

          // 💰 التسعير الموحد
          let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5
            : cjPrice <= 15 ? cjPrice * 2.8
            : cjPrice <= 30 ? cjPrice * 2.2
            : cjPrice * 1.8;
          sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);
          const safePrice = parseFloat(sellingPrice.toFixed(2));
          const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));

          // 🏷️ Category — من الاستجابة المباشرة
          const categorySlug = getCategorySlugSafe(
            p.threeCategoryName || p.twoCategoryName || p.oneCategoryName || strategy.label
          );

          // 💾 Insert — بجميع الحقول الحقيقية
          const insert = await pool.query(`
            INSERT INTO products (
              title, price, original_price, image_url, images,
              stock_status, cj_product_id, description, category,
              is_sourced, sales_count,
              cj_listed_num, warehouse_inventory, verified_warehouse,
              has_video, free_shipping, delivery_cycle, has_ce_cert, product_type_cj
            )
            VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, true, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (cj_product_id) DO NOTHING
            RETURNING id
          `, [
            p.nameEn,
            safePrice, safeOriginalPrice,
            p.bigImage,
            [], // images تُستكمل في جولة detail
            pid,
            p.description || 'High quality product from Laclarc Global Catalog.',
            categorySlug,
            true,                             // is_sourced — مؤهل
            p.listedNum || 0,                 // sales_count = listedNum
            p.warehouseInventoryNum || 0,     // cj_listed_num
            inventory,                        // warehouse_inventory
            verified,                         // verified_warehouse
            p.isVideo === 1,                  // has_video
            p.addMarkStatus === 1,            // free_shipping
            p.deliveryCycle || '7-15',        // delivery_cycle
            p.hasCECertification === 1,       // has_ce_cert
            p.productType || 'ORDINARY_PRODUCT', // product_type_cj
          ]);

          if (insert.rowCount > 0) {
            imported++;
            importedPids.add(pid);
            console.log(`   ✅ #${imported}: ${p.nameEn?.slice(0, 50)} (inv=${inventory}, listed=${listedNum}, $${safePrice})`);
          } else {
            deduped++;
          }
        } catch (prodErr) {
          errors++;
          console.warn(`   ⚠️ ${pid}: ${prodErr.message?.slice(0, 60)}`);
        }
      }
    } catch (strategyErr) {
      console.error(`❌ Strategy ${strategy.label} failed: ${strategyErr.message}`);
      errors++;
    }

    await new Promise(r => setTimeout(r, 2000)); // بين الاستراتيجيات
  }
  

  // ─── 3. التقرير النهائي ───
  const tookSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n═══ 📊 Smart Clone v2 — Complete ═══`);
  console.log(`   ✅ imported: ${imported}`);
  console.log(`   ⏭️ deduped: ${deduped}`);
  console.log(`   🚫 rejected: ${rejected} (inventory/listed/price/blacklist)`);
  console.log(`   ❌ errors: ${errors}`);
  console.log(`   ⏱️ duration: ${tookSec}s`);
  console.log(`   📦 new catalog size: ~${imported} verified products\n`);

  await pool.end(); process.exit(0);
})().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });

// 🩹 getCategorySlug — fallback إذا غير مستوردة من parser
function getCategorySlugSafe(name) {
  if (!name) return 'other';
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
}
