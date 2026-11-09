@echo off
cd /d "%~dp0server"
if not exist node_modules call npm install --no-audit --no-fund
start "" /MIN cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3001/admin"
echo Opened http://127.0.0.1:3001/admin
echo Owner coupon page: http://127.0.0.1:3001/admin
if /i not "%~1"=="nopause" pause
