@echo off
chcp 65001 >nul
echo ═══════════════════════════════════════════════
echo  LaClarc كيت 30 [card-swatches] — backend
echo ═══════════════════════════════════════════════
python patch_card_swatches.py --backend .
if errorlevel 1 (
  echo.
  echo ❌ التركيب فشل — شوف kit30-diag/ والـ README-CARD-SWATCHES.txt
  pause
  exit /b 1
)
echo.
echo ✅ مكتمل. خدم verify_card_swatches.py باش تتأكد، من بعد push.
pause
