import path from "path";

/** pdfjs-dist needs a `DOMMatrix` global for pattern/shading transforms
 *  (gradient fills, tiling patterns — exactly what a decorative PDF like a
 *  wedding invite's floral border uses). It's a browser API with no Node
 *  built-in equivalent; pdfjs-dist's own fallback is `require("canvas").
 *  DOMMatrix` — but that `canvas` package ships a native binary compiled
 *  for a different Node ABI version than this Electron build uses, so the
 *  require throws, pdfjs-dist catches it and only warns ("Cannot polyfill
 *  DOMMatrix, rendering may be broken"), and then throws for real the
 *  moment a page actually tries to construct one — exactly the
 *  "DOMMatrix is not defined" failure confirmed on a real PDF upload.
 *  Providing a correct polyfill BEFORE pdfjs-dist's module code runs (its
 *  own check is `if (globalThis.DOMMatrix) return;`, evaluated at module
 *  load) makes it skip the broken `canvas` require entirely. Implements
 *  exactly the 2D affine-matrix surface pdfjs-dist's TilingPattern/
 *  shading-pattern code actually calls (constructor from a 6-element
 *  [a,b,c,d,e,f] array, translate, scale, multiply) — verified by reading
 *  pdfjs-dist's own source rather than guessing the full DOMMatrix spec. */
function ensureDOMMatrixPolyfill(): void {
  if ((globalThis as any).DOMMatrix) return;
  class DOMMatrixPolyfill {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
    multiply(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a * other.a + this.c * other.b,
        this.b * other.a + this.d * other.b,
        this.a * other.c + this.c * other.d,
        this.b * other.c + this.d * other.d,
        this.a * other.e + this.c * other.f + this.e,
        this.b * other.e + this.d * other.f + this.f,
      ]);
    }
    translate(x: number, y: number): DOMMatrixPolyfill {
      return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, x, y]));
    }
    scale(sx: number, sy: number = sx): DOMMatrixPolyfill {
      return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
    }
  }
  (globalThis as any).DOMMatrix = DOMMatrixPolyfill;
}

/** Same root cause as DOMMatrix above, different global: pdfjs-dist also
 *  wants `Path2D` and falls back to the same broken `canvas` package,
 *  warning "Cannot polyfill `Path2D`, rendering may be broken" (confirmed
 *  alongside the DOMMatrix failure, same real-hardware test). Used for
 *  clipping paths, glyph outlines, and stroked curves — a different real
 *  PDF than the one that exposed the DOMMatrix bug could fail the same
 *  way on this instead. Unlike DOMMatrix, no hand-rolled polyfill is
 *  needed here — @napi-rs/canvas (the library this whole file already
 *  uses, and the one actually linked for this Electron build's ABI) ships
 *  its own real, native Path2D implementation, so this uses that directly
 *  rather than reimplementing bezier/arc path-building by hand. */
async function ensurePath2DPolyfill(): Promise<void> {
  if ((globalThis as any).Path2D) return;
  const { Path2D } = await import("@napi-rs/canvas");
  (globalThis as any).Path2D = Path2D;
}

/** pdfjs-dist's Node build creates its own internal canvases (for masks,
 *  patterns, Type3 fonts, etc.) via a canvasFactory it's given — its own
 *  default factory assumes the classic `canvas` npm package's API, which
 *  isn't what we use, so every internal canvas it creates without this
 *  adapter breaks on cleanup. This wraps @napi-rs/canvas to the exact shape
 *  pdf.js's renderer expects, so both the top-level page canvas and any
 *  internal ones it allocates go through the same, working canvas library. */
class NapiCanvasFactory {
  constructor(private createCanvas: (w: number, h: number) => any) {}

  create(width: number, height: number) {
    const canvas = this.createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(canvasAndContext: { canvas: any }, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: { canvas: any; context: any }) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    (canvasAndContext as any).canvas = null;
    (canvasAndContext as any).context = null;
  }
}

/**
 * Renders a PDF's first page to a raster image at a given DPI, entirely
 * in-process (no GDI/EMF, no printer driver involved). This exists for two
 * different callers with different needs: printPdfViaRasterRaw() wants a
 * compact JPEG for a fast raw-feed print (speed matters more than
 * losslessness there, and it's an opt-in path). The custom-size PDF path
 * wants PNG — same reasoning as rotateImage180's PNG preservation for image
 * uploads: a PDF that's a flat-color/text poster shows visible JPEG
 * blocking at this DPI, which PNG avoids. `format` lets each caller choose.
 */
export async function rasterizePdfFirstPage(pdfBytes: Buffer, format: "jpeg" | "png" = "jpeg", dpi = 300): Promise<Buffer> {
  ensureDOMMatrixPolyfill();
  await ensurePath2DPolyfill();
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.js");
  const { createCanvas } = await import("@napi-rs/canvas");

  // Required so pdfjs-dist runs standalone in Node (no browser Worker global) —
  // without an explicit workerSrc it logs noisy "fake worker" warnings but
  // still works; pointing it at the real worker file avoids that.
  pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.js");

  const canvasFactory = new NapiCanvasFactory(createCanvas);
  const standardFontDataUrl = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    disableFontFace: true,
    canvasFactory: canvasFactory as any,
    standardFontDataUrl,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const scale = dpi / 72; // PDF user space is defined at 72 units per inch
    const viewport = page.getViewport({ scale });

    const { canvas, context } = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport }).promise;

    return format === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", 0.92);
  } finally {
    await doc.destroy();
  }
}
