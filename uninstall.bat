@echo off
rem NimuQDock-dsh uninstaller.
rem If a bundled portable node exists (node\node.exe), copy node + uninstall.mjs to
rem %TEMP% and run from there: a node.exe running from inside the install folder would
rem lock itself and prevent the folder from being deleted. Falls back to system node.
chcp 65001 >nul
set "PKG=%~dp0"
set "BUNDLED=%PKG%node\node.exe"
set "TMPD="
if exist "%BUNDLED%" (
    set "TMPD=%TEMP%\nimu-uninstall-%RANDOM%"
    mkdir "%TMPD%" >nul 2>&1
    copy /y "%BUNDLED%" "%TMPD%\node.exe" >nul
    copy /y "%PKG%uninstall.mjs" "%TMPD%\uninstall.mjs" >nul
)
cd /d C:\
if defined TMPD (
    "%TMPD%\node.exe" "%TMPD%\uninstall.mjs" "%PKG%"
) else (
    node "%PKG%uninstall.mjs" "%PKG%"
)
timeout /t 3 /nobreak >nul
if defined TMPD rmdir /s /q "%TMPD%" >nul 2>&1
