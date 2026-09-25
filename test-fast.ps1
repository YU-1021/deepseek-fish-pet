# FAST drag test: high-speed linear (4 directions) + high-speed circle
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
function Fmt([double]$v) { return ('{0:0.####}' -f $v) }

Mark 'FAST-BEGIN'
Snap 'F0'

# ---- F1: fast right (460px in ~200ms => ~2300 px/s) ----
Snap 'F1a'
$bp = MoveToBody 120
& $in fdrag (Fmt $bp[0]) (Fmt $bp[1]) (Fmt ([math]::Min(0.92, $bp[0]+0.30))) (Fmt $bp[1]) 200 1 | Out-Null
Start-Sleep -Milliseconds 1200
Snap 'F1b'

# ---- F2: fast left (back) ----
Snap 'F2a'
$bp = MoveToBody 120
& $in fdrag (Fmt $bp[0]) (Fmt $bp[1]) (Fmt ([math]::Max(0.06, $bp[0]-0.30))) (Fmt $bp[1]) 200 1 | Out-Null
Start-Sleep -Milliseconds 1200
Snap 'F2b'

# ---- F3: fast down (260px in ~200ms) ----
Snap 'F3a'
$bp = MoveToBody 120
& $in fdrag (Fmt $bp[0]) (Fmt $bp[1]) (Fmt $bp[0]) (Fmt ([math]::Min(0.88, $bp[1]+0.30))) 200 1 | Out-Null
Start-Sleep -Milliseconds 1200
Snap 'F3b'

# ---- F4: fast up (back) ----
Snap 'F4a'
$bp = MoveToBody 120
& $in fdrag (Fmt $bp[0]) (Fmt $bp[1]) (Fmt $bp[0]) (Fmt ([math]::Max(0.10, $bp[1]-0.30))) 200 1 | Out-Null
Start-Sleep -Milliseconds 1200
Snap 'F4b'

# ---- F5: fast circle (r=0.09, 180 steps, 1ms) ----
Snap 'F5a'
$bp = MoveToBody 120
& $in fcircle (Fmt $bp[0]) (Fmt $bp[1]) 0.09 180 1 | Out-Null
Start-Sleep -Milliseconds 1200
Snap 'F5b'

Mark 'FAST-END'
