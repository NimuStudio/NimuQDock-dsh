@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在停止旧桥接实例（只匹配 napcat-bridge 的 main.js，不影响其他 node 进程）...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*napcat-bridge*src*main.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
del /q state\bridge.lock 2>nul
echo 已清理，重新启动守护...
call start.bat
