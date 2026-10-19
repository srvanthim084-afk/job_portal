@echo off
REM TeamLink - run the portal and START IT AGAIN BY ITSELF if it ever stops (needs Node.js 20+).
REM Double-click this instead of START-TeamLink.bat and leave the window open (minimise it, do not close it).
REM If the portal is already running on this PC it only opens the page and does nothing else.
cd /d "%~dp0"
netstat -ano | findstr /R /C:":4323 .*LISTENING" >nul
if %errorlevel%==0 (
  echo TeamLink is already running on http://localhost:4323
  if not "%1"=="quiet" start "" http://localhost:4323
  exit /b 0
)
if not exist node_modules (
  echo Installing packages, one time only...
  call npm install
)
set LOAD_SEED=true
title TeamLink server (keep this window open)
echo.
echo TeamLink runs on http://localhost:4323 - this window restarts it if it stops.
if not "%1"=="quiet" start "" http://localhost:4323
:again
echo [%date% %time%] starting the TeamLink server...
node tools\dev-server.mjs 4323 >> var\live-server.log 2>> var\live-server.err.log
echo [%date% %time%] the server stopped (code %errorlevel%). Starting it again in 5 seconds - close this window to stop for good.
timeout /t 5 /nobreak >nul
goto again
