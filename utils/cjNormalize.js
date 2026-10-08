// utils/cjNormalize.js — Laclarc CJ Field Normalizers (v1.1)
// v1.1: parseMaxNumber يتجاهل فواصل الآلاف ("1,234.56" → 1234.56)
// ⚠️ معروف ومقبول: الفاصلة العشرية الأوروبية ("1,5") ما مدعومة — CJ API يصدر US-format (نقطة)
// ============================================================
'use strict';

/**
 * يستخرج أكبر رقم من قيمة CJ.
 * 150 → 150 | "150.00" → 150 | "120.00-150.00" → 150 | "3.67 -- 5.21" → 5.21 | null → 0
 */
function parseMaxNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const matches = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/g); // v1.1: فواصل الآلاف
  if (!matches) return 0;
  const nums = matches.map(Number).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : 0;
}

/** وزن بالغرام (يدعم range) */
function parseWeightGrams(value) {
  return Math.round(parseMaxNumber(value));
}

/**
 * يحول أي شكل (array | JSON string | "a,b" | "a") إلى array.
 */
function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}

/** productProEnSet → ["COMMON"] / ["BATTERY"] ... (string أو array) */
function parseProductProps(raw, fallback = ['COMMON']) {
  const arr = parseJsonArray(raw)
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
  return arr.length ? arr : [...fallback];
}

/** يقبل http/https/‏//cdn... فقط */
function normalizeUrl(u) {
  if (typeof u !== 'string') return null;
  let s = u.trim();
  if (!s) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  return /^https?:\/\//i.test(s) ? s : null;
}

/**
 * قائمة الصور الكاملة (مرتبة، بلا تكرار):
 * bigImage → productImageSet → productImage → variantImage (آخر شي)
 */
function parseImageList(details, { includeVariantImages = true, max = 20 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const n = normalizeUrl(u);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };

  push(details?.bigImage);
  parseJsonArray(details?.productImageSet).forEach(push);
  parseJsonArray(details?.productImage).forEach(push);
  if (includeVariantImages) {
    for (const v of (details?.variants || [])) push(v?.variantImage);
  }
  return out.slice(0, max);
}

/** حجم المتغير بـ cm³ (variantVolume mm³ ÷ 1000، وإلا الطول×العرض×الارتفاع) */
function variantVolumeCm3(v) {
  const cm3 = Math.round(parseMaxNumber(v?.variantVolume) / 1000);
  if (cm3 > 0 && cm3 <= 200000) return cm3;

  const l = parseMaxNumber(v?.variantLength);
  const w = parseMaxNumber(v?.variantWidth);
  const h = parseMaxNumber(v?.variantHeight);
  if (l && w && h) return Math.round((l * w * h) / 1000);
  return 0;
}

/**
 * ملخص المخزون من variants[].inventories (Tier-0 — بلا نداء إضافي)
 * @returns {{countries: string[], total: number, verifiedTotal: number, verified: boolean, hasData: boolean}}
 */
function summarizeInventory(details) {
  const countries = new Set();
  let total = 0;
  let verifiedTotal = 0;
  let verified = false;
  let hasData = false;

  for (const v of (details?.variants || [])) {
    for (const inv of (v?.inventories || [])) {
      hasData = true;
      if (inv.countryCode) countries.add(String(inv.countryCode).toUpperCase());

      const qty = Number(
        inv.totalInventory ?? ((Number(inv.cjInventory) || 0) + (Number(inv.factoryInventory) || 0))
      ) || 0;
      total += qty;

      if (inv.verifiedWarehouse === 1 || inv.verifiedWarehouse === '1') {
        verified = true;
        verifiedTotal += qty;
      }
    }
  }
  return { countries: [...countries], total, verifiedTotal, verified, hasData };
}

module.exports = {
  parseMaxNumber,
  parseWeightGrams,
  parseJsonArray,
  parseProductProps,
  normalizeUrl,
  parseImageList,
  variantVolumeCm3,
  summarizeInventory,
};