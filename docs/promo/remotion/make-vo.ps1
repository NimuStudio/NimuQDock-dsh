
Add-Type -AssemblyName System.Speech
$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $syn.SelectVoice('Microsoft Huihui Desktop') } catch {}
$syn.Rate = 0
$syn.Volume = 100
$lines = Get-Content -LiteralPath "E:\qqbot\napcat-bridge\docs\promo\remotion\narration.json" -Raw -Encoding UTF8 | ConvertFrom-Json
for ($i=0; $i -lt $lines.Count; $i++) {
  $out = "E:\qqbot\napcat-bridge\docs\promo\remotion\public\vo\vo-$i.wav"
  $syn.SetOutputToWaveFile($out)
  $syn.Speak([string]$lines[$i])
}
$syn.Dispose()
Write-Output "done"
