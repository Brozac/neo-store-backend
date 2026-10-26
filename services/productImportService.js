// services/productImportService.js - Laclarc Enterprise Product Import Engine (v3.1)
// ============================================================
// v3.1 — القرارات الأربعة + إغلاق ثغرات الـ audit:
//   • no_pid guard → ما بقا "undefined" يولي cj_product_id (P1-1)
//   • محرك تسعير واعي بالوزن: landed = cost + ship · هامش مستهدف ENV (قرار 3)
//   • shipping_dominant: الشحن كيبلع التكلفة → يُرفض (قرار 3)
//   • no_stock: مخزون معروف = صفر → يُرفض · مجهول = fail-open (قرار 4)
//   • original_price = null — بلا strikethrough مزوّر (Tenet #26) (قرار 1)
//   • material = '' — بلا "Premium Quality" بلا مصدر (قرار 2)
//   • has_video = Boolean(video_url) فقط — قابل للإثبات · sticky في SQL (P2-2)
//   • stock_status محسوب من inventories (ماشي مضمّن) (P1-3)
//   • الأولوية للمخزون الحي على الحقول القديمة (P2-3)
//   • sanitizeDescription: script/on*/javascript: تتقشط قبل التخزين (P2-6)
//   • الصمتين في catch ولاو مسجلين (Tenet #14) (P2-1)
//   • diagnoseShipping: timeout 15s + code=0 نجاح (P2-4)
//   • (v3 كامل يبقى: ranges · lastIndex · الصور بلا تكرار · props · ...)
// ============================================================
const axios = require('axios');
const logger = require('../logger');
const { cjRequest } = require('./cjService');
const { parseVariants, getCategorySlug, phoneAccRegex, pcBlacklistRegex } = require('../utils/parser');
const { resolveCategoryByCjId } = require('./categoryService');
const {
  parseMaxNumber,
  parseWeightGrams,
  parseJsonArray,
  parseProductProps,
  parseImageList,
  variantVolumeCm3,
  summarizeInventory,
} = require('../utils/cjNormalize');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

// ==========================================
// helpers
// ==========================================
function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>?/gm, '').replace(/&nbsp;/gi, ' ').trim();
}

// 🆕 v5.2b — بيانات CJ أحياناً كتجي بالعنوان مكتوب جوج مرات (داتا سيلر خاسرة):
// "Name Name" / "NameName" / "Name - Name" بحال بالضبط → نحيدو التكرار.
// دقيق ومحافظ: كيتفعل غير إلا النصفين متطابقين حرفياً (≥5 حروف لكل نصف)
function dedupeTitle(t) {
  const s = String(t || '').trim();
  const len = s.length;
  if (len < 10) return s;
  for (const sepLen of [0, 1, 3]) {                       // '' · ' ' · ' - '
    if ((len - sepLen) % 2 !== 0) continue;
    const k = (len - sepLen) / 2;
    if (k < 5) continue;
    const a = s.slice(0, k).trim();
    const b = s.slice(k + sepLen).trim();
    if (a === b && a.length >= 5) return a;
  }
  return s;
}

