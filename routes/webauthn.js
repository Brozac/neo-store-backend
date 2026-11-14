// routes/webauthn.js — F#73 PASSKEYS (WebAuthn endpoints)
// ============================================================
// المصادقة بالـ Passkeys حسب أدلة modern-web-guidance:
//   passkeys (orientation) · passkey-registration · passkey-authentication
//   passkey-management · passkey-conditional-create
//
// القواعد المطبقة حرفيا من الأدلة:
//   • مكتبة vetted على السيرفر فقط (@simplewebauthn/server v14) — بلا hand-rolled crypto
//   • RP ID ثابت من env (PASSKEY_RP_ID، default laclarc.com) — لا مشتقة من الorigin
//   • expectedOrigin كمصفوفة (apex + www) — v14 كيقبل string[]
//   • الchallenge فجدول DB (استعمال واحد ذريا عبر DELETE...RETURNING + TTL 5 دقائق)
//   • residentKey: required + userVerification: preferred + attestation: none
//   • promotion flag → authenticatorAttachment: platform (flow الترقية بعد الpassword)
//   • verifyRegistrationResponse مع requireUserVerification:false (لأننا طلبنا preferred —
//     قاعدة الدليل الحرفية: وإلا authenticators بلا قفل شاشة كيرميو فشل زائف)
//   • requireUserPresence:false فقط للثنائيات المولدة بconditional-create (دليل conditional-create §5)
//   • login/verify كيرجع 404 على credential مجهول → الclient يطلق Signal API
//   • JWT نفس شكل /api/login بالضبط ({id,name} · 7d) — توافق كامل مع الواجهة
//   • passkeys كتخدم حتى لحسابات Google-social (password_hash NULL) بلا أي تعديل users
//   • CRUD ديال البصمات كيرجع rpId + userId(base64url) — الclient عمره ما يخمن الrpId من hostname
// ============================================================
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const pool = require('../db');
const logger = require('../logger');
const { auditEvent } = require('../services/cjService');

// ─── الإعدادات — ثوابت من env مع defaults آمنة ───────────────────────────
const RP_ID = process.env.PASSKEY_RP_ID || 'laclarc.com';
const RP_NAME = process.env.PASSKEY_RP_NAME || 'Laclarc';
const EXPECTED_ORIGINS = (process.env.PASSKEY_ORIGINS || 'https://laclarc.com,https://www.laclarc.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CHALLENGE_TTL_MINUTES = 5;

// ─── Rate limits — منفصلين عن authLimiter (10/15m) ───────────────────────
// login/options كيتطلع أوتوماتيكيا فكل تحميل ديال صفحة /auth (conditional UI)
// → لو خدمنا authLimiter لاحرقنا المحاولات على الuser بلا ما يدخل شي حاجة
const optionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again after 15 minutes.' },
});
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Too many attempts, please try again after 15 minutes.' },
});

// ─── نفس middleware تاع server.js (Bearer JWT) — مكتفية ذاتيا ─────────────
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access Denied: No token provided' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// ─── أدوات ────────────────────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const userHandleB64u = (userId) => b64u(String(userId)); // نفس user.id المستعمل فالتسجيل — مستقر للحساب

// استخراج الchallenge من clientDataJSON (الرد ديال credential.toJSON() مهما كان الحفل)
function extractChallenge(webauthnResponse) {
  try {
    const cdj = webauthnResponse && webauthnResponse.response && webauthnResponse.response.clientDataJSON;
    if (!cdj || typeof cdj !== 'string') return null;
    const data = JSON.parse(Buffer.from(cdj, 'base64url').toString('utf8'));
    return typeof data.challenge === 'string' ? data.challenge : null;
  } catch (e) {
    return null;
  }
}

// استهلاك ذري للchallenge: DELETE...RETURNING = استعمال واحد مضمون حتى مع سباق طلبات
async function consumeChallenge(challenge, type) {
  const r = await pool.query(
    `DELETE FROM webauthn_challenges
      WHERE challenge = $1 AND type = $2 AND expires_at > now()
      RETURNING user_id, uv, conditional`,
    [challenge, type]
  );
  return r.rows[0] || null;
}

