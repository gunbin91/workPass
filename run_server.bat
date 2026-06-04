@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo =========================================
echo 🚀 QR 자동 출석체크 [웹 서버] 실행
echo =========================================
echo.

node server.js

pause
