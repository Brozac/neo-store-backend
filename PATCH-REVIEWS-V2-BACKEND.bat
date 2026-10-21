@echo off
chcp 65001 >nul
echo ═══════════════════════════════════════════════════
echo   LaClarc Kit 36 [cj-reviews-v2] — BACKEND (server.js)
echo ═══════════════════════════════════════════════════
where python >nul 2>nul
if errorlevel 1 (
  echo ❌ Python ما لقيتوش — ركبو ولا استعمل: python3 patch_reviews_v2_backend.py
  pause
  exit /b 1
)
python patch_reviews_v2_backend.py %*
if errorlevel 1 (
  echo.
  echo ❌ الرقعة ما ركبتش — اقرا الرسالة فوق
  echo    إلا كان انجراف: صيفط مجلد kit36-diag للمطور
  pause
  exit /b 1
)
echo.
echo ✅ ركب. الخطوات:
echo    1. node --check server.js
echo    2. git add . ثم commit ثم push
echo    3. Render redeploy
echo    4. python verify_reviews_v2.py
echo    ثم دوز للفرونت: PATCH-REVIEWS-V2-FRONTEND.bat
pause
