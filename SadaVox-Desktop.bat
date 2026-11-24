@echo off
setlocal
cd /d "%~dp0"
title SadaVox Studio - Standalone Desktop App

echo ============================================================
echo   SadaVox Studio - Independent Desktop Window Launcher
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required for first-time setup.
  echo Please install Node.js LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo [1/4] Installing SadaVox Studio runtime packages...
  call npm install --legacy-peer-deps --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
  )
)

if not exist "node_modules\ffmpeg-static" (
  echo [2/4] Configuring Windows FFmpeg and FFprobe binaries...
  call npm install --save-optional --legacy-peer-deps --no-audit --no-fund ffmpeg-static ffprobe-static
)

if not exist "node_modules\electron" (
  echo [3/4] Installing standalone Electron Desktop Engine...
  call npm install --no-save --legacy-peer-deps --no-audit --no-fund electron
  if errorlevel 1 (
    echo [ERROR] Failed to install Electron desktop runtime.
    pause
    exit /b 1
  )
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

if not exist "dist-desktop\server.cjs" (
  echo [4/4] Compiling Desktop Studio Bundle...
  call npm run desktop:build
  if errorlevel 1 (
    echo [ERROR] Desktop build failed.
    pause
    exit /b 1
  )
)

echo Launching SadaVox Studio as an independent desktop window...
call "node_modules\.bin\electron.cmd" electron/main.mjs
