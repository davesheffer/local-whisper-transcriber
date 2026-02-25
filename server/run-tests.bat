@echo off
echo ========================================
echo Local Whisper Transcriber - Server Tests
echo ========================================
echo.

echo [1/3] Checking if server is running...
curl -s http://localhost:5000/api/health >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Server is not running on port 5000
    echo.
    echo Please start the server first:
    echo    1. Open a new terminal
    echo    2. Run: cd server
    echo    3. Run: npm start
    echo.
    pause
    exit /b 1
)
echo [SUCCESS] Server is running!
echo.

echo [2/3] Installing test dependencies...
call npm install
echo.

echo [3/3] Running tests...
echo.
call npm test

echo.
echo ========================================
echo Tests completed!
echo ========================================
pause
