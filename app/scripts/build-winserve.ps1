# build-winserve.ps1 -- rebuild app/vendor/winserve/winserve.exe from WinServe.cs
# The bundled exe is committed (same as input.exe); rebuild only when WinServe.cs changes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { $fw = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319'; $csc = Join-Path $fw 'csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe not found (.NET Framework 4 required)' }
$src = Join-Path $root 'vendor\winserve\WinServe.cs'
$out = Join-Path $root 'vendor\winserve\winserve.exe'
$uia = Join-Path $fw 'WPF\UIAutomationClient.dll'
$uiat = Join-Path $fw 'WPF\UIAutomationTypes.dll'
$wb = Join-Path $fw 'WPF\WindowsBase.dll'
if (-not (Test-Path $uia)) { throw ('UIAutomationClient.dll not found: ' + $uia) }
& $csc /nologo /target:exe /out:$out /r:$uia /r:$uiat /r:$wb $src
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
Write-Host ('built ' + $out + '  ' + [math]::Round((Get-Item $out).Length / 1KB, 1) + ' KB')
