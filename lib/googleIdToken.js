// lib/googleIdToken.js — F#74 C2: تحقق من Google ID token بلا أي dependency خارجية
// ============================================================
// 🎯 ليه: /api/auth/social كان كياخد الإيميل خام من الطلب → أي حد معروف بالإيميل
//   كان يقدر ياخد JWT تاعو = ATO كامل. دابا: الهوية كتتحقق من التوقيع (RS256 ضد
//   JWKS الرسمي) + iss/exp/aud/email_verified — الحد الأدنى الموثق من Google:
//   https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken
//
// 🧩 صفر dependencies: crypto.createPublicKey({key: jwk, format:'jwk'}) + fetch (Node 18+)
// 📦 كاش JWKS ساعة + إعادة جلب قسرية ملي kid ما لقيناش (دوران مفاتيح Google)
// ❌ كيرمي Error مع message واضح — المستدعي كيرجم 401 (fail-closed)
// ============================================================
const crypto = require('crypto');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 60 * 60 * 1000;      // ساعة — أكثر من كافية لعمر id_token (دقائق)
const CLOCK_SKEW_S = 60;                 // تسامح الساعة
const ALLOWED_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);

let _jwksCache = null; // { keys, at }

async function _fetchJwks(force = false) {
  if (!force && _jwksCache && Date.now() - _jwksCache.at < JWKS_TTL_MS) return _jwksCache.keys;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(JWKS_URL, { signal: ac.signal });
    if (!r.ok) throw new Error(`JWKS HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.keys) || !j.keys.length) throw new Error('JWKS بلا مفاتيح');
    _jwksCache = { keys: j.keys, at: Date.now() };
    return _jwksCache.keys;
  } finally {
    clearTimeout(t);
  }
}

function _b64urlJson(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

function _verifyRs256(signedPart, sigSeg, jwk) {
  const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  const sig = Buffer.from(sigSeg, 'base64url');
  return crypto.createVerify('RSA-SHA256').update(signedPart).verify(key, sig);
}

/**
 * يتحقق من id_token تاع Google ويرجع الهوية المثبتة.
 * @param {string} idToken - JWT من Google (account.id_token من NextAuth ولا credential من GIS)
 * @param {{audience: string}} opts - GOOGLE_CLIENT_ID إجباري (aud check)
 * @returns {Promise<{email: string, name: string, sub: string}>}
 * @throws {Error} أي فشل تحقق — fail-closed
 */
async function verifyGoogleIdToken(idToken, { audience } = {}) {
  if (!audience) throw new Error('audience (GOOGLE_CLIENT_ID) مطلوب للتحقق');
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) throw new Error('idToken ناقص/شاذ');

  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('شكل JWT خاطئ');

  let header, payload;
  try {
    header = _b64urlJson(parts[0]);
    payload = _b64urlJson(parts[1]);
  } catch {
    throw new Error('header/payload غير قابلين للقراءة');
  }

  // 1) alg = RS256 صلب (منع alg:none و HS256-confusion على أي حال)
  if (String(header.alg) !== 'RS256') throw new Error(`alg غير مسموح: ${header.alg}`);

  // 2) claims — قبل التوقيع (أرخص رفض للقيم السخيفة)
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now > Number(payload.exp) + CLOCK_SKEW_S) throw new Error('التوكن منتهي (exp)');
  if (payload.iat && Number(payload.iat) > now + CLOCK_SKEW_S) throw new Error('iat فالمستقبل');
  if (!ALLOWED_ISS.has(String(payload.iss))) throw new Error(`iss غير متوقع: ${payload.iss}`);
  if (String(payload.aud) !== String(audience)) throw new Error('aud ≠ GOOGLE_CLIENT_ID (توكن لتطبيق آخر)');
  if (payload.email_verified !== true) throw new Error('الإيميل غير مُوثق عند Google (email_verified)');
  if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email))) throw new Error('إيميل غير صالح');

  // 3) التوقيع — kid → JWKS (إعادة جلب قسرية مرة واحدة إلا kid ما لقيناش)
  let keys = await _fetchJwks(false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    keys = await _fetchJwks(true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) throw new Error(`kid غير موجود فـ JWKS: ${header.kid}`);
  if (!_verifyRs256(`${parts[0]}.${parts[1]}`, parts[2], jwk)) throw new Error('التوقيع RSA-SHA256 خاطئ');

  return {
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || '').slice(0, 100),
    sub: String(payload.sub || ''),
  };
}

module.exports = { verifyGoogleIdToken };
