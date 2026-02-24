@echo off
echo ================================
echo   Starting Audio Transcriber
echo ================================
echo.

echo Refreshing PATH for Python and FFmpeg...
:: Refresh environment variables to pick up Python and FFmpeg paths
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "system_path=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "user_path=%%b"
set "PATH=%system_path%;%user_path%"

echo Starting backend server...
start "Transcriber Backend" cmd /k "cd server && node server.js"

timeout /t 3 /nobreak >nul

echo Starting frontend...
start "Transcriber Frontend" cmd /k "npm start"

echo.
echo Both servers are starting...
echo Backend: http://localhost:5000
echo Frontend: http://localhost:3000
echo.
echo Press any key to close this window (servers will keep running)
pause >nul
