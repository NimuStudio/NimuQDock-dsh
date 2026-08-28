@echo off
rem NimuQDock-dsh one-click installer (ASCII only, Node does the Chinese output)
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo [install] Node.js not found. Please install Node.js 22.13+ from https://nodejs.org
    pause
    exit /b 1
)
node install.mjs
pause
