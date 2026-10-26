; NimuQDock-dsh 原生安装向导（NSIS / MUI2）
; 页面：欢迎 → 组件勾选 → 安装目录 → 安装（进度+日志）→ 完成
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"

!ifndef SEP
  !define SEP "\"
!endif

!ifndef APP_VERSION
  !define APP_VERSION "0.6.1"
!endif
!ifndef PAYLOAD
  !define PAYLOAD "dist\nsis-payload"
!endif


!define APP_NAME "NimuQDock-dsh"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME} ${APP_VERSION}"
!ifndef OUTFILE
  !define OUTFILE "dist\${APP_NAME}-${APP_VERSION}-setup.exe"
!endif
OutFile "${OUTFILE}"
InstallDir "C:\NimuQDock-dsh"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
XPStyle on

; ---------- 界面 ----------
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "把 DeepSeek Harness 的 AI 停靠进 QQ。$\r$\n$\r$\n安装器会自动检测你电脑里已有的组件：已装好的会置灰跳过，没装的默认勾选。$\r$\n$\r$\n所有内容都安装到一个文件夹里，卸载时删除该文件夹即可。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\start.bat"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ComponentsLeave

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载前请先关闭项目窗口（桥接 / NapCat / 控制台），否则文件被占用会删不掉。"
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------- 检测 ----------
Var DetectProject
Var DetectFlags

Section "程序本体（必需）" SEC_CORE
  FileClose $9
  SectionIn RO
  FileClose $9
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}${SEP}*"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\start.bat"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\start.bat"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "DeepSeek Harness（约 400MB）" SEC_DSH
  FileClose $9
  DetailPrint "正在安装 DeepSeek Harness（首次约 1~2 分钟）…"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\scripts\nsis-install-items.mjs" --dsh'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "DeepSeek Harness 安装失败（可稍后重新运行安装器，或直接用本机已有的 DSH）。"
  ${EndIf}
SectionEnd

Section "NapCat（QQ 接入，约 34MB）" SEC_NAPCAT
  FileClose $9
  DetailPrint "正在安装 NapCat…"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\scripts\nsis-install-items.mjs" --napcat'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "NapCat 安装失败（可稍后重新运行安装器）。"
  ${EndIf}
SectionEnd

Section "判断模型 1.7B（约 1.1GB，更准）" SEC_M17
  FileClose $9
  DetailPrint "正在下载判断模型 1.7B…"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\scripts\nsis-install-items.mjs" --model=large'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "判断模型下载失败（可在安装器或 install-model.bat 里重试）。"
  ${EndIf}
SectionEnd

Section "判断模型 0.6B（约 380MB，轻量）" SEC_M06
  FileClose $9
  DetailPrint "正在下载判断模型 0.6B…"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\scripts\nsis-install-items.mjs" --model=small'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "判断模型下载失败（可在安装器或 install-model.bat 里重试）。"
  ${EndIf}
SectionEnd

Section "推理引擎 llama.cpp（约 23MB）" SEC_LLAMA
  FileClose $9
  DetailPrint "正在安装推理引擎…"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\scripts\nsis-install-items.mjs" --llama'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "推理引擎安装失败（可稍后重新运行安装器）。"
  ${EndIf}
SectionEnd


