@echo off
echo ========================================
echo    Tilbi Inno Setup Installer Builder
echo ========================================
echo.

REM Check if Inno Setup is installed
where iscc >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Inno Setup Compiler (iscc.exe) not found in PATH.
  echo.
  echo Please install Inno Setup from: https://jrsoftware.org/isdl.php
  echo And add it to your system PATH, or run this script from Inno Setup's installation directory.
  echo.
  pause
  exit /b 1
)

echo Step 1: Installing dependencies...
if not exist "node_modules" (
  echo Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo.
echo Step 2: Building Electron application...
call npm run build
if errorlevel 1 (
  echo [ERROR] Failed to build Electron application.
  echo.
  pause
  exit /b 1
)

echo.
echo Step 3: Embedding icon into executable...
if exist "embed-icon.js" (
  call node embed-icon.js
  if errorlevel 1 (
    echo [WARNING] Failed to embed icon, but continuing...
  ) else (
    echo [SUCCESS] Icon embedded successfully!
  )
) else (
  echo [INFO] embed-icon.js not found, skipping icon embedding...
)

echo.
echo Step 4: Checking for built files...
if not exist "dist\win-unpacked\Tilbi.exe" (
  echo [ERROR] Built application not found at dist\win-unpacked\Tilbi.exe
  echo Please ensure the build completed successfully.
  echo.
  pause
  exit /b 1
)

echo.
echo Step 5: Compiling Inno Setup installer...
echo.

REM Use the source-based installer (works with built files)
if exist "tilbi-installer.iss" (
  iscc "tilbi-installer.iss"
  if errorlevel 1 (
    echo [ERROR] Failed to compile Inno Setup installer.
    pause
    exit /b 1
  )
  echo.
  echo [SUCCESS] Installer created successfully!
  echo Location: dist\Tilbi-Setup.exe
) else (
  echo [ERROR] Inno Setup script (tilbi-installer.iss) not found.
  pause
  exit /b 1
)

echo.
echo ========================================
echo    Build Complete!
echo ========================================
echo.
pause