// تنظيف الchallenges الفاسدة (خفيف — كيتشغل مع كل options request)
function pruneExpiredChallenges() {
  pool.query('DELETE FROM webauthn_challenges WHERE expires_at < now()').catch(() => {});
}

function logError(context, err) {
  try { Sentry.captureException(err); } catch (__laclarcGuard) {}
  logger.logError(context, err);
}

// ══════════════════════════════════════════════════════════════════════════
// التسجيل — POST /api/auth/passkey/register/options (يتطلب Bearer JWT)
// body اختياري: { promotion?: bool, conditional?: bool }
// ══════════════════════════════════════════════════════════════════════════
router.post('/api/auth/passkey/register/options', authenticateToken, optionsLimiter, async (req, res) => {
  pruneExpiredChallenges();
  try {
    const userId = req.user.id;
    const promotion = req.body && req.body.promotion === true;
    const conditional = req.body && req.body.conditional === true;

    // الJWT ديال /api/login فيه id+name فقط — email كيجي من DB (وحسابات social كيحتاجوه)
    const userRes = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    const dbUser = userRes.rows[0];

    // excludeCredentials — منع تسجيل نفس الpasskey مرتين (دليل registration §3)
    const existing = await pool.query(
      'SELECT id, transports FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: dbUser.email || String(userId),
      userID: Buffer.from(String(userId), 'utf8'), // handle مستقر للحساب — عمره ما random
      userDisplayName: dbUser.name || '',
      attestationType: 'none',
      excludeCredentials: existing.rows.map((c) => ({
        id: c.id,
        transports: Array.isArray(c.transports) ? c.transports : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'required',      // discoverable — ضروري للدخول بلا username (دليل registration §4)
        requireResidentKey: true,
        userVerification: 'preferred',
        // flow الترقية بعد password → platform؛ flow الإدارة → نسيبه (security keys مسموحة)
        ...(promotion && !conditional ? { authenticatorAttachment: 'platform' } : {}),
      },
    });

    const challengeId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO webauthn_challenges (id, challenge, type, user_id, uv, conditional, expires_at)
       VALUES ($1, $2, 'registration', $3, 'preferred', $4, now() + interval '${CHALLENGE_TTL_MINUTES} minutes')`,
      [challengeId, options.challenge, userId, conditional]
    );

    // ملاحظة: الchallenge كيتحفظ فالجدول مربوط بالمستخدم — الverify كيقرا الflags
    // (conditional) من الجدول ماشي من الclient (قاعدة الأمان من دليل passkey-authentication §16)
    return res.json(options); // PublicKeyCredentialCreationOptionsJSON — جاهز لـparseCreationOptionsFromJSON
  } catch (err) {
    logError('Passkey Register Options', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/auth/passkey/register/verify (يتطلب Bearer JWT) — body = credential.toJSON()
// ══════════════════════════════════════════════════════════════════════════
router.post('/api/auth/passkey/register/verify', authenticateToken, verifyLimiter, async (req, res) => {
  try {
    const body = req.body;
    const challenge = extractChallenge(body);
    if (!challenge) return res.status(400).json({ error: 'Invalid registration response.' });

    const row = await consumeChallenge(challenge, 'registration');
    if (!row) return res.status(400).json({ error: 'Challenge expired or already used. Please retry.' });
    if (row.user_id !== req.user.id) {
      return res.status(400).json({ error: 'Challenge does not belong to this account.' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: challenge,
        expectedOrigin: EXPECTED_ORIGINS, // apex + www — v14 كيقبل مصفوفة
        expectedRPID: RP_ID,
        requireUserVerification: false, // طلبنا 'preferred' — قاعدة الدليل الحرفية (registration §83)
        requireUserPresence: !row.conditional, // relaxation فقط للconditional-create (conditional-create §5)
      });
    } catch (verifyErr) {
      logger.logError('Passkey Register Verify', verifyErr);
      return res.status(400).json({ error: 'Registration verification failed.' });
    }

    const { verified } = verification;
    if (!verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Registration verification failed.' });
    }

    const info = verification.registrationInfo;
    const transports = (body.response && Array.isArray(body.response.transports)) ? body.response.transports : [];

    // ON CONFLICT — إعادة تسجيل نفس الcredential كتعوض السجل (نمط SimpleWebAuthn الرسمي)
    await pool.query(
      `INSERT INTO webauthn_credentials
         (id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Passkey')
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         public_key = EXCLUDED.public_key,
         counter = EXCLUDED.counter,
         transports = EXCLUDED.transports,
         device_type = EXCLUDED.device_type,
         backed_up = EXCLUDED.backed_up,
         aaguid = EXCLUDED.aaguid`,
      [
        info.credentialID,                       // base64url — مفتاح البحث الوحيد
        req.user.id,
        b64u(Buffer.from(info.credentialPublicKey)),
        info.counter || 0,
        transports,
        info.credentialDeviceType || null,       // singleDevice | multiDevice
        info.credentialBackedUp === true,
        info.aaguid || null,
      ]
    );

    auditEvent('PASSKEY_REGISTERED', req.user.id, {
      aaguid: info.aaguid || null,
      deviceType: info.credentialDeviceType || null,
      backedUp: info.credentialBackedUp === true,
      conditional: row.conditional === true,
    }, 'info').catch(() => {});

    return res.json({ verified: true });
  } catch (err) {
    logError('Passkey Register Verify', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// الدخول — POST /api/auth/passkey/login/options (عام — قبل المصادقة)
// allowCredentials: [] = discoverable credentials → دخول بلا username (دليل authentication §14)
// ══════════════════════════════════════════════════════════════════════════
router.post('/api/auth/passkey/login/options', optionsLimiter, async (req, res) => {
  pruneExpiredChallenges();
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: [],
      userVerification: 'preferred',
    });

    await pool.query(
      `INSERT INTO webauthn_challenges (id, challenge, type, user_id, uv, conditional, expires_at)
       VALUES ($1, $2, 'authentication', NULL, $3, FALSE, now() + interval '${CHALLENGE_TTL_MINUTES} minutes')`,
      [crypto.randomUUID(), options.challenge, options.userVerification || 'preferred']
    );

    // المستوى ديال UV كيتسجل فالسيرفر — الverify كيفرضه بلا اعتماد على الclient
    return res.json(options); // PublicKeyCredentialRequestOptionsJSON — جاهز لـparseRequestOptionsFromJSON
  } catch (err) {
    logError('Passkey Login Options', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/auth/passkey/login/verify (عام + rate limit) — body = credential.toJSON()
// الرد نفس شكل /api/login بالضبط → الواجهة كتخزن token/user_data بنفس الطريقة
// ══════════════════════════════════════════════════════════════════════════
router.post('/api/auth/passkey/login/verify', verifyLimiter, async (req, res) => {
  try {
    const body = req.body;
    const credentialId = body && typeof body.id === 'string' ? body.id : null;
    const challenge = extractChallenge(body);
    if (!credentialId || !challenge) return res.status(400).json({ message: 'Invalid authentication response.' });

    const row = await consumeChallenge(challenge, 'authentication');
    if (!row) return res.status(400).json({ message: 'Challenge expired or already used. Please retry.' });

    const credRes = await pool.query(
      'SELECT id, user_id, public_key, counter, transports FROM webauthn_credentials WHERE id = $1',
      [credentialId]
    );
    // 404 صريح = إشارة معروفة للclient باش يطلق signalUnknownCredential (دليل authentication §38)
    if (credRes.rows.length === 0) return res.status(404).json({ message: 'Credential not found.' });
    const cred = credRes.rows[0];

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: challenge,
        expectedOrigin: EXPECTED_ORIGINS,
        expectedRPID: RP_ID,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
          counter: Number(cred.counter) || 0,
          transports: Array.isArray(cred.transports) ? cred.transports : undefined,
        },
        requireUserVerification: row.uv === 'required', // 'preferred' مسجل فالسيرفر → relaxation صحيح
      });
    } catch (verifyErr) {
      // counter تراجع = clone suspicion → نفس الرد العام (بلا كشف السبب)
      logger.logError('Passkey Login Verify', verifyErr);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!verification.verified) return res.status(401).json({ message: 'Invalid credentials' });

    const info = verification.authenticationInfo;
    await pool.query(
      `UPDATE webauthn_credentials
          SET counter = $1, last_used_at = now(), backed_up = $2, device_type = $3
        WHERE id = $4`,
      [info.newCounter || 0, info.credentialBackedUp === true, info.credentialDeviceType || null, cred.id]
    );

    const userRes = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [cred.user_id]);
    if (userRes.rows.length === 0) return res.status(404).json({ message: 'Credential not found.' });
    const user = userRes.rows[0];

    // JWT مطابق تماما لـ/api/login — حتى حسابات Google-social (بلا password) كيدخلو هنا
    const token = jwt.sign({ id: user.id, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });

    auditEvent('PASSKEY_LOGIN', user.id, {
      credentialId: String(cred.id).slice(0, 8) + '…',
      backedUp: info.credentialBackedUp === true,
    }, 'info').catch(() => {});

    return res.json({
      message: 'Logged in successfully',
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    logError('Passkey Login Verify', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// الإدارة — دليل passkey-management (CRUD + rpId + userId base64url مع كل رد)
// ══════════════════════════════════════════════════════════════════════════

// GET — قائمة بصمات المستخدم (+ rpId وuserId باش الclient يطلق Signal API صح)
router.get('/api/auth/passkey/credentials', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, aaguid, transports, device_type, backed_up, counter, created_at, last_used_at
         FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json({
      rpId: RP_ID,
      userId: userHandleB64u(req.user.id), // base64url بلا padding — صالح للSignal API
      credentials: r.rows.map((c) => ({
        id: c.id,
        name: c.name,
        aaguid: c.aaguid || null,
        transports: Array.isArray(c.transports) ? c.transports : [],
        deviceType: c.device_type || null,
        backedUp: c.backed_up === true,
        registeredAt: c.created_at ? new Date(c.created_at).getTime() : null,
        lastUsedAt: c.last_used_at ? new Date(c.last_used_at).getTime() : null,
      })),
    });
  } catch (err) {
    logError('Passkey List', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PUT — إعادة تسمية (label فالسيرفر فقط — ما كيطلقش signalCurrentUserDetails، دليل management §72)
router.put('/api/auth/passkey/credentials/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const name = typeof req.body && req.body.name === 'string' ? req.body.name.trim().slice(0, 50) : '';
    if (!name) return res.status(400).json({ error: 'A name is required.' });

    const cred = await pool.query('SELECT id FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (cred.rows.length === 0) return res.status(404).json({ error: 'Credential not found.' });

    await pool.query('UPDATE webauthn_credentials SET name = $1 WHERE id = $2', [name, id]);
    return res.json({ success: true, name });
  } catch (err) {
    logError('Passkey Rename', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// DELETE — حذف بصمة (الclient من بعد كيطلق signalAllAcceptedCredentials بالمتبقي)
router.delete('/api/auth/passkey/credentials/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const cred = await pool.query('SELECT id FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (cred.rows.length === 0) return res.status(404).json({ error: 'Credential not found.' });

    await pool.query('DELETE FROM webauthn_credentials WHERE id = $1', [id]);
    auditEvent('PASSKEY_DELETED', req.user.id, { credentialId: String(id).slice(0, 8) + '…' }, 'info').catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    logError('Passkey Delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
