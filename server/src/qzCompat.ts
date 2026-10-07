import { logger } from "./logger";

/**
 * PrintTrays's actual wire protocol never matched QZ Tray's config schema,
 * but at least one real integration (qrinto.com) was built assuming it did
 * — its buildPrintConfig() sends `orientation`, `colorType`, `size`+`units`,
 * numeric `margins`, and `scale`/`scaleContent`, all QZ's own field names.
 * PrintTrays silently ignored every one of those (only `type` and `copies`
 * happen to coincidentally match), so every print setting a user picked was
 * dropped and the job printed with the printer's own hardware defaults —
 * with no error, since the fields were just unrecognized extra JSON keys.
 *
 * Rather than requiring every such integration to be rewritten against
 * PrintTrays's own field names, accept QZ's names too: fill in PrintTrays's
 * native fields from their QZ-shaped equivalents whenever the native field
 * wasn't already set directly. Mutates `raw` in place; safe to call on any
 * incoming print request regardless of which style it uses.
 */
export function applyQzCompat(raw: Record<string, unknown>): void {
  if (raw.landscape === undefined && typeof raw.orientation === "string") {
    raw.landscape = raw.orientation === "landscape";
  }

  if (raw.color === undefined && typeof raw.colorType === "string") {
    raw.color = raw.colorType !== "grayscale";
  }

  // QZ's `duplex` is `false` (simplex) or a "two-sided-*-edge" string, unlike
  // PrintTrays's own "simplex"/"shortEdge"/"longEdge" — same field name,
  // different value space, so this has to translate in place rather than
  // fill in a separate field.
  if (typeof raw.duplex === "string" && raw.duplex.startsWith("two-sided")) {
    raw.duplex = raw.duplex.includes("short") ? "shortEdge" : "longEdge";
  } else if (raw.duplex === false) {
    raw.duplex = undefined;
  }

  // QZ's `size` + `units` is an exact page size. Keep it as PrintTrays's own
  // `pageSize` (the image-printing path uses it as-is) in addition to the
  // best-effort named-paper mapping below (the PDF path needs a name).
  if (raw.pageSize === undefined && isSizeObject(raw.size)) {
    const u = typeof raw.units === "string" ? raw.units.toLowerCase() : "in";
    raw.pageSize = {
      width: raw.size.width,
      height: raw.size.height,
      units: u.startsWith("mm") ? "mm" : "in",
    };
  }

  // QZ names the paper source `printerTray`; PrintTrays calls it `inputBin`.
  // Without this a tray picked on the page was silently ignored.
  if (raw.inputBin === undefined) {
    const t = raw.printerTray;
    const trayName = typeof t === "string" ? t : t && typeof t === "object" ? (t as any).name : undefined;
    if (typeof trayName === "string" && trayName) raw.inputBin = trayName;
  }

  if (raw.paperSize === undefined && isSizeObject(raw.size)) {
    const mapped = nearestStandardPaperSize(raw.size, typeof raw.units === "string" ? raw.units : "in");
    if (mapped) {
      raw.paperSize = mapped;
    } else {
      logger.warn(
        `QZ compat: no standard paper size matches ${raw.size.width}x${raw.size.height} ${raw.units ?? "in"} — the PDF path will use the printer's default paper size (image printing uses the exact size).`
      );
    }
  }

  if (raw.scaleMode === undefined && typeof raw.scale === "number" && raw.scaleContent) {
    raw.scaleFactor = raw.scale * 100;
    raw.scaleMode = "custom";
  }

  // QZ's `margins` is a plain number (0 = borderless) rather than
  // PrintTrays's { marginType, top, bottom, left, right } object — same
  // field name, different shape, so this replaces it in place.
  if (typeof raw.margins === "number") {
    raw.margins = raw.margins === 0 ? { marginType: "none" } : { marginType: "default" };
  }
}

function isSizeObject(v: unknown): v is { width: number; height: number } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as any).width === "number" &&
    typeof (v as any).height === "number"
  );
}

// Standard office sizes, plus the exact custom photo sizes confirmed by
// actually querying a real Noritsu 931BL's PrintCapabilities via
// getPrinterDetails() (see printerService.ts) — these are the driver's own
// exact size names, required verbatim for SumatraPDF's `-print-settings
// paper=<name>` to select the matching tray/media rather than silently
// falling back to the printer's default. E2E ("edge to edge") variants are
// intentionally separate entries — they're a genuinely larger bleed size,
// not the same paper as their nominal counterpart.
const STANDARD_SIZES_IN: Record<string, [number, number]> = {
  Letter: [8.5, 11],
  Legal: [8.5, 14],
  Tabloid: [11, 17],
  A3: [11.69, 16.54],
  A4: [8.27, 11.69],
  A5: [5.83, 8.27],
  "Index Card 3 x 5in": [3, 5],
  "4 x 6in": [4, 6],
  "5 x 7in": [5, 7],
  "4 x 6in E2E": [4.57, 6.49],
  "5 x 7in E2E": [5.57, 7.49],
  "7 x 10in E2E": [7.57, 10.49],
};

const TOLERANCE_IN = 0.15;

function nearestStandardPaperSize(size: { width: number; height: number }, units: string): string | undefined {
  const toInches = units.toLowerCase().startsWith("mm") ? 1 / 25.4 : 1;
  const w = size.width * toInches;
  const h = size.height * toInches;

  for (const [name, [sw, sh]] of Object.entries(STANDARD_SIZES_IN)) {
    const matchesUpright = Math.abs(w - sw) < TOLERANCE_IN && Math.abs(h - sh) < TOLERANCE_IN;
    const matchesRotated = Math.abs(w - sh) < TOLERANCE_IN && Math.abs(h - sw) < TOLERANCE_IN;
    if (matchesUpright || matchesRotated) return name;
  }
  return undefined;
}
