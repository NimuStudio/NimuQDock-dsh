@echo off
rem NimuQDock-dsh uninstaller (ASCII only, Node does the Chinese output)
chcp 65001 >nul
cd /d "%~dp0"
node uninstall.mjs
pause
