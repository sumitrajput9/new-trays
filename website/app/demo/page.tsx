"use client";

import { useState, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import Nav from "../components/Nav";
import Footer from "../components/Footer";

type Printer = { name: string; isDefault: boolean };
type Status = "idle" | "connecting" | "connected" | "failed";
type LivePaperSize = { name: string; widthIn: number; heightIn: number };
type PrinterOption = { name: string };
type PrinterDetails = {
  sizes: LivePaperSize[];
  resolutions: { name: string; dpiX: number; dpiY: number }[];
  mediaTypes: PrinterOption[];
  inputBins: PrinterOption[];
  orientations: PrinterOption[];
  customSizeOptionName?: string;
  defaultCustomSize?: LivePaperSize;
};

const CUSTOM_SIZE_VALUE = "__custom_size__";

const CERT_URL = "https://127.0.0.1:8181";
const PAPER_SIZES = ["Letter", "A4", "A5", "A3", "Legal", "Tabloid"] as const;
const MICRONS_PER_INCH = 25400;
const DUPLEX_MODES = [
  { value: "", label: "Simplex (single-sided)" },
  { value: "longEdge", label: "Duplex — long edge" },
  { value: "shortEdge", label: "Duplex — short edge" },
];
const PAGE_ORDERS = [
  { value: "frontToBack", label: "Front to Back" },
  { value: "backToFront", label: "Back to Front" },
] as const;

export default function DemoPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [ppRef, setPpRef] = useState<any>(null);
  const [version, setVersion] = useState<string | undefined>();

  const [paperSize, setPaperSize] = useState<string>("Letter");
  const [printerDetails, setPrinterDetails] = useState<PrinterDetails | null>(null);
  const [printerDetailsLoading, setPrinterDetailsLoading] = useState(false);
  const [inputBin, setInputBin] = useState("");
  const [quality, setQuality] = useState("");
  const [mediaType, setMediaType] = useState("");
  const [scaleMode, setScaleMode] = useState<"fit" | "actual" | "custom">("fit");
  const [scalePercent, setScalePercent] = useState(100);
  const [landscape, setLandscape] = useState(false);
  const [duplex, setDuplex] = useState("");
  const [pageOrder, setPageOrder] = useState<(typeof PAGE_ORDERS)[number]["value"]>("frontToBack");
  const [color, setColor] = useState(true);
  const [copies, setCopies] = useState(1);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfPrinting, setPdfPrinting] = useState(false);
  const [fastRaster, setFastRaster] = useState(false);
  const [classicEngine, setClassicEngine] = useState(false);

  // Live preview — mirrors the server's real logic (see imagePrint.ts /
  // printerService.ts), not an approximation: image uploads always
  // crop-fill; a custom-size PDF does too (page 1, rasterized); a classic
  // PDF in "Fit" mode is contained (can letterbox); "Actual"/"Custom %"
  // center it at true size (can clip or gap).
  const [pdfjsReady, setPdfjsReady] = useState(false);
  const [previewVerdictText, setPreviewVerdictText] = useState("Choose a file to preview.");
  const [previewVerdictGood, setPreviewVerdictGood] = useState<boolean | null>(null);
  const [previewNoteText, setPreviewNoteText] = useState("");
  // Catches a low-resolution upload before it ever reaches the printer —
  // an image with too few pixels for the target size prints pixelated/soft
  // no matter what the software does (source quality, not a bug), but
  // nobody could tell beforehand without this. Computed against the crop
  // actually being used (post-zoom), since zooming in reduces the
  // effective pixels-per-inch further.
  const [lowResWarning, setLowResWarning] = useState<string>("");
  const pdfPreviewDocRef = useRef<any>(null);
  const previewImgRef = useRef<{ url: string; w: number; h: number } | null>(null);
  const previewImgElRef = useRef<HTMLImageElement | null>(null);
  const paperBoxRef = useRef<HTMLDivElement>(null);
  const paperInnerRef = useRef<HTMLDivElement>(null);
  const [useCustomSize, setUseCustomSize] = useState(false);
  const [customWidthIn, setCustomWidthIn] = useState(11);
  const [customHeightIn, setCustomHeightIn] = useState(17);

  // Interactive crop for image uploads: zoom (1 = the minimum needed to
  // cover the box, same as the old fixed cover-fit) and pan (0..1 on each
  // axis, 0.5 = centered) expressed as FRACTIONS of the image's own native
  // size — deliberately resolution-independent, so the exact same numbers
  // drive both the small on-screen preview and the full-resolution export,
  // with no re-derivation or drift between the two.
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPanX, setCropPanX] = useState(0.5);
  const [cropPanY, setCropPanY] = useState(0.5);
  const dragStateRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);

  const appendLog = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l]);

  // Fetches the printer's *actual* capabilities (getPrinterDetails) whenever
  // the selected printer changes, so these dropdowns can show real, driver-
  // reported options — including custom ones like photo-tray sizes or
  // "User Type" media — instead of only the fixed guess lists below. Falls
  // back to those lists silently if the bridge doesn't support this yet or
  // the printer reports nothing usable. Only `sizes` and `inputBins` are
  // actually applied to a print job below — `resolutions`/`mediaTypes` are
  // shown for visibility only, since the print pipeline can't set a driver's
  // DPI or media-type option yet (that needs a lower-level Windows API call
  // than SumatraPDF's print-settings support).
  useEffect(() => {
    if (!ppRef || !selected) {
      setPrinterDetails(null);
      return;
    }
    let cancelled = false;
    setPrinterDetailsLoading(true);
    setPrinterDetails(null);
    ppRef
      .getPrinterDetails(selected)
      .then((details: any) => {
        if (cancelled) return;
        const sizes: LivePaperSize[] = (details?.sizes ?? [])
          .filter((s: any) => s.width > 0 && s.height > 0)
          .map((s: any) => ({ name: s.name, widthIn: s.width / MICRONS_PER_INCH, heightIn: s.height / MICRONS_PER_INCH }));
        const resolutions = details?.resolutions ?? [];
        const mediaTypes = details?.mediaTypes ?? [];
        const inputBins = details?.inputBins ?? [];
        const orientations = details?.orientations ?? [];
        const customSizeOptionName: string | undefined = details?.customSizeOptionName;
        const dc = details?.defaultCustomSize;
        const defaultCustomSize: LivePaperSize | undefined = dc
          ? { name: dc.name, widthIn: dc.width / MICRONS_PER_INCH, heightIn: dc.height / MICRONS_PER_INCH }
          : undefined;
        const hasAny = sizes.length || resolutions.length || mediaTypes.length || inputBins.length || customSizeOptionName;
        setPrinterDetails(hasAny ? { sizes, resolutions, mediaTypes, inputBins, orientations, customSizeOptionName, defaultCustomSize } : null);
        if (defaultCustomSize) {
          setCustomWidthIn(Number(defaultCustomSize.widthIn.toFixed(2)));
          setCustomHeightIn(Number(defaultCustomSize.heightIn.toFixed(2)));
        }
        if (sizes.length) {
          setPaperSize((current) => (sizes.some((s) => s.name === current) ? current : sizes[0].name));
        }
        setInputBin((current) => (inputBins.some((b: PrinterOption) => b.name === current) ? current : ""));
      })
      .catch(() => {
        if (!cancelled) setPrinterDetails(null);
      })
      .finally(() => {
        if (!cancelled) setPrinterDetailsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ppRef, selected]);

  async function attemptConnect() {
    setStatus("connecting");
    appendLog("Connecting to wss://127.0.0.1:8181 ...");
    try {
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
      const sdkUrl = `${basePath}/printtrays.js`;
      const { PrintTrays } = await import(/* webpackIgnore: true */ sdkUrl);
      const pp = new PrintTrays({ downloadUrl: `${basePath}/download` });
      await pp.connect();
      setPpRef(pp);
      setVersion(pp.version);
      setStatus("connected");
      appendLog(`Connected to PrintTrays v${pp.version ?? "unknown"}. Fetching printer list...`);
      const list = await pp.getPrinters();
      setPrinters(list);
      if (list.length) setSelected(list.find((p: Printer) => p.isDefault)?.name ?? list[0].name);
      appendLog(`Found ${list.length} printer(s).`);
    } catch (err: any) {
      setStatus("failed");
      // Browsers deliberately don't tell JS *why* a WSS connection failed
      // (refused vs. untrusted certificate look identical from here), so we
      // can't distinguish "not installed" from "cert not trusted yet" — the
      // UI below covers both possibilities instead of guessing.
      appendLog(`Couldn't connect: ${err?.message ?? err}`);
    }
  }

  function openTrustPopup() {
    appendLog("Opening PrintTrays's certificate page in a small window...");
    const popup = window.open(CERT_URL, "printtrays-trust", "width=520,height=420");
    if (!popup) {
      appendLog("Popup blocked — allow popups for this site, or open " + CERT_URL + " manually in a new tab.");
      return;
    }
    // Cross-origin means we can't see inside the popup, but we can see when
    // it closes — PrintTrays's own confirmation page auto-closes itself once
    // the user gets past the certificate warning, so that's our retry signal.
    const poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        appendLog("Certificate window closed — retrying connection...");
        attemptConnect();
      }
    }, 400);
  }

  async function handleTestPrint() {
    if (!ppRef || !selected) return;
    const options = {
      type: "html" as const,
      paperSize,
      landscape,
      color,
      copies,
      pageOrder,
      ...(duplex ? { duplex } : {}),
      ...(scaleMode === "custom" ? { scaleFactor: scalePercent } : {}),
    };
    appendLog(
      `Sending test page to "${selected}" (${paperSize}${landscape ? ", landscape" : ""}${
        duplex ? ", duplex " + duplex : ""
      }${color ? "" : ", grayscale"}, ${copies} cop${copies === 1 ? "y" : "ies"})...`
    );
    // Full, exact request object — check this in DevTools for anything the
    // popup doesn't spell out.
    console.log("[PrintTrays demo] HTML test print — request:", { printer: selected, ...options });
    try {
      await ppRef.print(
        selected,
        `<html><body style="font-family:sans-serif;padding:40px">
           <h1>PrintTrays test page</h1>
           <p>If you can read this on paper, the bridge is working.</p>
           <p>Paper: ${paperSize}${landscape ? " (landscape)" : ""}</p>
           <p>Printed at ${new Date().toString()}</p>
         </body></html>`,
        options
      );
      appendLog("Print job sent successfully.");
      window.alert(
        `Test page sent\n\n` +
          `Printer: ${selected}\n` +
          `Type: html\n` +
          `Paper size: ${paperSize}\n` +
          `Orientation: ${landscape ? "landscape" : "portrait"}\n` +
          `Color: ${color ? "color" : "grayscale"}\n` +
          `Duplex: ${duplex || "simplex"}\n` +
          `Copies: ${copies}\n` +
          `Page order: ${pageOrder}\n` +
          `Scale mode: ${scaleMode}${scaleMode === "custom" ? ` (${scalePercent}%)` : ""}\n` +
          `Path: classic HTML render (Chromium, via Electron's print API)`
      );
    } catch (err: any) {
      appendLog(`Print failed: ${err?.message ?? err}`);
    }
  }

  function readFileAsBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  const STATIC_SIZE_INCHES: Record<string, [number, number]> = {
    Letter: [8.5, 11],
    A4: [8.27, 11.69],
    A5: [5.83, 8.27],
    A3: [11.69, 16.54],
    Legal: [8.5, 14],
    Tabloid: [11, 17],
  };

  // REVERTED: tried subtracting a fixed 0.57in/0.49in margin from the
  // custom-size PDF's page dimensions (per the driver developer's numbers),
  // but this pipeline sends the custom-size path through SumatraPDF with
  // scale:"noscale" (see printerService.ts ~line 399) — it prints the PDF
  // at exactly its own defined page size, with no scaling to fill whatever
  // physical paper is selected. The physical paper slot is chosen by NAME
  // (customSizeOptionName) and stays at its full declared size (e.g.
  // 6.48x8.76) regardless of what page size the PDF itself uses. Shrinking
  // only the PDF's page size left the extra 0.57/0.49 as a visible blank
  // white border on all four sides on real hardware — confirmed by a real
  // print. Reverted to no adjustment; custom size now behaves exactly as
  // it did in 1.3.28/1.3.29.
  function getSelectedPaperInches(): [number, number] {
    if (useCustomSize) return [customWidthIn || 8.5, customHeightIn || 11];
    const live = printerDetails?.sizes.find((s) => s.name === paperSize);
    if (live) return [live.widthIn, live.heightIn];
    return STATIC_SIZE_INCHES[paperSize] ?? [8.5, 11];
  }

  // The crop window, as fractions of the source image's own native width/
  // height — e.g. cropW=1 means "the full image width is visible". At
  // zoom=1 this exactly reproduces the old fixed cover-fit (one axis fully
  // visible, the other cropped just enough to match the paper's ratio);
  // zooming in shrinks the window further, revealing less of the image per
  // axis. panX/panY (0..1) then slide that window across whatever slack is
  // left once the window is smaller than the full image on that axis.
  function computeCropFracs(imgW: number, imgH: number, paperWIn: number, paperHIn: number, zoom: number) {
    const targetRatio = paperWIn / paperHIn;
    const imgRatio = imgW / imgH;
    const visW = imgRatio > targetRatio ? targetRatio / imgRatio : 1;
    const visH = imgRatio > targetRatio ? 1 : imgRatio / targetRatio;
    const cropW = Math.min(1, visW / zoom);
    const cropH = Math.min(1, visH / zoom);
    const maxPanX = 1 - cropW;
    const maxPanY = 1 - cropH;
    return { cropW, cropH, maxPanX, maxPanY };
  }

  // Source-pixel crop rectangle for the current crop state — the single
  // source of truth used by both the preview (scaled down for display) and
  // the real print export (drawn at full native resolution), so what's
  // shown on screen is exactly what gets sent.
  function getCropRectPx(imgW: number, imgH: number, paperWIn: number, paperHIn: number) {
    const { cropW, cropH, maxPanX, maxPanY } = computeCropFracs(imgW, imgH, paperWIn, paperHIn, cropZoom);
    const x0 = cropPanX * maxPanX;
    const y0 = cropPanY * maxPanY;
    return { sx: x0 * imgW, sy: y0 * imgH, sw: cropW * imgW, sh: cropH * imgH };
  }

  // Loads pdf.js once, on demand — not in the root layout, since only this
  // page needs it.
  useEffect(() => {
    if ((window as any).pdfjsLib) {
      setPdfjsReady(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      setPdfjsReady(true);
    };
    document.head.appendChild(script);
  }, []);

  function fmtGapIn(px: number, pxPerIn: number): string {
    return (Math.abs(px) / pxPerIn).toFixed(2) + "in";
  }

  async function renderPreview() {
    const paperBox = paperBoxRef.current;
    const paperInner = paperInnerRef.current;
    if (!paperBox || !paperInner) return;
    paperInner.innerHTML = "";

    const MAX = 220;
    if (!pdfFile) {
      setPreviewVerdictText("Choose a file to preview.");
      setPreviewVerdictGood(null);
      setPreviewNoteText("");
      setLowResWarning("");
      paperBox.style.width = paperBox.style.height = MAX + "px";
      return;
    }

    let [paperWIn, paperHIn] = getSelectedPaperInches();
    if (landscape) [paperWIn, paperHIn] = [paperHIn, paperWIn];
    const pxPerIn = Math.min(MAX / paperWIn, MAX / paperHIn);
    const boxW = paperWIn * pxPerIn;
    const boxH = paperHIn * pxPerIn;
    paperBox.style.width = boxW + "px";
    paperBox.style.height = boxH + "px";

    const isImage = pdfFile.type.startsWith("image/");
    if (!isImage) setLowResWarning("");

    if (isImage || (!isImage && useCustomSize)) {
      // Crop-fill — always for an image, and for a PDF when a custom size
      // is in use (that path rasterizes + crop-fills page 1 server-side,
      // same as a photo).
      if (isImage) {
        if (!previewImgRef.current) return;
        const { w: imgW, h: imgH } = previewImgRef.current;
        const { cropW, cropH, maxPanX, maxPanY } = computeCropFracs(imgW, imgH, paperWIn, paperHIn, cropZoom);

        // Low-resolution warning — the pixels actually visible after crop/
        // zoom, divided by the physical size they'll cover, in DPI. Below
        // ~100 DPI a print visibly softens/pixelates; below ~150 it's
        // noticeable up close. This can't be fixed in software — it's
        // telling the customer to pick a higher-resolution source image.
        const effectiveDpi = Math.min((cropW * imgW) / paperWIn, (cropH * imgH) / paperHIn);
        if (effectiveDpi < 100) {
          setLowResWarning(
            `This image is low resolution for this print size — about ${Math.round(effectiveDpi)} DPI (aim for 150+). It will likely look soft or pixelated on paper. Use a higher-resolution source image, or a smaller print size.`
          );
        } else if (effectiveDpi < 150) {
          setLowResWarning(`This image is below ideal resolution for this print size (~${Math.round(effectiveDpi)} DPI, aim for 150+) — detail may look slightly soft.`);
        } else {
          setLowResWarning("");
        }

        const displayScale = boxW / (cropW * imgW);
        const imgDisplayW = imgW * displayScale;
        const imgDisplayH = imgH * displayScale;
        const imgLeft = -(cropPanX * maxPanX) * imgDisplayW;
        const imgTop = -(cropPanY * maxPanY) * imgDisplayH;
        const img = document.createElement("img");
        img.src = previewImgRef.current.url;
        img.draggable = false;
        img.style.position = "absolute";
        img.style.left = imgLeft + "px";
        img.style.top = imgTop + "px";
        img.style.width = imgDisplayW + "px";
        img.style.height = imgDisplayH + "px";
        img.style.maxWidth = "none";
        img.style.cursor = "grab";
        paperInner.appendChild(img);
      } else if (pdfPreviewDocRef.current) {
        const page = await pdfPreviewDocRef.current.getPage(1);
        const vp0 = page.getViewport({ scale: 1 });
        const renderScale = Math.max(boxW / vp0.width, boxH / vp0.height) * 2;
        const vp = page.getViewport({ scale: renderScale });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        const coverScale = Math.max(boxW / vp0.width, boxH / vp0.height);
        const dispW = vp0.width * coverScale;
        const dispH = vp0.height * coverScale;
        canvas.style.position = "absolute";
        canvas.style.left = (boxW - dispW) / 2 + "px";
        canvas.style.top = (boxH - dispH) / 2 + "px";
        canvas.style.width = dispW + "px";
        canvas.style.height = dispH + "px";
        paperInner.appendChild(canvas);
      } else {
        return;
      }
      setPreviewVerdictText("Borderless — fills the page completely (cropped to fit).");
      setPreviewVerdictGood(true);
      setPreviewNoteText(
        isImage
          ? "Drag the photo to reposition it, zoom to crop in tighter — the exact crop you frame here is what gets printed, not an approximation. Scale mode has no effect on image uploads — only PDFs at a normal (non-custom) size."
          : "Custom size on this PDF: page 1 is rasterized and crop-filled, same as a photo."
      );
      return;
    }

    // Classic PDF path (not custom size) — mirrors SumatraPDF's real
    // behaviour: "Fit" contains (never crops); "Actual"/"Custom %" center
    // the page at its true size.
    if (!pdfPreviewDocRef.current) {
      setPreviewVerdictText(pdfjsReady ? "Rendering PDF…" : "PDF preview unavailable (pdf.js didn't load).");
      setPreviewVerdictGood(null);
      setPreviewNoteText("");
      return;
    }
    const page = await pdfPreviewDocRef.current.getPage(1);
    const view = page.view;
    const pdfWIn = (view[2] - view[0]) / 72;
    const pdfHIn = (view[3] - view[1]) / 72;
    const pdfWpx = pdfWIn * pxPerIn;
    const pdfHpx = pdfHIn * pxPerIn;

    let dispW: number, dispH: number;
    if (scaleMode === "actual" || scaleMode === "custom") {
      const f = scaleMode === "custom" ? scalePercent / 100 : 1;
      dispW = pdfWpx * f;
      dispH = pdfHpx * f;
    } else {
      const s = Math.min(boxW / pdfWpx, boxH / pdfHpx);
      dispW = pdfWpx * s;
      dispH = pdfHpx * s;
    }
    const renderScale = Math.max((dispW / (pdfWIn * 72)) * 2, 0.1);
    const vp = page.getViewport({ scale: renderScale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    canvas.style.position = "absolute";
    canvas.style.left = (boxW - dispW) / 2 + "px";
    canvas.style.top = (boxH - dispH) / 2 + "px";
    canvas.style.width = dispW + "px";
    canvas.style.height = dispH + "px";
    paperInner.appendChild(canvas);

    const gapX = boxW - dispW;
    const gapY = boxH - dispH;
    if (Math.abs(gapX) <= 1 && Math.abs(gapY) <= 1) {
      setPreviewVerdictText("Fills the page exactly — borderless.");
      setPreviewVerdictGood(true);
    } else {
      const msgs: string[] = [];
      if (gapX > 1) msgs.push(`${fmtGapIn(gapX, pxPerIn)} gap left/right`);
      else if (gapX < -1) msgs.push(`${fmtGapIn(gapX, pxPerIn)} clipped off left/right`);
      if (gapY > 1) msgs.push(`${fmtGapIn(gapY, pxPerIn)} gap top/bottom`);
      else if (gapY < -1) msgs.push(`${fmtGapIn(gapY, pxPerIn)} clipped off top/bottom`);
      setPreviewVerdictText(msgs.join(" and ") + ".");
      setPreviewVerdictGood(false);
    }
    setPreviewNoteText(
      scaleMode === "fit" || !scaleMode
        ? "\"Fit\" scales to stay within the page (never crops) — gaps appear when the PDF's own aspect ratio doesn't match the paper's. Exception: if this PDF is auto-detected as just one full-page photo, the server crop-fills it like an image instead — this preview shows the general/document case."
        : "\"Actual\"/\"Custom %\" print the PDF at its own defined size (times the percentage), centered — content bigger than the page gets clipped, smaller content leaves a gap."
    );
  }

  // Reload the preview source whenever the file changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (previewImgRef.current) {
        URL.revokeObjectURL(previewImgRef.current.url);
        previewImgRef.current = null;
      }
      previewImgElRef.current = null;
      pdfPreviewDocRef.current = null;
      if (pdfFile) {
        if (pdfFile.type.startsWith("image/")) {
          const url = URL.createObjectURL(pdfFile);
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("couldn't load image"));
            img.src = url;
          }).catch(() => undefined);
          if (cancelled) return;
          previewImgRef.current = { url, w: img.naturalWidth, h: img.naturalHeight };
          previewImgElRef.current = img;
          setCropZoom(1);
          setCropPanX(0.5);
          setCropPanY(0.5);
        } else if (pdfFile.type === "application/pdf" && (window as any).pdfjsLib) {
          try {
            const buf = await pdfFile.arrayBuffer();
            pdfPreviewDocRef.current = await (window as any).pdfjsLib.getDocument({ data: buf }).promise;
          } catch {
            pdfPreviewDocRef.current = null;
          }
        }
      }
      if (!cancelled) renderPreview();
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfFile, pdfjsReady]);

  // The target paper shape just changed — snap the crop back to centered,
  // un-zoomed. Otherwise a crop dialed in for one ratio silently carries
  // over (still valid, just confusingly framed) onto a differently-shaped
  // page.
  useEffect(() => {
    setCropZoom(1);
    setCropPanX(0.5);
    setCropPanY(0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperSize, useCustomSize, customWidthIn, customHeightIn, landscape]);

  // Re-render whenever a setting that affects the preview changes.
  useEffect(() => {
    renderPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperSize, useCustomSize, customWidthIn, customHeightIn, scaleMode, scalePercent, landscape, printerDetails, cropZoom, cropPanX, cropPanY]);

  function handleCropPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pdfFile?.type.startsWith("image/")) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, startPanX: cropPanX, startPanY: cropPanY };
  }

  function handleCropPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    const paperBox = paperBoxRef.current;
    if (!drag || !paperBox || !previewImgRef.current) return;
    let [paperWIn, paperHIn] = getSelectedPaperInches();
    if (landscape) [paperWIn, paperHIn] = [paperHIn, paperWIn];
    const { w: imgW, h: imgH } = previewImgRef.current;
    const { cropW, maxPanX, maxPanY } = computeCropFracs(imgW, imgH, paperWIn, paperHIn, cropZoom);
    const boxW = paperBox.clientWidth;
    const displayScale = boxW / (cropW * imgW);
    const dxFrac = maxPanX > 0 ? (e.clientX - drag.startX) / (displayScale * imgW * maxPanX) : 0;
    const dyFrac = maxPanY > 0 ? (e.clientY - drag.startY) / (displayScale * imgH * maxPanY) : 0;
    setCropPanX(Math.min(1, Math.max(0, drag.startPanX - dxFrac)));
    setCropPanY(Math.min(1, Math.max(0, drag.startPanY - dyFrac)));
  }

  function handleCropPointerUp() {
    dragStateRef.current = null;
  }

  // Renders the current crop (full resolution, native pixels — no
  // resampling beyond what the crop itself requires) to a blob in the
  // original format, so a PNG design stays lossless end to end and a
  // flat-color/text graphic never picks up JPEG blocking. This is what
  // actually gets sent for an image upload, not the raw file — by the time
  // it reaches the bridge its aspect ratio already equals the paper's, so
  // the server's own cover-fit crop becomes a no-op.
  async function buildCroppedImageBlob(paperWIn: number, paperHIn: number): Promise<Blob | null> {
    const imgEl = previewImgElRef.current;
    if (!imgEl || !pdfFile) return null;
    const { sx, sy, sw, sh } = getCropRectPx(imgEl.naturalWidth, imgEl.naturalHeight, paperWIn, paperHIn);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const isPng = pdfFile.type === "image/png";
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), isPng ? "image/png" : "image/jpeg", 0.95));
  }

  async function handlePrintPdf() {
    if (!ppRef || !selected || !pdfFile) return;
    setPdfPrinting(true);
    appendLog(`Reading "${pdfFile.name}" (${(pdfFile.size / 1024).toFixed(0)} KB)...`);
    try {
      // An uploaded photo is cropped client-side, right here, to exactly the
      // paper's own aspect ratio — using the same crop the user just framed
      // in the preview above — before it's ever sent. The bridge still does
      // its own cover-fit crop server-side as a safety net, but since the
      // ratios now already match, that becomes a no-op: what's framed above
      // is what prints, not an approximation of it. (Only PDFs need the
      // classic PDF route, untouched here.)
      const isImage = pdfFile.type.startsWith("image/");
      const [wIn, hIn] = getSelectedPaperInches();
      let base64: string;
      if (isImage) {
        let [cropWIn, cropHIn] = [wIn, hIn];
        if (landscape) [cropWIn, cropHIn] = [cropHIn, cropWIn];
        const croppedBlob = await buildCroppedImageBlob(cropWIn, cropHIn);
        base64 = croppedBlob ? await readFileAsBase64(croppedBlob) : await readFileAsBase64(pdfFile);
      } else {
        base64 = await readFileAsBase64(pdfFile);
      }
      appendLog(
        `Sending "${pdfFile.name}" to "${selected}" (${useCustomSize ? "custom size" : paperSize}, ${wIn.toFixed(2)} × ${hIn.toFixed(2)} in${
          landscape ? ", landscape" : ""
        }${duplex ? ", duplex " + duplex : ""}${color ? "" : ", grayscale"}, ${copies} cop${copies === 1 ? "y" : "ies"}${
          pageOrder === "backToFront" ? ", back to front" : ""
        }${fastRaster ? ", fast-raster mode" : ""}${classicEngine ? ", classic engine" : ""})...`
      );
      const startedAt = performance.now();
      // The custom-size print path (server side) only engages when scaleMode
      // is "fit" — "actual"/"custom%" are a document-layout concept that
      // deliberately keeps the classic engine instead, which doesn't know
      // about the locked custom size at all. Since Scale can drift to
      // "Custom %" just from focusing its input box, force "fit" here
      // whenever a custom size is in use, regardless of what the radio
      // group currently shows — there's no valid reason to combine them.
      const effectiveScaleMode = useCustomSize ? "fit" : scaleMode;
      const options = {
        type: isImage ? ("image" as const) : ("pdf" as const),
        ...(useCustomSize ? {} : { paperSize }),
        ...(isImage || useCustomSize ? { pageSize: { width: wIn, height: hIn, units: "in" as const } } : {}),
        // The custom-size value IS the printer's own current default (read
        // straight from it, read-only in this UI) — so for that case only,
        // tell PrintTrays to use the printer's default settings instead of
        // overriding page size/orientation explicitly, which was silently
        // leaving out that default's own feed-direction/E2E configuration.
        ...(useCustomSize ? { useDriverDefaultSize: true } : {}),
        landscape,
        color,
        copies,
        fastRaster,
        scaleMode: effectiveScaleMode,
        pageOrder,
        ...(classicEngine ? { imageEngine: "sumatra" as const } : {}),
        ...(!useCustomSize && scaleMode === "custom" ? { scaleFactor: scalePercent } : {}),
        ...(duplex ? { duplex } : {}),
        ...(inputBin ? { inputBin } : {}),
      };
      // Full, exact request object — check this in DevTools for anything the
      // popup below doesn't spell out.
      console.log("[PrintTrays demo] Upload print — request:", { printer: selected, file: pdfFile.name, ...options });
      await ppRef.print(selected, base64, options);
      const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
      appendLog(`Print job sent successfully (spooler accepted it after ${elapsedSec}s).`);
      // A plain summary of exactly what was requested — for testing, so it's
      // obvious at a glance which path this went down, without reading logs.
      const engineNote = isImage
        ? classicEngine
          ? "classic engine (forced)"
          : "Chromium image path (fast)"
        : useCustomSize
          ? "custom-size path (rasterized page 1, crop-filled)"
          : "classic PDF path (or auto-detected single-photo image path)";
      window.alert(
        `Print sent — ${elapsedSec}s\n\n` +
          `Printer: ${selected}\n` +
          `File: ${pdfFile.name}\n` +
          `Sent as type: ${isImage ? "image" : "pdf"}\n` +
          `Size: ${useCustomSize ? "custom" : paperSize} (${wIn.toFixed(2)} × ${hIn.toFixed(2)} in)\n` +
          `Orientation: ${landscape ? "landscape" : "portrait"}\n` +
          `Color: ${color ? "color" : "grayscale"}\n` +
          `Duplex: ${duplex || "simplex"}\n` +
          `Copies: ${copies}\n` +
          `Page order: ${pageOrder}\n` +
          `Input bin: ${inputBin || "printer default"}\n` +
          `Scale mode: ${effectiveScaleMode}${!useCustomSize && scaleMode === "custom" ? ` (${scalePercent}%)` : ""}\n` +
          `Fast-raster: ${fastRaster}\n` +
          `Image engine: ${classicEngine ? "sumatra (forced)" : "chromium (default)"}\n` +
          `Using printer's own default size/orientation: ${useCustomSize}\n` +
          `Likely path: ${engineNote}\n\n` +
          `Full request object logged to the browser console (F12).`
      );
    } catch (err: any) {
      appendLog(`Print failed: ${err?.message ?? err}`);
    } finally {
      setPdfPrinting(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="container">
        <section style={{ borderTop: "none", paddingTop: 56 }}>
          <h2>Live demo</h2>
          <p className="lead">
            This page talks to PrintTrays running on <em>your</em> machine, right now, over{" "}
            <code>wss://127.0.0.1:8181</code>. Nothing is sent to any server.
          </p>

          <div className="status-line">
            <span className={`dot ${status === "connected" ? "ok" : ""}`} />
            {status === "idle" && "Not connected yet"}
            {status === "connecting" && "Connecting..."}
            {status === "connected" && `Connected to v${version ?? "unknown"} — ${printers.length} printer(s) found`}
            {status === "failed" && "Couldn't reach PrintTrays — see steps below"}
          </div>

          {status !== "connected" && (
            <button className="btn" onClick={attemptConnect}>
              Connect to PrintTrays
            </button>
          )}

          {status === "failed" && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3>Two things this usually means</h3>
              <p style={{ marginBottom: 12 }}>
                Browsers can't tell a JavaScript app the difference between "not installed" and "certificate not
                trusted yet" — both fail a WebSocket connection silently. Try both of these:
              </p>
              <ol style={{ margin: "0 0 14px", paddingLeft: 20, color: "var(--text-dim)", fontSize: 14, lineHeight: 1.7 }}>
                <li>
                  <strong>Trust the local certificate</strong> — click the button below, click <em>Advanced →
                  Proceed</em> in the small window that opens, then it'll close itself and retry automatically.
                  (Skip this if PrintTrays was installed via its real installer — that trusts the certificate
                  automatically.)
                  <div style={{ marginTop: 8 }}>
                    <button className="btn-ghost" onClick={openTrustPopup}>
                      Trust PrintTrays's certificate
                    </button>
                  </div>
                </li>
                <li>
                  <strong>Make sure PrintTrays is actually running</strong> — look for its icon in your system
                  tray. If it's not there, <Link href="/download">download and install it</Link> first.
                </li>
              </ol>
            </div>
          )}

          {status === "connected" && (
            <div className="card" style={{ marginTop: 20 }}>
              <h3>Send a test print</h3>
              <p style={{ marginBottom: 14 }}>Pick a printer and page-setup options, then send a one-page HTML test document.</p>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Printer
                  <select
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                    style={selectStyle}
                  >
                    {printers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                        {p.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Paper size{" "}
                  {printerDetailsLoading && <span style={{ color: "var(--text-dim)" }}>(checking…)</span>}
                  {!printerDetailsLoading && !useCustomSize && printerDetails?.sizes.length ? (
                    <span className="badge" style={{ marginLeft: 4 }}>LIVE</span>
                  ) : null}
                  {!useCustomSize && (
                    <select
                      value={paperSize}
                      onChange={(e) => {
                        if (e.target.value === CUSTOM_SIZE_VALUE) {
                          setUseCustomSize(true);
                        } else {
                          setPaperSize(e.target.value);
                        }
                      }}
                      style={selectStyle}
                    >
                      {printerDetails?.sizes.length
                        ? printerDetails.sizes.map((s) => (
                            <option key={s.name} value={s.name}>
                              {s.name} ({s.widthIn.toFixed(2)} × {s.heightIn.toFixed(2)} in)
                            </option>
                          ))
                        : PAPER_SIZES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                      {printerDetails?.customSizeOptionName && (
                        <option value={CUSTOM_SIZE_VALUE}>
                          {printerDetails.customSizeOptionName}
                          {printerDetails.defaultCustomSize
                            ? ` (${printerDetails.defaultCustomSize.widthIn.toFixed(2)} × ${printerDetails.defaultCustomSize.heightIn.toFixed(2)} in, last used)`
                            : " (type your own size)"}
                        </option>
                      )}
                    </select>
                  )}
                  {useCustomSize && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
                      <input
                        type="number"
                        min={0.1}
                        step={0.01}
                        value={customWidthIn}
                        onChange={(e) => setCustomWidthIn(Number(e.target.value) || 0.1)}
                        readOnly={!!printerDetails?.defaultCustomSize}
                        style={{
                          ...selectStyle,
                          marginTop: 0,
                          ...(printerDetails?.defaultCustomSize ? { opacity: 0.75, cursor: "not-allowed" } : {}),
                        }}
                        aria-label="Custom width (inches)"
                      />
                      <span>×</span>
                      <input
                        type="number"
                        min={0.1}
                        step={0.01}
                        value={customHeightIn}
                        onChange={(e) => setCustomHeightIn(Number(e.target.value) || 0.1)}
                        readOnly={!!printerDetails?.defaultCustomSize}
                        style={{
                          ...selectStyle,
                          marginTop: 0,
                          ...(printerDetails?.defaultCustomSize ? { opacity: 0.75, cursor: "not-allowed" } : {}),
                        }}
                        aria-label="Custom height (inches)"
                      />
                      <span>in</span>
                    </div>
                  )}
                  {useCustomSize && (
                    <button
                      type="button"
                      onClick={() => setUseCustomSize(false)}
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        background: "none",
                        border: "none",
                        color: "var(--accent)",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      ← back to the size list
                    </button>
                  )}
                </label>

                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Paper source{" "}
                  {!printerDetailsLoading && printerDetails?.inputBins.length ? (
                    <span className="badge" style={{ marginLeft: 4 }}>LIVE</span>
                  ) : null}
                  <select
                    value={inputBin}
                    onChange={(e) => setInputBin(e.target.value)}
                    style={selectStyle}
                    disabled={!printerDetails?.inputBins.length}
                  >
                    <option value="">Printer default</option>
                    {(printerDetails?.inputBins ?? []).map((b) => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </select>
                </label>

                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Duplex
                  <select value={duplex} onChange={(e) => setDuplex(e.target.value)} style={selectStyle}>
                    {DUPLEX_MODES.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </label>

                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Page order{" "}
                  <span className="badge" style={{ marginLeft: 4, opacity: 0.6 }} title="Only affects multi-page PDFs — a one-page document or photo has no order to reverse">
                    MULTI-PAGE
                  </span>
                  <select value={pageOrder} onChange={(e) => setPageOrder(e.target.value as typeof pageOrder)} style={selectStyle}>
                    {PAGE_ORDERS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </label>

                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Copies
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={copies}
                    onChange={(e) => setCopies(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                    style={selectStyle}
                  />
                </label>

                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Quality{" "}
                  {printerDetails?.resolutions.length ? (
                    <span className="badge" style={{ marginLeft: 4, opacity: 0.6 }} title="Reported by the printer, but not yet applied to the print job">NOT WIRED</span>
                  ) : null}
                  <select
                    value={quality}
                    onChange={(e) => setQuality(e.target.value)}
                    style={selectStyle}
                    disabled={!printerDetails?.resolutions.length}
                  >
                    <option value="">Printer default</option>
                    {(printerDetails?.resolutions ?? []).map((r) => (
                      <option key={r.name} value={r.name}>{r.name}</option>
                    ))}
                  </select>
                </label>

                <label style={{ fontSize: 13, color: "var(--text-dim)" }}>
                  Media type{" "}
                  {printerDetails?.mediaTypes.length ? (
                    <span className="badge" style={{ marginLeft: 4, opacity: 0.6 }} title="Reported by the printer, but not yet applied to the print job">NOT WIRED</span>
                  ) : null}
                  <select
                    value={mediaType}
                    onChange={(e) => setMediaType(e.target.value)}
                    style={selectStyle}
                    disabled={!printerDetails?.mediaTypes.length}
                  >
                    <option value="">Printer default</option>
                    {(printerDetails?.mediaTypes ?? []).map((m) => (
                      <option key={m.name} value={m.name}>{m.name}</option>
                    ))}
                  </select>
                </label>
              </div>

              {quality || mediaType ? (
                <p style={{ marginBottom: 16, fontSize: 12, color: "var(--text-dim)" }}>
                  Quality/Media type selections above are shown for reference only right now — the print
                  pipeline can't yet set a driver's DPI or media-type option, so these won't change the
                  actual printout yet.
                </p>
              ) : null}

              <div style={{ display: "flex", gap: 20, marginBottom: 16, fontSize: 13, color: "var(--text-dim)" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} />
                  Landscape
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={color} onChange={(e) => setColor(e.target.checked)} />
                  Color
                </label>
              </div>

              <div style={{ marginBottom: 16, fontSize: 13, color: "var(--text-dim)" }}>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>Scale</div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <input type="radio" name="scaleMode" checked={scaleMode === "fit"} onChange={() => setScaleMode("fit")} />
                  Fit to printable area
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <input type="radio" name="scaleMode" checked={scaleMode === "actual"} onChange={() => setScaleMode("actual")} />
                  Actual size
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="radio" name="scaleMode" checked={scaleMode === "custom"} onChange={() => setScaleMode("custom")} />
                  <input
                    type="number"
                    min={1}
                    max={400}
                    value={scalePercent}
                    onFocus={() => setScaleMode("custom")}
                    onChange={(e) => {
                      setScaleMode("custom");
                      setScalePercent(Math.max(1, Math.min(400, Number(e.target.value) || 100)));
                    }}
                    style={{ ...selectStyle, width: 70, display: "inline-block" }}
                  />
                  %
                </label>
                {useCustomSize && (
                  <p style={{ marginTop: 8, fontSize: 12 }}>
                    Custom size is in use below — for a PDF upload, Scale is always treated as "Fit" regardless of
                    what's selected here (the custom-size print path requires it; "Actual"/"Custom %" would silently
                    fall back to the classic engine and ignore the locked size). This only affects the PDF upload,
                    not the HTML test print above.
                  </p>
                )}
              </div>

              <button className="btn" onClick={handleTestPrint} disabled={!selected}>
                Print test page
              </button>
            </div>
          )}

          {status === "connected" && (
            <div className="card" style={{ marginTop: 20 }}>
              <h3>Upload &amp; print a PDF or image</h3>
              <p style={{ marginBottom: 14 }}>
                Test a real file end-to-end (uses the same printer and page-setup options above). Useful for
                catching issues that a plain HTML test page won't — e.g. blank pages on image-heavy PDFs. An
                image file (JPEG/PNG/WEBP) is sent as-is; PrintTrays crops it to fill the selected paper size
                exactly, edge-to-edge, and prints it the same way Ctrl+P would (much less data for the driver,
                so much faster on photo printers) — pick an "E2E" paper size above first for a true borderless
                test. A PDF that is only one full-page photo is treated the same way.
              </p>
              {useCustomSize && (
                <p style={{ marginBottom: 14, fontSize: 12, color: "var(--text-dim)" }}>
                  You picked the printer's own "{printerDetails?.customSizeOptionName ?? "custom size"}" option — the
                  same one Chrome/Acrobat's print dialog offers.{" "}
                  {printerDetails?.defaultCustomSize
                    ? `It's locked to ${printerDetails.defaultCustomSize.widthIn.toFixed(2)} × ${printerDetails.defaultCustomSize.heightIn.toFixed(
                        2
                      )}in — the exact size currently saved on this printer's own driver settings (not editable here on purpose: this guarantees the print matches whatever bleed/E2E option is saved alongside that size on the driver — a different typed number here wouldn't carry that over). To use a different size, change it in the printer's own Properties → Preferences → Advanced dialog, then reload this page.`
                    : "Windows doesn't remember a previous value for this printer yet — go set one in the printer's own Properties → Preferences → Advanced dialog first, then reload this page."}{" "}
                  A size larger than anything in the size list above is almost certainly bigger than what the tray's
                  media can physically hold. For a PDF (not an image), this only works when Scale is set to "Fit" —
                  only page 1 is used, rasterized and crop-filled the same way a photo is.
                </p>
              )}

              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                style={{ marginBottom: 14, display: "block" }}
              />

              <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 16 }}>
                <div
                  ref={paperBoxRef}
                  onPointerDown={handleCropPointerDown}
                  onPointerMove={handleCropPointerMove}
                  onPointerUp={handleCropPointerUp}
                  onPointerCancel={handleCropPointerUp}
                  style={{
                    position: "relative",
                    overflow: "hidden",
                    border: "1px solid var(--border)",
                    boxShadow: "0 1px 4px rgba(0,0,0,.15)",
                    backgroundColor: "#fde68a",
                    backgroundImage:
                      "repeating-linear-gradient(45deg, #fde68a, #fde68a 6px, #fcd34d 6px, #fcd34d 12px)",
                    maxWidth: 220,
                    maxHeight: 220,
                    flexShrink: 0,
                    touchAction: "none",
                  }}
                >
                  <div ref={paperInnerRef} />
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      padding: "6px 10px",
                      borderRadius: 6,
                      maxWidth: 320,
                      ...(previewVerdictGood === true
                        ? { background: "#d1fae5", color: "#065f46" }
                        : previewVerdictGood === false
                          ? { background: "#fee2e2", color: "#991b1b" }
                          : { color: "var(--text-dim)" }),
                    }}
                  >
                    {previewVerdictText}
                  </div>
                  {previewNoteText && (
                    <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6, maxWidth: 320 }}>{previewNoteText}</div>
                  )}
                  {lowResWarning && (
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        marginTop: 8,
                        padding: "6px 10px",
                        borderRadius: 6,
                        maxWidth: 320,
                        background: "#fef3c7",
                        color: "#92400e",
                      }}
                    >
                      ⚠ {lowResWarning}
                    </div>
                  )}
                  {pdfFile?.type.startsWith("image/") && (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12, color: "var(--text-dim)" }}>
                      Zoom
                      <input
                        type="range"
                        min={1}
                        max={3}
                        step={0.01}
                        value={cropZoom}
                        onChange={(e) => setCropZoom(parseFloat(e.target.value))}
                        style={{ width: 140 }}
                      />
                      <span style={{ minWidth: 34 }}>{Math.round(cropZoom * 100)}%</span>
                    </label>
                  )}
                </div>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: -8, marginBottom: 16, maxWidth: 560 }}>
                The striped area is the paper — striping visible means a real gap the printer will leave blank. This
                mirrors the server's actual logic, not an approximation.
              </p>

              <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 13, color: "var(--text-dim)" }}>
                <input type="checkbox" checked={fastRaster} onChange={(e) => setFastRaster(e.target.checked)} />
                Fast-raster mode (experimental) — rasterizes the PDF ourselves and sends it as a raw image feed
                instead of the normal PDF print pipeline. Much faster on some drivers, but only works if your
                printer's queue actually accepts a raw image feed — try both and compare.
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 13, color: "var(--text-dim)" }}>
                <input type="checkbox" checked={classicEngine} onChange={(e) => setClassicEngine(e.target.checked)} />
                Use the classic print engine for images (slower — only for comparing speed; JPEG/PNG only)
              </label>

              <p style={{ marginBottom: 14, fontSize: 12, color: "var(--text-dim)" }}>
                Uses the same Scale setting from "Send a test print" above.
              </p>

              <button className="btn" onClick={handlePrintPdf} disabled={!selected || !pdfFile || pdfPrinting}>
                {pdfPrinting ? "Printing..." : "Print uploaded PDF"}
              </button>
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 14, color: "var(--text-dim)" }}>Activity log</h3>
            <pre>{log.length ? log.join("\n") : "(nothing yet)"}</pre>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

const selectStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: 8,
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  fontSize: 14,
};
