# 造一张已知中文文字的测试图（PowerShell + System.Drawing，不依赖屏幕上有什么）
# 用法：powershell -File make-ocr-fixture.ps1 -Out C:\path\fixture.png
param([string]$Out = "$env:TEMP\ocr-fixture.png")
Add-Type -AssemblyName System.Drawing
$w = 900; $h = 260
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(24, 26, 32))
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$font = New-Object System.Drawing.Font("Microsoft YaHei", 34, [System.Drawing.FontStyle]::Regular)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 235, 240))
$lines = @("进驻总览", "编辑队列", "角色", "制造站 龙门商法", "确认 取消")
$y = 16
foreach ($t in $lines) {
    $g.DrawString($t, $font, $brush, 30, $y)
    $y += 48
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("SAVED " + $Out)
