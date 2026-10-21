@echo off
chcp 65001 >nul
cd /d "%~dp0"
python verify_cj_pid_health.py %*
pause
