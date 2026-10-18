$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assets = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
$source = [Drawing.Image]::FromFile((Join-Path $assets 'sj-paint-master.png'))
function Resize-IconPng([int]$size) {
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($source, [Drawing.Rectangle]::new(0, 0, $size, $size))
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}
try {
    $png = Resize-IconPng 512
    [IO.File]::WriteAllBytes((Join-Path $assets 'sj-paint.png'), $png)
    # Keep the existing Linux scalable-icon path, with the same embedded artwork.
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,' + [Convert]::ToBase64String($png) + '"/></svg>'
    [IO.File]::WriteAllText((Join-Path $assets 'sj-paint.svg'), $svg, [Text.UTF8Encoding]::new($false))
    $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
    $frames = @($sizes | ForEach-Object { ,(Resize-IconPng $_) })
    $file = [IO.File]::Create((Join-Path $assets 'sj-paint.ico'))
    $writer = [IO.BinaryWriter]::new($file)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
            $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
            $offset += $frames[$i].Length
        }
        foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
    } finally { $writer.Dispose(); $file.Dispose() }
} finally { $source.Dispose() }
Write-Output 'Created the 512px PNG, embedded-image SVG and nine-size Windows ICO.'
