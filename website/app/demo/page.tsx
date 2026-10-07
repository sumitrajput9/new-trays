"use client";

import { useState, useEffect } from "react";
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
};

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
        const hasAny = sizes.length || resolutions.length || mediaTypes.length || inputBins.length;
        setPrinterDetails(hasAny ? { sizes, resolutions, mediaTypes, inputBins, orientations } : null);
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
    appendLog(
      `Sending test page to "${selected}" (${paperSize}${landscape ? ", landscape" : ""}${
        duplex ? ", duplex " + duplex : ""
      }${color ? "" : ", grayscale"}, ${copies} cop${copies === 1 ? "y" : "ies"})...`
    );
    try {
      await ppRef.print(
        selected,
        `<html><body style="font-family:sans-serif;padding:40px">
           <h1>PrintTrays test page</h1>
           <p>If you can read this on paper, the bridge is working.</p>
           <p>Paper: ${paperSize}${landscape ? " (landscape)" : ""}</p>
           <p>Printed at ${new Date().toString()}</p>
         </body></html>`,
        {
          type: "html",
          paperSize,
          landscape,
          color,
          copies,
          ...(duplex ? { duplex } : {}),
          ...(scaleMode === "custom" ? { scaleFactor: scalePercent } : {}),
        }
      );
      appendLog("Print job sent successfully.");
    } catch (err: any) {
      appendLog(`Print failed: ${err?.message ?? err}`);
    }
  }

  function readFileAsBase64(file: File): Promise<string> {
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

  function getSelectedPaperInches(): [number, number] {
    const live = printerDetails?.sizes.find((s) => s.name === paperSize);
    if (live) return [live.widthIn, live.heightIn];
    return STATIC_SIZE_INCHES[paperSize] ?? [8.5, 11];
  }

  async function handlePrintPdf() {
    if (!ppRef || !selected || !pdfFile) return;
    setPdfPrinting(true);
    appendLog(`Reading "${pdfFile.name}" (${(pdfFile.size / 1024).toFixed(0)} KB)...`);
    try {
      // Photos are sent as-is: the bridge crops them to the exact paper size
      // and prints them through the same engine as Ctrl+P. (Only PDFs need
      // the classic PDF route.)
      const isImage = pdfFile.type.startsWith("image/");
      const base64 = await readFileAsBase64(pdfFile);
      const [wIn, hIn] = getSelectedPaperInches();
      appendLog(
        `Sending "${pdfFile.name}" to "${selected}" (${paperSize}${isImage ? `, ${wIn.toFixed(2)} × ${hIn.toFixed(2)} in` : ""}${
          landscape ? ", landscape" : ""
        }${duplex ? ", duplex " + duplex : ""}${color ? "" : ", grayscale"}, ${copies} cop${copies === 1 ? "y" : "ies"}${
          pageOrder === "backToFront" ? ", back to front" : ""
        }${fastRaster ? ", fast-raster mode" : ""}${classicEngine ? ", classic engine" : ""})...`
      );
      const startedAt = performance.now();
      await ppRef.print(selected, base64, {
        type: isImage ? "image" : "pdf",
        paperSize,
        ...(isImage ? { pageSize: { width: wIn, height: hIn, units: "in" } } : {}),
        landscape,
        color,
        copies,
        fastRaster,
        scaleMode,
        pageOrder,
        ...(classicEngine ? { imageEngine: "sumatra" } : {}),
        ...(scaleMode === "custom" ? { scaleFactor: scalePercent } : {}),
        ...(duplex ? { duplex } : {}),
        ...(inputBin ? { inputBin } : {}),
      });
      const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
      appendLog(`Print job sent successfully (spooler accepted it after ${elapsedSec}s).`);
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
                  {!printerDetailsLoading && printerDetails?.sizes.length ? (
                    <span className="badge" style={{ marginLeft: 4 }}>LIVE</span>
                  ) : null}
                  <select value={paperSize} onChange={(e) => setPaperSize(e.target.value)} style={selectStyle}>
                    {printerDetails?.sizes.length
                      ? printerDetails.sizes.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name} ({s.widthIn.toFixed(2)} × {s.heightIn.toFixed(2)} in)
                          </option>
                        ))
                      : PAPER_SIZES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                  </select>
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

              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                style={{ marginBottom: 14, display: "block" }}
              />

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
