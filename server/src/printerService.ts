import { BrowserWindow } from "electron";
import { exec, execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { print as printPdfWindows } from "pdf-to-printer";
import { print as printPdfUnix } from "unix-print";
import { PrinterInfo, PrintRequest, PrinterMediaSize, PrinterOption, PrinterResolution, GetPrinterDetailsResult } from "./types";
import { logger } from "./logger";
import { rasterizePdfFirstPage } from "./pdfRaster";
import { scalePdfFirstPage } from "./pdfScale";
import { PDFDocument } from "pdf-lib";
import { applyQzCompat } from "./qzCompat";
import { sniffImage, buildImageHtml, imageToPdfBytes, extractSingleImageFromPdf, ImageKind } from "./imagePrint";

function execAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/** Uses Electron's built-in printer enumeration (wraps the native OS print
 *  subsystem on Windows/macOS/Linux, so no platform-specific code needed). */
export async function listPrinters(): Promise<PrinterInfo[]> {
  const probe = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    const printers = await probe.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      isDefault: !!p.isDefault,
      status: String(p.status ?? ""),
      driver: (p as unknown as { driverName?: string }).driverName,
    }));
  } finally {
    probe.destroy();
  }
}

// Reads System.Printing's PrintCapabilities XML for a queue and pulls the
// options out of five standard PrintSchema features — this is how a page
// can offer a printer's *actual* capabilities (including custom driver-
// defined ones, like a photo-lab printer's "Index Card 3 x 5 in" tray or its
// "User Type 4" media) instead of a fixed guess list. Verified directly
// against a real Noritsu 931BL's capabilities XML. The printer name is
// piped over stdin rather than interpolated into the script text, so names
// containing quotes/parens/etc. (very common — "Noritsu 931BL (Tray 1)")
// can never break out of the PowerShell string or enable injection.
const GET_PRINTER_DETAILS_PS = `
$printerName = [Console]::In.ReadLine()

Add-Type -AssemblyName System.Printing
$ps = New-Object System.Printing.LocalPrintServer
$q  = $ps.GetPrintQueue($printerName)
$sr = New-Object System.IO.StreamReader($q.GetPrintCapabilitiesAsXml())
$xml = [xml]$sr.ReadToEnd(); $sr.Close()

# System.Printing's PrintCapabilities (above) never attaches a width/height to
# a driver's "type your own size" option — confirmed, there's genuinely none
# there. But a DIFFERENT, older Windows layer — the per-user default DEVMODE,
# the same one GDI-based apps (Chrome included) read — DOES remember the last
# custom size actually set via the driver's own Properties/Preferences dialog.
# System.Drawing.Printing.PrinterSettings wraps exactly that legacy DEVMODE
# API, so if a custom size was ever saved for this user+printer, it shows up
# here with real numbers, even though it's invisible to every API above.
$defaultCustom = $null
try {
  Add-Type -AssemblyName System.Drawing
  $gdiSettings = New-Object System.Drawing.Printing.PrinterSettings
  $gdiSettings.PrinterName = $printerName
  $gdiPaper = $gdiSettings.DefaultPageSettings.PaperSize
  if ($gdiPaper.Kind -eq [System.Drawing.Printing.PaperKind]::Custom -and $gdiPaper.Width -gt 0 -and $gdiPaper.Height -gt 0) {
    $defaultCustom = [PSCustomObject]@{
      name = $gdiPaper.PaperName
      widthHundredthsInch = $gdiPaper.Width
      heightHundredthsInch = $gdiPaper.Height
    }
  }
} catch {}

function Get-FeatureOptions($featureName) {
  $feat = $xml.GetElementsByTagName('psf:Feature') | Where-Object { $_.name -eq $featureName }
  if (-not $feat) { return @() }
  foreach ($o in ($feat.ChildNodes | Where-Object { $_.LocalName -eq 'Option' })) {
    $disp = ($o.ChildNodes | Where-Object { $_.name -like '*DisplayName*' }).Value.'#text'
    if (-not $disp) { $disp = $o.name }
    $props = @{}
    foreach ($sp in ($o.ChildNodes | Where-Object { $_.LocalName -eq 'ScoredProperty' })) {
      $props[$sp.name] = $sp.Value.'#text'
    }
    [PSCustomObject]@{ name = $o.name; displayName = $disp; props = $props }
  }
}

$out = [PSCustomObject]@{
  sizes         = @(Get-FeatureOptions 'psk:PageMediaSize')
  resolutions   = @(Get-FeatureOptions 'psk:PageResolution')
  mediaTypes    = @(Get-FeatureOptions 'psk:PageMediaType')
  inputBins     = @(Get-FeatureOptions 'psk:JobInputBin')
  orientations  = @(Get-FeatureOptions 'psk:PageOrientation')
  defaultCustom = $defaultCustom
}
$out | ConvertTo-Json -Compress -Depth 6
`;

interface RawOption {
  /** The PrintSchema option's own internal identifier (e.g.
   *  "psk:NorthAmericaLetter") — not what SumatraPDF matches against, kept
   *  here only in case it's ever needed for debugging. */
  name: string;
  /** The human-readable name (e.g. "Letter") — this is what actually gets
   *  used to select the option on a print job. */
  displayName: string;
  props: Record<string, string | null>;
}

function toPlainOptions(rows: RawOption[] | RawOption | undefined): PrinterOption[] {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.filter((r) => r && (r.displayName || r.name)).map((r) => ({ name: r.displayName || r.name }));
}

/** Windows-only: the printer's real supported sizes, resolutions, media
 *  types, input bins, and orientations, read straight from its
 *  PrintCapabilities XML via .NET's System.Printing API. Returns all-empty
 *  on other platforms or if the query fails — callers should fall back to
 *  a static list rather than treat that as fatal.
 *
 *  Only `sizes.name`/`inputBins.name` are actually usable on a print job
 *  today (as `paperSize`/`inputBin`) — `resolutions` and `mediaTypes` are
 *  discoverable here but the print pipeline has no way yet to apply them
 *  (they're Windows driver DEVMODE settings, not something SumatraPDF's
 *  print-settings can set). Surface them for display, not as a promise
 *  they'll change what gets printed. */
