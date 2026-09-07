@echo off
rem NimuQDock-dsh uninstaller (ASCII only, Node does the Chinese output)
rem 结尾用 timeout 自动关闭：不 pause 占着项目目录作为 cwd，否则项目目录删不掉
chcp 65001 >nul
cd /d "%~dp0"
node uninstall.mjs
timeout /t 3 /nobreak >nul
