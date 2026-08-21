require('dotenv').config();
const axios = require('axios');
const pool = require('./db');
const { cjRequest } = require('./services/cjService');
const { parseVariants } = require('./utils/parser');

async function fixMissingVariants() {
  console.log('⏳ Checking for products with missing or empty variants...');
  
  try {
    // 1. جلب المنتجات التي لا تحتوي على variants صالحة
    const { rows } = await pool.query(
      `SELECT id, cj_product_id, title FROM products 
       WHERE cj_product_id IS NOT NULL 
       AND cj_product_id NOT LIKE 'MANUAL_%' 
       AND (variants IS NULL OR variants::text = '[]' OR variants::text = 'null')`
    );

    if (rows.length === 0) {
      console.log('✅ All products already have valid variants! No fix needed.');
      return;
    }

    console.log(`Found ${rows.length} products with missing variants. Starting fix...`);

    let fixedCount = 0;
    let errorCount = 0;

    for (const p of rows) {
      try {
        await new Promise(r => setTimeout(r, 1200)); // احترام Rate Limit

        // 2. جلب تفاصيل المنتج من CJ
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
            ...config,
            headers: { 'CJ-Access-Token': token },
            params: { pid: p.cj_product_id }
          })
        );

        const details = detailRes.data?.data;
        
        // 3. التحقق إذا كان CJ يرجع variants
        if (!details || !details.variants || details.variants.length === 0) {
          console.log(`⚠️ Product #${p.id} (${p.title}) has no variants in CJ either. Skipping.`);
          continue;
        }

        const variants = details.variants;
        const parsedData = parseVariants(variants);

        // 4. تحديث قاعدة البيانات بالـ variants والـ colors/sizes الصحيحة
        await pool.query(
          `UPDATE products 
           SET variants = $1, colors = $2, sizes = $3 
           WHERE id = $4`,
          [JSON.stringify(variants), parsedData.colors, parsedData.sizes, p.id]
        );

        console.log(`✅ Fixed variants for product #${p.id} (${p.title.substring(0, 30)}...)`);
        fixedCount++;
      } catch (err) {
        console.error(`❌ Error fixing product #${p.id}:`, err.message);
        errorCount++;
      }
    }

    console.log('\n========================================');
    console.log('🎉 FIX VARIANTS COMPLETED!');
    console.log(`Fixed: ${fixedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('========================================\n');

  } catch (err) {
    console.error('❌ Fatal error in fix script:', err);
  } finally {
    await pool.end();
  }
}

fixMissingVariants();