@echo off
:: Double-click to install or update Meeting Transcriber (see install.ps1 for options).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
