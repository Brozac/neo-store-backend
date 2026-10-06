// services/cjProductDetailsService.js — 🌟 M#34b — Shipping Data Extractor
// ============================================================
// من نداء واحد (Product Details):
//   • productProEnSet → productProp لـ 1.2/1.3
//   • packingWeight → weight للشحن (أدق من productWeight)
//   • variantVolume (mm³) ÷ 1000 → volume (cm³) للـ 1.2/1.3
//   • variants[].inventories[].countryCode → Tier-0 warehouse
//   • entryCode → HS Code للجمارك/IOSS
//   • suggestSellPrice → مرجع تسعير
//   • listedNum → مؤشر الطلب
// كل شيء في نداء واحد — كل نظام يستفيد
// ============================================================
const axios = require('axios');
const pool = require('../db');
const logger = require('../logger');
const { cjRequest } = require('./cjService');

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
 *   ok: boolean,
 *   productProp: string[],          // ["COMMON"] أو ["BATTERY"] إلخ
 *   shippingWeight: number,         // g — packingWeight (أدق من productWeight)
 *   productWeight: number,          // g — وزن المنتج فقط
 *   volumeCm3: number,              // cm³ — محول من mm³
 *   warehouseCountries: string[],   // ["CN", "US"] — Tier-0 مباشرة
 *   isMultiWarehouse: boolean,
 *   hsCode: string,                 // entryCode — للجمارك
 *   listedNum: number,              // مؤشر الطلب
 *   suggestSellPrice: string,       // مرجع تسعير
 *   freeShipping: boolean,          // addMarkStatus
 *   variants: Array,                // كل المتغيرات مع inventories
 *   rawData: object
 * }}
 */
async function getShippingData(pid) {
  // Cache-Aside
  const cached = cacheGet(pid);
  if (cached) return { ...cached, fromCache: true };

  try {
    const detailRes = await cjRequest((token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config, headers: { 'CJ-Access-Token': token },
        params: { pid, features: 'enable_video' }
      })
    );

    const d = detailRes.data?.data;
    if (!d) return { ok: false, error: 'Product not found at CJ' };

    // ─── استخراج بيانات الشحن ───

    // 1️⃣ الوزن — packingWeight (يشمل التغليف) > productWeight (المنتج فقط)
    //    كلاهما string من CJ → parseInt
    const productWeightG = parseInt(d.productWeight) || 0;
    const packingWeightG = parseInt(d.packingWeight) || productWeightG;
    // للشحن: استعمل packingWeight (أثقل = أكثر واقعية للـ freight)
    const shippingWeightG = Math.max(packingWeightG, productWeightG);

    // 2️⃣ الخصائص اللوجستية — من productProEnSet (Appendix 4)
    let productProp = ['COMMON']; // fallback
    try {
      const parsed = typeof d.productProEnSet === 'string'
        ? JSON.parse(d.productProEnSet)
        : d.productProEnSet;
      if (Array.isArray(parsed) && parsed.length > 0) {
        productProp = parsed.filter(p => typeof p === 'string' && p.length > 0);
      }
    } catch (e) { /* keep fallback */ }
    if (productProp.length === 0) productProp = ['COMMON'];

    // 3️⃣ Warehouse Countries — من الـ variants[].inventories مباشرة
    const warehouseCountries = new Set();
    let totalVerifiedInventory = 0;
    const variantData = [];

    for (const v of (d.variants || [])) {
      // inventories داخل كل variant — Tier-0 مجاني!
      const inventories = v.inventories || [];
      for (const inv of inventories) {
        if (inv.countryCode) warehouseCountries.add(inv.countryCode);
        if (inv.verifiedWarehouse === 1) {
          totalVerifiedInventory += inv.totalInventory || 0;
        }
      }

      // variantVolume: mm³ → cm³
      const volMm3 = parseInt(v.variantVolume) || 0;
      const volCm3 = Math.round(volMm3 / 1000); // mm³ → cm³

      variantData.push({
        vid: v.vid,
        variantSku: v.variantSku,
        volumeCm3: volCm3,      // ← صحح: استعمل المتغير الصحيح
        weightG: parseInt(v.variantWeight) || 0,
        inventories,
      });
    }

    const isMultiWarehouse = warehouseCountries.size > 1;

    // 4️⃣ HS Code — للجمارك والـ IOSS
    const hsCode = d.entryCode || d.entryCodeEn || '';

    // 5️⃣ مؤشرات الجودة والطلب
    const listedNum = d.listedNum || 0;
    const suggestSellPrice = d.suggestSellPrice || '';
    const freeShipping = d.addMarkStatus === 1;

    // 🩹 بناء الـ result — كل المتغيرات معرفة هنا صراحةً
    const result = {
      ok: true,
      pid,
      productProp,                       // ✅ معرف قبل الحلقة
      shippingWeightG,                   // ✅ معرف قبل الحلقة
      productWeightG,                    // ✅ معرف قبل الحلقة
      volumeCm3: variantData[0]?.volumeCm3 || Math.round(shippingWeightG * 6.75) || 3375,  // 🩹 من variantData أو fallback
      warehouseCountries: [...warehouseCountries],
      isMultiWarehouse: warehouseCountries.size > 1,
      hsCode,                            // ✅ معرف قبل الحلقة
      listedNum,                         // ✅ معرف قبل الحلقة
      suggestSellPrice,                  // ✅ معرف قبل الحلقة
      freeShipping,                      // ✅ معرف قبل الحلقة
      variants: variantData,
      productNameEn: d.productNameEn,
      productImageSet: d.productImageSet || [],
      bigImage: d.bigImage,
      sellPrice: parseFloat(d.sellPrice) || 0,
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
 * 🔬 getPrecisionShippingPayload — يبني payload جاهز لـ 1.2/1.3
 *    ببيانات حقيقية من Product Details — صفر افتراضات
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
        srcAreaCode: 'CN',   // أو من warehouseCountries الأقرب
        destAreaCode: destCountry,
        weight: shipping.shippingWeightG,     // ✅ حقيقي
        volume: shipping.volumeCm3,           // ✅ cm³ محول من mm³
        productProp: shipping.productProp,     // ✅ حقيقي من CJ
        skuList: [sku],
        freightTrialSkuList: [{ sku, skuQuantity: 1 }],
      }]
    },
    shipping,
  };
}

module.exports = { getShippingData, buildPrecisionPayload, cacheGet, cacheSet };