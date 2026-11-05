@echo off
chcp 65001 >nul
echo ═══════════════════════════════════════════════════
echo   PUSH → Render Deploy (visibility-persist v25)
echo ═══════════════════════════════════════════════════
cd /d "%~dp0"
if not exist ".git" (
  echo ❌ هاد المجلد ماشي git repo — دير الكيت فمجلد الباكند نفسو.
  pause
  exit /b 1
)
git add server.js
git status --short server.js
git commit -m "visibility-persist v25: settings GETs serve hidden_routes/hidden_sections + PUT guards"
git push
echo.
echo ✅ تدفعو — Render كيبني أوتوماتيك (~دقيقتين).
echo    شوف داشبورد Render حتى يولي: Deploy live
echo    من بعد جرب: /admin/visibility → حبس فرع → save → عاود دخّل = باق 💪
pause
