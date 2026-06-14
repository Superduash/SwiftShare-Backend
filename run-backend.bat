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
set SHARE_BASE_URL=http://localhost:3001
set NODE_ENV=development

:: TOKEN_SECRET is required — use a dev placeholder if not already set
if "%TOKEN_SECRET%"=="" set TOKEN_SECRET=dev-local-secret-change-in-prod

:: Check for .env file
if not exist "%~dp0.env" (
    color 0E
    echo.
    echo  [WARNING] No .env file found in Backend folder.
    echo  MongoDB, R2, and other services may fail to connect.
    echo  Copy .env.example to .env and fill in your credentials.
    echo.
    color 0B
)

echo.
echo Environment variables set:
echo PORT=%PORT%
echo FRONTEND_URL=%FRONTEND_URL%
echo SHARE_BASE_URL=%SHARE_BASE_URL%
echo NODE_ENV=%NODE_ENV%
echo.

call npm run dev
