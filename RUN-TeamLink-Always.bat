@echo off
REM TeamLink - run the portal and START IT AGAIN BY ITSELF if it ever stops (needs Node.js 20+).
REM Double-click this instead of START-TeamLink.bat and leave the window open (minimise it, do not close it).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages, one time only...
  call npm install
)
set LOAD_SEED=true
title TeamLink server (keep this window open)
echo.
echo TeamLink runs on http://localhost:4323 - this window restarts it if it stops.
start "" http://localhost:4323
:again
echo [%date% %time%] starting the TeamLink server...
node tools\dev-server.mjs 4323
echo [%date% %time%] the server stopped (code %errorlevel%). Starting it again in 5 seconds - close this window to stop for good.
timeout /t 5 /nobreak >nul
goto again
