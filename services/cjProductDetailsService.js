// services/cjProductDetailsService.js — 🌟 M#34b — Shipping Data Extractor (v2)
// ============================================================
// من نداء واحد (Product Details):
//   • productProEnSet → productProp لـ 1.2/1.3 (string أو array)
//   • packingWeight / productWeight → أكبرهما للشحن (يدعم range)
//   • variantVolume (mm³) ÷ 1000 → volume (cm³)
//   • variants[].inventories[].countryCode → Tier-0 warehouse
//   • entryCode → HS Code للجمارك/IOSS
//   • suggestSellPrice → مرجع تسعير
//   • listedNum → مؤشر الطلب
// v2: نفس المحوّلات المشتركة مع productImportService (utils/cjNormalize)
//     + إزالة import غير مستعمل (pool) + timeout على النداء
// ============================================================
const axios = require('axios');
const logger = require('../logger');
const { cjRequest } = require('./cjService');
const {
  parseMaxNumber,
  parseWeightGrams,
  parseProductProps,
  variantVolumeCm3,
  summarizeInventory,
} = require('../utils/cjNormalize');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

// 🧠 Cache — منتج يُجلب مرة، يُستعمل من كل الأنظمة
const detailCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 ساعة
const CACHE_MAX = 5000;

function cacheGet(pid) {
  const entry = detailCache.get(pid);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    detailCache.delete(pid);
    return null;
  }
  return entry.data;
}

function cacheSet(pid, data) {
  if (detailCache.size >= CACHE_MAX) {
    const oldest = detailCache.keys().next().value;
    detailCache.delete(oldest);
  }
  detailCache.set(pid, { data, ts: Date.now() });
}

/**
 * 🔬 getShippingData — يستخرج كل بيانات الشحن الدقيقة من نداء واحد
 * @returns {{
 *   ok: boolean, pid: string,
 *   productProp: string[],
 *   shippingWeightG: number,   // g — الأكبر بين packingWeight و productWeight
 *   productWeightG: number,    // g — وزن المنتج فقط
 *   volumeCm3: number,
 *   warehouseCountries: string[],
 *   isMultiWarehouse: boolean,
 *   hsCode: string, listedNum: number, suggestSellPrice: string, freeShipping: boolean,
 *   variants: Array, productNameEn, productImageSet, bigImage, sellPrice, status, rawData
 * }}
 */
async function getShippingData(pid) {
  if (!pid) return { ok: false, error: 'Missing pid' };

  // Cache-Aside
  const cached = cacheGet(pid);
  if (cached) return { ...cached, fromCache: true };

  try {
    const detailRes = await cjRequest((token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config,
        timeout: 20000,
        headers: { 'CJ-Access-Token': token },
        params: { pid, features: 'enable_video' },
      })
    );

    const d = detailRes.data?.data;
    if (!d) return { ok: false, error: 'Product not found at CJ' };

    // 1️⃣ الوزن — packingWeight (يشمل التغليف) و productWeight (المنتج فقط)
    const productWeightG = parseWeightGrams(d.productWeight);
    const packingWeightG = parseWeightGrams(d.packingWeight) || productWeightG;
    const shippingWeightG = Math.max(packingWeightG, productWeightG);

    // 2️⃣ الخصائص اللوجستية — productProEnSet (string JSON أو array)
    const productProp = parseProductProps(d.productProEnSet);

    // 3️⃣ المتغيرات + المستودعات (Tier-0 مجاني)
    const variantData = (d.variants || []).map((v) => ({
      vid: v.vid,
      variantSku: v.variantSku,
      volumeCm3: variantVolumeCm3(v),
      weightG: parseWeightGrams(v.variantWeight),
      inventories: v.inventories || [],
    }));
    const inv = summarizeInventory(d);

    // 4️⃣ HS Code
    const hsCode = d.entryCode || d.entryCodeEn || '';

    // 5️⃣ مؤشرات الجودة والطلب
    const listedNum = parseInt(d.listedNum, 10) || 0;
    const suggestSellPrice = d.suggestSellPrice || '';
    const freeShipping = d.addMarkStatus === 1;

    const volumeCm3 =
      variantData.find((v) => v.volumeCm3 > 0)?.volumeCm3 ||
      Math.round(shippingWeightG * 6.75) ||
      3375;

    const result = {
      ok: true,
      pid,
      productProp,
      shippingWeightG,
      productWeightG,
      volumeCm3,
      warehouseCountries: inv.countries,
      isMultiWarehouse: inv.countries.length > 1,
      hsCode,
      listedNum,
      suggestSellPrice,
      freeShipping,
      variants: variantData,
      productNameEn: d.productNameEn,
      productImageSet: d.productImageSet || [],
      bigImage: d.bigImage,
      sellPrice: parseMaxNumber(d.sellPrice),
      status: d.status,
      rawData: {
        packingNameEnSet: d.packingNameEnSet,
        materialNameEnSet: d.materialNameEnSet,
        customization: d.customizationVersion || 0,
      },
    };

    cacheSet(pid, result);
    return { ...result, fromCache: false };
  } catch (e) {
    logger.logError('GetShippingData', e);
    return { ok: false, error: e.message };
  }
}

/**
 * 🔬 buildPrecisionPayload — payload جاهز لـ 1.2/1.3 ببيانات حقيقية من Product Details
 */
async function buildPrecisionPayload(pid, destCountry) {
  const shipping = await getShippingData(pid);
  if (!shipping.ok) return shipping;

  const firstVariant = shipping.variants[0];
  const sku = firstVariant?.variantSku || shipping.pid;

  return {
    ok: true,
    payload: {
      reqDTOS: [{
        srcAreaCode: 'CN',
        destAreaCode: destCountry,
        weight: shipping.shippingWeightG,
        volume: shipping.volumeCm3,
        productProp: shipping.productProp,
        skuList: [sku],
        freightTrialSkuList: [{ sku, skuQuantity: 1 }],
      }],
    },
    shipping,
  };
}

module.exports = { getShippingData, buildPrecisionPayload, cacheGet, cacheSet };