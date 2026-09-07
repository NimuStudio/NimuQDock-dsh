@echo off
rem NimuQDock-dsh uninstaller (ASCII only, Node does the Chinese output)
rem 关键：先切到 C:\ 释放对项目目录的 cwd 占用（否则项目目录删不掉），再用绝对路径跑 node。
rem 项目目录由 uninstall.mjs 里的 HERE(=本脚本所在目录) 定位，不受这个 cd 影响。
rem 结尾用 timeout 自动关闭，不必 pause（会一直占着项目目录）。
chcp 65001 >nul
set "PROJ=%~dp0"
cd /d C:\
node "%PROJ%uninstall.mjs"
timeout /t 3 /nobreak >nul
