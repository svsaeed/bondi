@echo off
cd /d "%~dp0"
title BONDI Cloudflare Deployment
echo ==============================================
echo BONDI - Online Multiplayer Cloudflare Deploy
echo ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Please install Node.js LTS from https://nodejs.org/ then run this file again.
  pause
  exit /b 1
)
echo Installing/updating deployment tools...
call npm install
if errorlevel 1 goto :fail
echo.
echo Cloudflare login will open in your browser if needed.
call npx wrangler login
if errorlevel 1 goto :fail
echo.
echo Deploying BONDI...
call npm run deploy
if errorlevel 1 goto :fail
echo.
echo ==============================================
echo BONDI DEPLOYMENT FINISHED
ECHO Look above for your workers.dev web address.
echo ==============================================
pause
exit /b 0
:fail
echo.
echo Deployment stopped because of an error.
echo Take a screenshot of this window and send it to ChatGPT.
pause
exit /b 1
