@echo off
rem NimuQDock-dsh uninstaller. ASCII-only here; Node prints the Chinese output.
rem Important: cd to C:\ first so the project folder is NOT held as the cwd,
rem otherwise the project folder cannot be deleted. The project dir is found
rem by uninstall.mjs via HERE (this script's own folder), independent of this cd.
chcp 65001 >nul
set "PROJ=%~dp0"
cd /d C:\
node "%PROJ%uninstall.mjs"
timeout /t 3 /nobreak >nul
