@echo off
rem NimuQDock-dsh installer. Prefers the bundled portable node (node\node.exe),
rem otherwise falls back to system node for source users.
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" install.mjs
pause
