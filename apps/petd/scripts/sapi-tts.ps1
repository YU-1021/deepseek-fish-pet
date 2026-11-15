# PETD SAPI TTS helper (System.Speech).
# ASCII only: PS 5.1 decodes source with the ANSI codepage, so keep comments ASCII.
# Usage:
#   powershell -File sapi-tts.ps1 -ListVoices
#   powershell -File sapi-tts.ps1 -OutFile C:\x\a.wav -TextFile C:\x\a.txt -Voice "Microsoft Huihui Desktop" -Rate 0
param(
  [string]$OutFile,
  [string]$TextFile,
  [string]$Voice,
  [int]$Rate = 0,
  [int]$Volume = 100,
  [int]$SampleRate = 0,
  [switch]$ListVoices
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

if ($ListVoices) {
  foreach ($v in $synth.GetInstalledVoices()) {
    if ($v.Enabled) {
      $info = $v.VoiceInfo
      Write-Output ($info.Name + '|' + $info.Culture)
    }
  }
  $synth.Dispose()
  exit 0
}

if (-not $OutFile) { Write-Error 'OutFile is required'; exit 2 }
if (-not $TextFile) { Write-Error 'TextFile is required'; exit 2 }

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { Write-Error 'text is empty'; exit 3 }

if ($Voice) {
  $found = $false
  foreach ($v in $synth.GetInstalledVoices()) {
    if ($v.VoiceInfo.Name -eq $Voice) { $found = $true }
  }
  if ($found) { $synth.SelectVoice($Voice) }
}

if ($Rate -lt -10) { $Rate = -10 }
if ($Rate -gt 10) { $Rate = 10 }
if ($Volume -lt 0) { $Volume = 0 }
if ($Volume -gt 100) { $Volume = 100 }
$synth.Rate = $Rate
$synth.Volume = $Volume

$dir = [System.IO.Path]::GetDirectoryName($OutFile)
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
if ($SampleRate -gt 0) {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    $SampleRate,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  $synth.SetOutputToWaveFile($OutFile, $fmt)
} else {
  $synth.SetOutputToWaveFile($OutFile)
}
$synth.Speak($text)
$synth.Dispose()
Write-Output 'OK'
