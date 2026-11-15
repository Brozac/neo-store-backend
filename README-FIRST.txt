
════════════════════════════════════════════════════════════════
  LACLARC BACKEND — CUMULATIVE SENTRY FIXES (F#94 + F#95 + F#96)
  Base ref: f261d86 (aclarc-backend-F79-mergeguard)
  هذا الپتش يستبدل laclarc-backend-sentryfix-F94-95-FROM-f261d86.patch
════════════════════════════════════════════════════════════════

FILES (5):
  server.js                        — F94 (init order, /__sentry_test guard, scrub)
                                     F95 (safeScheduleCron, merge-columns self-guarantee,
                                          Gemini history fix, probe 404 clean)
                                     F96 (antiCloneIp — ipKeyGenerator + cf-header validation)
  db.js                            — F96: pool max 10→6 (PGPOOL_MAX override), idle 45s→30s,
                                     boot config line (Neon session-pooler cap 15)
  migrations/003_webauthn_tables.js— F95: SET lock_timeout '5s' (كان "5s" = SQL invalid
                                     → webauthn_credentials عمرو ما تخلق — SERVER-14)
  routes/webauthn.js               — F95: ensureWebauthnTables() router-level self-guarantee
  services/cjService.js            — F95: ALTER inline self-guarantee (selfHealStuckOrders)

APPLY (من جذر الـ repo):
  git apply laclarc-backend-sentryfix-F94-95-96-FROM-f261d86.patch

GATES (دازو كلهم):
  node --check server.js + db.js ✓
  boot smoke (NODE_ENV=production + stub envs): running ✓ crons مسجلين ✓
    صفر ValidationError ✓ (ERR_ERL_KEY_GEN_IPV6 زال) صفر "[Sentry] express is not instrumented" ✓
    SIGTERM → graceful drain ✓
  dashboard: 24 issues (22 أصليين + 2 جداد EMAXCONNSESSION) كلهم resolved/resolvedInNextRelease

ENV (اختياري):
  SENTRY_TEST_KEY — كي تشفع /__sentry_test?go=1&key=<value> في الإنتاج
  PGPOOL_MAX      — default 6؛ ارجعو 10-12 فقط إلا حولت Neon pooler لtransaction-mode

AFTER DEPLOY:
  - Render Logs كيبان: [DBFIX] pool: max=6 idle=30000ms ...
  - EMAXCONNSESSION يختفي (deploy overlap 6×2=12 ≤ 15 جلسة Neon)
  - SERVER-9/14 وينحلوا أوتوماتيك من أول release جديد بلا أحداث