export async function getPrinterDetails(printerName: string): Promise<GetPrinterDetailsResult> {
  const empty: GetPrinterDetailsResult = { sizes: [], resolutions: [], mediaTypes: [], inputBins: [], orientations: [] };
  if (process.platform !== "win32") return empty;

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", GET_PRINTER_DETAILS_PS],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(out))
    );
    child.stdin?.write(printerName + "\n");
    child.stdin?.end();
  });

  let parsed: {
    sizes?: RawOption[];
    resolutions?: RawOption[];
    mediaTypes?: RawOption[];
    inputBins?: RawOption[];
    orientations?: RawOption[];
    defaultCustom?: { name: string; widthHundredthsInch: number; heightHundredthsInch: number } | null;
  };
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch (err) {
    logger.warn(`getPrinterDetails: couldn't parse PowerShell output for "${printerName}": ${(err as Error).message}`);
    return empty;
  }

  const sizeRows = Array.isArray(parsed.sizes) ? parsed.sizes : parsed.sizes ? [parsed.sizes] : [];
  const sizes: PrinterMediaSize[] = sizeRows
    // Some entries (e.g. "PostScript Custom Page Size") report null width/
    // height — Number(null) is 0, not NaN, so that must be filtered before
    // the numeric conversion below, not after.
    .filter((r) => r?.props?.["psk:MediaSizeWidth"] != null && r?.props?.["psk:MediaSizeHeight"] != null)
    .map((r) => ({
      name: r.displayName || r.name,
      width: Number(r.props["psk:MediaSizeWidth"]),
      height: Number(r.props["psk:MediaSizeHeight"]),
      units: "micron" as const,
    }))
    .filter((s) => Number.isFinite(s.width) && Number.isFinite(s.height));

  // The entry (or entries) filtered out above because they report no fixed
  // width/height — "PostScript Custom Page Size" on a PostScript driver like
  // the Noritsu's. PrintCapabilities (above) never attaches dimensions to
  // this option, for any app — confirmed by direct testing. The option
  // itself is still real and worth surfacing by name, so a UI can offer
  // "type your own size" as a distinct, discoverable choice.
  const customSizeOptionName = sizeRows.find(
    (r) => r?.props?.["psk:MediaSizeWidth"] == null || r?.props?.["psk:MediaSizeHeight"] == null
  )?.displayName;

  // A *different* Windows layer than PrintCapabilities: the per-user default
  // DEVMODE (the same one GDI print pipelines — including Chrome's — read)
  // does remember the last custom size actually saved through the driver's
  // own Properties/Preferences dialog, even though it's invisible to every
  // API above. When present, this lets the custom-size option be offered
  // pre-filled with a real, live value instead of a blank box every time.
  const defaultCustomSize: PrinterMediaSize | undefined = parsed.defaultCustom
    ? {
        name: parsed.defaultCustom.name,
        width: Math.round((parsed.defaultCustom.widthHundredthsInch / 100) * MICRONS_PER_INCH),
        height: Math.round((parsed.defaultCustom.heightHundredthsInch / 100) * MICRONS_PER_INCH),
        units: "micron" as const,
      }
    : undefined;

  const resRows = Array.isArray(parsed.resolutions) ? parsed.resolutions : parsed.resolutions ? [parsed.resolutions] : [];
  const resolutions: PrinterResolution[] = resRows
    .filter((r) => r?.props?.["psk:ResolutionX"] != null && r?.props?.["psk:ResolutionY"] != null)
    .map((r) => ({
      name: r.displayName || r.name,
      dpiX: Number(r.props["psk:ResolutionX"]),
      dpiY: Number(r.props["psk:ResolutionY"]),
    }))
    .filter((r) => Number.isFinite(r.dpiX) && Number.isFinite(r.dpiY));

  // Fires on every "get printer details" call — i.e. whenever the demo page
  // loads/reconnects, no actual print needed — specifically so this one
  // value can be checked just by opening the page, instead of needing a
  // full print test each time.
  logger.info(
    `getPrinterDetails: customSizeOptionName=${customSizeOptionName ? `"${customSizeOptionName}"` : "(not found)"} defaultCustomSize=${
      defaultCustomSize ? `${defaultCustomSize.width}x${defaultCustomSize.height} microns` : "(not found)"
    }`
  );

  return {
    sizes,
    resolutions,
    mediaTypes: toPlainOptions(parsed.mediaTypes),
    inputBins: toPlainOptions(parsed.inputBins),
    orientations: toPlainOptions(parsed.orientations),
    ...(customSizeOptionName ? { customSizeOptionName } : {}),
    ...(defaultCustomSize ? { defaultCustomSize } : {}),
  };
}

/** Maps PrintTrays's wire-protocol print options onto Electron's native
 *  print() options — duplex/orientation/paper size/margins/color are all
 *  already supported by Chromium's print pipeline, just not previously
 *  exposed through PrintTrays's own API. */
// Electron's own `pageSize` option only recognizes these six exact strings —
// anything else (every one of this driver's own named sizes: "5 x 7in E2E",
// "Legal13", "8.5\"SQ", …) silently doesn't match, and Electron falls back
// to some default instead of erroring, which looked like a random/wrong
// orientation with no obvious cause. A name outside this set has to be
// resolved to real {width, height} microns first — the same lookup already
// used for an image job — not passed through as a bare string.
const ELECTRON_BUILTIN_PAGE_SIZES = new Set(["A3", "A4", "A5", "Legal", "Letter", "Tabloid"]);

async function buildElectronPrintOptions(
  req: PrintRequest,
  printer: string,
  copies: number
): Promise<Electron.WebContentsPrintOptions> {
  let pageSize: Electron.WebContentsPrintOptions["pageSize"];
  if (req.paperSize && ELECTRON_BUILTIN_PAGE_SIZES.has(req.paperSize)) {
    pageSize = req.paperSize as Electron.WebContentsPrintOptions["pageSize"];
  } else if (req.paperSize) {
    const m = await lookupPaperMicrons(printer, req.paperSize).catch(() => null);
    if (m) pageSize = { width: m.w, height: m.h };
  }
  return {
    silent: true,
    deviceName: printer,
    copies,
    landscape: req.landscape,
    color: req.color,
    scaleFactor: req.scaleFactor,
    duplexMode: req.duplex,
    ...(pageSize ? { pageSize } : {}),
    margins: req.margins,
  };
}

/** Renders HTML (or a PDF's built-in viewer) in a hidden window and sends it
 *  to a standard printer via the OS print spooler. */
async function printRendered(html: string, req: PrintRequest, printer: string, copies = 1): Promise<void> {
  const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const printOptions = await buildElectronPrintOptions(req, printer, copies);
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(printOptions, (ok, failureReason) => {
        if (ok) resolve();
        else reject(new Error(failureReason || "print failed"));
      });
    });
  } finally {
    win.destroy();
  }
}

const DUPLEX_TO_SUMATRA: Record<string, "duplexshort" | "duplexlong" | "simplex"> = {
  shortEdge: "duplexshort",
  longEdge: "duplexlong",
};

function duplexToCupsSides(duplex: string | undefined): string | null {
  if (duplex === "shortEdge") return "two-sided-short-edge";
  if (duplex === "longEdge") return "two-sided-long-edge";
  return null;
}

