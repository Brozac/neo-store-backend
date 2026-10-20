@echo off
chcp 65001 >nul
echo ============================================
echo  LaClarc Kit 29d — Freight Row Fix (BACKEND)
echo ============================================
echo.
python patch_freight_row.py
if errorlevel 1 (
  echo.
  echo [X] الرقعة ما كملتش — قارن الرسائل فوق
  pause
  exit /b 1
)
echo.
echo [OK] كمل: commit + push → Render redeploy
echo      من بعد شغل: python verify_live_pipeline.py
pause
