@echo off
REM ======================================================================
REM  TeamLink - package this PC's portal data for the hosted server
REM
REM  Makes ONE file on the Desktop:  teamlink-data-for-server-<date>.zip
REM    teamlink-data.ndjson.gz   every candidate, application, job, setting (rows only - small)
REM    uploads.tar.gz            resumes, documents, interview recordings
REM    env-from-pc.txt           this PC's settings (.env) - CONTAINS PASSWORDS
REM
REM  The portal is stopped for a few seconds to take a clean copy, then
REM  started again. Send the zip to the server administrator PRIVATELY
REM  (it holds passwords) - they load it with deploy/import-data.sh.
REM  See docs/DEPLOY-TEAMLINKS-SERVER.md.
REM ======================================================================
setlocal
cd /d "%~dp0"
if not defined TL_PORT set TL_PORT=4323
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set STAMP=%%i
set OUT=%USERPROFILE%\Desktop\teamlink-data-for-server-%STAMP%
set ZIP=%OUT%.zip

if not exist var\dev-db (
  echo No portal data found in var\dev-db - nothing to export.
  pause & exit /b 1
)
if exist var\dev-db-export rmdir /s /q var\dev-db-export
mkdir "%OUT%" || (echo Could not create %OUT% & pause & exit /b 1)

echo [1/5] Stopping the portal for a clean copy (about a minute)...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %TL_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Start-Sleep -Seconds 6; Stop-Process -Id $c.OwningProcess -Force; Start-Sleep -Seconds 2; 'stopped' } else { 'the portal was not running' }"

echo [2/5] Copying the data folder...
robocopy var\dev-db var\dev-db-export /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo The copy failed. & goto :restart_fail)

echo [3/5] Starting the portal again...
start "TeamLink portal" /min cmd /c "node tools\dev-server.mjs %TL_PORT% > var\live-server.log 2>&1"

echo [4/5] Exporting the rows and the uploaded files...
node tools\copy-live-to-postgres.mjs --source var\dev-db-export --to-file "%OUT%\teamlink-data.ndjson.gz"
if errorlevel 1 (echo The export failed - see the message above. & rmdir /s /q var\dev-db-export & pause & exit /b 1)
rmdir /s /q var\dev-db-export
if exist var\uploads (tar -czf "%OUT%\uploads.tar.gz" -C var uploads) else (echo   no uploads folder - skipped)
if exist .env copy /y .env "%OUT%\env-from-pc.txt" >nul

echo [5/5] Making the zip...
powershell -NoProfile -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath '%ZIP%' -Force"
rmdir /s /q "%OUT%"

echo.
echo Done:  %ZIP%
echo Send it to the server administrator PRIVATELY - it contains passwords.
echo The portal is running again on http://localhost:%TL_PORT%
pause
exit /b 0

:restart_fail
start "TeamLink portal" /min cmd /c "node tools\dev-server.mjs %TL_PORT% > var\live-server.log 2>&1"
pause
exit /b 1
