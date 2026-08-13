require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const { cjRequest, parseNumeric } = require('./services/cjService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function updateProductPrices() {
  console.log('🚀 Starting Price Update Process...');

  try {
    // 1. جلب جميع منتجات CJ الموجودة في قاعدة بياناتنا (باستثناء المنتجات اليدوية)
    const dbProducts = await pool.query("SELECT id, cj_product_id, title FROM products WHERE cj_product_id NOT LIKE 'MANUAL_%'");
    let updatedCount = 0;

    console.log(`Found ${dbProducts.rows.length} products to check.`);

    for (const dbProduct of dbProducts.rows) {
      await new Promise(r => setTimeout(r, 1000)); // تأخير 1 ثانية لتجنب حظر CJ API

      try {
        // 2. جلب السعر الحالي من CJ
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
            ...config,
            headers: { 'CJ-Access-Token': token },
            params: { pid: String(dbProduct.cj_product_id) }
          })
        );

        const details = detailRes.data?.data;
        if (!details) continue;

        const currentCJPrice = parseNumeric(details.sellPrice);
        if (currentCJPrice <= 0) continue;

        // 3. إعادة تطبيق خوارزمية التسعير التلقائي
        let sellingPrice = 0;
        if (currentCJPrice <= 5) sellingPrice = currentCJPrice * 3.5;
        else if (currentCJPrice <= 15) sellingPrice = currentCJPrice * 2.8;
        else if (currentCJPrice <= 30) sellingPrice = currentCJPrice * 2.2;
        else sellingPrice = currentCJPrice * 1.8;
        
        sellingPrice = Math.floor(sellingPrice) - 0.01;
        if (sellingPrice < 9.99) sellingPrice = 9.99;
        
        const safePrice = parseFloat(sellingPrice.toFixed(2));
        const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));

        // 4. تحديث السعر في قاعدة البيانات
        await pool.query(
          "UPDATE products SET price = $1, original_price = $2 WHERE id = $3",
          [safePrice, safeOriginalPrice, dbProduct.id]
        );

        updatedCount++;
        console.log(`✅ Updated: ${dbProduct.title.substring(0, 30)} -> $${safePrice}`);

      } catch (productErr) {
        console.log(`⚠️ Failed to update product ${dbProduct.cj_product_id}`);
      }
    }

    console.log(`\n🎉 Price Update Complete! Successfully updated ${updatedCount} products.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Update Prices Error:', error.message);
    process.exit(1);
  }
}

updateProductPrices();