import { BrowserWindow } from "electron";
import { exec, execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { print as printPdfWindows } from "pdf-to-printer";
import { print as printPdfUnix } from "unix-print";
import { PrinterInfo, PrintRequest, PrinterMediaSize, PrinterOption, PrinterResolution, GetPrinterDetailsResult } from "./types";
import { logger } from "./logger";
import { rasterizePdfFirstPageToJpeg } from "./pdfRaster";
import { scalePdfFirstPage } from "./pdfScale";
import { PDFDocument } from "pdf-lib";
import { applyQzCompat } from "./qzCompat";
import { sniffImage, buildImageHtml, imageToPdfBytes, extractSingleImageFromPdf } from "./imagePrint";

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
Add-Type -AssemblyName System.Printing
$ps = New-Object System.Printing.LocalPrintServer
$q  = $ps.GetPrintQueue([Console]::In.ReadLine())
$sr = New-Object System.IO.StreamReader($q.GetPrintCapabilitiesAsXml())
$xml = [xml]$sr.ReadToEnd(); $sr.Close()

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
  sizes        = @(Get-FeatureOptions 'psk:PageMediaSize')
  resolutions  = @(Get-FeatureOptions 'psk:PageResolution')
  mediaTypes   = @(Get-FeatureOptions 'psk:PageMediaType')
  inputBins    = @(Get-FeatureOptions 'psk:JobInputBin')
  orientations = @(Get-FeatureOptions 'psk:PageOrientation')
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

  const resRows = Array.isArray(parsed.resolutions) ? parsed.resolutions : parsed.resolutions ? [parsed.resolutions] : [];
  const resolutions: PrinterResolution[] = resRows
    .filter((r) => r?.props?.["psk:ResolutionX"] != null && r?.props?.["psk:ResolutionY"] != null)
    .map((r) => ({
      name: r.displayName || r.name,
      dpiX: Number(r.props["psk:ResolutionX"]),
      dpiY: Number(r.props["psk:ResolutionY"]),
    }))
    .filter((r) => Number.isFinite(r.dpiX) && Number.isFinite(r.dpiY));

  return {
    sizes,
    resolutions,
    mediaTypes: toPlainOptions(parsed.mediaTypes),
    inputBins: toPlainOptions(parsed.inputBins),
    orientations: toPlainOptions(parsed.orientations),
  };
}

/** Maps PrintTrays's wire-protocol print options onto Electron's native
 *  print() options — duplex/orientation/paper size/margins/color are all
 *  already supported by Chromium's print pipeline, just not previously
 *  exposed through PrintTrays's own API. */
function buildElectronPrintOptions(req: PrintRequest, printer: string, copies: number): Electron.WebContentsPrintOptions {
  return {
    silent: true,
    deviceName: printer,
    copies,
    landscape: req.landscape,
    color: req.color,
    scaleFactor: req.scaleFactor,
    duplexMode: req.duplex,
    pageSize: req.paperSize,
    margins: req.margins,
  };
}

/** Renders HTML (or a PDF's built-in viewer) in a hidden window and sends it
 *  to a standard printer via the OS print spooler. */
async function printRendered(html: string, req: PrintRequest, printer: string, copies = 1): Promise<void> {
  const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(buildElectronPrintOptions(req, printer, copies), (ok, failureReason) => {
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
async function printPdfBase64(base64: string, req: PrintRequest, printer: string, copies = 1): Promise<void> {
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
        .toString("latin1")}" | printer="${printer}" | paperSize=${req.paperSize ?? "(default)"} | duplex=${
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
        paperSize: req.paperSize,
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
        // for "custom" the content was already pre-scaled above.
        scale: req.scaleMode === "actual" || req.scaleMode === "custom" ? "noscale" : "fit",
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
  const jpeg = await rasterizePdfFirstPageToJpeg(pdfBytes);
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
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        {
          silent: true,
          deviceName: printer,
          copies,
          printBackground: true,
          color: req.color !== false,
          landscape: w > h,
          margins: { marginType: "none" },
          // Chromium takes the page size portrait-oriented and applies `landscape` on top.
          pageSize: { width: Math.min(w, h), height: Math.max(w, h) },
          ...(req.duplex ? { duplexMode: req.duplex } : {}),
        },
        (ok, failureReason) => (ok ? resolve() : reject(new Error(failureReason || "print failed")))
      );
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
  const kind = sniffImage(image);
  const { w, h } = await resolvePageMicrons(req, printer, fallbackPt);
  const pdf = kind ? await imageToPdfBytes(image, kind, w / MICRONS_PER_INCH, h / MICRONS_PER_INCH) : null;
  if (!pdf) throw new Error("The classic print engine only supports JPEG and PNG images");
  await printPdfBase64(pdf.toString("base64"), req, printer, copies);
}

async function printImage(
  image: Buffer,
  req: PrintRequest,
  printer: string,
  copies: number,
  fallbackPt?: [number, number]
): Promise<void> {
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

export async function handlePrint(req: PrintRequest): Promise<void> {
  // Some real integrations (qrinto.com) send QZ-Tray-shaped option names
  // instead of PrintTrays's own — fill in the native fields from those
  // before anything below reads them, so those requests aren't silently
  // printed with every setting reset to the printer's hardware defaults.
  applyQzCompat(req as unknown as Record<string, unknown>);

  const copies = req.copies ?? 1;
  logger.info(`print -> printer="${req.printer}" type=${req.type} copies=${copies} fastRaster=${!!req.fastRaster}`);

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
      const wantsFit = !req.scaleMode || req.scaleMode === "fit";
      if (req.imageEngine !== "sumatra" && wantsFit) {
        const single = await extractSingleImageFromPdf(Buffer.from(req.data, "base64")).catch(() => null);
        if (single) {
          logger.info("print: PDF is a single full-page photo — printing the image directly");
          return printImage(single.jpeg, req, req.printer, copies, [single.widthPt, single.heightPt]);
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
