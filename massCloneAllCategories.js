require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const { cjRequest, parseNumeric } = require('./services/cjService');
const { parseVariants, getCategorySlug, phoneAccRegex, pcBlacklistRegex } = require('./utils/parser');
const { resolveCategoryByCjId } = require('./services/categoryService');

// ✨ 1. إضافة ssl: { rejectUnauthorized: false } للاتصال الآمن
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runMassClone() {
  console.log(`🚀 Starting Mass Clone from ALL Categories...`);

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
            const detailRes = await cjRequest((token, config) =>
              axios.get('https://developers.cjdropshipping.com/api2.0/v1/product/query', {
                ...config,
                headers: { 'CJ-Access-Token': token },
                params: { pid: productId }
              })
            );

            const details = detailRes.data?.data;
            if (!details) continue;

            // الفلترة المعتادة
            const hasTitle = details.productNameEn?.trim() !== '';
            const hasMainImage = details.bigImage?.startsWith('http');
            const hasImages = details.productImageSet?.length >= 1;
            const strippedDescription = details.description?.replace(/<[^>]*>?/gm, '').trim() || '';
            const hasValidDescription = strippedDescription.length > 10;
            const hasPrice = parseNumeric(details.sellPrice) >= 1.00;
            const hasVariants = details.variants?.length > 0;
            const isWorldwideShipping = details.isGlobalShipping !== false;

            const lowerTitle = (details.productNameEn || '').toLowerCase();
            if (phoneAccRegex.test(lowerTitle)) continue;
            if (pcBlacklistRegex.test(lowerTitle)) continue;

            if (!hasTitle || !hasMainImage || !hasImages || !hasValidDescription || !hasPrice || !hasVariants || !isWorldwideShipping) continue;

            // التسعير
            const cjPrice = parseNumeric(details.sellPrice);
            let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
            sellingPrice = Math.floor(sellingPrice) - 0.01;
            if (sellingPrice < 9.99) sellingPrice = 9.99;
            const safePrice = parseFloat(sellingPrice.toFixed(2));
            const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));

            // التصنيف الرسمي
            const cjCategoryId = details.categoryId || category.cj_category_id;
            const resolved = await resolveCategoryByCjId(cjCategoryId);
            const categorySlug = resolved ? resolved.slugPath : getCategorySlug(`${details.categoryName} ${details.productNameEn}`);

            const parsedData = parseVariants(details.variants || []);
            let material = 'Premium Quality';
            if (details.materialNameEnSet?.length > 0) material = details.materialNameEnSet.filter(m => m && m !== "").join(', ');

            let videoUrl = '';
            try {
              const videoRes = await cjRequest((token) => axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/queryVideosByProductId', { productId }, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }));
              if (videoRes.data.code === 200 && videoRes.data.data?.length > 0) videoUrl = videoRes.data.data[0].videoUrl;
            } catch (e) {}

            // ✨ 2. إضافة patterns إلى الاستعلام
            await pool.query(
              `INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, patterns, stock_status, cj_product_id, description, material, category, video_url, cj_category_id) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
               ON CONFLICT (cj_product_id) DO UPDATE SET 
                 title=EXCLUDED.title, price=EXCLUDED.price, original_price=EXCLUDED.original_price, 
                 image_url=EXCLUDED.image_url, images=EXCLUDED.images, variants=EXCLUDED.variants, 
                 colors=EXCLUDED.colors, sizes=EXCLUDED.sizes, patterns=EXCLUDED.patterns, stock_status=EXCLUDED.stock_status, 
                 description=EXCLUDED.description, material=EXCLUDED.material, category=EXCLUDED.category, 
                 video_url=EXCLUDED.video_url, cj_category_id=EXCLUDED.cj_category_id`,
              [details.productNameEn, safePrice, safeOriginalPrice, details.bigImage, details.productImageSet, JSON.stringify(details.variants || []), parsedData.colors, parsedData.sizes, parsedData.patterns, true, details.pid, details.description, material, categorySlug, videoUrl, cjCategoryId]
            );

            totalImported++;
            categoryImported++;
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

  console.log(`\n🎉 Mass Clone Complete! Successfully imported ${totalImported} products across ${categories.length} categories.`);
  
  // ✨ 3. إغلاق الاتصال بأمان
  await pool.end();
  process.exit(0);
}

runMassClone();