// تنظيف الوصف قبل التخزين — الواجهة تعرضه كـ HTML: سكريبت/هاندلرز/JS-URIs ما يعبروش (P2-6)
function sanitizeDescription(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

// regex بـ flag g/y يحتفظ بـ lastIndex بين النداءات → نصفره قبل كل test
function safeTest(regex, text) {
  if (!regex) return false;
  regex.lastIndex = 0;
  return regex.test(text);
}

// قراءة ENV كسولة (كل نداء) — tests يقدرو يبدلو env بلا restart
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const SHIP_BASE = () => num(process.env.SYNC_SHIP_BASE_USD, 5.0);
const SHIP_PER_KG = () => num(process.env.SYNC_SHIP_PER_KG_USD, 4.0);
const TARGET_MARGIN = () => num(process.env.SYNC_TARGET_MARGIN, 0.35);
const PRICE_FLOOR = () => num(process.env.SYNC_PRICE_FLOOR, 9.99);
const SHIP_DOMINANT_RATIO = () => num(process.env.SYNC_SHIP_DOMINANT_RATIO, 3);

// الوزن النهائي: الأكبر بين productWeight و packingWeight (الأدق للـ freight)
function productWeightGrams(details) {
  return Math.max(parseWeightGrams(details.productWeight), parseWeightGrams(details.packingWeight));
}

// تقدير الشحن — معايرة أولية من shipping_matrix (DZ $6.19 / US $6.43 @~300g)
function estimateShipUsd(weightGrams) {
  const kg = Math.max(Number(weightGrams) || 0, 50) / 1000;
  return SHIP_BASE() + kg * SHIP_PER_KG();
}

// ==========================================
// 1. فلترة دقيقة للمنتجات المؤهلة
// ==========================================
/**
 * @returns {string|null} سبب الرفض، أو null إذا المنتج مؤهل
 */
function getIneligibilityReason(details, { ignoreBlacklist = false } = {}) {
  if (!details) return 'no_details';

  // P1-1: بلا pid → cj_product_id='undefined' + ON CONFLICT يدمج صفوف فاسدة
  if (details.pid === undefined || details.pid === null || String(details.pid).trim() === '') return 'no_pid';

  const rawTitle = details.productNameEn?.trim() || '';
  if (rawTitle.length === 0) return 'no_title';

  if (parseImageList(details, { includeVariantImages: false }).length === 0) return 'no_image';

  if (stripHtml(details.description).length <= 10) return 'no_description';

  const cost = parseMaxNumber(details.sellPrice);
  if (cost < 1.0) return 'low_price';

  if (!Array.isArray(details.variants) || details.variants.length === 0) return 'no_variants';

  if (details.isGlobalShipping === false) return 'not_global_shipping';

  if (!ignoreBlacklist) {
    const lowerTitle = rawTitle.toLowerCase();
    if (safeTest(phoneAccRegex, lowerTitle)) return 'blacklist_phone_acc';
    if (safeTest(pcBlacklistRegex, lowerTitle)) return 'blacklist_pc';
  }

  // قرار 4: مخزون معروف = صفر → رفض. inventories غايبة → fail-open (مجهول ≠ صفر)
  const inv = summarizeInventory(details);
  if (inv.hasData && inv.total <= 0) return 'no_stock';

  // قرار 3 (guard): الشحن كيبلع التكلفة → منتج ما حتى واحد يشريه
  if (estimateShipUsd(productWeightGrams(details)) > cost * SHIP_DOMINANT_RATIO()) return 'shipping_dominant';

  return null;
}

function isProductEligible(details, opts = {}) {
  return getIneligibilityReason(details, opts) === null;
}

// ==========================================
// 2. معادلة احتساب الأسعار الموحدة (v3.1 — واعية بالوزن)
// ==========================================
// landed = cost + ship → + fees → ÷ (1 - margin) → floor psychological
// الخفيف يلتقي مع المضاعفات القديمة تقريباً · الغارق (خفيف الرخيص لا، الثقيل الرخيص) يتصلح
// 🆕 Geo Flow v3.0 — shipOverrideUsd (اختياري): الشحن الحقيقي من freightCalculateTip.
// null/0 → التقدير القديم (estimateShipUsd) — التوافقية الخلفية 100% مع كل المستدعين.
function calculateSellingPrice(cjPrice, weightGrams = 0, shipOverrideUsd = null) {
  const cost = parseMaxNumber(cjPrice);
  if (cost <= 0) return { safePrice: PRICE_FLOOR(), safeOriginalPrice: null };

  const override = Number(shipOverrideUsd);
  const ship = (override > 0 && isFinite(override)) ? override : estimateShipUsd(weightGrams);
  const landed = cost + ship;
  const fees = landed * 0.05 + 0.45; // دفع (~2.9%+$0.30) + طوارئ

  let price = (landed + fees) / (1 - TARGET_MARGIN());
  price = Math.max(PRICE_FLOOR(), Math.floor(price) - 0.01);

  return { safePrice: parseFloat(price.toFixed(2)), safeOriginalPrice: null }; // قرار 1: بلا 1.5x مزوّر
}

// ==========================================
// 3. جلب رابط الفيديو (اختياري وسريع)
// ==========================================
async function fetchProductVideoUrl(productId) {
  if (!productId) return '';
  try {
    const videoRes = await cjRequest((token, config) =>
      axios.post(`${CJ_API}/product/queryVideosByProductId`,
        { productId: String(productId) },
        { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 8000 }
      )
    );
    const isSuccess = videoRes.data?.code === 0 || videoRes.data?.code === 200 || videoRes.data?.success === true;
    if (isSuccess && Array.isArray(videoRes.data?.data) && videoRes.data.data.length > 0) {
      return videoRes.data.data[0].videoUrl || '';
    }
  } catch (e) {
    logger.logError('FetchProductVideoUrl', e); // Tenet #14 — non-fatal لكن مسجل
  }
  return '';
}

function extractVideoFromDetails(details) {
  const list = parseJsonArray(details?.productVideo);
  for (const item of list) {
    if (typeof item === 'string' && /^https?:\/\//i.test(item)) return item;
    if (item && typeof item === 'object' && typeof item.videoUrl === 'string' && item.videoUrl) return item.videoUrl;
  }
  return '';
}

// ==========================================
// 4. بناء صف المنتج المحصن (Safe Row Builder — v3.1)
// ==========================================
// options:
//   fallbackCategoryId · fetchVideo · isSourced
//   videoApiFallback (default true) — إذا ما لقاش الفيديو في details يدير نداء إضافي
async function buildProductRow(details, options = {}) {
  const {
    fallbackCategoryId = null,
    fetchVideo = false,
    isSourced = false,
    videoApiFallback = true,
    ignoreBlacklist = false,
  } = options;

  if (!isProductEligible(details, { ignoreBlacklist })) return null;

  // قرار 3: الوزن قبل التسعير (المعادلة الجديدة تعتمد عليه)
  const weightGrams = productWeightGrams(details);
  const { safePrice, safeOriginalPrice } = calculateSellingPrice(details.sellPrice, weightGrams);

  // ── التصنيف (لا يوقف الاستيراد إذا فشل) ──
  const cjCategoryId = details.categoryId || fallbackCategoryId || null;
  const categoryText = `${details.categoryName || ''} ${details.productNameEn || ''}`;
  let categorySlug = null;
  if (cjCategoryId) {
    try {
      const resolved = await resolveCategoryByCjId(cjCategoryId);
      if (resolved && resolved.slugPath) categorySlug = resolved.slugPath;
    } catch (e) {
      logger.logError('ResolveCategoryByCjId', e);
    }
  }
  if (!categorySlug) {
    try { categorySlug = getCategorySlug(categoryText); } catch (e) {
      logger.logError('GetCategorySlug', e); // Tenet #14 (P2-1)
      categorySlug = null;
    }
  }

  // ── المتغيرات (ألوان/مقاسات/أنماط) ──
  // ⚠️ P2-5 معلق: variants الخام كيحتوي inventories لكل دولة (تضخم) — ما نقشطوهش غير
  //    بعد التأكد بأن حتى consumer ما يقرا inventories من DB (grep قبل التطبيق)
  let parsedData = { colors: [], sizes: [], patterns: [] };
  try {
    parsedData = parseVariants(details.variants || []) || parsedData;
  } catch (e) {
    logger.logError('ParseVariants', e);
  }

  // ── المادة (قرار 2: بلا default تسويقي — '' والواجهة تخبي الحقل الفارغ) ──
  let material = '';
  const materials = parseJsonArray(details.materialNameEnSet);
  if (materials.length > 0) {
    const joined = materials.filter((m) => m && String(m).trim() !== '').join(', ');
    if (joined) material = joined.slice(0, 250);
  }

  // ── الصور (كاملة، بلا تكرار) ──
  const safeImages = parseImageList(details, { includeVariantImages: true, max: 20 });
  const mainImage = safeImages[0] || '';

  // ── الفيديو (P2-2: الاستخراج المجاني دائماً — has_video يعني "عندنا URL صالح") ──
  let videoUrl = extractVideoFromDetails(details);
  if (!videoUrl && fetchVideo && videoApiFallback) {
    videoUrl = await fetchProductVideoUrl(details.pid);
  }
  const hasVideo = Boolean(videoUrl);

  // 🆕 v5.2b — بيانات CJ أحياناً كتجي بالعنوان مضاعف (السيلر كيكتبو جوج مرات بلا فاصل)
  const safeTitle = dedupeTitle((details.productNameEn || 'Premium Product').trim()).slice(0, 250);

  // ── الشحن والجودة ──
  // ⚠️ P3-2: معنى addMarkStatus=1 موثق من فهرس endpoints — تأكد عند أول تشغيل حي
  const productProps = parseProductProps(details.productProEnSet);
  const freeShipping = details.addMarkStatus === 1;
  const deliveryCycle = details.deliveryCycle || '';
  const hasCECert = details.hasCECertification === 1;
  const productTypeCj = details.productType || 'ORDINARY_PRODUCT';
  const listedNum = parseInt(details.listedNum, 10) || 0;

  // ── المخزون والمستودعات من variants[].inventories ──
  const inv = summarizeInventory(details);
  // P2-3: الحي أولاً — الحقل القديم fallback فقط
  const warehouseInventory = inv.hasData ? inv.total : (parseInt(details.warehouseInventoryNum, 10) || 0);
  const verifiedWarehouse = details.verifiedWarehouse === 1 || inv.verified;
  // P1-3 + قرار 4: صادق. بعد فلتر no_stock كل الممرّين true — لكن يبقى صحيحاً لأي مسار مستقبلي
  const stockStatus = inv.hasData ? inv.total > 0 : true;

  return {
    title: safeTitle,
    price: safePrice,
    original_price: safeOriginalPrice, // null — قرار 1
    image_url: mainImage,
    images: safeImages,
    variants: JSON.stringify(details.variants || []),
    colors: Array.isArray(parsedData.colors) ? parsedData.colors : [],
    sizes: Array.isArray(parsedData.sizes) ? parsedData.sizes : [],
    patterns: Array.isArray(parsedData.patterns) ? parsedData.patterns : [],
    stock_status: stockStatus,
    is_sourced: Boolean(isSourced),
    cj_product_id: String(details.pid), // مضمون بـ no_pid guard
    description: sanitizeDescription(details.description), // P2-6
    material,
    category: categorySlug || 'other',
    video_url: videoUrl,
    cj_category_id: cjCategoryId ? String(cjCategoryId) : null,
    listed_num: listedNum,
    warehouse_inventory: warehouseInventory,
    verified_warehouse: verifiedWarehouse,
    has_video_flag: hasVideo,
    free_shipping_flag: freeShipping,
    delivery_cycle: deliveryCycle,
    has_ce_cert: hasCECert,
    product_type_cj: productTypeCj,
    product_props: productProps,
    weight_grams: weightGrams,
    warehouse_countries: inv.countries,
  };
}

// ==========================================
// 4b. فحص اكتمال الصف (للتقارير — ما يرفضش المنتج)
// ==========================================
function auditProductRow(row) {
  const issues = [];
  if (!row) return ['no_row'];
  if (!row.title || row.title.length < 5) issues.push('short_title');
  if (!row.image_url) issues.push('no_main_image');
  if (!Array.isArray(row.images) || row.images.length === 0) issues.push('no_images');
  else if (row.images.length === 1) issues.push('single_image');
  if (stripHtml(row.description).length < 50) issues.push('short_description');
  if (!row.variants || row.variants === '[]') issues.push('no_variants');
  if (!row.price || row.price <= 0) issues.push('bad_price');
  if (!row.weight_grams) issues.push('no_weight');
  if (!row.category || row.category === 'other') issues.push('uncategorized');
  if (!Array.isArray(row.warehouse_countries) || row.warehouse_countries.length === 0) issues.push('no_warehouse_info');
  if (row.stock_status === false) issues.push('zero_stock'); // دفاعي — دابا مستحيل يطلع (فلتر no_stock)
  return issues;
}

// ==========================================
// 5. استعلام الـ Upsert المحصن (v3.1)
// ==========================================
// ⚠️ شرط التشغيل: unique index على cj_product_id (migrations/001 — قسم الفهرس)
const UPSERT_PRODUCT_SQL_V2 = `
  INSERT INTO products (
    title, price, original_price, image_url, images, variants, colors,
    sizes, patterns, stock_status, is_sourced, cj_product_id, description,
    material, category, video_url, cj_category_id,
    cj_listed_num, warehouse_inventory, verified_warehouse,
    has_video, free_shipping, delivery_cycle, has_ce_cert,
    product_type_cj, product_props, weight_grams, warehouse_country_codes
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
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
    cj_listed_num = EXCLUDED.cj_listed_num,
    warehouse_inventory = EXCLUDED.warehouse_inventory,
    verified_warehouse = EXCLUDED.verified_warehouse,
    has_video = CASE WHEN EXCLUDED.has_video THEN true ELSE products.has_video END,
    free_shipping = EXCLUDED.free_shipping,
    delivery_cycle = EXCLUDED.delivery_cycle,
    has_ce_cert = EXCLUDED.has_ce_cert,
    product_type_cj = EXCLUDED.product_type_cj,
    product_props = EXCLUDED.product_props,
    weight_grams = EXCLUDED.weight_grams,
    warehouse_country_codes = EXCLUDED.warehouse_country_codes,
    updated_at = NOW()
`;

// pool.query يأخذ client ويرجعو تلقائياً (release) — لا تسريب اتصالات
async function upsertProductRow(pool, row) {
  await pool.query(UPSERT_PRODUCT_SQL_V2, [
    row.title, row.price, row.original_price, row.image_url, row.images, row.variants,
    row.colors, row.sizes, row.patterns, row.stock_status, row.is_sourced, row.cj_product_id,
    row.description, row.material, row.category, row.video_url, row.cj_category_id,
    row.listed_num ?? 0,
    row.warehouse_inventory ?? 0,
    row.verified_warehouse ?? false,
    row.has_video_flag ?? false,
    row.free_shipping_flag ?? false,
    row.delivery_cycle ?? null,
    row.has_ce_cert ?? false,
    row.product_type_cj ?? 'ORDINARY_PRODUCT',
    row.product_props ?? ['COMMON'],
    row.weight_grams ?? null,
    row.warehouse_countries ?? [],
  ]);
}

// ==========================================
// 6. Shipping Diagnosis (1.3 unavailableShippingMethods)
// ==========================================
async function diagnoseShipping({ sku, destCountry, weight = 500, volumeCm3 = 3375, productProp = ['COMMON'] }) {
  try {
    const payload = {
      reqDTOS: [{
        srcAreaCode: 'CN',
        destAreaCode: destCountry,
        weight,
        volume: volumeCm3,
        productProp,
        skuList: [sku],
        freightTrialSkuList: [{ sku, skuQuantity: 1 }],
      }],
    };

    const res = await cjRequest((token, config) =>
      axios.post(`${CJ_API}/logistic/unavailableShippingMethods`, payload,
        { ...config, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 }) // P2-4
    );

    if (res.data?.code !== 200 && res.data?.code !== 0) { // P2-4: كلا النجاحين
      return { ok: false, error: `code=${res.data?.code}`, message: res.data?.message };
    }

    const available = (res.data?.data?.availableList || []).map((a) => a.optionName);
    const unavailable = (res.data?.data?.unavailableList || []).map((u) => ({
      carrier: u.optionName,
      code: u.errorCode,
      reason: u.errorEn?.slice(0, 150),
    }));

    const reasonSummary = {};
    unavailable.forEach((u) => {
      reasonSummary[u.code] = (reasonSummary[u.code] || 0) + 1;
    });

    return {
      ok: true,
      available,
      availableCount: available.length,
      unavailableCount: unavailable.length,
      reasonSummary,
      dominantReason: Object.entries(reasonSummary).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      verdict: available.length > 0 ? 'SHIPPABLE' : 'NOT_SHIPPABLE',
    };
  } catch (e) {
    logger.logError('DiagnoseShipping', e);
    return { ok: false, error: e.message };
  }
}

// ==========================================
// 7. Tier-0 Warehouse Detection
// ==========================================
function extractWarehouseCountries(details) {
  return summarizeInventory(details).countries;
}

// ==========================================
// 8. buildPrecisionPayload — payload جاهز لـ 1.2/1.3 ببيانات حقيقية
// ==========================================
function buildPrecisionPayload(details, destCountry) {
  const weight = productWeightGrams(details) || 500;

  const firstVar = (details.variants || [])[0] || {};
  const volumeCm3 = variantVolumeCm3(firstVar) || Math.max(3000, Math.round(weight * 6.75));

  const sku = firstVar.variantSku || details.productSku || details.pid; // ⚠️ P3-3: تحقق productSku من الحقل

  return {
    reqDTOS: [{
      srcAreaCode: 'CN',
      destAreaCode: destCountry,
      weight,
      volume: volumeCm3,
      productProp: parseProductProps(details.productProEnSet),
      skuList: [sku],
      freightTrialSkuList: [{ sku, skuQuantity: 1 }],
    }],
  };
}

// ==========================================
// 9. ملخص إعدادات التسعير (للبانر ديال massSync + probes)
// ==========================================
function getPricingConfig() {
  return {
    margin: TARGET_MARGIN(),
    floor: PRICE_FLOOR(),
    shipBaseUsd: SHIP_BASE(),
    shipPerKgUsd: SHIP_PER_KG(),
    shipDominantRatio: SHIP_DOMINANT_RATIO(),
  };
}

module.exports = {
  isProductEligible,
  getIneligibilityReason,
  calculateSellingPrice,
  estimateShipUsd,
  getPricingConfig,
  fetchProductVideoUrl,
  buildProductRow,
  auditProductRow,
  upsertProductRow,
  UPSERT_PRODUCT_SQL_V2,
  diagnoseShipping,
  extractWarehouseCountries,
  buildPrecisionPayload,
  sanitizeDescription,
  estimateShipUsd,
};