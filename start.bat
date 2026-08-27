@echo off
chcp 65001 >nul
cd /d "%~dp0"
:loop
node src/main.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] 已有实例在运行，退出。
    pause
    exit /b 2
)
echo [%date% %time%] 桥接退出（code %code%），5 秒后重启...
timeout /t 5 /nobreak >nul
goto loop
