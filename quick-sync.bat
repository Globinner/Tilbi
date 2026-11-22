@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo  QUICK UPDATE (fast - ~30 seconds)
echo ========================================

if not exist "dist\win-unpacked\Tilbi.exe" (
  echo ERROR: Run "npm run build" once first to create dist\win-unpacked
  exit /b 1
)

if not exist "dist\win-unpacked\resources\app.asar" (
  echo ERROR: app.asar missing. Run "npm run build" once first.
  exit /b 1
)

set "STAGE=%TEMP%\tilbi-asar-update"
set "ASAR=dist\win-unpacked\resources\app.asar"

echo [1/3] Extracting app.asar...
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
call npx asar extract "%ASAR%" "%STAGE%"
if errorlevel 1 (
  echo ERROR: Failed to extract app.asar
  exit /b 1
)

echo [2/3] Overlaying latest source files only...
copy /Y "index.js" "%STAGE%\"
copy /Y "popup.html" "%STAGE%\"
copy /Y "electron-package.json" "%STAGE%\package.json"
copy /Y "subscription.js" "%STAGE%\" 2>nul
copy /Y "coupons-catalog.json" "%STAGE%\" 2>nul
copy /Y "*.html" "%STAGE%\"
copy /Y "*.js" "%STAGE%\"
copy /Y "*.svg" "%STAGE%\" 2>nul
copy /Y "*.mp3" "%STAGE%\" 2>nul
copy /Y "*.wav" "%STAGE%\" 2>nul
if exist "base.css" copy /Y "base.css" "%STAGE%\"
xcopy /E /Y /I /Q "icons" "%STAGE%\icons"
xcopy /E /Y /I /Q "fonts" "%STAGE%\fonts"
if exist "themes" xcopy /E /Y /I /Q "themes" "%STAGE%\themes"
if exist "%STAGE%\node_modules\next" rmdir /s /q "%STAGE%\node_modules\next"
if exist "%STAGE%\node_modules\react" rmdir /s /q "%STAGE%\node_modules\react"
if exist "%STAGE%\node_modules\react-dom" rmdir /s /q "%STAGE%\node_modules\react-dom"

echo [3/3] Repacking app.asar + icon...
call npx asar pack "%STAGE%" "%ASAR%"
if errorlevel 1 (
  echo ERROR: Failed to pack app.asar
  exit /b 1
)
if not exist "dist\win-unpacked\resources" mkdir "dist\win-unpacked\resources"
copy /Y "app-update.yml" "dist\win-unpacked\resources\app-update.yml"
rmdir /s /q "%STAGE%"
if exist "dist\win-unpacked\Tilbi-patched.exe" del /F /Q "dist\win-unpacked\Tilbi-patched.exe"
if exist "dist\win-unpacked\Tilbi.lnk" del /F /Q "dist\win-unpacked\Tilbi.lnk"
node embed-icon.js
node polish-dist.js

echo.
echo DONE - dist updated in seconds, not minutes.
echo Run dist\win-unpacked\Tilbi.exe OR reinstall with dist\Tilbi-Setup.exe
if /i not "%~1"=="nopause" pause
exit /b 0
