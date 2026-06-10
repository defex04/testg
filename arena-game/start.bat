@echo off
rem ============================================================
rem Arena - local launcher. Double-click to play.
rem Browsers block ES modules on file://, so the game is served
rem from localhost. Close the minimized console window to stop.
rem ============================================================
setlocal
cd /d "%~dp0"
set PORT=8765

where python >nul 2>nul
if %errorlevel%==0 (set PY=python) else (set PY=py)

start "Arena server - close this window to stop the game" /min %PY% serve.py %PORT%

rem give the server a second to start
timeout /t 1 /nobreak >nul

start "" "http://localhost:%PORT%/"
endlocal
