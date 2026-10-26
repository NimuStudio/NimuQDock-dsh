Unicode true
OutFile "E:\qqbot\_probe\debug-nsis.exe"
InstallDir "C:\NimuQDock-dsh"
RequestExecutionLevel user
SilentInstall silent
Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\node.exe" "E:\qqbot\napcat-bridge\node\node.exe"
  File "/oname=$PLUGINSDIR\detect.mjs" "E:\qqbot\napcat-bridge\scripts\nsis-detect.mjs"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=$PLUGINSDIR\node.exe" "E:\qqbot\napcat-bridge\node\node.exe"
  File "/oname=$PLUGINSDIR\detect.mjs" "E:\qqbot\napcat-bridge\scripts\nsis-detect.mjs"
  FileOpen $9 "E:\qqbot\_probe\nimu-nsis-test.log" w
  FileWrite $9 "plugins=$PLUGINSDIR$\r$\n"
  IfFileExists "$PLUGINSDIR\detect.txt" 0 +2
  FileWrite $9 "detect.txt exists$\r$\n"
  FileClose $9
  nsExec::ExecToStack '"$PLUGINSDIR\node.exe" "$PLUGINSDIR\detect.mjs" "--out=$PLUGINSDIR\detect.txt" "$INSTDIR"'
  Pop $0
  Pop $1
  FileOpen $9 "E:\qqbot\_probe\nimu-nsis-test.log" a
  FileWrite $9 "rc=$0$\r$\n"
  FileWrite $9 "out=$1$\r$\n"
  FileClose $9
SectionEnd
