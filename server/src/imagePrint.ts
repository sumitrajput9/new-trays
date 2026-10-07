import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";

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
 * A one-page HTML document that shows `imgFile` covering the whole page
 * (crop-to-fill, no gaps), optionally rotated and/or scaled about the page
 * centre. This is printed through Chromium's own print engine — the same
 * one Ctrl+P uses — which hands the driver the image itself (a few hundred
 * KB) instead of a full-page bitmap at the driver's DPI (tens of MB).
 * `.page` is position:fixed so it adds no flow height, which keeps the job
 * to exactly one page regardless of rounding in the page size.
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
.pic{position:absolute;left:50%;top:50%;width:${iw}in;height:${ih}in;object-fit:cover;transform:translate(-50%,-50%) rotate(${rotation}deg)}
</style></head><body><div class="page"><img class="pic" src="${imgFile}"></div></body></html>`;
}

/** Classic-engine fallback: wrap a JPEG/PNG into a one-page PDF exactly the size of the paper, cropped to fill. */
export async function imageToPdfBytes(image: Buffer, kind: ImageKind, wIn: number, hIn: number): Promise<Buffer | null> {
  if (kind.mime !== "image/jpeg" && kind.mime !== "image/png") return null;
  const doc = await PDFDocument.create();
  const emb = kind.mime === "image/jpeg" ? await doc.embedJpg(image) : await doc.embedPng(image);
  const W = wIn * 72;
  const H = hIn * 72;
  const s = Math.max(W / emb.width, H / emb.height);
  const dw = emb.width * s;
  const dh = emb.height * s;
  const page = doc.addPage([W, H]);
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

/** True only if the content stream is nothing but "draw one image over the whole page". */
function isFullPageImageOnly(content: string, w: number, h: number): boolean {
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
  return draws === 1 && covers && stack.length === 0;
}

const nameOf = (v: unknown): string => String(v);

/**
 * If `pdfBytes` is a single page that is just one full-page JPEG (which is
 * exactly what a browser-side "wrap this photo in a PDF" step produces),
 * return the JPEG itself plus the page size in points. Anything else —
 * text, several images, masks, odd colour spaces, rotation, more than one
 * page — returns null and is printed the normal way, so real documents are
 * never altered.
 */
export async function extractSingleImageFromPdf(
  pdfBytes: Buffer
): Promise<{ jpeg: Buffer; widthPt: number; heightPt: number } | null> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  if (doc.getPageCount() !== 1) return null;
  const page = doc.getPage(0);
  if (page.getRotation().angle !== 0) return null;
  const { width, height } = page.getSize();

  const resources = page.node.Resources();
  if (!resources) return null;
  // (No "has fonts" check: some libraries add an empty Font entry to every
  // page. Text can only appear via text operators, which isFullPageImageOnly
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
  if (!isFullPageImageOnly(text, width, height)) return null;

  const jpeg = Buffer.from(img.getContents());
  if (sniffImage(jpeg)?.mime !== "image/jpeg") return null;
  return { jpeg, widthPt: width, heightPt: height };
}
