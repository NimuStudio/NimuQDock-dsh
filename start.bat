@echo off
rem NimuQDock-dsh daily launcher. Prefers the bundled portable node (node\node.exe),
rem otherwise falls back to system node for source users.
rem Runs start.mjs: fill QQ + scan + launch DSH/NapCat/bridge, then opens console.
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" start.mjs
pause
