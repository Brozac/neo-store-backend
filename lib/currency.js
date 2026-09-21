// lib/currency.js — Multi-Currency Engine (Mission #19)
const axios = require('axios');

const FX_CACHE = new Map(); // currency → { rate, ts }
const FX_TTL = 60 * 60 * 1000; // ساعة

const SUPPORTED = [
  { code: 'USD', symbol: '$' },
  { code: 'EUR', symbol: '€' },
  { code: 'GBP', symbol: '£' },
  { code: 'DZD', symbol: 'DA' },
  { code: 'SAR', symbol: '﷼' },
  { code: 'AED', symbol: 'د.إ' },
  { code: 'BRL', symbol: 'R$' },
  { code: 'MXN', symbol: 'MX$' },
];

const COUNTRY_CURRENCY = {
  DZ: 'DZD', FR: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR',
  GB: 'GBP', SA: 'SAR', AE: 'AED', QA: 'QAR', KW: 'KWD',
  BR: 'BRL', MX: 'MXN', US: 'USD', CA: 'CAD', AU: 'AUD',
};

async function getRate(currency) {
  if (currency === 'USD') return 1;
  const cached = FX_CACHE.get(currency);
  if (cached && Date.now() - cached.ts < FX_TTL) return cached.rate;

  try {
    const res = await axios.get(
      `https://api.exchangerate.host/latest?base=USD&symbols=${currency}`,
      { timeout: 8000 }
    );
    const rate = res.data?.rates?.[currency];
    if (rate) {
      FX_CACHE.set(currency, { rate, ts: Date.now() });
      return rate;
    }
  } catch (e) {
    console.warn(`💱 [FX] ${currency} fetch failed: ${e.message}`);
  }
  return cached?.rate || 1;
}

async function detectAndConvert(usdAmount, country) {
  const currency = COUNTRY_CURRENCY[country?.toUpperCase()] || 'USD';
  const rate = await getRate(currency);
  const meta = SUPPORTED.find(s => s.code === currency);
  return {
    country,
    currency,
    rate,
    symbol: meta?.symbol || currency,
    localAmount: parseFloat((usdAmount * rate).toFixed(2)),
  };
}

module.exports = { getRate, detectAndConvert, SUPPORTED, COUNTRY_CURRENCY };