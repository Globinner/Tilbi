@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Please install Node.js LTS from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] npm is not installed or not on PATH.
  echo         Ensure Node.js installation added npm to PATH, then reopen this window.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm ci --no-audit --no-fund 2>nul
  if errorlevel 1 (
    echo npm ci failed, retrying with npm install...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
      echo.
      echo [ERROR] Failed to install dependencies.
      echo         Try running: npm install
      echo.
      pause
      exit /b 1
    )
  )
)

echo Starting Tilbi...
call npm run start
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to start Electron (npm run start).
  echo         Try running this window as Administrator or run: npm run start
  echo.
  pause
  exit /b 1
)