/** SumatraPDF has no dedicated "reverse order" switch — its own forum and
 *  docs confirm the way to do it is a backwards page range in -print-settings
 *  (e.g. "5-1" prints pages 5,4,3,2,1), which is what pdf-to-printer's
 *  `pages` option passes straight through. Only meaningful for an actual
 *  multi-page document, so a 1-page PDF returns undefined (prints normally)
 *  rather than the no-op "1-1". */
async function reversedPageRange(pdfBytes: Buffer): Promise<string | undefined> {
  try {
    const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    const count = doc.getPageCount();
    return count > 1 ? `${count}-1` : undefined;
  } catch (err) {
    logger.warn(`pageOrder: couldn't read page count, printing in normal order: ${(err as Error).message}`);
    return undefined;
  }
}

/** Electron's own PDF viewer is implemented via Chromium's extension system
 *  and is documented by Electron maintainers as unprintable via
 *  webContents.print() — loadURL()+print() on a PDF reliably yields blank
 *  pages (worse the more image-heavy the PDF is), no amount of waiting for
 *  load events fixes it (see electron/electron#26448). So PDFs are handed
 *  directly to the OS's own PDF-capable print pipeline instead: SumatraPDF
 *  on Windows (bundled by pdf-to-printer), CUPS lp on macOS/Linux. */
async function printPdfBase64(base64: string, req: PrintRequest, printer: string, copies = 1, paperSizeOverride?: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `printtrays-${Date.now()}.pdf`);
  let bytes: Buffer = Buffer.from(base64, "base64");

  // "custom" % scaling has no equivalent in SumatraPDF's own scale option
  // (only noscale/shrink/fit — no arbitrary percentage), so it's done here,
  // physically re-rendering the content onto a same-size page before it
  // ever reaches SumatraPDF. That's then told "noscale" below, since the
  // content is already exactly the size it should be.
  if (req.scaleMode === "custom" && typeof req.scaleFactor === "number" && req.scaleFactor > 0) {
    try {
      bytes = await scalePdfFirstPage(bytes, req.scaleFactor);
    } catch (err) {
      logger.warn(`PDF print: custom scale (${req.scaleFactor}%) failed, printing unscaled: ${(err as Error).message}`);
    }
  }

  fs.writeFileSync(tmp, bytes);

  // Temporary diagnostics: keep a copy of exactly what we tried to print and
  // log what we sent to the OS print pipeline, so a "reports success but
  // prints blank" report can be root-caused from real evidence (bad input
  // data vs. a driver-side issue) instead of another guess.
  const debugDir = path.join(os.homedir(), "AppData", "Roaming", "PrintTrays", "debug-prints");
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const debugPath = path.join(debugDir, `printtrays-debug-${Date.now()}.pdf`);
    fs.writeFileSync(debugPath, bytes);
    logger.info(
      `PDF print debug: saved copy to ${debugPath} | byteLength=${bytes.length} | header="${bytes
        .subarray(0, 8)
        .toString("latin1")}" | printer="${printer}" | paperSize=${paperSizeOverride ?? req.paperSize ?? "(default)"} | duplex=${
        req.duplex ?? "(none)"
      } | color=${req.color !== false} | landscape=${!!req.landscape} | copies=${copies}`
    );
  } catch (err) {
    logger.warn(`PDF print debug: failed to save debug copy: ${(err as Error).message}`);
  }

  const pages = req.pageOrder === "backToFront" ? await reversedPageRange(bytes) : undefined;

  try {
    if (process.platform === "win32") {
      await printPdfWindows(tmp, {
        printer,
        copies,
        silent: true,
        orientation: req.landscape ? "landscape" : "portrait",
        monochrome: req.color === false,
        side: req.duplex ? DUPLEX_TO_SUMATRA[req.duplex] : "simplex",
        paperSize: paperSizeOverride ?? req.paperSize,
        bin: req.inputBin,
        ...(pages ? { pages } : {}),
        // Without this, SumatraPDF defaults to "shrink" — it only scales
        // pages DOWN when they're too big for the paper, never UP. So
        // printing a normal-size PDF onto a larger paperSize (like an "E2E"
        // borderless media that's physically bigger than its nominal size)
        // left the content at its original size in the corner of the sheet
        // instead of filling it — the opposite of what selecting a
        // borderless size is for. "fit" scales the content to fill the
        // selected paper (up or down) while keeping its aspect ratio.
        // "actual"/"custom" both want SumatraPDF to leave the page alone —
        // for "custom" the content was already pre-scaled above. The
        // custom-size driver-default flow (`useDriverDefaultSize`) is the
        // same situation: the PDF page here is already built at exactly the
        // target size (imageToPdfBytes), so no further scaling should be
        // needed — confirmed on real hardware that "fit" was still leaving
        // blank margins top/bottom despite the page already being correctly
        // sized and the right named paper being selected, which "fit"
        // scaling to some other number SumatraPDF associates with that
        // paper name would fully explain. "noscale" removes that scaling
        // decision entirely instead of continuing to guess at it.
        scale: req.scaleMode === "actual" || req.scaleMode === "custom" || req.useDriverDefaultSize ? "noscale" : "fit",
      });
      logger.info("PDF print debug: printPdfWindows() resolved without error");
    } else {
      const options = ["-n", String(copies)];
      if (req.landscape) options.push("-o", "landscape");
      if (req.color === false) options.push("-o", "monochrome");
      const sides = duplexToCupsSides(req.duplex);
      if (sides) options.push("-o", `sides=${sides}`);
      if (req.paperSize) options.push("-o", `media=${req.paperSize}`);
      if (req.pageOrder === "backToFront") options.push("-o", "outputorder=reverse");
      const result = await printPdfUnix(tmp, printer, options);
      logger.info(`PDF print debug: printPdfUnix() resolved — stdout="${result?.stdout}" stderr="${result?.stderr}"`);
    }
  } catch (err) {
    logger.error(`PDF print debug: OS print call threw: ${(err as Error).message}`);
    throw err;
  } finally {
    fs.unlink(tmp, () => undefined);
  }
}

/** Sends raw bytes (ESC/POS or ZPL) straight through the OS spooler to a
 *  printer configured with a raw/passthrough (e.g. "Generic / Text Only")
 *  driver. This bypasses page rendering entirely. */
async function printRawToSpooler(bytes: Buffer, printer: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `printtrays-raw-${Date.now()}.bin`);
  fs.writeFileSync(tmp, bytes);
  try {
    if (process.platform === "win32") {
      // Requires the target printer to be shared/reachable as \\localhost\<name>,
      // or installed with a RAW-capable driver. This is the standard
      // workaround for raw printing on Windows without the WinSpool native API.
      await execAsync(`copy /b "${tmp}" "\\\\localhost\\${printer}"`);
    } else {
      await execAsync(`lp -d "${printer}" -o raw "${tmp}"`);
    }
  } finally {
    fs.unlink(tmp, () => undefined);
  }
}

