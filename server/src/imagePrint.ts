import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream, rgb } from "pdf-lib";

export interface ImageKind {
  mime: string;
  ext: string;
}

/** Identify an image by its magic bytes — never trust a client-supplied type. */
export function sniffImage(b: Buffer): ImageKind | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b.length > 4 && b.toString("latin1", 0, 4) === "GIF8") return { mime: "image/gif", ext: "gif" };
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/**
 * A one-page HTML document that shows `imgFile` entirely within the page
 * (contain — never crops), optionally rotated and/or scaled about the page
 * centre. This is printed through Chromium's own print engine — the same
 * one Ctrl+P uses — which hands the driver the image itself (a few hundred
 * KB) instead of a full-page bitmap at the driver's DPI (tens of MB).
 * `.page` is position:fixed so it adds no flow height, which keeps the job
 * to exactly one page regardless of rounding in the page size.
 *
 * `object-fit:contain`, not `cover` — matches qrinto.com's own production
 * print agent (PrintExecutor.cs: `Math.Min(bounds.Width/image.Width,
 * bounds.Height/image.Height)`, the contain formula, not Math.Max/cover),
 * found by reading its actual source after the user confirmed it prints
 * custom/E2E sizes without cropping, today, in production. `cover` was the
 * root cause of every "crop" complaint this whole session — it guarantees
 * zero gap by cropping whatever doesn't fit; `contain` guarantees zero crop
 * by accepting a gap on the non-matching axis if the image's own aspect
 * ratio doesn't exactly equal the page's. Given the user has now explicitly
 * chosen "never crop" over "never gap" (the opposite of every earlier
 * request in this session, each of which asked for zero gap specifically),
 * this is not a bug fix so much as a deliberate trade-off swap.
 */
export function buildImageHtml(imgFile: string, wIn: number, hIn: number, rotation: number, factor: number): string {
  const bw = wIn * factor;
  const bh = hIn * factor;
  const sideways = rotation === 90 || rotation === 270;
  const iw = sideways ? bh : bw;
  const ih = sideways ? bw : bh;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:${wIn}in ${hIn}in;margin:0}
