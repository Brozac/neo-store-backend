// migrations/003_webauthn_tables.js — F#73 PASSKEYS (MWG passkey guides)
// ============================================================
// الجداول الازمة لـ WebAuthn/Passkeys (نفس مخطط StoredPasskeyCredential
// من دليل modern-web-guidance "passkey-registration"):
//   • webauthn_credentials — البصمات المسجلة (id = base64url credential ID)
//   • webauthn_challenges  — الchallenges الصادرة (TTL 5 دقائق، استعمال واحد)
//
// ليش جدول challenges فـDB ماشي ذاكرة؟ Render كيعاود يشعل العملية
// (spin-down/free tier) — الذاكرة تتمسح وسط الceremony؛ DB كيبقى صالح،
// وكيخدم صح حتى لو كاين أكثر من instance مستقبلا.
//
// ما كاين حتى تعديل على users — صفر مخاطرة على الجداول الموجودة.
//
// Idempotent — آمن تعاود تشغلو. lock_timeout=5s باش ما يحبسش الاستعلامات
// الحية على Neon (نفس قاعدة migrations/001).
//
// تشغيل:   node migrations/003_webauthn_tables.js
// ============================================================
require('dotenv').config();
const pool = require('../db');

const run = async () => {
  const client = await pool.connect();
  try {
    console.log('⏳ F#73 — WebAuthn tables setup...');
    // 🩹 F#95 — كانت \"5s\" بعلامات تنصياق مزدوجة = SQL غير صالح فPostgreSQL (identifier ماشي literal)
    //   → الميغراسيون كانت كتفشل ديما → webauthn_credentials عمرو ما تخلق فالإنتاج (LACLARC-SERVER-14)
    await client.query(`SET lock_timeout = '5s'`);
    await client.query('BEGIN');

    // 1. البصمات المسجلة — id هو الbase64url credential ID (lookup key وحيد)
    await client.query(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id            TEXT PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key    TEXT NOT NULL,
        counter       BIGINT NOT NULL DEFAULT 0,
        transports    TEXT[] NOT NULL DEFAULT '{}',
        device_type   TEXT,
        backed_up     BOOLEAN NOT NULL DEFAULT FALSE,
        aaguid        TEXT,
        name          TEXT NOT NULL DEFAULT 'Passkey',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at  TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);`);

    // 2. الchallenges — نوع الحفل + المستوى المطلوب ديال UV كيتسجل فالسيرفر
    //    (ماشي كيتاكل من client — قاعدة أمان من دليل passkey-authentication)
    await client.query(`
      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        id          TEXT PRIMARY KEY,
        challenge   TEXT NOT NULL UNIQUE,
        type        TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        uv          TEXT NOT NULL DEFAULT 'preferred',
        conditional BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at  TIMESTAMPTZ NOT NULL
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);`);

    await client.query('COMMIT');
    console.log('✅ F#73 — webauthn_credentials + webauthn_challenges ready.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* noop */ }
    console.error('❌ F#73 migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
};

run();
