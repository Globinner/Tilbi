@echo off
cd /d "C:\Users\davin\Desktop\Tilbi"

echo ========================================
echo  UPDATING TILBI BUILD
echo ========================================

echo.
echo [1/4] Removing old app.asar...
del /f "dist\win-unpacked\resources\app.asar" 2>nul

echo [2/4] Creating app folder...
mkdir "dist\win-unpacked\resources\app" 2>nul

echo [3/4] Copying files...
copy /Y "index.js" "dist\win-unpacked\resources\app\"
copy /Y "popup.html" "dist\win-unpacked\resources\app\"
copy /Y "package.json" "dist\win-unpacked\resources\app\"
copy /Y "*.html" "dist\win-unpacked\resources\app\"
copy /Y "*.js" "dist\win-unpacked\resources\app\"
copy /Y "*.mp3" "dist\win-unpacked\resources\app\" 2>nul
copy /Y "*.wav" "dist\win-unpacked\resources\app\" 2>nul
xcopy /E /Y /I /Q "node_modules" "dist\win-unpacked\resources\app\node_modules"
xcopy /E /Y /I /Q "icons" "dist\win-unpacked\resources\app\icons"
xcopy /E /Y /I /Q "fonts" "dist\win-unpacked\resources\app\fonts"

echo [4/4] Done!
echo.
echo ========================================
echo  BUILD UPDATED - Now compile with Inno Setup
echo ========================================
pause

