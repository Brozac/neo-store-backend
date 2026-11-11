@echo off
chcp 65001 >nul
cd /d "%~dp0"
title F54 — Sourcing Table Fix (Sentry SERVER-R)
python f54_sourcing_table_patch.py %*
pause
