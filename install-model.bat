@echo off
rem Upgrade the local reply-judge model (Qwen3-1.7B, ~1.1 GB) for better accuracy.
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" scripts\fetch-judge-model.mjs
echo.
echo Done. Restart the project (start.bat) to use the new model.
pause
