@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo Starting SwiftShare backend...
if not exist node_modules (
    echo Installing backend dependencies...
    npm install
    if errorlevel 1 pause & exit /b 1
)
call npm run dev
