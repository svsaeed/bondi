@echo off
cd /d "%~dp0"
title BONDI Local Test
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org/ first.
  pause
  exit /b 1
)
call npm install
call npx wrangler dev
pause
