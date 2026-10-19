@echo off
chcp 65001 >nul
title Laclarc Kit 27 - CJ Live Shipping Estimate
cd /d "%~dp0"

echo.
echo ============================================
echo   Kit 27 - CJ Live Shipping + Points Monitor
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [FAIL] python not found in PATH - install python or use: py patch_cj_shipping.py
    pause
    exit /b 1
)

python patch_cj_shipping.py
if errorlevel 1 (
    echo.
    echo [FAIL] patch aborted - your files are UNCHANGED (safe).
    echo Read the message above: an anchor did not match = your code
    echo version differs from what this kit expects. Contact Z.ai.
    pause
    exit /b 1
)

echo.
echo [NEXT] cd to your backend repo if not already there, then:
echo        git add services/cjService.js server.js
echo        git commit -m "Kit27: live shipping estimate + CJ points monitor"
echo        git push    (Render rebuilds automatically)
echo        after deploy: python verify_shipping_estimate.py
echo.
echo Backups created: *.bak-cjkit27 (delete them after deploy is verified)
echo.
pause