/** Rasterizes the PDF ourselves and sends the resulting JPEG straight to the
 *  printer as a raw feed, skipping SumatraPDF/GDI's own page-rendering step
 *  entirely. Some printer drivers (photo minilab units in particular) are
 *  dramatically slower processing a GDI/EMF job than a flat raster image —
 *  this is the same class of "raw" pass-through printing other print
 *  bridges use to get near-instant turnaround on those printers. Opt-in via
 *  `fastRaster` since a plain raw feed isn't guaranteed to be accepted by
 *  every printer's queue the way a real PDF-aware driver call is. */
async function printPdfViaRasterRaw(base64: string, printer: string): Promise<void> {
  const pdfBytes = Buffer.from(base64, "base64");
  const jpeg = await rasterizePdfFirstPage(pdfBytes, "jpeg");
  logger.info(`PDF fast-raster: rasterized ${pdfBytes.length}-byte PDF to ${jpeg.length}-byte JPEG`);
  await printRawToSpooler(jpeg, printer);
}

// ── Image printing ─────────────────────────────────────────────────────────
// SumatraPDF draws a page as one uncompressed bitmap at the driver's DPI: a
// 32 KB photo became a 41 MB spool job for a 5x7in print (measured on the
// Noritsu queue), and the driver has to swallow all of it. Chromium's print
// engine — what Ctrl+P uses — hands the driver the image itself (0.3 MB for
// the same photo). Photos therefore go through Chromium; real documents keep
// the SumatraPDF route.

const MICRONS_PER_INCH = 25400;
const LETTER_MICRONS = { w: 215900, h: 279400 };
const PAPER_CACHE_MS = 10 * 60 * 1000;
const paperCache = new Map<string, { at: number; sizes: PrinterMediaSize[] }>();

async function lookupPaperMicrons(printer: string, name: string): Promise<{ w: number; h: number } | null> {
  let entry = paperCache.get(printer);
  if (!entry || Date.now() - entry.at > PAPER_CACHE_MS) {
    const details = await getPrinterDetails(printer);
    entry = { at: Date.now(), sizes: details.sizes };
    if (details.sizes.length) paperCache.set(printer, entry);
  }
  const hit = entry.sizes.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return hit ? { w: hit.width, h: hit.height } : null;
}

/** Exact page size for an image job: explicit pageSize, else the printer's own size of that name, else the PDF page, else Letter. */
async function resolvePageMicrons(
  req: PrintRequest,
  printer: string,
  fallbackPt?: [number, number]
): Promise<{ w: number; h: number }> {
  const ps = req.pageSize;
  if (ps && ps.width > 0 && ps.height > 0) {
    const k = ps.units === "mm" ? 1000 : ps.units === "micron" ? 1 : MICRONS_PER_INCH;
    return { w: Math.round(ps.width * k), h: Math.round(ps.height * k) };
  }
  if (req.paperSize) {
    const m = await lookupPaperMicrons(printer, String(req.paperSize)).catch(() => null);
    if (m) return m;
  }
  if (fallbackPt) {
    return { w: Math.round((fallbackPt[0] * MICRONS_PER_INCH) / 72), h: Math.round((fallbackPt[1] * MICRONS_PER_INCH) / 72) };
  }
  return LETTER_MICRONS;
}

function normalizedRotation(deg: number | undefined): number {
  return (((Math.round((deg ?? 0) / 90) * 90) % 360) + 360) % 360;
}

async function printImageChromium(
  image: Buffer,
  req: PrintRequest,
  printer: string,
  copies: number,
  fallbackPt?: [number, number]
): Promise<void> {
  const kind = sniffImage(image);
  if (!kind) throw new Error("Unsupported image format — expected JPEG, PNG, WEBP or GIF");

  let { w, h } = await resolvePageMicrons(req, printer, fallbackPt);
  if (req.landscape === true && w < h) [w, h] = [h, w];
  const rotation = normalizedRotation(req.rotation);
  const factor = req.scaleMode === "custom" && req.scaleFactor && req.scaleFactor > 0 ? req.scaleFactor / 100 : 1;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const imgPath = path.join(os.tmpdir(), `printtrays-img-${stamp}.${kind.ext}`);
  const htmlPath = path.join(os.tmpdir(), `printtrays-img-${stamp}.html`);
  fs.writeFileSync(imgPath, image);
  fs.writeFileSync(htmlPath, buildImageHtml(path.basename(imgPath), w / MICRONS_PER_INCH, h / MICRONS_PER_INCH, rotation, factor));
  logger.info(
    `image print (chromium): ${image.length} bytes ${kind.mime} -> ${(w / MICRONS_PER_INCH).toFixed(2)}x${(h / MICRONS_PER_INCH).toFixed(2)}in rotation=${rotation} factor=${factor}`
  );

  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript("Promise.all(Array.from(document.images).map(function(i){return i.decode();}))");
    const electronPrintOptions = {
      silent: true,
      deviceName: printer,
      copies,
      printBackground: true,
      color: req.color !== false,
      margins: { marginType: "none" as const },
      ...(req.duplex ? { duplexMode: req.duplex } : {}),
      // This function is never called for the custom-size driver-default
      // flow (`useDriverDefaultSize`) — see printImage() below, which routes
      // that case through the classic SumatraPDF engine instead, since
      // Electron's own page-size handling turned out to have a real bug for
      // that specific driver/custom-size combination (three different
      // compensation attempts here each failed in a different way; Adobe
      // and SumatraPDF, which both go through the standard Windows print
      // path instead of Chromium's own, get it right without any of this).
      // For every other (non-custom-size) job, both options below are
      // required explicitly — `landscape` being left out previously made
      // Electron fall back to whatever orientation was left over from a
      // previous job, and `pageSize` being left out made it fall back to
      // the printer's current default size, not the one actually requested.
      landscape: w > h,
      // Chromium takes the page size portrait-oriented and applies `landscape` on top.
      pageSize: { width: Math.min(w, h), height: Math.max(w, h) },
    };
    // Exactly what gets handed to Electron/the Windows driver — the single
    // most useful line for checking "what did PrintTrays actually ask the
    // printer to do" against what came out of the printer.
    logger.info(`image print (chromium): webContents.print() options -> ${JSON.stringify(electronPrintOptions)}`);
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(electronPrintOptions, (ok, failureReason) => {
        if (ok) {
          logger.info("image print (chromium): webContents.print() reported success");
          resolve();
        } else {
          logger.error(`image print (chromium): webContents.print() reported failure — ${failureReason || "unknown reason"}`);
          reject(new Error(failureReason || "print failed"));
        }
      });
    });
  } finally {
    win.destroy();
    fs.unlink(imgPath, () => undefined);
    fs.unlink(htmlPath, () => undefined);
  }
}

