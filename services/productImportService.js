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
    // ✨ CJ API ترجع code: 0 عند النجاح لهذه النقطة بالذات (وليس 200)
    const isSuccess = videoRes.data?.code === 0 || videoRes.data?.code === 200 || videoRes.data?.success === true;
    if (isSuccess && Array.isArray(videoRes.data?.data) && videoRes.data.data.length > 0) {
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
// 🩹 v2 — buildProductRow مع الحقول الجديدة (M#26 v2 + M#34)
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

  let material = 'Premium Quality';
  if (Array.isArray(details.materialNameEnSet) && details.materialNameEnSet.length > 0) {
    const joined = details.materialNameEnSet.filter(m => m && String(m).trim() !== '').join(', ');
    if (joined) material = joined.slice(0, 250);
  }

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

  let videoUrl = '';
  if (fetchVideo) {
    if (Array.isArray(details.productVideo) && details.productVideo.length > 0) {
      const firstVideo = details.productVideo[0];
      if (typeof firstVideo === 'string' && firstVideo.startsWith('http')) videoUrl = firstVideo;
      else if (firstVideo && typeof firstVideo === 'object' && firstVideo.videoUrl) videoUrl = firstVideo.videoUrl;
    }
    if (!videoUrl) videoUrl = await fetchProductVideoUrl(details.pid);
  }

  const safeTitle = (details.productNameEn || 'Premium Product').trim().slice(0, 250);

  // 🩹 v2 — بيانات الشحن والجودة (من Product Details مباشرة)
  const weightGrams = parseInt(details.productWeight) || parseInt(details.packingWeight) || 0;
  const productProps = Array.isArray(details.productProEnSet) ? details.productProEnSet : ['COMMON'];
  const hasVideo = details.isVideo === 1 || Boolean(videoUrl);
  const freeShipping = details.addMarkStatus === 1;
  const deliveryCycle = details.deliveryCycle || '';
  const hasCECert = details.hasCECertification === 1;
  const productTypeCj = details.productType || 'ORDINARY_PRODUCT';
  const listedNum = details.listedNum || 0;
  const warehouseInventory = details.warehouseInventoryNum || 0;

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
    cj_category_id: cjCategoryId ? String(cjCategoryId) : null,
    // 🩹 v2 — الحقول الجديدة
    listed_num: listedNum,
    warehouse_inventory: warehouseInventory,
    verified_warehouse: details.verifiedWarehouse === 1,
    has_video_flag: hasVideo,
    free_shipping_flag: freeShipping,
    delivery_cycle,
    has_ce_cert: hasCECert,
    product_type_cj: productTypeCj,
    product_props: productProps,
    weight_grams: weightGrams,
  };
}

// ==========================================
// 5. استعلام الـ Upsert المحصن
// ==========================================
const UPSERT_PRODUCT_SQL_V2 = `
  INSERT INTO products (
    title, price, original_price, image_url, images, variants, colors,
    sizes, patterns, stock_status, is_sourced, cj_product_id, description,
    material, category, video_url, cj_category_id,
    cj_listed_num, warehouse_inventory, verified_warehouse,
    has_video, free_shipping, delivery_cycle, has_ce_cert,
    product_type_cj, product_props, weight_grams
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
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
    cj_category_id = EXCLUDED.cj_category_id,
    -- 🩹 v2 — الحقول الجديدة
    cj_listed_num = EXCLUDED.cj_listed_num,
    warehouse_inventory = EXCLUDED.warehouse_inventory,
    verified_warehouse = EXCLUDED.verified_warehouse,
    has_video = EXCLUDED.has_video,
    free_shipping = EXCLUDED.free_shipping,
    delivery_cycle = EXCLUDED.delivery_cycle,
    has_ce_cert = EXCLUDED.has_ce_cert,
    product_type_cj = EXCLUDED.product_type_cj,
    product_props = EXCLUDED.product_props,
    weight_grams = EXCLUDED.weight_grams
`;

async function upsertProductRow(pool, row) {
  await pool.query(UPSERT_PRODUCT_SQL_V2, [
    row.title, row.price, row.original_price, row.image_url, row.images, row.variants,
    row.colors, row.sizes, row.patterns, row.stock_status, row.is_sourced, row.cj_product_id,
    row.description, row.material, row.category, row.video_url, row.cj_category_id,
    // 🩹 v2 — الحقول الجديدة (defaults آمنة لو row قديم بلا الحقول)
    row.listed_num ?? 0,
    row.warehouse_inventory ?? 0,
    row.verified_warehouse ?? false,
    row.has_video_flag ?? false,
    row.free_shipping_flag ?? false,
    row.delivery_cycle ?? null,
    row.has_ce_cert ?? false,
    row.product_type_cj ?? 'ORDINARY_PRODUCT',
    row.product_props ?? ['COMMON'],
    row.weight_grams ?? null
  ]);
}

module.exports = { 
  isProductEligible, 
  calculateSellingPrice, 
  fetchProductVideoUrl,
  buildProductRow, 
  upsertProductRow, 
  UPSERT_PRODUCT_SQL: UPSERT_PRODUCT_SQL_V2   // 🩹 v2
};