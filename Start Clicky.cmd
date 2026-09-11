@echo off
rem  Double-click this file to run Clicky. It installs what's needed the first
rem  time, walks you through the API key, then starts the app. After the first
rem  run it just starts.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required and was not found.
  echo Install the LTS build from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies, this happens once...
  call npm install
  if errorlevel 1 ( echo. & echo Install failed. & pause & exit /b 1 )
)

call npm run setup
if errorlevel 1 ( echo. & echo Setup did not finish. & pause & exit /b 1 )

echo.
echo Starting Clicky. Look for the blue arrow in your system tray, then hold Ctrl + Alt to talk.
echo Close this window to quit Clicky.
echo.
call npm start

pause