/** Classic route for an image: wrap it into a PDF the size of the paper and send that through SumatraPDF. */
async function printImageViaPdf(
  image: Buffer,
  req: PrintRequest,
  printer: string,
  copies: number,
  fallbackPt?: [number, number]
): Promise<void> {
  const { w, h } = await resolvePageMicrons(req, printer, fallbackPt);
  const kind = sniffImage(image);
  const pdf = kind ? await imageToPdfBytes(image, kind, w / MICRONS_PER_INCH, h / MICRONS_PER_INCH) : null;
  if (!pdf) throw new Error("The classic print engine only supports JPEG and PNG images");
  await printPdfBase64(pdf.toString("base64"), req, printer, copies);
}

/** Flips an image's pixels 180 degrees (no dimension swap, unlike a 90°
 *  rotation). Re-encodes as PNG when the source was PNG (lossless — a
 *  design with flat colors/text/logos shows visible JPEG blocking
 *  otherwise) and JPEG only as a fallback for other formats. See
 *  printImageViaSumatraClassic's doc comment — this is specifically the
 *  1.3.13-era compensation, brought back deliberately at the user's
 *  explicit request after 1.3.25 (built on a real, confirmed technical
 *  fix) still didn't produce a correct result on real hardware. Known
 *  tradeoff, not a secret: this exact combination (classic SumatraPDF
 *  engine + 180° pre-rotation) was the one found later to depend on the
 *  driver's shared, mutable custom-size state — it looked right in that
 *  one test, but was never confirmed consistent across repeated prints,
 *  which is why the project moved away from it. Restored here as an
 *  explicit, deliberate choice, not a rediscovery. */
async function rotateImage180(image: Buffer, kind: ImageKind): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(image);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width, canvas.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(img, 0, 0);
  return kind.mime === "image/png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", 0.95);
}

/** The exact 1.3.13-era custom-size path, restored deliberately: classic
 *  SumatraPDF engine, the driver's custom-size slot selected by name, and
 *  a 180° content pre-rotation to compensate for this driver's upside-down
 *  behavior on that engine. Confirmed on real hardware (white border on all
 *  four sides) that removing overscan entirely (1.3.28/1.3.29) reintroduced
 *  this driver's real non-printable margin as a visible unprinted gap — the
 *  3%/7% percentage guesses were replaced with nothing instead of with the
 *  right number. The driver's own developer then gave the actual fixed
 *  margin: 0.57in width, 0.49in height (NOT a percentage — doesn't scale
 *  with page size, confirmed by the two axes being different percentages
 *  of this specific page: 0.57/6.48=8.8%, 0.49/8.76=5.6%, which also lines
 *  up with the ~5.6% minimum separately measured earlier via
 *  PageSettings.PrintableArea for the height axis). The PDF page itself
 *  stays at the exact requested size (matching the physical paper the
 *  driver was told to use by name, since SumatraPDF prints this path with
 *  scale:"noscale" — a smaller/larger PDF page than the physical paper
 *  leaves blank paper, confirmed separately) — only the drawn image bleeds
 *  past the page edge by this fixed margin, centered. */
const E2E_BLEED_IN = { w: 0.57, h: 0.49 };

async function printImageViaSumatraClassic(
  image: Buffer,
  req: PrintRequest,
  printer: string,
  copies: number,
  fallbackPt?: [number, number]
): Promise<void> {
  const { w, h } = await resolvePageMicrons(req, printer, fallbackPt);
  const kind = sniffImage(image);
  const finalImage = kind ? await rotateImage180(image, kind) : image;
  const finalKind = kind ? (kind.mime === "image/png" ? kind : { mime: "image/jpeg", ext: "jpg" }) : kind;

  let paperSizeOverride: string | undefined;
  try {
    const details = await getPrinterDetails(printer);
    paperSizeOverride = details.customSizeOptionName;
    if (paperSizeOverride?.includes(",")) {
      logger.warn(`classic engine (1.3.13 path): customSizeOptionName contains a comma ("${paperSizeOverride}") — skipping it to avoid corrupting SumatraPDF's settings string`);
      paperSizeOverride = undefined;
    }
    logger.info(
      paperSizeOverride
        ? `classic engine (1.3.13 path): using the driver's custom-size option by name -> "${paperSizeOverride}"`
        : `classic engine (1.3.13 path): printer reported no customSizeOptionName — paperSize will be left unset`
    );
  } catch (err) {
    logger.warn(`classic engine (1.3.13 path): couldn't look up the driver's custom-size option name: ${(err as Error).message}`);
  }

  const pdf = finalKind
    ? await imageToPdfBytes(
        finalImage,
        finalKind,
        w / MICRONS_PER_INCH,
        h / MICRONS_PER_INCH,
        1,
        E2E_BLEED_IN.w,
        E2E_BLEED_IN.h,
        undefined,
        true // independent axis scaling — see imageToPdfBytes' doc comment; cuts the extra crop that uniform
        // scaling forces on whichever axis has more natural slack, at the cost of a mild aspect stretch.
      )
    : null;
  if (!pdf) throw new Error("The classic print engine only supports JPEG and PNG images");

  // Local, no-printer-needed coverage check — same idea as preview-print.js,
  // but built from the exact same code path as the real print instead of a
  // hand-rolled approximation, and saved alongside the real debug PDF so a
  // gap can be caught before it ever reaches a physical print. A real
  // uncovered gap and the PDF's own default white page background are
  // visually identical, which is exactly why the 1.3.28/1.3.29 white-border
  // bug wasn't visible in the normal debug PDF — filling the page black
  // first makes any gap obvious at a glance.
  if (finalKind) {
    try {
      const diagPdf = await imageToPdfBytes(
        finalImage,
        finalKind,
        w / MICRONS_PER_INCH,
        h / MICRONS_PER_INCH,
        1,
        E2E_BLEED_IN.w,
        E2E_BLEED_IN.h,
        { r: 0, g: 0, b: 0 },
        true // must match the real print's independentAxisScale setting above, or this coverage check
        // would be verifying different math than what actually gets sent to the printer.
      );
      if (diagPdf) {
        const debugDir = path.join(os.homedir(), "AppData", "Roaming", "PrintTrays", "debug-prints");
        fs.mkdirSync(debugDir, { recursive: true });
        const diagPath = path.join(debugDir, `printtrays-debug-${Date.now()}-coverage-check.pdf`);
        fs.writeFileSync(diagPath, diagPdf);
        logger.info(
          `classic engine (1.3.13 path): coverage check saved to ${diagPath} — any black visible around the photo means a real uncovered gap at this exact size; open and check before trusting a physical print`
        );
      }
    } catch (err) {
      logger.warn(`classic engine (1.3.13 path): couldn't save coverage-check PDF: ${(err as Error).message}`);
    }
  }

  await printPdfBase64(pdf.toString("base64"), req, printer, copies, paperSizeOverride);
}

