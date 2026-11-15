# shoot-ocr.ps1 -- capture (via Electron child) + OCR + UTF-8 JSON write, ALL inside PowerShell.
# ASCII ONLY. Why: Node cannot spawn/capture children in this sandbox (EPERM), but PowerShell can
# Start-Process electron.exe, wait, then run the OCR engine and write the JSON with WriteAllText.
# Usage: powershell -File shoot-ocr.ps1 -Png <png> -Out <json> [-Capture 1 -Electron <exe>]
param(
  [Parameter(Mandatory=$true)][string]$Png,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Capture = 0,
  [string]$Electron = '',
  [int]$W = 1920,
  [int]$H = 1080
)
$ErrorActionPreference = 'Continue'
if ($Capture -eq 1) {
  if ($Electron -eq '') { Write-Output 'CAPTURE_ERR no electron path'; exit 1 }
  if (Test-Path $Png) { Remove-Item $Png -Force }
  $shoot = Join-Path $PSScriptRoot 'shoot2.js'
  Start-Process -FilePath $Electron -ArgumentList @(('"' + $shoot + '"'), "$W", "$H", ('"' + $Png + '"')) -Wait -WindowStyle Hidden
  if (-not (Test-Path $Png)) { Write-Output 'CAPTURE_ERR no file'; exit 1 }
  Write-Output ('CAPTURED ' + $Png + ' bytes=' + (Get-Item $Png).Length)
}
$ocr = Join-Path $PSScriptRoot '..\ocr.ps1'
$txt = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ocr -Path $Png -Json 2>&1 | Out-String).Trim()
[System.IO.File]::WriteAllText($Out, $txt, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('OCR_JSON_WRITTEN ' + $Out + ' bytes=' + (Get-Item $Out).Length)
