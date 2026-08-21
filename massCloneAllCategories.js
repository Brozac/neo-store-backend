require('dotenv').config();
const axios = require('axios');
// ✨ Pool مشترك بدل new Pool() محلي — يتفادى تكاثر الاتصالات (شوف db.js)
const pool = require('./db');
const { cjRequest } = require('./services/cjService');
// ✨ استيراد الدوال الجاهزة من خدمة الاستيراد الجديدة
const { buildProductRow, upsertProductRow } = require('./services/productImportService');

async function runMassClone() {
  console.log(`🚀 Starting Mass Clone from ALL Categories (Optimized)...`);

  try {
    // 1. جلب جميع الأقسام التحتية (Leaf Categories) من قاعدة بياناتنا
    const catsRes = await pool.query("SELECT cj_category_id, name, slug FROM categories WHERE level = 3 AND cj_category_id IS NOT NULL");
    const categories = catsRes.rows;
    
    let totalImported = 0;

    // 2. المرور على كل قسم وجلب منتجاته
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      console.log(`\n📂 [${i + 1}/${categories.length}] Fetching products for: ${category.name} (${category.slug})`);

      const pagesToFetch = 2; // نجلب صفحتين (40 منتج) لكل قسم تحتي
      let categoryImported = 0;

      for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
        try {
          await new Promise(r => setTimeout(r, 1200)); // احترام حد السرعة (QPS=1)

          const listRes = await cjRequest((token, config) =>
            axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
              ...config,
              headers: { 'CJ-Access-Token': token },
              params: { pageNum, pageSize: 20, categoryId: category.cj_category_id }
            })
          );

          const cjProducts = listRes.data?.data?.list || [];
          if (cjProducts.length === 0) break;

          for (const cjItem of cjProducts) {
            await new Promise(r => setTimeout(r, 1200));
            const productId = cjItem.pid ? String(cjItem.pid) : null;
            if (!productId) continue;

            try {
              // جلب تفاصيل المنتج من CJ
              const detailRes = await cjRequest((token, config) =>
                axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
                  ...config,
                  headers: { 'CJ-Access-Token': token },
                  params: { pid: productId }
                })
              );

              const details = detailRes.data?.data;
              if (!details) continue;

              // ✨ استخدام خدمة الاستيراد الجديدة (بلا كود مكرر للفلترة والتسعير والتصنيف)
              // نمرر fallbackCategoryId = category.cj_category_id
              const productRow = await buildProductRow(details, category.cj_category_id);
              
              if (productRow) {
                await upsertProductRow(pool, productRow);
                totalImported++;
                categoryImported++;
              }
            } catch (productErr) {
              console.log(`⚠️ Skipped ${productId} due to error.`);
            }
          }
        } catch (pageErr) {
          console.log(`⚠️ Error fetching page ${pageNum} for ${category.name}. Skipping page.`);
        }
      }
      console.log(`✅ Category ${category.name} done. Imported ${categoryImported} products.`);
    }

    console.log(`\n========================================`);
    console.log(`🎉 Mass Clone Complete!`);
    console.log(`Successfully imported ${totalImported} products across ${categories.length} categories.`);
    console.log(`========================================\n`);

  } catch (err) {
    console.error('❌ Fatal error in Mass Clone script:', err);
  } finally {
    // إغلاق الاتصال بأمان
    await pool.end();
    process.exit(0);
  }
}

runMassClone();