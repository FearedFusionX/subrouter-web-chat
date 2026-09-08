# Render the simple public/icon.svg geometry with WPF, then pack PNG ICO frames.
# No browser screenshot viewport (or browser profile) is involved.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase
$assetsDir = Join-Path $PSScriptRoot '..\SubrouterNative\Assets'
$sizes = 16, 32, 48, 64, 128, 256
$blobs = @()
foreach ($size in $sizes) {
    $visual = [System.Windows.Media.DrawingVisual]::new()
    $dc = $visual.RenderOpen()
    $dc.PushTransform([System.Windows.Media.ScaleTransform]::new($size / 64.0, $size / 64.0))
    $background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#141312')
    $accent = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#93b0ff')
    $dc.DrawRoundedRectangle($background, $null, [System.Windows.Rect]::new(0, 0, 64, 64), 12, 12)
    $pen = [System.Windows.Media.Pen]::new($accent, 4)
    $pen.StartLineCap = $pen.EndLineCap = [System.Windows.Media.PenLineCap]::Round
    $dc.DrawGeometry($null, $pen, [System.Windows.Media.Geometry]::Parse('M16,32 H26 M38,32 H48 M32,16 V26 M32,38 V48'))
    $dc.DrawEllipse($accent, $null, [System.Windows.Point]::new(32, 32), 6, 6)
    $dc.Pop()
    $dc.Close()
    $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new($size, $size, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    if ($bitmap.PixelWidth -ne $size -or $bitmap.PixelHeight -ne $size) { throw 'Invalid icon frame dimensions.' }
    $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [System.IO.MemoryStream]::new()
    $encoder.Save($stream)
    $blobs += ,$stream.ToArray()
    $stream.Dispose()
}
$icoPath = Join-Path $assetsDir 'icon.ico'
$stream = [System.IO.File]::Create($icoPath)
$writer = [System.IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dim = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$dim)
        $writer.Write([byte]$dim)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$blobs[$i].Length)
        $writer.Write([uint32]$offset)
        $offset += $blobs[$i].Length
    }
    foreach ($blob in $blobs) { $writer.Write([byte[]]$blob) }
} finally { $writer.Dispose() }
Write-Host "Generated validated icon frames: $($sizes -join ', ') pixels."
