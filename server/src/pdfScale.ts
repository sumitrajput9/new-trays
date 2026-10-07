import { PDFDocument } from "pdf-lib";

/**
 * Physically re-renders a PDF's first page onto a same-size new page with
 * its content scaled and centered by `percent` (100 = unchanged) — this is
 * how "custom %" scaling in a real print dialog behaves: content shrinks or
 * grows, the sheet itself stays the same size, so there's no separate
 * driver-level scale setting doing this for us. SumatraPDF's own scale
 * option (see printerService.ts) is only "noscale" | "shrink" | "fit" —
 * none of those are an arbitrary percentage, so this handles it upstream,
 * before the PDF ever reaches SumatraPDF (which is then told "noscale",
 * since the content is already sized exactly as wanted).
 */
export async function scalePdfFirstPage(pdfBytes: Buffer, percent: number): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(pdfBytes);
  const outDoc = await PDFDocument.create();

  const [srcPage] = srcDoc.getPages();
  const { width, height } = srcPage.getSize();
  const embedded = await outDoc.embedPage(srcPage);

  const scale = percent / 100;
  const outPage = outDoc.addPage([width, height]);
  const drawW = width * scale;
  const drawH = height * scale;
  outPage.drawPage(embedded, {
    x: (width - drawW) / 2,
    y: (height - drawH) / 2,
    xScale: scale,
    yScale: scale,
  });

  const bytes = await outDoc.save();
  return Buffer.from(bytes) as Buffer;
}
