# Capture screen or a single window to PNG.
# Usage:
#   screenshot.ps1 -OutFile x.png                 # full screen
#   screenshot.ps1 -OutFile x.png -Window "QQ"    # only that window (title contains)
#   screenshot.ps1 -List                          # list visible window titles
param(
  [string]$OutFile = "",
  [string]$Window = "",
  [switch]$List
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static System.Collections.Generic.List<string> Titles() {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      var t = sb.ToString();
      if (t.Length > 0) list.Add(t);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

if ($List) {
  $titles = [WinCap]::Titles() | Sort-Object -Unique
  $titles | ForEach-Object { Write-Output $_ }
  exit 0
}

if ($Window -ne "") {
  $target = [IntPtr]::Zero
  $found = ""
  [WinCap]::EnumWindows({
    param($h, $l)
    if ($target -ne [IntPtr]::Zero) { return $true }
    if (-not [WinCap]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][WinCap]::GetWindowTextW($h, $sb, 512)
    $t = $sb.ToString()
    if ($t.Length -gt 0 -and $t.ToLower().Contains($Window.ToLower())) {
      $script:target = $h
      $script:found = $t
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null

  if ($target -eq [IntPtr]::Zero) {
    Write-Error "没有找到标题包含 '$Window' 的窗口"
    exit 2
  }

  $r = New-Object WinCap+RECT
  [void][WinCap]::GetWindowRect($target, [ref]$r)
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Write-Error "窗口尺寸无效"; exit 3 }

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [WinCap]::PrintWindow($target, $hdc, 2)
  $g.ReleaseHdc($hdc)

  # 检测是不是全黑（部分窗口 PrintWindow 拿不到内容）
  $nonBlack = 0
  for ($x = 0; $x -lt $w; $x += 40) {
    for ($y = 0; $y -lt $h; $y += 40) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R + $c.G + $c.B -gt 30) { $nonBlack++ }
    }
  }
  if (-not $ok -or $nonBlack -lt 3) {
    # 回退：把窗口提到前台再抓屏
    if ([WinCap]::IsIconic($target)) { [void][WinCap]::ShowWindow($target, 9) }
    [void][WinCap]::SetForegroundWindow($target)
    Start-Sleep -Milliseconds 260
    [void][WinCap]::GetWindowRect($target, [ref]$r)
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    $g.Dispose(); $bmp.Dispose()
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  }

  $dir = [System.IO.Path]::GetDirectoryName($OutFile)
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "OK window='$found' ${w}x${h}"
  exit 0
}

# 全屏
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$dir = [System.IO.Path]::GetDirectoryName($OutFile)
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "OK screen $($b.Width)x$($b.Height)"
