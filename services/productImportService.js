// services/productImportService.js
// ✨ منطق استيراد منتج واحد من CJ (فلترة + تسعير + تصنيف + parseVariants + فيديو)
// تم فصله هنا لتجنب تكرار الكود بين server.js و massCloneAllCategories.js.

const axios = require('axios');
const { cjRequest, parseNumeric } = require('./cjService');
const { parseVariants, getCategorySlug, phoneAccRegex, pcBlacklistRegex } = require('../utils/parser');
const { resolveCategoryByCjId } = require('./categoryService');

// ✨ كيتحقق أن منتج CJ يستاهل الاستيراد (نفس شروط الفلترة اللي كانت فـ الجوج بلايص)
function isProductEligible(details) {
  if (!details) return false;

  const hasTitle = details.productNameEn?.trim() !== '';
  const hasMainImage = details.bigImage?.startsWith('http');
  const hasImages = details.productImageSet?.length >= 1;
  const strippedDescription = details.description?.replace(/<[^>]*>?/gm, '').trim() || '';
  const hasValidDescription = strippedDescription.length > 10;
  const hasPrice = parseNumeric(details.sellPrice) >= 1.00;
  const hasVariants = details.variants?.length > 0;
  const isWorldwideShipping = details.isGlobalShipping !== false;

  const lowerTitle = (details.productNameEn || '').toLowerCase();
  if (phoneAccRegex.test(lowerTitle)) return false;
  if (pcBlacklistRegex.test(lowerTitle)) return false;

  return hasTitle && hasMainImage && hasImages && hasValidDescription && hasPrice && hasVariants && isWorldwideShipping;
}

// ✨ حساب سعر البيع والسعر القديم بناءً على سعر تكلفة CJ
function calculateSellingPrice(cjPrice) {
  let sellingPrice = cjPrice <= 5 ? cjPrice * 3.5 : cjPrice <= 15 ? cjPrice * 2.8 : cjPrice <= 30 ? cjPrice * 2.2 : cjPrice * 1.8;
  sellingPrice = Math.floor(sellingPrice) - 0.01;
  if (sellingPrice < 9.99) sellingPrice = 9.99;
  const safePrice = parseFloat(sellingPrice.toFixed(2));
  const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));
  return { safePrice, safeOriginalPrice };
}

// ✨ جلب رابط الفيديو الخاص بالمنتج من CJ
async function fetchProductVideoUrl(productId) {
  try {
    const videoRes = await cjRequest((token) =>
      axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/queryVideosByProductId', 
        { productId }, 
        { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } }
      )
    );
    if (videoRes.data.code === 200 && videoRes.data.data?.length > 0) {
      return videoRes.data.data[0].videoUrl;
    }
  } catch (e) {}
  return '';
}

// ✨ كيبني الصف الجاهز للـ INSERT/UPDATE انطلاقاً من تفاصيل منتج CJ (details من /product/query).
// كيرجع null إذا المنتج ماستأهلش الاستيراد (فلترة).
// fallbackCategoryId: اختياري — تستعمل كي details.categoryId ماكانش موجود، لكن عندنا
// قسم معروف مسبقاً (بحال massCloneAllCategories.js اللي كيمر قسم بقسم).
async function buildProductRow(details, fallbackCategoryId = null) {
  if (!isProductEligible(details)) return null;

  const cjPrice = parseNumeric(details.sellPrice);
  const { safePrice, safeOriginalPrice } = calculateSellingPrice(cjPrice);

  const cjCategoryId = details.categoryId || fallbackCategoryId || null;
  let categorySlug;
  if (cjCategoryId) {
    const resolved = await resolveCategoryByCjId(cjCategoryId);
    categorySlug = resolved ? resolved.slugPath : getCategorySlug(`${details.categoryName || ''} ${details.productNameEn || ''}`);
  } else {
    categorySlug = getCategorySlug(`${details.categoryName || ''} ${details.productNameEn || ''}`);
  }

  const parsedData = parseVariants(details.variants || []);
  let material = 'Premium Quality';
  if (details.materialNameEnSet?.length > 0) {
    material = details.materialNameEnSet.filter((m) => m && m !== '').join(', ');
  }

  const videoUrl = await fetchProductVideoUrl(details.pid);

  return {
    title: details.productNameEn,
    price: safePrice,
    original_price: safeOriginalPrice,
    image_url: details.bigImage,
    images: details.productImageSet,
    variants: JSON.stringify(details.variants || []),
    colors: parsedData.colors,
    sizes: parsedData.sizes,
    patterns: parsedData.patterns,
    stock_status: true,
    cj_product_id: details.pid,
    description: details.description,
    material,
    category: categorySlug,
    video_url: videoUrl,
    cj_category_id: cjCategoryId
  };
}

// ✨ استعلام SQL موحد للإدراج أو التحديث (Upsert)
const UPSERT_PRODUCT_SQL = `
  INSERT INTO products (title, price, original_price, image_url, images, variants, colors, sizes, patterns, stock_status, cj_product_id, description, material, category, video_url, cj_category_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (cj_product_id) DO UPDATE SET
    title=EXCLUDED.title, price=EXCLUDED.price, original_price=EXCLUDED.original_price,
    image_url=EXCLUDED.image_url, images=EXCLUDED.images, variants=EXCLUDED.variants,
    colors=EXCLUDED.colors, sizes=EXCLUDED.sizes, patterns=EXCLUDED.patterns, stock_status=EXCLUDED.stock_status,
    description=EXCLUDED.description, material=EXCLUDED.material, category=EXCLUDED.category,
    video_url=EXCLUDED.video_url, cj_category_id=EXCLUDED.cj_category_id
`;

// ✨ تنفيذ الاستعلام في قاعدة البيانات
async function upsertProductRow(pool, row) {
  await pool.query(UPSERT_PRODUCT_SQL, [
    row.title, row.price, row.original_price, row.image_url, row.images, row.variants,
    row.colors, row.sizes, row.patterns, row.stock_status, row.cj_product_id, row.description,
    row.material, row.category, row.video_url, row.cj_category_id
  ]);
}

module.exports = { 
  isProductEligible, 
  calculateSellingPrice, 
  buildProductRow, 
  upsertProductRow, 
  UPSERT_PRODUCT_SQL 
};