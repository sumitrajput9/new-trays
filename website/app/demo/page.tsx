"use client";

import { useState } from "react";
import Nav from "../components/Nav";
import Footer from "../components/Footer";

type Printer = { name: string; isDefault: boolean };
type Status = "idle" | "connecting" | "connected" | "failed";

const CERT_URL = "https://127.0.0.1:8181";
const PAPER_SIZES = ["Letter", "A4", "A5", "A3", "Legal", "Tabloid"] as const;
const DUPLEX_MODES = [
  { value: "", label: "Simplex (single-sided)" },
  { value: "longEdge", label: "Duplex — long edge" },
  { value: "shortEdge", label: "Duplex — short edge" },
];

export default function DemoPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [ppRef, setPpRef] = useState<any>(null);
  const [version, setVersion] = useState<string | undefined>();

  const [paperSize, setPaperSize] = useState<(typeof PAPER_SIZES)[number]>("Letter");
  const [landscape, setLandscape] = useState(false);
  const [duplex, setDuplex] = useState("");
  const [color, setColor] = useState(true);
  const [copies, setCopies] = useState(1);

  const appendLog = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l]);

  async function attemptConnect() {
    setStatus("connecting");
    appendLog("Connecting to wss://127.0.0.1:8181 ...");
    try {
      const sdkUrl = "/printtrays.js";
      const { PrintTrays } = await import(/* webpackIgnore: true */ sdkUrl);
      const pp = new PrintTrays({ downloadUrl: "/download" });
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
        }
      );
      appendLog("Print job sent successfully.");
    } catch (err: any) {
      appendLog(`Print failed: ${err?.message ?? err}`);
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
                  tray. If it's not there, <a href="/download">download and install it</a> first.
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
                  Paper size
                  <select value={paperSize} onChange={(e) => setPaperSize(e.target.value as any)} style={selectStyle}>
                    {PAPER_SIZES.map((s) => (
                      <option key={s} value={s}>{s}</option>
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
              </div>

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

              <button className="btn" onClick={handleTestPrint} disabled={!selected}>
                Print test page
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
