@echo off
chcp 65001 >nul
echo ═══════════════════════════════════════════════════
echo   LaClarc Kit v25 [visibility-persist] — BACKEND
echo   إصلاح: غرفة التحكم في الظهور — save كيبقى محفوظ
echo ═══════════════════════════════════════════════════
where python >nul 2>nul
if errorlevel 1 (
  echo ❌ Python ما لقيتوش — ركبو ولا استعمل: py fix_visibility_settings.py
  pause
  exit /b 1
)
python fix_visibility_settings.py %*
if errorlevel 1 (
  echo.
  echo ❌ الرقعة ما ركبتش — اقرا الرسالة فوق
  echo    حل احتياطي: python fix_visibility_settings.py --full
  pause
  exit /b 1
)
echo.
echo ✅ سالينا. دابا شغّل: PUSH-DEPLOY.bat
pause
