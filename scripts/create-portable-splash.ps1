param(
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\build\portable-splash.bmp")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [IO.Path]::GetDirectoryName($resolvedOutput)
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$bitmap = [Drawing.Bitmap]::new(640, 360)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$paper = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#f4f0e7"))
$green = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#1f5a45"))
$ink = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#17251f"))
$muted = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#53635b"))
$gold = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#b8792a"))
$line = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml("#e8e1d4"), 1)
$track = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#d9d2c3"))
$whitePen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml("#fffdf8"), 10)
$whitePen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$whitePen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$whitePen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round

try {
  $graphics.FillRectangle($paper, 0, 0, 640, 360)
  for ($position = 40; $position -lt 640; $position += 40) {
    $graphics.DrawLine($line, $position, 0, $position, 360)
  }
  for ($position = 40; $position -lt 360; $position += 40) {
    $graphics.DrawLine($line, 0, $position, 640, $position)
  }

  $graphics.FillRectangle($green, 56, 62, 104, 104)
  $graphics.DrawLine($whitePen, 94, 88, 94, 142)
  $graphics.DrawLine($whitePen, 97, 115, 126, 88)
  $graphics.DrawLine($whitePen, 97, 115, 129, 144)
  $graphics.FillEllipse($gold, 126, 76, 27, 18)

  $titleFont = [Drawing.Font]::new("Georgia", 24, [Drawing.FontStyle]::Regular)
  $bodyFont = [Drawing.Font]::new("Arial", 11, [Drawing.FontStyle]::Regular)
  $smallFont = [Drawing.Font]::new("Arial", 10, [Drawing.FontStyle]::Regular)
  try {
    $graphics.DrawString("Kakebo Harvester", $titleFont, $ink, 190, 78)
    $graphics.DrawString(
      "Preparing your private local workspace...",
      $bodyFont,
      $muted,
      191,
      127
    )
    $graphics.FillRectangle($track, 56, 244, 528, 7)
    $graphics.FillRectangle($green, 56, 244, 348, 7)
    $graphics.FillEllipse($gold, 419, 240, 15, 15)
    $graphics.DrawString(
      "Starting securely on this computer",
      $smallFont,
      $muted,
      56,
      277
    )
  } finally {
    $titleFont.Dispose()
    $bodyFont.Dispose()
    $smallFont.Dispose()
  }

  $bitmap.Save($resolvedOutput, [Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  $paper.Dispose()
  $green.Dispose()
  $ink.Dispose()
  $muted.Dispose()
  $gold.Dispose()
  $line.Dispose()
  $track.Dispose()
  $whitePen.Dispose()
}

Write-Host "Portable splash generated at $resolvedOutput"