Function .onInit
  InitPluginsDir
  ; 把便携 node 与检测脚本解到临时目录，用它做本机检测（不弹窗）
  SetOutPath $PLUGINSDIR
  File "/oname=$PLUGINSDIR\node.exe" "${PAYLOAD}${SEP}node${SEP}node.exe"
  File "/oname=$PLUGINSDIR\detect.mjs" "${PAYLOAD}${SEP}scripts${SEP}nsis-detect.mjs"
  nsExec::ExecToStack '"$PLUGINSDIR\node.exe" "$PLUGINSDIR\detect.mjs" "--out=$PLUGINSDIR\detect.txt" "$INSTDIR"'
  Pop $0
  Pop $1
  ; 诊断日志（安装失败时排查用）
  FileOpen $9 "$TEMP\nimu-install-detect.log" w
  FileWrite $9 "rc=$0$\r$\n"
  FileWrite $9 "$1"
  FileClose $9
  CopyFiles /SILENT "$PLUGINSDIR\detect.txt" "$TEMP\nimu-detect-values.log"

  StrCpy $DetectProject ""   ; PROJECT
  StrCpy $DetectFlags 0    ; flags
  FileOpen $0 "$PLUGINSDIR\detect.txt" r
  ${Do}
    FileRead $0 $1
    ${If} $1 == ""
      ${ExitDo}
    ${EndIf}
    StrCpy $2 $1 5
    ${If} $2 == "DSH=1"
      IntOp $DetectFlags $DetectFlags | 1
    ${EndIf}
    StrCpy $2 $1 8
    ${If} $2 == "NAPCAT=1"
      IntOp $DetectFlags $DetectFlags | 2
    ${EndIf}
    StrCpy $2 $1 7
    ${If} $2 == "MODEL=1"
      IntOp $DetectFlags $DetectFlags | 4
    ${EndIf}
    StrCpy $2 $1 7
    ${If} $2 == "LLAMA=1"
      IntOp $DetectFlags $DetectFlags | 8
    ${EndIf}
    StrCpy $2 $1 8
    ${If} $2 == "PROJECT="
      StrLen $3 $1
      IntOp $3 $3 - 10
      ${If} $3 > 0
        StrCpy $DetectProject $1 $3 8
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $0

  ; 组件状态：已检测到 → 取消勾选并置灰
  SectionSetFlags ${SEC_CORE} ${SF_SELECTED}
  SectionSetFlags ${SEC_DSH} ${SF_SELECTED}
  SectionSetFlags ${SEC_NAPCAT} ${SF_SELECTED}
  SectionSetFlags ${SEC_M06} 0
  SectionSetFlags ${SEC_M17} ${SF_SELECTED}
  SectionSetFlags ${SEC_LLAMA} ${SF_SELECTED}

  IntOp $0 $DetectFlags & 1
  ${If} $0 != 0
    SectionSetFlags ${SEC_DSH} 0
    SectionSetFlags ${SEC_DSH} ${SF_RO}
  ${EndIf}
  IntOp $0 $DetectFlags & 2
  ${If} $0 != 0
    SectionSetFlags ${SEC_NAPCAT} 0
    SectionSetFlags ${SEC_NAPCAT} ${SF_RO}
  ${EndIf}
  IntOp $0 $DetectFlags & 4
  ${If} $0 != 0
    SectionSetFlags ${SEC_M06} 0
    SectionSetFlags ${SEC_M06} ${SF_RO}
    SectionSetFlags ${SEC_M17} 0
    SectionSetFlags ${SEC_M17} ${SF_RO}
  ${EndIf}
  IntOp $0 $DetectFlags & 8
  ${If} $0 != 0
    SectionSetFlags ${SEC_LLAMA} 0
    SectionSetFlags ${SEC_LLAMA} ${SF_RO}
  ${EndIf}
  SectionGetFlags ${SEC_NAPCAT} $0
  SectionGetFlags ${SEC_DSH} $0
  FileClose $9
FunctionEnd

; 组件页离开时保证模型只选一个
Function ComponentsLeave
  SectionGetFlags ${SEC_M06} $0
  IntOp $1 $0 & ${SF_SELECTED}
  SectionGetFlags ${SEC_M17} $2
  IntOp $3 $2 & ${SF_SELECTED}
  ${If} $1 != 0
  ${AndIf} $3 != 0
    ; 两个都选：默认保留 1.7B
    IntOp $0 $0 & ~${SF_SELECTED}
    SectionSetFlags ${SEC_M06} $0
    MessageBox MB_ICONINFORMATION|MB_OK "两个判断模型只能选一个，已为你保留 1.7B（更准）。"
  ${EndIf}
FunctionEnd

; ---------- 组件 ----------
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "程序代码与便携运行环境，所有组件都装在这个文件夹里。"
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_DSH} "AI 引擎本体。若检测到你已经在运行 DSH，会自动跳过。"
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_NAPCAT} "把 QQ 变成 OneBot 接口。需要本机已安装 QQ 客户端。"
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_M17} "接话判断模型（推荐），判断更准确。"
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_M06} "轻量模型，体积小、CPU 也能跑；两个模型只能选一个。"
!insertmacro MUI_DESCRIPTION_TEXT ${SEC_LLAMA} "运行判断模型所需的推理引擎（CPU 版）。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------- 卸载 ----------
Function un.onInit
  InitPluginsDir
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; 先停掉 NapCat 的 QQ 注入进程（不会影响普通 QQ）
  nsExec::Exec 'cmd /c taskkill /F /IM NapCatWinBootMain.exe >nul 2>&1'
  Sleep 500
  RMDir /r "$INSTDIR"
  nsExec::Exec 'cmd /c rmdir /s /q "$INSTDIR"'
SectionEnd
