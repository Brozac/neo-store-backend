// massSync.js - Laclarc Enterprise Bulk Importer
require('dotenv').config();
const axios = require('axios');
const pool = require('./db'); // ✨ استخدام الـ Pool الموحد
const { cjRequest } = require('./services/cjService');
const { buildProductRow, upsertProductRow } = require('./services/productImportService');

async function runMassSync() {
  const pagesToFetch = 60; // 60 صفحة × 20 = 1200 منتج
  const pageSize = 20;
  let importedCount = 0;

  console.log(`\n==================================================`);
  console.log(`🚀 Starting Laclarc Mass Sync Engine (${pagesToFetch} Pages)...`);
  console.log(`==================================================\n`);

  try {
    for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
      console.log(`\n📦 Fetching page ${pageNum}/${pagesToFetch}...`);

      try {
        await new Promise(r => setTimeout(r, 1200)); // احترام QPS=1

        const listRes = await cjRequest((token, config) =>
          axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
            ...config,
            headers: { 'CJ-Access-Token': token },
            params: { pageNum, pageSize }
          })
        );

        const cjProducts = listRes.data?.data?.list || [];
        if (cjProducts.length === 0) {
          console.log('🏁 No more products found on CJ. Stopping sync.');
          break;
        }

        for (const cjItem of cjProducts) {
          const productId = cjItem.pid ? String(cjItem.pid) : null;
          if (!productId) continue;

          try {
            await new Promise(r => setTimeout(r, 1200));

            const detailRes = await cjRequest((token, config) =>
              axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
                ...config,
                headers: { 'CJ-Access-Token': token },
                params: { pid: productId }
              })
            );

            const details = detailRes.data?.data;
            if (!details) continue;

            // ✨ استخدام محرك الاستيراد الموحد (فحص الطول، مصفوفة الصور، التسعير، والفلترة)
            const productRow = await buildProductRow(details, {
              fallbackCategoryId: details.categoryId || null,
              fetchVideo: false, // تعطيل الفيديو لتسريع المزامنة
              isSourced: false
            });

            if (productRow) {
              await upsertProductRow(pool, productRow);
              importedCount++;
              console.log(`✅ [${importedCount}] Imported: ${productRow.title.substring(0, 35)}... ($${productRow.price})`);
            }
          } catch (productErr) {
            console.log(`⚠️ Skipped product ${productId}`);
          }
        }
      } catch (pageErr) {
        console.error(`❌ Error on page ${pageNum}:`, pageErr.message);
      }
    }

    console.log(`\n==================================================`);
    console.log(`🎉 Mass Sync Complete! Successfully imported ${importedCount} products.`);
    console.log(`==================================================\n`);
  } catch (err) {
    console.error('❌ Fatal error in Mass Sync:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

// ✨ تصدير الدالة بدلاً من تشغيلها تلقائياً
module.exports = { runMassSync };

// السماح بتشغيله يدوياً من التيرمينال إذا أردت: node massSync.js
if (require.main === module) {
  runMassSync();
}