html,body{margin:0;padding:0;height:0;overflow:visible;background:#fff}
.page{position:fixed;left:0;top:0;width:${wIn}in;height:${hIn}in;overflow:hidden;background:#fff}
.pic{position:absolute;left:50%;top:50%;width:${iw}in;height:${ih}in;object-fit:contain;transform:translate(-50%,-50%) rotate(${rotation}deg)}
</style></head><body><div class="page"><img class="pic" src="${imgFile}"></div></body></html>`;
}


/** Classic-engine fallback: wrap a JPEG/PNG into a one-page PDF exactly the size of the paper, cropped to fill.
 *  `overscan` (1 = none) draws the image slightly larger than the page and lets the page's own edge clip the
 *  overflow — the same deliberate-bleed trick Adobe's print dialog applies automatically (seen at 101% scale
 *  on this exact driver/paper) to guarantee true edge-to-edge coverage despite any non-printable hardware
 *  margin: printing at exactly 100% of the nominal size shows that margin as a thin unprinted border, however
 *  small it is, while a slight deliberate overflow pushes content past it with nothing left unprinted.
 *  `bleedWIn`/`bleedHIn` (inches, 0 = none) do the same thing but as a FIXED amount rather than a percentage —
 *  this driver's real non-printable margin is a fixed inches value (given directly by the driver's own
 *  developer: 0.57in width, 0.49in height) and is NOT proportional to the page size, so a flat percentage
 *  overscan can only ever be correct for one specific page size at a time. The page itself stays exactly
 *  wIn x hIn (matching the physical paper the driver was told to use) — only the drawn image is sized larger
 *  and centered, bleeding past the page edge by half the margin on each side.
 *  `diagBackground`, when given, fills the whole page with that color BEFORE drawing the image — purely a
 *  local verification aid (the white-border bug that shipped in 1.3.28/1.3.29 was invisible in the saved
 *  debug PDF precisely because a real gap and the PDF's own default white page background look identical; a
 *  high-contrast fill makes any uncovered gap immediately obvious without a real print). Never pass this for
 *  the PDF that's actually sent to the printer — only for a separate, debug-only copy.
 *  `independentAxisScale`, when true, scales width and height separately instead of by one uniform factor —
 *  each axis gets exactly its own minimum required bleed, no more. With uniform scaling (the default), when
 *  the image's own aspect ratio doesn't match the page's, whichever axis needs the bigger zoom to satisfy its
 *  bleed "drags" the other axis along with it (since one scale factor affects both dimensions equally),
 *  overshooting that axis's own requirement — confirmed on a real 1427x2000 test image where width needed a
 *  bigger zoom than height, and height ended up cropped by roughly double what it actually needed. Independent
 *  scaling fixes that at the cost of a mild aspect-ratio stretch (the two axes' scale factors can now differ),
 *  which is the tradeoff the user explicitly asked to try for designs with text close to the edge. */
export async function imageToPdfBytes(
  image: Buffer,
  kind: ImageKind,
  wIn: number,
  hIn: number,
  overscan = 1,
  bleedWIn = 0,
  bleedHIn = 0,
  diagBackground?: { r: number; g: number; b: number },
  independentAxisScale = false,
  fit: "cover" | "contain" = "cover"
): Promise<Buffer | null> {
  if (kind.mime !== "image/jpeg" && kind.mime !== "image/png") return null;
  const doc = await PDFDocument.create();
  const emb = kind.mime === "image/jpeg" ? await doc.embedJpg(image) : await doc.embedPng(image);
  const W = wIn * 72;
  const H = hIn * 72;
  const targetW = (wIn + bleedWIn) * 72;
  const targetH = (hIn + bleedHIn) * 72;
  const pickScale = fit === "contain" ? Math.min : Math.max;
  const sUniform = pickScale(targetW / emb.width, targetH / emb.height) * overscan;
  const sx = independentAxisScale ? (targetW / emb.width) * overscan : sUniform;
  const sy = independentAxisScale ? (targetH / emb.height) * overscan : sUniform;
  const dw = emb.width * sx;
  const dh = emb.height * sy;
  const page = doc.addPage([W, H]);
  if (diagBackground) {
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(diagBackground.r / 255, diagBackground.g / 255, diagBackground.b / 255) });
  }
  page.drawImage(emb, { x: (W - dw) / 2, y: (H - dh) / 2, width: dw, height: dh });
  return Buffer.from(await doc.save()) as Buffer;
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/**
 * True only if the content stream is nothing but "draw one image" — once,
 * anywhere on the page. When `requireFullPage` is true, that one image must
 * also cover the entire page (within 1% tolerance); when false, any
 * placement counts (margins, undersized, off-centre — all fine). Either way,
 * any other operator (text, paths, colour, clipping…) means this is a real
 * document, not a plain photo wrapper, and disqualifies it.
 */
function isSingleImageOnly(content: string, w: number, h: number, requireFullPage: boolean): boolean {
  const tokens = content.split(/\s+/).filter(Boolean);
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let operands: string[] = [];
  let draws = 0;
  let covers = false;
  const tol = 0.01;
  for (const t of tokens) {
    if (t === "q") {
      stack.push(ctm);
      operands = [];
    } else if (t === "Q") {
      const prev = stack.pop();
      if (!prev) return false;
      ctm = prev;
      operands = [];
    } else if (t === "cm") {
      const m = operands.map(Number);
      if (m.length !== 6 || m.some((n) => !Number.isFinite(n))) return false;
      ctm = multiply(m as Matrix, ctm);
      operands = [];
    } else if (t === "Do") {
      draws++;
      if (draws > 1) return false;
      const [a, b, c, d, e, f] = ctm;
      covers =
        Math.abs(b) < 1e-6 &&
        Math.abs(c) < 1e-6 &&
        Math.abs(a - w) <= w * tol &&
        Math.abs(d - h) <= h * tol &&
        Math.abs(e) <= w * tol &&
        Math.abs(f) <= h * tol;
      operands = [];
    } else if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t) || t.startsWith("/")) {
      operands.push(t);
    } else {
      // Any other operator (text, paths, colour, clipping…) means this is a
      // real document, not a plain photo wrapper — don't take the image shortcut.
      return false;
    }
  }
  return draws === 1 && stack.length === 0 && (!requireFullPage || covers);
}

const nameOf = (v: unknown): string => String(v);

/**
 * If `pdfBytes` is a single page that is just one JPEG, return the JPEG
 * itself plus the page size in points. Anything else — text, several
 * images, masks, odd colour spaces, rotation, more than one page — returns
 * null and is printed the normal way, so real documents are never altered.
 *
 * `requireFullPage` controls how strict the "just one photo" test is:
 * - `true` (default): the image must already fill the entire page — exactly
 *   what a browser-side "wrap this photo in a PDF" step produces. Safe as a
 *   default for a nominal (non-bleed) target size, since it changes nothing
 *   about how the page is laid out.
 * - `false`: any placement counts, including margins or an undersized
 *   image. Intended only for an E2E/bleed target size, where the point is
 *   to fill the sheet edge-to-edge regardless of how the source PDF placed
 *   its photo — the original placement is discarded either way.
 */
export async function extractSingleImageFromPdf(
  pdfBytes: Buffer,
  requireFullPage = true
): Promise<{ jpeg: Buffer; widthPt: number; heightPt: number } | null> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  if (doc.getPageCount() !== 1) return null;
  const page = doc.getPage(0);
  if (page.getRotation().angle !== 0) return null;
  const { width, height } = page.getSize();

  const resources = page.node.Resources();
  if (!resources) return null;
  // (No "has fonts" check: some libraries add an empty Font entry to every
  // page. Text can only appear via text operators, which isSingleImageOnly
  // below rejects.)
  const xobjects = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xobjects) return null;
  const keys = xobjects.keys();
  if (keys.length !== 1) return null;

  const img = xobjects.lookup(keys[0]);
  if (!(img instanceof PDFRawStream)) return null;
  const d = img.dict;
  if (nameOf(d.lookup(PDFName.of("Subtype"))) !== "/Image") return null;
  if (d.get(PDFName.of("SMask")) || d.get(PDFName.of("Mask"))) return null;

  let filter = d.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFArray) {
    if (filter.size() !== 1) return null;
    filter = filter.lookup(0);
  }
  if (nameOf(filter) !== "/DCTDecode") return null;
  const cs = nameOf(d.lookup(PDFName.of("ColorSpace")));
  if (cs !== "/DeviceRGB" && cs !== "/DeviceGray") return null;

  // A page's content may be one stream or several (many libraries wrap the
  // drawing in separate "q" / "Q" streams) — read them all, in order.
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : [contents];
  let text = "";
  for (const s of streams) {
    if (!(s instanceof PDFRawStream)) return null;
    text += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1") + "\n";
  }
  if (!isSingleImageOnly(text, width, height, requireFullPage)) return null;

  const jpeg = Buffer.from(img.getContents());
  if (sniffImage(jpeg)?.mime !== "image/jpeg") return null;
  return { jpeg, widthPt: width, heightPt: height };
}
