// updatePrices.js - Laclarc Enterprise Price & Stock Synchronizer
require('dotenv').config();
const axios = require('axios');
const pool = require('./db'); // ✨ استخدام الـ Pool الموحد (يحل مشكلة غياب SSL)
const { cjRequest, parseNumeric } = require('./services/cjService');
const { calculateSellingPrice } = require('./services/productImportService');

async function updateProductPrices() {
  console.log('\n==================================================');
  console.log('🚀 Starting Enterprise Price & Stock Update...');
  console.log('==================================================\n');

  try {
    // 1. جلب المنتجات غير اليدوية النشطة
    const dbProducts = await pool.query(
      "SELECT id, cj_product_id, title, price FROM products WHERE cj_product_id IS NOT NULL AND cj_product_id NOT LIKE 'MANUAL_%' ORDER BY id ASC"
    );

    console.log(`📊 Found ${dbProducts.rows.length} products to verify.\n`);
    let updatedCount = 0;
    let outOfStockCount = 0;

    for (const [index, dbProduct] of dbProducts.rows.entries()) {
      await new Promise(r => setTimeout(r, 1200)); // تأخير 1.2 ثانية لتفادي الـ QPS Limit

      try {
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
            ...config,
            headers: { 'CJ-Access-Token': token },
            params: { pid: String(dbProduct.cj_product_id) }
          })
        );

        const details = detailRes.data?.data;

        // ✨ فحص المخزون وتوفر الشحن العالمي
        if (!details || details.isGlobalShipping === false) {
          await pool.query("UPDATE products SET stock_status = false WHERE id = $1", [dbProduct.id]);
          outOfStockCount++;
          console.log(`🔻 [${index + 1}/${dbProducts.rows.length}] Marked Out of Stock: ${dbProduct.title.substring(0, 30)}`);
          continue;
        }

        const cjCostPrice = parseNumeric(details.sellPrice);
        if (cjCostPrice <= 0) continue;

        // استخدام معادلة التسعير الموحدة
        const { safePrice, safeOriginalPrice } = calculateSellingPrice(cjCostPrice);

        // تحديث السعر والمخزون
        await pool.query(
          "UPDATE products SET price = $1, original_price = $2, stock_status = true WHERE id = $3",
          [safePrice, safeOriginalPrice, dbProduct.id]
        );

        updatedCount++;
        console.log(`✅ [${index + 1}/${dbProducts.rows.length}] Updated: ${dbProduct.title.substring(0, 30)} -> $${safePrice}`);

      } catch (err) {
        console.log(`⚠️ Skipped PID ${dbProduct.cj_product_id}: ${err.message}`);
      }
    }

    console.log('\n==================================================');
    console.log(`🎉 Sync Finished Successfully!`);
    console.log(`Updated Prices: ${updatedCount}`);
    console.log(`Marked Out-of-Stock: ${outOfStockCount}`);
    console.log('==================================================\n');
  } catch (error) {
    console.error('❌ Fatal error in Update Prices:', error.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

updateProductPrices();