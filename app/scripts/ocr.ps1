param([Parameter(Mandatory = $true)][string]$Path, [switch]$Json)
# Windows 自带 OCR（WinRT OcrEngine），离线，支持系统里已安装的语言（中/英）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Path <图片路径>
#
# ⚠️ 必须先把输出编码钉成 UTF-8：
#   powershell.exe（5.1）把 stdout 重定向到管道时用的是**控制台代码页**，
#   中文系统上是 GBK/936。而 Node 那边是按 UTF-8 解码的 ——
#   于是识别出来的中文全变成 "��" 这种乱码（实测中文屏幕上整段都是乱码，
#   "读屏幕"对中文界面等于失效）。设置 OutputEncoding 后写出的就是 UTF-8 字节，
#   两边才对得上。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

    function Await($op, $type) {
        $m = $asTaskGeneric.MakeGenericMethod($type)
        $task = $m.Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }

    $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
    $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'OCR engine unavailable (no language pack installed)' }

    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    if ($Json) {
        # 【JSON 模式】输出每行每词的文字与包围盒，供 find_text 定位用。
        # ⚠️ 为什么把坐标一起输出：Windows OCR 的 $result.Text 会把每个汉字之间插空格
        #    （CJK 没空格，它当"词"处理），而且**完全丢掉行的位置** ——
        #    只知道"读到了什么"，不知道"在哪"。要"文字的模板匹配"必须有 BoundingRect。
        # ⚠️ 为什么用 ConvertTo-Json：PowerShell 5.1 会把非 ASCII 自动转义成 \uXXXX，
        #    于是输出**纯 ASCII**，彻底绕开 stdout 编码问题（之前那版就是在这里踩的坑）。
        # 注意：BoundingRect 的坐标系是**送入图片的像素坐标**（我们的抓帧就是 1920x1080 全屏），
        #    所以直接可用，不需要再换算。
        # ⚠️ 用管道 + ForEach-Object 构造，**不要用 `+=`** ——
        #    实测 `$words += [pscustomobject]@{...}` 在 Windows PowerShell 5.1 上会报
        #    "Method invocation failed because [System.Management.Automation.PSObject]
        #     does not contain a method named 'op_Addition'"，整个 JSON 输出失败。
        $outLines = @($result.Lines | ForEach-Object {
            $ln = $_
            [pscustomobject]@{
                text  = $ln.Text
                words = @($ln.Words | ForEach-Object {
                    $r = $_.BoundingRect
                    [pscustomobject]@{
                        t = $_.Text
                        x = [int][math]::Round($r.X); y = [int][math]::Round($r.Y)
                        w = [int][math]::Round($r.Width); h = [int][math]::Round($r.Height)
                    }
                })
            }
        })
        $obj = [pscustomobject]@{
            ok = $true
            imgW = $bitmap.PixelWidth; imgH = $bitmap.PixelHeight
            text = $result.Text
            lines = $outLines
        }
        Write-Output ($obj | ConvertTo-Json -Depth 6 -Compress)
    }
    else {
        Write-Output $result.Text
    }
}
catch {
    if ($Json) {
        Write-Output (([pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    } else {
        Write-Error $_.Exception.Message
    }
    exit 1
}
