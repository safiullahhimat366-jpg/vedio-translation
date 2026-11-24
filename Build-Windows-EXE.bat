@echo off
setlocal
cd /d "%~dp0"
title SadaVox Studio - Build Standalone Windows EXE
set CSC_IDENTITY_AUTO_DISCOVERY=false

echo ============================================================
echo   SadaVox Studio - Standalone Windows EXE Builder
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required to build the .exe package.
  echo Please install Node.js LTS from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo [1/5] Installing project dependencies...
  call npm install --legacy-peer-deps --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo [2/5] Configuring Windows FFmpeg and FFprobe binaries...
call npm install --save-optional --legacy-peer-deps --no-audit --no-fund ffmpeg-static ffprobe-static
if errorlevel 1 (
  echo [ERROR] Failed to install ffmpeg-static / ffprobe-static.
  pause
  exit /b 1
)

echo [3/5] Installing Electron and Electron-Builder...
call npm install --no-save --legacy-peer-deps --no-audit --no-fund electron electron-builder
if errorlevel 1 (
  echo [ERROR] Failed to install Electron and Electron-Builder.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  if exist "node_modules\electron\install.js" (
    echo Downloading Electron desktop runtime binary...
    call node "node_modules\electron\install.js"
    if errorlevel 1 (
      echo [ERROR] Electron binary download failed.
      pause
      exit /b 1
    )
  )
)

if not exist "node_modules\ffmpeg-static\ffmpeg.exe" (
  if exist "node_modules\ffmpeg-static\install.js" (
    echo Downloading Windows FFmpeg static binary...
    call node "node_modules\ffmpeg-static\install.js"
  )
)

echo [4/5] Compiling frontend and self-contained desktop server...
call npm run desktop:build
if errorlevel 1 (
  echo [ERROR] Desktop build failed.
  pause
  exit /b 1
)

echo [5/5] Packaging standalone Windows Installer and Portable EXE...
if exist "node_modules\.bin\electron-builder.cmd" (
  call "node_modules\.bin\electron-builder.cmd" --win
) else (
  call node "node_modules\electron-builder\cli.js" --win
)
if errorlevel 1 (
  echo [ERROR] Windows EXE packaging failed.
  pause
  exit /b 1
)

echo.
echo Done! Your standalone executables are inside the "release\" folder:
dir /b release\*.exe
echo.
pause
