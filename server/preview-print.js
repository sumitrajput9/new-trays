// Local, no-printer-needed preview of the custom-size print pipeline.
//
// Renders a PNG showing exactly what printImageViaDevmode will draw onto
// the page: the same crop-to-cover + overscan math, at the same target
// size, with a red outline marking the true paper edge so any blank gap or
// over-aggressive crop is immediately visible without touching real
// hardware.
//
// What this CAN catch: wrong crop, wrong composition, a margin/gap that
// shouldn't be there — anything that's a bug in our own code.
// What this CANNOT catch: orientation (landscape vs portrait) — that comes
// from the printer driver's own behavior at print time, which has no local
// equivalent. Only a real hardware test confirms that.
//
// Usage: node preview-print.js <input-image-or-pdf> <widthIn> <heightIn> [overscan]
// Example: node preview-print.js design.jpg 6.48 8.76 1.07

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

async function main() {
  const [, , inputPath, widthArg, heightArg, overscanArg] = process.argv;
  if (!inputPath || !widthArg || !heightArg) {
    console.error("Usage: node preview-print.js <input-image-or-pdf> <widthIn> <heightIn> [overscan]");
    process.exit(1);
  }
  const widthIn = parseFloat(widthArg);
  const heightIn = parseFloat(heightArg);
  const overscan = overscanArg ? parseFloat(overscanArg) : 1.07;

  let imageBytes = fs.readFileSync(inputPath);
  if (inputPath.toLowerCase().endsWith(".pdf")) {
    const { rasterizePdfFirstPageToJpeg } = require("./dist/pdfRaster.js");
    console.log("Rasterizing PDF page 1...");
    imageBytes = await rasterizePdfFirstPageToJpeg(imageBytes);
  }

  const tmpImg = path.join(require("os").tmpdir(), `preview-src-${Date.now()}.jpg`);
  fs.writeFileSync(tmpImg, imageBytes);

  const outPng = path.join(process.cwd(), `preview-${Date.now()}.png`);

  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("${tmpImg.replace(/\\/g, "\\\\")}")
$dpi = 150
$pageW = [int](${widthIn} * $dpi)
$pageH = [int](${heightIn} * $dpi)
$bmp = New-Object System.Drawing.Bitmap($pageW, $pageH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
# Solid red fill FIRST, underneath everything — if any red survives after
# the image is drawn on top, that's an uncovered gap, a real bug. If the
# image is drawn after and covers properly, no red should remain visible
# anywhere inside the page.
$g.Clear([System.Drawing.Color]::Red)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$scale = [Math]::Max($pageW / $img.Width, $pageH / $img.Height) * ${overscan}
$dw = $img.Width * $scale
$dh = $img.Height * $scale
$x = ($pageW - $dw) / 2
$y = ($pageH - $dh) / 2
$g.SetClip((New-Object System.Drawing.Rectangle(0, 0, $pageW, $pageH)))
$g.DrawImage($img, $x, $y, $dw, $dh)
$g.Dispose()
$bmp.Save("${outPng.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose(); $bmp.Dispose()
Write-Output "OK $pageW x $pageH"
`;

  const result = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  fs.unlinkSync(tmpImg);
  console.log(result.trim());
  console.log(`Preview written to: ${outPng}`);
  console.log(`Target: ${widthIn}x${heightIn}in, overscan=${overscan}`);
  console.log("Check: any red visible anywhere = a real uncovered gap. No red visible = full coverage confirmed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
