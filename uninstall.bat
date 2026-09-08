@echo off
rem NimuQDock-dsh uninstaller.
rem Prefer running from a %TEMP% copy of the bundled node: a node.exe running from
rem inside the install folder locks itself and prevents the folder from being deleted.
rem If the copy fails, fall back to running the bundled node in place, else system node.
chcp 65001 >nul
set "PKG=%~dp0"
set "BUNDLED=%PKG%node\node.exe"
set "TMPD="
if exist "%BUNDLED%" (
    set "TMPD=%TEMP%\nimu-uninstall-%RANDOM%"
    mkdir "%TMPD%" >nul 2>&1
    copy /y "%BUNDLED%" "%TMPD%\node.exe" >nul
    copy /y "%PKG%uninstall.mjs" "%TMPD%\uninstall.mjs" >nul
    if not exist "%TMPD%\node.exe" set "TMPD="
)
cd /d C:\
if defined TMPD (
    "%TMPD%\node.exe" "%TMPD%\uninstall.mjs" "%PKG%"
) else (
    if exist "%BUNDLED%" (
        "%BUNDLED%" "%PKG%uninstall.mjs" "%PKG%"
    ) else (
        node "%PKG%uninstall.mjs" "%PKG%"
    )
)
timeout /t 3 /nobreak >nul
if defined TMPD rmdir /s /q "%TMPD%" >nul 2>&1
