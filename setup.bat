@echo off
echo ================================
echo   Audio Transcriber Setup
echo ================================
echo.

echo [1/4] Installing backend dependencies...
cd server
call npm install
if errorlevel 1 (
    echo ERROR: Failed to install backend dependencies
    pause
    exit /b 1
)

echo.
echo [2/4] Installing Python dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install Python dependencies
    echo Make sure Python and pip are installed and in PATH
    pause
    exit /b 1
)

echo.
echo [3/4] Installing frontend dependencies...
cd ..
call npm install
if errorlevel 1 (
    echo ERROR: Failed to install frontend dependencies
    pause
    exit /b 1
)

echo.
echo [4/4] Setup complete!
echo.
echo ================================
echo   Next Steps:
echo ================================
echo 1. Start backend:  cd server ^&^& npm start
echo 2. Start frontend: npm start
echo 3. Open http://localhost:3000
echo.
echo Or use start-all.bat to start both!
echo.
pause
