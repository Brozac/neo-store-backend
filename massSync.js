require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const { getCJToken, cjRequest, parseNumeric } = require('./services/cjService');
const { parseVariants, getCategorySlug } = require('./utils/parser');
// ✨ استيراد دالة الفئات الرسمية
const { resolveCategoryByCjId } = require('./services/categoryService');

// ✨ إضافة ssl: { rejectUnauthorized: false } للاتصال بـ Neon/Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runMassSync() {
  const pagesToFetch = 60;
  const pageSize = 20;
  let importedCount = 0;

  console.log(`🚀 Starting Mass Sync for ${pagesToFetch} pages...`);

  for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
    console.log(`\nFetching page ${pageNum}/${pagesToFetch}...`);

    try {
      const listRes = await cjRequest((token, config) =>
        axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/list', {
          ...config,
          headers: { 'CJ-Access-Token': token },
          params: { pageNum, pageSize }
        })
      );

      const cjProducts = listRes.data?.data?.list || [];
      if (cjProducts.length === 0) {
        console.log('No more products found. Stopping.');
        break;
      }

      for (const cjItem of cjProducts) {
        await new Promise(r => setTimeout(r, 1200)); // تأخير لتفادي الـ Rate Limit

        const productId = cjItem.pid ? String(cjItem.pid) : null;
        if (!productId) continue;

        try {
          const detailRes = await cjRequest((token, config) =>
            axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
              ...config,
              headers: { 'CJ-Access-Token': token },
              params: { pid: productId }
            })
          );

          const details = detailRes.data?.data;
          if (!details) continue;

          // ======[ الفلترة ]======
          const hasTitle = details.productNameEn?.trim() !== '';
          const hasMainImage = details.bigImage?.startsWith('http');
          const hasImages = details.productImageSet?.length >= 1;
          const strippedDescription = details.description?.replace(/<[^>]*>?/gm, '').trim() || '';
          const hasValidDescription = strippedDescription.length > 10;
          const hasPrice = parseNumeric(details.sellPrice) >= 1.00;
          const hasVariants = details.variants?.length > 0;
          const isWorldwideShipping = details.isGlobalShipping !== false;

          if (!hasTitle || !hasMainImage || !hasImages || !hasValidDescription || !hasPrice || !hasVariants || !isWorldwideShipping) {
            continue;
          }
          // =======================

          // التسعير التلقائي
          const cjPrice = parseNumeric(details.sellPrice);
          let sellingPrice = 0;
          if (cjPrice <= 5) sellingPrice = cjPrice * 3.5;
          else if (cjPrice <= 15) sellingPrice = cjPrice * 2.8;
          else if (cjPrice <= 30) sellingPrice = cjPrice * 2.2;
          else sellingPrice = cjPrice * 1.8;
          
          sellingPrice = Math.floor(sellingPrice) - 0.01;
          if (sellingPrice < 9.99) sellingPrice = 9.99;
          const safePrice = parseFloat(sellingPrice.toFixed(2));
          const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));

          // ✨ تصنيف ذكي باستخدام الشجرة الرسمية لـ CJ
          const cjCategoryId = details.categoryId || null;
          let categorySlug;
          if (cjCategoryId) {
            const resolved = await resolveCategoryByCjId(cjCategoryId);
            categorySlug = resolved ? resolved.slugPath : getCategorySlug(`${details.categoryName} ${details.productNameEn}`);
          } else {
            categorySlug = getCategorySlug(`${details.categoryName} ${details.productNameEn}`);
          }
          
          const parsedData = parseVariants(details.variants || []);
          
          let material = 'Premium Quality';
          if (details.materialNameEnSet?.length > 0) {
            material = details.materialNameEnSet.filter(m => m && m !== "").join(', ');
          }

          // جلب الفيديو
          let videoUrl = '';
          try {
            const videoRes = await cjRequest((token) =>
              axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/queryVideosByProductId',
                { productId: productId },
                { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
              )
            );
            if (videoRes.data.code === 200 && videoRes.data.data?.length > 0) {
              videoUrl = videoRes.data.data[0].videoUrl;
            }
          } catch (e) {}

          // ✨ الحفظ في قاعدة البيانات (تمت إضافة patterns و cj_category_id)
          await pool.query(
            `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, patterns, stock_status, cj_product_id, description, material, category, cj_category_id, video_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (cj_product_id) DO UPDATE SET 
               title=EXCLUDED.title, price=EXCLUDED.price, original_price=EXCLUDED.original_price, 
               image_url=EXCLUDED.image_url, images=EXCLUDED.images, variants=EXCLUDED.variants, 
               colors=EXCLUDED.colors, sizes=EXCLUDED.sizes, patterns=EXCLUDED.patterns, stock_status=EXCLUDED.stock_status, 
               description=EXCLUDED.description, material=EXCLUDED.material, category=EXCLUDED.category, cj_category_id=EXCLUDED.cj_category_id, video_url=EXCLUDED.video_url`,
            [
              details.productNameEn, safePrice, safeOriginalPrice, details.bigImage, details.productImageSet,
              JSON.stringify(details.variants || []), parsedData.colors, parsedData.sizes, parsedData.patterns, true, details.pid,
              details.description, material, categorySlug, cjCategoryId, videoUrl
            ]
          );
          
          importedCount++;
          console.log(`✅ Imported: ${details.productNameEn.substring(0, 30)}... (${importedCount} total)`);
          
        } catch (productErr) {
          console.log(`⚠️ Skipped ${productId} due to error:`, productErr.response?.data || productErr.message);
        }
      }
    } catch (pageErr) {
      console.error(`❌ Error fetching page ${pageNum}:`, pageErr.response?.data || pageErr.message);
    }
  }

  console.log(`\n🎉 Mass Sync Complete! Successfully imported ${importedCount} high-quality products.`);
  // ✨ إغلاق تجمع الاتصالات قبل الخروج لمنع تعليق السكريبت
  await pool.end();
  process.exit(0);
}

runMassSync();