@echo off
chcp 65001 >nul
echo ============================================
echo  LaClarc Kit 29c — Geo Warehouse Fix (BACKEND)
echo ============================================
echo.
python patch_geo_warehouse.py
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
