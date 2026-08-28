# SFX 模块来源

`7z.sfx` 是 7-Zip 的自解压模块（GUI 版），从 7-Zip 官方完整安装包提取：

- 来源：https://www.7-zip.org/ （7z2501-x64.exe 安装包内）
- 用途：与 `sfx-config.txt` + 打包好的 zip 合并，生成 `NimuQDock-dsh-vX.Y.Z-setup.exe`
- 合并命令（Windows）：
  ```
  copy /b 7z.sfx + sfx-config.txt + <archive.zip> setup.exe
  ```
  或（Linux/macOS）：
  ```
  cat 7z.sfx sfx-config.txt <archive.zip> > setup.exe
  ```
- 许可证：7-Zip 采用 GNU LGPL（允许再分发，需保留来源声明）。本项目仅将其作为安装器外壳使用，7-Zip 版权归 Igor Pavlov 所有。
- 7-Zip 版本：25.01（2025-08-03），与 GitHub Actions 构建时使用的一致。

更新方法：从 https://www.7-zip.org/a/7z2501-x64.exe 下载安装包，用 7-Zip 解压后取 `7z.sfx` 覆盖本文件。
