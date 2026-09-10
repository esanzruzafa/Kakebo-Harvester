param(
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\build\portable-splash.bmp")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [IO.Path]::GetDirectoryName($resolvedOutput)
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$bitmap = [Drawing.Bitmap]::new(560, 220)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$surface = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#fffdf8"))
$dark = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#17251f"))
$ink = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#17251f"))
$muted = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#53635b"))
$gold = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml("#b8792a"))
$trackPen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml("#e6efe9"), 3)
$spinnerPen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml("#b8792a"), 3)
$whitePen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml("#fffdf8"), 6)
$whitePen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$whitePen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$whitePen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round

try {
  $graphics.FillRectangle($surface, 0, 0, 560, 220)
  $graphics.FillEllipse($dark, 44, 78, 64, 64)
  $graphics.DrawLine($whitePen, 68, 89, 68, 131)
  $graphics.DrawLine($whitePen, 70, 110, 92, 90)
  $graphics.DrawLine($whitePen, 70, 110, 95, 132)
  $graphics.FillEllipse($gold, 85, 85, 18, 12)

  $titleFont = [Drawing.Font]::new("Georgia", 18, [Drawing.FontStyle]::Regular)
  $bodyFont = [Drawing.Font]::new("Arial", 11, [Drawing.FontStyle]::Regular)
  try {
    $graphics.DrawString("Kakebo Harvester", $titleFont, $ink, 128, 83)
    $graphics.DrawString(
      "Preparing your private local workspace...",
      $bodyFont,
      $muted,
      129,
      116
    )
    $graphics.DrawArc($trackPen, 485, 95, 30, 30, 0, 360)
    $graphics.DrawArc($spinnerPen, 485, 95, 30, 30, 280, 95)
  } finally {
    $titleFont.Dispose()
    $bodyFont.Dispose()
  }

  $bitmap.Save($resolvedOutput, [Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  $surface.Dispose()
  $dark.Dispose()
  $ink.Dispose()
  $muted.Dispose()
  $gold.Dispose()
  $trackPen.Dispose()
  $spinnerPen.Dispose()
  $whitePen.Dispose()
}

Write-Host "Portable splash generated at $resolvedOutput"
