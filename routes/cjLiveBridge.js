// routes/cjLiveBridge.js - Laclarc Live Bridge (v1 rebuild)
// ============================================================
// M#25 rebuild — CJ live sourcing with v3.1 pricing law:
//   • search  : CJ global search → laclarcPrice (est. 500g) per result
//   • product : CJ details → laclarcPrice (real weight) + XSS-shielded desc
//   • الـ variants كتمرر خام — الإضافة للسلة كتدير أول variant vid
// نقاط CJ: كتخصم من الحساب — محمي بـ rate limiter (R2)
// ============================================================
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { cjRequest } = require('../services/cjService');
const { calculateSellingPrice, sanitizeDescription } = require('../services/productImportService');
const { parseMaxNumber, parseWeightGrams, parseJsonArray, parseImageList } = require('../utils/cjNormalize');

const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';

// ── Rate limiter مبني — 20 بحث/10 دقائق/IP (نفس عائلة second-shot) ──
const buckets = new Map();
function limiter(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const b = buckets.get(ip) || [];
  const fresh = b.filter(t => now - t < 10 * 60 * 1000);
  if (fresh.length >= 20) {
    return res.status(429).json({ error: 'Too many searches. Try again later.' });
  }
  fresh.push(now);
  buckets.set(ip, fresh);
  // GC خفيف — ما كينموش الذاكرة
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.every(t => now - t > 10 * 60 * 1000)) buckets.delete(k);
  }
  next();
}

// ═══ GET /api/cj-live/search?q=&page= ═══
router.get('/search', limiter, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (q.length < 2) return res.json({ products: [] });

    const r = await cjRequest((token, config) =>
      axios.get(`${CJ_API}/product/list`, {
        ...config,
        headers: { 'CJ-Access-Token': token },
        params: { keyword: q, pageNum: page, pageSize: 20 },
        timeout: 15000,
      })
    );

    const list = r?.data?.data?.list || [];
    const products = list.map(p => {
      // 💰 v3.1 — التسعير المقدر (بلا وزن في الـ list — التفاصيل كتجيب الحقيقي)
      const cost = parseMaxNumber(p.sellPrice);
      const { safePrice } = calculateSellingPrice(cost, 500);
      return {
        pid: String(p.pid || ''),
        title: p.productNameEn || '',
        price: parseMaxNumber(p.sellPrice),        // كلفة CJ (للعرض الداخلي فقط)
        laclarcPrice: safePrice,                    // 💰 السعر اللي كيشوفه الزبون
        image: p.productImage || p.bigImage || '',
        ordersCount: parseInt(p.ordersCount, 10) || 0,
      };
    }).filter(p => p.pid);

    return res.json({ products, page, hasMore: list.length >= 20 });
  } catch (e) {
    console.error('[cj-live/search]', e.message);
    return res.status(502).json({ error: 'CJ unavailable' });
  }
});

// ═══ GET /api/cj-live/product/:pid ═══
router.get('/product/:pid', async (req, res) => {
  try {
    const pid = String(req.params.pid || '').trim();
    if (!pid || pid.length < 5) return res.status(400).json({ error: 'Bad pid' });

    const r = await cjRequest((token, config) =>
      axios.get(`${CJ_API}/product/query`, {
        ...config,
        headers: { 'CJ-Access-Token': token },
        params: { pid, features: 'enable_video' },
        timeout: 15000,
      })
    );

    const d = r?.data?.data;
    if (!d || !d.pid) return res.status(404).json({ error: 'Product not found' });

    // 💰 v3.1 — الوزن الحقيقي + أول variant = السعر المعروض
    const weight = Math.max(parseWeightGrams(d.productWeight), parseWeightGrams(d.packingWeight));
    const v0 = (Array.isArray(d.variants) && d.variants[0]) || {};
    const cost = parseMaxNumber(v0.variantSellPrice) || parseMaxNumber(d.sellPrice) || 0;
    const { safePrice } = calculateSellingPrice(cost, weight);

    return res.json({
      pid: String(d.pid),
      title: d.productNameEn || '',
      description: sanitizeDescription(d.description || ''), // 🔒 XSS shield
      bigImage: d.bigImage || '',
      images: parseImageList(d, { includeVariantImages: false, max: 12 }),
      variants: (d.variants || []).map(v => ({
        vid: v.vid,
        variantKey: v.variantKey || '',
        variantSellPrice: parseMaxNumber(v.variantSellPrice), // كلفة CJ للـ variant
        // 💰 سعر البيع لكل variant — نستعملو في Add-to-Cart
        laclarcVariantPrice: calculateSellingPrice(parseMaxNumber(v.variantSellPrice), weight).safePrice,
      })),
      sellPrice: parseMaxNumber(d.sellPrice),
      laclarcPrice: safePrice,     // 💰 السعر الرسمي المعروض — هامش 35% محمي
      original_price: null,        // قرار 1 — بلا strikethrough مولّد
      estimatedShipUsd: +(5 + Math.max(weight, 50) / 1000 * 4).toFixed(2),
      weightGrams: weight,
    });
  } catch (e) {
    console.error('[cj-live/product]', e.message);
    return res.status(502).json({ error: 'CJ unavailable' });
  }
});

module.exports = router;