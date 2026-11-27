param([Parameter(Mandatory=$true)][string]$TextFile,[Parameter(Mandatory=$true)][string]$OutFile,[int]$Rate=1,[string]$Voice='Microsoft Huihui Desktop')
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice($Voice) } catch {}
$s.Rate = $Rate
$s.Volume = 100
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$s.SetOutputToWaveFile($OutFile)
$s.Speak($text)
$s.Dispose()
Write-Output 'ok'
