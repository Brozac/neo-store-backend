// fix-variants.js - Laclarc Variant & Attribute Repair Engine
require('dotenv').config();
const axios = require('axios');
const pool = require('./db');
const { cjRequest } = require('./services/cjService');
const { parseVariants } = require('./utils/parser');

async function fixMissingVariants() {
  console.log('\n==================================================');
  console.log('⏳ Checking for products with missing/corrupted variants...');
  console.log('==================================================\n');
  
  try {
    // 1. استعلام دقيق للمنتجات التي تنقصها المتغيرات
    const { rows } = await pool.query(
      `SELECT id, cj_product_id, title FROM products 
       WHERE cj_product_id IS NOT NULL 
       AND cj_product_id NOT LIKE 'MANUAL_%' 
       AND (variants IS NULL OR variants::text IN ('[]', 'null', '""', '{}'))
       ORDER BY id ASC`
    );

    if (rows.length === 0) {
      console.log('✅ All products have complete and valid variants! No action needed.');
      return;
    }

    console.log(`📊 Found ${rows.length} products to inspect and repair...\n`);

    let fixedCount = 0;
    let disabledCount = 0;
    let errorCount = 0;

    for (const [index, p] of rows.entries()) {
      try {
        await new Promise(r => setTimeout(r, 1200)); // احترام معدل QPS=1

        // 2. جلب التفاصيل الرسمية من CJ
        const detailRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
            ...config,
            headers: { 'CJ-Access-Token': token },
            params: { pid: p.cj_product_id }
          })
        );

        const details = detailRes.data?.data;
        
        // 3. إذا لم يجد المنتج أو لا توجد به متغيرات صالحة -> إخفاؤه من المتجر
        if (!details || !Array.isArray(details.variants) || details.variants.length === 0 || details.isGlobalShipping === false) {
          await pool.query("UPDATE products SET stock_status = false WHERE id = $1", [p.id]);
          disabledCount++;
          console.log(`🔻 [${index + 1}/${rows.length}] No variants found in CJ. Hidden from store: #${p.id} (${p.title.substring(0, 30)})`);
          continue;
        }

        const variants = details.variants;
        const parsedData = parseVariants(variants);

        // 4. ✨ تحديث قاعدة البيانات بكافة الخصائص (بما فيها patterns التي كانت ناقصة)
        await pool.query(
          `UPDATE products 
           SET variants = $1, colors = $2, sizes = $3, patterns = $4, stock_status = true
           WHERE id = $5`,
          [
            JSON.stringify(variants),
            parsedData.colors,
            parsedData.sizes,
            parsedData.patterns,
            p.id
          ]
        );

        fixedCount++;
        console.log(`✅ [${index + 1}/${rows.length}] Repaired: #${p.id} (${p.title.substring(0, 30)}) - [${parsedData.colors.length} colors, ${parsedData.sizes.length} sizes]`);
      } catch (err) {
        errorCount++;
        console.error(`❌ [${index + 1}/${rows.length}] Error on #${p.id}:`, err.message);
      }
    }

    console.log('\n==================================================');
    console.log('🎉 REPAIR TASK COMPLETED!');
    console.log(`Successfully Fixed: ${fixedCount}`);
    console.log(`Hidden (Unavailable in CJ): ${disabledCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('==================================================\n');

  } catch (err) {
    console.error('❌ Fatal error in fix script:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

fixMissingVariants();