// Along the way, also confirmed the driver's "type your own size" slot is
// shared, mutable state — its remembered width/height changes whenever
// *anything* (Adobe, Ctrl+P, a different PrintTrays job) last saved a
// different value through it. Checked the same named slot twice in one
// session: 648x876 the first time, 1150x1749 the second, with nothing in
// our own code changed in between — why nothing that selected a paper *by
// name* was ever going to be reliable, and why printImageViaDevmode below
// sends its own exact size with every job instead.
//
// A raw-PostScript-direct-to-spooler approach was also tried and removed:
// this driver turned out not to be a true PostScript RIP, so bypassing the
// Windows driver's translation step (the same way Adobe appeared to) left
// the printer holding data it couldn't understand — the job reached
// "SUCCESS" in our own log but nothing physically printed. See
// printImageViaDevmode's doc comment for where that left things.
// Confirmed on real hardware: this driver is NOT a true PostScript RIP —
// it's a Windows PostScript-*class* driver that does essential translation
// into the printer's own proprietary protocol. Sending raw PostScript
// straight to the spooler (printImageViaPostScript, above) bypasses that
// translation on purpose, same as Adobe appeared to — but on real hardware
// the job was accepted into the queue ("SUCCESS" in our own log) and then
// nothing physically printed at all, because the printer never understood
// the raw PostScript it was handed. So Adobe must be going through this
// same driver after all, triggering something correctly that explicit
// GDI-level requests (Electron, SumatraPDF, this function) haven't found
// yet — not bypassing it, as the PostScript attempt assumed. Back to this
// known-working baseline (correct size and paper selection, confirmed on
// real hardware; orientation still unresolved) while that gets re-examined,
// since *something* physically printing is strictly better than nothing.
async function printImageViaDevmode(image: Buffer, req: PrintRequest, printer: string, copies: number, fallbackPt?: [number, number]): Promise<void> {
  const { w, h } = await resolvePageMicrons(req, printer, fallbackPt);
  const widthIn = w / MICRONS_PER_INCH;
  const heightIn = h / MICRONS_PER_INCH;

  const tmp = path.join(os.tmpdir(), `printtrays-devmode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  fs.writeFileSync(tmp, image);

  // Saves exactly the image this job sends to the driver — same purpose as
  // the debug copies elsewhere in this file: lets a "did it print wrong"
  // report be checked against the real input instead of guessed at, and
  // lets preview-print.js be run against the *actual* file from a real
  // test instead of only a hand-made one.
  const debugDir = path.join(os.homedir(), "AppData", "Roaming", "PrintTrays", "debug-prints");
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const debugPath = path.join(debugDir, `printtrays-debug-${Date.now()}.jpg`);
    fs.writeFileSync(debugPath, image);
    logger.info(`print (devmode): saved copy to ${debugPath}`);
  } catch (err) {
    logger.warn(`print (devmode): failed to save debug copy: ${(err as Error).message}`);
  }

  try {
    const payload = JSON.stringify({
      printer,
      imagePath: tmp,
      widthIn,
      heightIn,
      color: req.color !== false,
      copies,
      // Measured directly on real hardware via .NET's PageSettings.PrintableArea
      // for this exact custom size: printable area is inset by ~18 hundredths-
      // inch (~0.18in) on every side. 7% leaves a small safety margin above
      // the precisely measured ~5.6% needed.
      overscan: 1.07,
    });
    logger.info(`print (devmode): requesting ${widthIn.toFixed(2)}x${heightIn.toFixed(2)}in, explicit PaperSize, printer="${printer}"`);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", PRINT_VIA_DEVMODE_PS],
        { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
        (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))
      );
      child.stdin?.write(payload + "\n");
      child.stdin?.end();
    });
    if (!stdout.includes("PRINTTRAYS_DEVMODE_PRINT_OK")) {
      throw new Error(`Unexpected output from print-via-devmode script: ${stdout.trim()}`);
    }
    logger.info(`print (devmode): printed successfully — ${stdout.trim()}`);
  } finally {
    fs.unlink(tmp, () => undefined);
  }
}

// The driver's own PPD file states outright, in a comment, that it does
// not use the standard PostScript orientation parameter for custom page
// sizes at all ("Orientation and Margin (offsets) values are not
// utilized") — explaining why forcing Landscape=false (the previous
// attempt) could never have worked; it's not a bug, it's documented
// driver behavior. The PPD separately exposes a real, driver-specific
// rotation feature ("Page Rotate" / OKEnvRotate), set from the driver's
// own Properties dialog — but every version up to this one built a brand
// new PaperSize object from scratch for each job, which likely resets
// that and every other driver-private setting back to its default each
// time, silently discarding whatever was configured in the dialog.
// Instead of constructing settings from scratch, this reads the printer's
// *current* DEVMODE (which already reflects whatever's set in the driver's
// own Properties dialog — Page Rotate included) and patches only the two
// fields that actually need to change (paper width/height, in DEVMODE's
// native unit of tenths of a millimeter) directly in the raw bytes,
// leaving every other field — Page Rotate above all — exactly as the
// dialog has it.
const PRINT_VIA_DEVMODE_PS = `
$ErrorActionPreference = "Stop"
$json = [Console]::In.ReadLine()
$p = ConvertFrom-Json $json

Add-Type -AssemblyName System.Drawing

# Confirmed by direct comparison on real hardware: .NET's own GetHdevmode()
# does NOT faithfully return the printer's true current settings — it comes
# back 64 bytes smaller than the devmode the raw Win32 DocumentProperties
# API returns for the exact same printer at the exact same moment. That gap
# is almost certainly why Ctrl+P and Adobe (which go through the real Win32
# path) have printed this exact custom size correctly while every one of
# our own attempts, including the previous version of this function that
# patched .NET's (apparently already-wrong) devmode, did not. This bypasses
# .NET's devmode retrieval entirely and calls DocumentProperties directly —
# the same API Windows' own printing pipeline uses — then patches only the
# two size fields in *that* buffer before handing it to .NET for drawing.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PrintTraysDevmode {
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern bool OpenPrinter(string printerName, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint = "DocumentPropertiesA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
    public static extern int DocumentProperties(IntPtr hwnd, IntPtr hPrinter, string pDeviceName, IntPtr pDevModeOutput, IntPtr pDevModeInput, int fMode);

    public const uint GMEM_MOVEABLE = 0x2;
    public const int DM_OUT_BUFFER = 2;

    // Returns a GlobalAlloc'd HGLOBAL (same convention PrinterSettings.
    // SetHdevmode expects) containing the printer's TRUE current devmode,
    // read via the real Win32 API instead of .NET's lossy wrapper.
    public static IntPtr GetTrueCurrentHdevmode(string printerName) {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter failed: " + Marshal.GetLastWin32Error());
        try {
            int size = DocumentProperties(IntPtr.Zero, hPrinter, printerName, IntPtr.Zero, IntPtr.Zero, 0);
            if (size <= 0) throw new Exception("DocumentProperties size query failed: " + Marshal.GetLastWin32Error());
            IntPtr hGlobal = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)size);
            if (hGlobal == IntPtr.Zero) throw new Exception("GlobalAlloc failed");
            IntPtr pDevMode = GlobalLock(hGlobal);
            try {
                int result = DocumentProperties(IntPtr.Zero, hPrinter, printerName, pDevMode, IntPtr.Zero, DM_OUT_BUFFER);
                if (result < 0) throw new Exception("DocumentProperties DM_OUT_BUFFER failed: " + Marshal.GetLastWin32Error());
            } finally {
                GlobalUnlock(hGlobal);
            }
            return hGlobal;
        } finally {
            ClosePrinter(hPrinter);
        }
    }
}
"@

