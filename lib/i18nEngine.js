// lib/i18nEngine.js — Mission #20: AI Localization Engine
/**
 * 🌐 الترجمة الآلية بـ Gemini — نموذج "الترجمة مرة، للجميع للأبد":
 * أول زائر من بلد جديد → Gemini يترجم → يُخزن في Neon → 
 * كل الزوار اللاحقين يقراؤون من DB — صفر تكلفة تكرار.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pool = require('../db');

if (!process.env.GEMINI_API_KEY) {
  console.warn('🌐 [i18n] GEMINI_API_KEY ناقص — الترجمة الآلية معطلة (fallback: English)');
}
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const LANGUAGES = {
  es: 'Spanish',
  pt: 'Brazilian Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  tr: 'Turkish',
  ar: 'Modern Standard Arabic',
  id: 'Indonesian',
  ja: 'Japanese',
  ko: 'Korean',
};

// بلدان → لغة الواجهة (يُستخدم مع cf-ipcountry)
const COUNTRY_LANG = {
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es',
  BR: 'pt', PT: 'pt',
  FR: 'fr', BE: 'fr',
  DE: 'de', AT: 'de',
  IT: 'it',
  TR: 'tr',
  ID: 'id',
  JP: 'ja', KR: 'ko',
};

function getLangFromCountry(countryCode) {
  return COUNTRY_LANG[(countryCode || '').toUpperCase()] || null;
}

/** ترجمة نص واحد — مع كاش دائم في DB */
async function translateText(text, targetLang) {
  if (!text || !LANGUAGES[targetLang]) return text;
  if (!genAI) return text; // AI معطل — fallback للإنجليزية

  const cacheKey = `${targetLang}:${text}`;
  try {
    const cached = await pool.query(
      'SELECT translated FROM i18n_cache WHERE cache_key = $1',
      [cacheKey]
    );
    if (cached.rows[0]) return cached.rows[0].translated;
  } catch (e) { /* جدول غايب — نكمل للترجمة */ }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `Translate this e-commerce product text to ${LANGUAGES[targetLang]}.
Keep it natural, marketing-friendly, and concise. Return ONLY the translation — no quotes, no explanations:
"${text}"`;

    const result = await model.generateContent(prompt);
    const translated = result.response.text().trim();

    // كاش دائم — صفر تكلفة للاستدعاءات القادمة
    await pool.query(
      `INSERT INTO i18n_cache (cache_key, target_lang, original, translated) 
       VALUES ($1, $2, $3, $4) ON CONFLICT (cache_key) DO NOTHING`,
      [cacheKey, targetLang, text, translated]
    );

    return translated;
  } catch (e) {
    console.warn(`🌐 [i18n] Gemini translate failed: ${e.message}`);
    return text; // فشل = الأصل الإنجليزي (fallback آمن)
  }
}

/** ترجمة منتج كامل (title + description) — كاش على مستوى المنتج */
async function translateProduct(productId, targetLang) {
  if (!LANGUAGES[targetLang] || !genAI) return null;

  // كاش على مستوى المنتج — فحص أولًا
  const existing = await pool.query(
    'SELECT title, description FROM product_translations WHERE product_id = $1 AND lang = $2',
    [productId, targetLang]
  );
  if (existing.rows[0]) return existing.rows[0];

  const { rows } = await pool.query(
    'SELECT title, description FROM products WHERE id = $1',
    [productId]
  );
  const p = rows[0];
  if (!p) return null;

  const title = await translateText(p.title, targetLang);
  const cleanDesc = (p.description || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 500);
  const description = cleanDesc ? await translateText(cleanDesc, targetLang) : null;

  await pool.query(
    `INSERT INTO product_translations (product_id, lang, title, description) 
     VALUES ($1, $2, $3, $4) 
     ON CONFLICT (product_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description`,
    [productId, targetLang, title, description]
  );

  return { title, description };
}

module.exports = { translateText, translateProduct, getLangFromCountry, LANGUAGES };