# Drag automation test v2: per-test position snapshots + properly closing circle
$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$in = Join-Path $root 'app\vendor\input\input.exe'
$log = "$env:APPDATA\dayu-pet\position.json"
$dbg = "$env:APPDATA\dayu-pet\debug.log"

function Mark([string]$s) {
  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  Add-Content -Path $dbg -Value "$ts ==== $s ===="
}
function Snap([string]$label) {
  $p = Get-Content $log -Raw | ConvertFrom-Json
  Mark "$label pos=$($p.x),$($p.y)"
}
function Step([double]$x, [double]$y, [int]$ms) {
  & $in move ('{0:0.####}' -f $x) ('{0:0.####}' -f $y) | Out-Null
  Start-Sleep -Milliseconds $ms
}
function BodyPoint {
  $p = Get-Content $log -Raw | ConvertFrom-Json
  $bx = ([double]$p.x + 190.0) / 1536.0
  $by = ([double]$p.y + 130.0) / 864.0
  return @($bx, $by)
}
function MoveToBody([int]$ms) {
  $bp = BodyPoint
  & $in move ('{0:0.####}' -f $bp[0]) ('{0:0.####}' -f $bp[1]) | Out-Null
  Start-Sleep -Milliseconds $ms
  return $bp
}

Mark 'TEST-BEGIN'
Snap 'T0'

# ---- A: single-direction linear ----
Snap 'A0'
$bp = MoveToBody 120
$ex = [math]::Min(0.92, $bp[0] + 0.15)
& $in drag ('{0:0.####}' -f $bp[0]) ('{0:0.####}' -f $bp[1]) ('{0:0.####}' -f $ex) ('{0:0.####}' -f $bp[1]) | Out-Null
Start-Sleep -Milliseconds 1500
Snap 'A1'

# ---- B: hold still 1.2s ----
Snap 'B0'
$bp = MoveToBody 120
& $in press | Out-Null
Start-Sleep -Milliseconds 1200
& $in release | Out-Null
Start-Sleep -Milliseconds 1500
Snap 'B1'

# ---- C: complex L-shape ----
Snap 'C0'
$bp = MoveToBody 120
& $in press | Out-Null
Start-Sleep -Milliseconds 80
foreach ($i in 1..12) { Step ($bp[0] + 0.15*$i/12) $bp[1] 25 }
foreach ($i in 1..12) { Step ($bp[0]+0.15) ($bp[1] + 0.15*$i/12) 25 }
foreach ($i in 1..12) { Step ($bp[0]+0.15 - 0.15*$i/12) ($bp[1]+0.15) 25 }
foreach ($i in 1..12) { Step $bp[0] ($bp[1]+0.15 - 0.15*$i/12) 25 }
Start-Sleep -Milliseconds 80
& $in release | Out-Null
Start-Sleep -Milliseconds 1500
Snap 'C1'

# ---- D: circle (2 loops, 73 steps so it closes exactly at start) ----
Snap 'D0'
$bp = MoveToBody 120
& $in press | Out-Null
Start-Sleep -Milliseconds 80
$cx = $bp[0]; $cy = $bp[1]; $r = 0.09
for ($k = 0; $k -le 72; $k++) {
  $a = 2 * [math]::PI * $k / 36
  Step ($cx + $r*[math]::Cos($a)) ($cy + $r*[math]::Sin($a)) 20
}
& $in release | Out-Null
Start-Sleep -Milliseconds 1500
Snap 'D1'

# ---- E: long slow ----
Snap 'E0'
$bp = MoveToBody 120
& $in press | Out-Null
Start-Sleep -Milliseconds 80
$ex2 = [math]::Min(0.92, $bp[0] + 0.20)
foreach ($i in 1..80) { Step ($bp[0] + ($ex2-$bp[0])*$i/80) $bp[1] 45 }
& $in release | Out-Null
Start-Sleep -Milliseconds 1500
Snap 'E1'

Mark 'TEST-END'
