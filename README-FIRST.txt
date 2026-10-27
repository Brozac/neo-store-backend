PATCH-1FILE: laclarc-backend-corsfix (F#33)
═══════════════════════════════════════════════
إلا فشل git apply (سطور تبدلت عندك): هاد server.js كامل
هو نسخة CRON-THIN (70c1aa2) + الپتش — عوّض الملف ديالك بيه مباشرة.

بعد التبديل:
  node --check server.js
  git add server.js && git commit -m "corsfix" && git push
  Render env → CORS_ORIGINS = https://laclarc.com,https://laclarc.xaanabroza75.workers.dev
  (FRONTEND_URL ما كتبدلش)
