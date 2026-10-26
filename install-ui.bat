@echo off
rem Graphical installer: starts a local web UI and opens the browser.
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" install-ui.mjs
pause
