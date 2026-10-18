import path from "path";

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
