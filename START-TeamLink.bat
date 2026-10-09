@echo off
REM TeamLink - run the portal from this folder (needs Node.js 20+ installed)
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages, one time only...
  call npm install
)
set LOAD_SEED=true
echo.
echo Starting TeamLink on http://localhost:4323  (keep this window open)
start "" http://localhost:4323
node tools\dev-server.mjs 4323
pause
