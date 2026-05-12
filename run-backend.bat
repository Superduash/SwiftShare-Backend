@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo Starting SwiftShare backend...
if not exist node_modules (
    echo Installing backend dependencies...
    npm install
    if errorlevel 1 pause & exit /b 1
)

:: Ensure environment variables are set
set PORT=3001
set FRONTEND_URL=http://localhost:5173
set NODE_ENV=development

echo.
echo Environment variables set:
echo PORT=%PORT%
echo FRONTEND_URL=%FRONTEND_URL%
echo NODE_ENV=%NODE_ENV%
echo.

call npm run dev
