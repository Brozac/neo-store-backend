// services/productImportService.js - Laclarc Enterprise Product Import Engine
const axios = require('axios');
const { cjRequest, parseNumeric } = require('./cjService');
const { parseVariants, getCategorySlug, phoneAccRegex, pcBlacklistRegex } = require('../utils/parser');
const { resolveCategoryByCjId } = require('./categoryService');

// ==========================================
// 1. فلترة دقيقة للمنتجات المؤهلة
// ==========================================
function isProductEligible(details) {
  if (!details) return false;

  const rawTitle = details.productNameEn?.trim() || '';
  const hasTitle = rawTitle.length > 0;
  const hasMainImage = typeof details.bigImage === 'string' && details.bigImage.startsWith('http');
  
  // التأكد من وجود مصفوفة صور صالحة
  const hasImages = Array.isArray(details.productImageSet) 
    ? details.productImageSet.length >= 1 
    : (typeof details.bigImage === 'string' && details.bigImage.startsWith('http'));

  // تنظيف الوصف من كود HTML والتأكد من جودته
  const strippedDescription = details.description ? details.description.replace(/<[^>]*>?/gm, '').trim() : '';
  const hasValidDescription = strippedDescription.length > 10;
  
  const hasPrice = parseNumeric(details.sellPrice) >= 1.00;
  const hasVariants = Array.isArray(details.variants) && details.variants.length > 0;
  const isWorldwideShipping = details.isGlobalShipping !== false;

  const lowerTitle = rawTitle.toLowerCase();
  if (phoneAccRegex.test(lowerTitle)) return false;
  if (pcBlacklistRegex.test(lowerTitle)) return false;

  return hasTitle && hasMainImage && hasImages && hasValidDescription && hasPrice && hasVariants && isWorldwideShipping;
}

// ==========================================
// 2. معادلة احتساب الأسعار الموحدة
// ==========================================
function calculateSellingPrice(cjPrice) {
  const cost = parseNumeric(cjPrice);
  if (cost <= 0) return { safePrice: 9.99, safeOriginalPrice: 14.99 };

  let sellingPrice = cost <= 5 ? cost * 3.5 : cost <= 15 ? cost * 2.8 : cost <= 30 ? cost * 2.2 : cost * 1.8;
  sellingPrice = Math.max(9.99, Math.floor(sellingPrice) - 0.01);

  const safePrice = parseFloat(sellingPrice.toFixed(2));
  const safeOriginalPrice = parseFloat((safePrice * 1.5).toFixed(2));
  return { safePrice, safeOriginalPrice };
}

// ==========================================
// 3. جلب رابط الفيديو (اختياري وسريع لمنع إبطاء المزامنة)
// ==========================================
async function fetchProductVideoUrl(productId) {
  if (!productId) return '';
  try {
    const videoRes = await cjRequest((token, config) =>
      axios.post('https://developers.cjdropshipping.com/api2.0/v1/product/queryVideosByProductId', 
        { productId: String(productId) }, 
        { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 8000 }
      )
    );
    if (videoRes.data?.code === 200 && Array.isArray(videoRes.data?.data) && videoRes.data.data.length > 0) {
      return videoRes.data.data[0].videoUrl || '';
    }
  } catch (e) {
    // تجاهل أخطاء الفيديو لعدم تعطيل استيراد المنتج
  }
  return '';
}

