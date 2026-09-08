@echo off
rem NimuQDock-dsh restart helper. ASCII-only here; Node prints the Chinese.
rem Stops the old bridge (matching src/main.js, regardless of folder name), then relaunches.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[\\/]main\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
del /q state\bridge.lock 2>nul
call start.bat