$img = [System.Drawing.Image]::FromFile($p.imagePath)
try {
  $ps = New-Object System.Drawing.Printing.PrinterSettings
  $ps.PrinterName = $p.printer
  if ([int]$p.copies -gt 1) { $ps.Copies = [int16]$p.copies }

  # Standard DEVMODEW field offsets (fixed by the Win32 API spec, not
  # driver-specific — only the bytes AFTER this fixed block are
  # driver-private, and those are the ones being left untouched here).
  $OFFSET_DMFIELDS = 72
  $OFFSET_DMPAPERSIZE = 78
  $OFFSET_DMPAPERLENGTH = 80
  $OFFSET_DMPAPERWIDTH = 82
  $OFFSET_DMCOLOR = 92
  $DM_PAPERSIZE = 0x2; $DM_PAPERLENGTH = 0x4; $DM_PAPERWIDTH = 0x8; $DM_COLOR = 0x800
  $DMPAPER_USER = 256
  $DMCOLOR_MONOCHROME = 1; $DMCOLOR_COLOR = 2

  # DEVMODE paper dimensions are in tenths of a millimeter, not hundredths
  # of an inch (that unit is specific to System.Drawing.Printing.PaperSize,
  # which isn't used here at all).
  $widthTenthsMm = [int16]([Math]::Round([double]$p.widthIn * 25.4 * 10))
  $heightTenthsMm = [int16]([Math]::Round([double]$p.heightIn * 25.4 * 10))

  $hDevMode = [PrintTraysDevmode]::GetTrueCurrentHdevmode($p.printer)
  $pDevMode = [PrintTraysDevmode]::GlobalLock($hDevMode)
  try {
    $fields = [System.Runtime.InteropServices.Marshal]::ReadInt32($pDevMode, $OFFSET_DMFIELDS)
    $fields = $fields -bor $DM_PAPERSIZE -bor $DM_PAPERLENGTH -bor $DM_PAPERWIDTH -bor $DM_COLOR
    [System.Runtime.InteropServices.Marshal]::WriteInt32($pDevMode, $OFFSET_DMFIELDS, $fields)
    [System.Runtime.InteropServices.Marshal]::WriteInt16($pDevMode, $OFFSET_DMPAPERSIZE, [int16]$DMPAPER_USER)
    [System.Runtime.InteropServices.Marshal]::WriteInt16($pDevMode, $OFFSET_DMPAPERLENGTH, $heightTenthsMm)
    [System.Runtime.InteropServices.Marshal]::WriteInt16($pDevMode, $OFFSET_DMPAPERWIDTH, $widthTenthsMm)
    $colorValue = if ([bool]$p.color) { $DMCOLOR_COLOR } else { $DMCOLOR_MONOCHROME }
    [System.Runtime.InteropServices.Marshal]::WriteInt16($pDevMode, $OFFSET_DMCOLOR, [int16]$colorValue)
  } finally {
    [PrintTraysDevmode]::GlobalUnlock($hDevMode) | Out-Null
  }
  $ps.SetHdevmode($hDevMode)
  $ps.DefaultPageSettings.SetHdevmode($hDevMode)

  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings = $ps
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

  $overscan = [double]$p.overscan

  $handler = {
    param($sender, $e)
    $pageW = $e.PageBounds.Width
    $pageH = $e.PageBounds.Height
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $scale = [Math]::Max($pageW / $img.Width, $pageH / $img.Height) * $overscan
    $dw = $img.Width * $scale
    $dh = $img.Height * $scale
    $x = ($pageW - $dw) / 2
    $y = ($pageH - $dh) / 2
    $e.Graphics.DrawImage($img, $x, $y, $dw, $dh)
  }
  $doc.add_PrintPage($handler)
  $doc.Print()
  Write-Output "PRINTTRAYS_DEVMODE_PRINT_OK"
} finally {
  $img.Dispose()
}
`;

async function printImage(
  image: Buffer,
  req: PrintRequest,
  printer: string,
  copies: number,
  fallbackPt?: [number, number]
): Promise<void> {
  // Electron's webContents.print(), SumatraPDF, a direct .NET PrintDocument
  // (preserving the driver's current settings, then rewritten again to use
  // the true Win32 devmode instead of .NET's own, confirmed-incomplete
  // version of it), and a raw PostScript document sent straight to the
  // spooler were all tried in turn — each grounded in real, confirmed
  // technical evidence, none of them yet confirmed correct on real
  // hardware for orientation. At the user's explicit, repeated, deliberate
  // request, this now uses the earlier (1.3.13-era) classic SumatraPDF
  // path instead — the one version that showed a correct orientation on
  // real hardware, even though it's built on a foundation (the driver's
  // shared, mutable custom-size state) later proven unreliable across
  // repeated tests. This is a known, explicit tradeoff, not a step taken
  // without understanding its risk — see printImageViaSumatraClassic's doc
  // comment for the full reasoning on both sides.
  if (req.useDriverDefaultSize) return printImageViaSumatraClassic(image, req, printer, copies, fallbackPt);
  if (req.imageEngine === "sumatra") return printImageViaPdf(image, req, printer, copies, fallbackPt);
  try {
    await printImageChromium(image, req, printer, copies, fallbackPt);
  } catch (err) {
    logger.warn(`image print (chromium) failed: ${(err as Error).message} — falling back to the classic engine`);
    if (normalizedRotation(req.rotation) !== 0) throw err;
    await printImageViaPdf(image, req, printer, copies, fallbackPt).catch(() => {
      throw err;
    });
  }
}

// wsServer's `ws.on("message", ...)` handler doesn't await its listener, so
// two print requests arriving close together (e.g. clicking "Send a test
// print" right after "Upload and print", before the first has finished —
// a single job here takes several seconds) were free to run fully
// concurrently, both hitting the OS print spooler/the physical printer at
// the same time with no ordering guarantee at all. On an ordinary sheet-fed
// printer that's merely wasteful; on this roll-fed one it let two entirely
// different jobs print onto the *same* physical sheet with no cut between
// them — exactly the double-exposed, two-designs-overlapping sheet seen on
// real hardware. This queue forces every print request through this module
// to run strictly one at a time, in arrival order, regardless of which
// browser tab or button triggered it.
let printQueue: Promise<void> = Promise.resolve();

export function handlePrint(req: PrintRequest): Promise<void> {
  const run = printQueue.then(() => handlePrintQueued(req));
  // The queue chain itself must never reject, or every print after a single
  // failed job would be silently dropped — each caller still sees its own
  // success/failure via the returned promise.
  printQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function handlePrintQueued(req: PrintRequest): Promise<void> {
  // Some real integrations (qrinto.com) send QZ-Tray-shaped option names
  // instead of PrintTrays's own — fill in the native fields from those
  // before anything below reads them, so those requests aren't silently
  // printed with every setting reset to the printer's hardware defaults.
  applyQzCompat(req as unknown as Record<string, unknown>);

  const copies = req.copies ?? 1;
  // A short id per job plus a START/END banner — several test prints in a
  // row all land in the same printtrays.log file, so without a clear marker
  // it's hard to tell where one job's lines end and the next one's begin.
  // Everything a single handlePrint() call logs (including from the chromium
  // print helper below) happens between its own START and END banner — now
  // actually true, not just asserted, since the queue above guarantees jobs
  // are handled one at a time, not interleaved.
  const jobId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const jobStart = Date.now();
  const sizeSummary = req.pageSize
    ? `${req.pageSize.width}x${req.pageSize.height}${req.pageSize.units ?? ""}`
    : req.paperSize
      ? String(req.paperSize)
      : "(printer default)";
  logger.info(
    `========== PRINT JOB ${jobId} START — printer="${req.printer}" type=${req.type} size=${sizeSummary} landscape=${!!req.landscape} useDriverDefaultSize=${!!req.useDriverDefaultSize} copies=${copies} ==========`
  );
  // Full request, minus the (huge, base64) file payload — this is the one
  // line that shows every setting that was actually received server-side,
  // so a print result can be cross-checked against what the browser sent
  // without needing DevTools access on the machine that's printing.
  logger.info(`print request (full, data omitted): ${JSON.stringify({ ...req, data: `<${req.data?.length ?? 0} chars>` })}`);

  try {
    await dispatchPrint(req, copies);
    logger.info(`========== PRINT JOB ${jobId} END — SUCCESS (${Date.now() - jobStart}ms) ==========`);
  } catch (err) {
    logger.error(`========== PRINT JOB ${jobId} END — FAILED after ${Date.now() - jobStart}ms: ${(err as Error).message} ==========`);
    throw err;
  }
}

async function dispatchPrint(req: PrintRequest, copies: number): Promise<void> {
  switch (req.type) {
    case "html":
      return printRendered(req.data, req, req.printer, copies);
    case "image":
      return printImage(Buffer.from(req.data, "base64"), req, req.printer, copies);
    case "pdf": {
      if (req.fastRaster) return printPdfViaRasterRaw(req.data, req.printer);

      // A PDF that is nothing but one full-page photo (what a browser-side
      // "wrap the image in a PDF" step produces) is really an image job —
      // print the photo itself instead of rendering it as a giant bitmap.
      // Explicit scale choices ("actual"/"custom") are a document concept and
      // keep the classic route. Anything that isn't provably a plain photo
      // page returns null here and prints exactly as before.
      //
      // For an E2E/bleed paper size, that detection is deliberately loosened
      // to also catch a photo placed with margins (not just exactly
      // full-page) — the point of picking an E2E size is a borderless
      // result, so it's cropped to fill regardless of how the source PDF
      // placed it. For a nominal (non-E2E) size, the stricter full-page-only
      // check is kept, unchanged from before — a document's own layout on a
      // bordered sheet is left alone, since nothing about a nominal size
      // implies "fill the sheet no matter what."
      const wantsFit = !req.scaleMode || req.scaleMode === "fit";
      if (req.imageEngine !== "sumatra" && wantsFit) {
        const targetLooksE2E = /e2e|borderless|full[\s-]?bleed/i.test(String(req.paperSize ?? ""));
        const single = await extractSingleImageFromPdf(Buffer.from(req.data, "base64"), !targetLooksE2E).catch(() => null);
        if (single) {
          logger.info("print: PDF is a single full-page photo — printing the image directly");
          return printImage(single.jpeg, req, req.printer, copies, [single.widthPt, single.heightPt]);
        }

        // A genuine multi-element document, but the caller gave an explicit
        // pageSize — i.e. "print this at exactly this size" rather than any
        // size the driver already has a name for. SumatraPDF's `paperSize`
        // can only select a size the driver already knows about (see
        // printPdfBase64 below); it has no way to request an arbitrary
        // width/height. Electron's own print API does support that directly
        // (the same mechanism Chrome/Acrobat use for a typed custom size),
        // which is exactly what the image path below already relies on — so
        // route through it the same way a photo does: rasterize page 1 (this
        // only covers the first page; a multi-page document at a custom size
        // isn't supported yet) and crop-fill it onto the requested size.
        if (req.pageSize && req.pageSize.width > 0 && req.pageSize.height > 0) {
          // PNG, not JPEG — this image then goes through printImageViaSumatraClassic,
          // which already preserves PNG losslessly (see rotateImage180's doc
          // comment); a PDF that's a flat-color/text poster would otherwise
          // pick up the same JPEG blocking that was fixed for direct PNG
          // uploads, just one step removed.
          logger.info("print: PDF with an explicit custom pageSize — rasterizing page 1 (PNG) for the custom-size image path");
          const png = await rasterizePdfFirstPage(Buffer.from(req.data, "base64"), "png");
          return printImage(png, req, req.printer, copies);
        }
      }
      return printPdfBase64(req.data, req, req.printer, copies);
    }
    case "raw":
    case "zpl":
    case "escpos": {
      const bytes =
        req.encoding === "base64" ? Buffer.from(req.data, "base64") : Buffer.from(req.data, "utf8");
      return printRawToSpooler(bytes, req.printer);
    }
    default:
      throw new Error(`Unsupported print type: ${(req as PrintRequest).type}`);
  }
}