// ==========================================
// 4. بناء صف المنتج المحصن (Safe Row Builder)
// ==========================================
async function buildProductRow(details, options = {}) {
  if (!isProductEligible(details)) return null;

  const { fallbackCategoryId = null, fetchVideo = false, isSourced = false } = options;

  const { safePrice, safeOriginalPrice } = calculateSellingPrice(details.sellPrice);

  // حل التصنيف
  const cjCategoryId = details.categoryId || fallbackCategoryId || null;
  let categorySlug;
  if (cjCategoryId) {
    const resolved = await resolveCategoryByCjId(cjCategoryId);
    categorySlug = resolved ? resolved.slugPath : getCategorySlug(`${details.categoryName || ''} ${details.productNameEn || ''}`);
  } else {
    categorySlug = getCategorySlug(`${details.categoryName || ''} ${details.productNameEn || ''}`);
  }

  const parsedData = parseVariants(details.variants || []);
  
  // ✨ تأمين طول المواد والخامات لمنع تجاوز VARCHAR(255)
  let material = 'Premium Quality';
  if (Array.isArray(details.materialNameEnSet) && details.materialNameEnSet.length > 0) {
    const joined = details.materialNameEnSet.filter(m => m && String(m).trim() !== '').join(', ');
    if (joined) material = joined.slice(0, 250);
  }

  // ✨ تأمين وتنظيف مصفوفة الصور لـ PostgreSQL TEXT[]
  let safeImages = [];
  if (Array.isArray(details.productImageSet)) {
    safeImages = details.productImageSet.filter(img => typeof img === 'string' && img.startsWith('http'));
  }
  if (details.bigImage && !safeImages.includes(details.bigImage)) {
    safeImages.unshift(details.bigImage);
  }
  if (safeImages.length === 0 && details.bigImage) {
    safeImages = [details.bigImage];
  }

  // جلب الفيديو عند الحاجة فقط
  const videoUrl = fetchVideo ? await fetchProductVideoUrl(details.pid) : '';

  // ✨ تأمين طول العنوان لمنع تجاوز VARCHAR(255)
  const safeTitle = (details.productNameEn || 'Premium Product').trim().slice(0, 250);

  return {
    title: safeTitle,
    price: safePrice,
    original_price: safeOriginalPrice,
    image_url: details.bigImage,
    images: safeImages,
    variants: JSON.stringify(details.variants || []),
    colors: Array.isArray(parsedData.colors) ? parsedData.colors : [],
    sizes: Array.isArray(parsedData.sizes) ? parsedData.sizes : [],
    patterns: Array.isArray(parsedData.patterns) ? parsedData.patterns : [],
    stock_status: true,
    is_sourced: Boolean(isSourced),
    cj_product_id: String(details.pid),
    description: details.description || '',
    material,
    category: categorySlug || 'other',
    video_url: videoUrl,
    cj_category_id: cjCategoryId ? String(cjCategoryId) : null
  };
}

// ==========================================
// 5. استعلام الـ Upsert المحصن
// ==========================================
const UPSERT_PRODUCT_SQL = `
  INSERT INTO products (
    title, price, original_price, image_url, images, variants, colors, 
    sizes, patterns, stock_status, is_sourced, cj_product_id, description, 
    material, category, video_url, cj_category_id
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  ON CONFLICT (cj_product_id) DO UPDATE SET
    title = EXCLUDED.title,
    price = EXCLUDED.price,
    original_price = EXCLUDED.original_price,
    image_url = EXCLUDED.image_url,
    images = EXCLUDED.images,
    variants = EXCLUDED.variants,
    colors = EXCLUDED.colors,
    sizes = EXCLUDED.sizes,
    patterns = EXCLUDED.patterns,
    stock_status = EXCLUDED.stock_status,
    is_sourced = CASE WHEN EXCLUDED.is_sourced = true THEN true ELSE products.is_sourced END,
    description = EXCLUDED.description,
    material = EXCLUDED.material,
    category = EXCLUDED.category,
    video_url = CASE WHEN EXCLUDED.video_url <> '' THEN EXCLUDED.video_url ELSE products.video_url END,
    cj_category_id = EXCLUDED.cj_category_id
`;

async function upsertProductRow(pool, row) {
  await pool.query(UPSERT_PRODUCT_SQL, [
    row.title, row.price, row.original_price, row.image_url, row.images, row.variants,
    row.colors, row.sizes, row.patterns, row.stock_status, row.is_sourced, row.cj_product_id,
    row.description, row.material, row.category, row.video_url, row.cj_category_id
  ]);
}

module.exports = { 
  isProductEligible, 
  calculateSellingPrice, 
  fetchProductVideoUrl,
  buildProductRow, 
  upsertProductRow, 
  UPSERT_PRODUCT_SQL 
};