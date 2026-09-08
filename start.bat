@echo off
rem NimuQDock-dsh daily launcher. ASCII-only here; Node prints the Chinese.
rem Runs start.mjs: fill QQ + scan + launch DSH/NapCat/bridge, then opens console.
chcp 65001 >nul
cd /d "%~dp0"
node start.mjs
pause
