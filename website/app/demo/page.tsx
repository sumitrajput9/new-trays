"use client";

import { useState } from "react";
import Nav from "../components/Nav";
import Footer from "../components/Footer";

type Printer = { name: string; isDefault: boolean };
type Status = "idle" | "connecting" | "connected" | "failed";

const CERT_URL = "https://127.0.0.1:8181";

export default function DemoPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [ppRef, setPpRef] = useState<any>(null);

  const appendLog = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l]);

  async function handleConnect() {
    setStatus("connecting");
    appendLog("Connecting to wss://127.0.0.1:8181 ...");
    try {
      const sdkUrl = "/printtrays.js";
      const { PrintTrays } = await import(/* webpackIgnore: true */ sdkUrl);
      const pp = new PrintTrays({ downloadUrl: "/download" });
      await pp.connect();
      setPpRef(pp);
      setStatus("connected");
      appendLog("Connected. Fetching printer list...");
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

  async function handleTestPrint() {
    if (!ppRef || !selected) return;
    appendLog(`Sending test page to "${selected}"...`);
    try {
      await ppRef.print(
        selected,
        `<html><body style="font-family:sans-serif;padding:40px">
           <h1>PrintTrays test page</h1>
           <p>If you can read this on paper, the bridge is working.</p>
           <p>Printed at ${new Date().toString()}</p>
         </body></html>`,
        { type: "html" }
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
            {status === "connected" && `Connected — ${printers.length} printer(s) found`}
            {status === "failed" && "Couldn't reach PrintTrays — see steps below"}
          </div>

          {status !== "connected" && (
            <button className="btn" onClick={handleConnect}>
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
                  <strong>Trust the local certificate</strong> — until PrintTrays is installed via its full
                  installer (which imports the certificate automatically), your browser needs to be told to trust
                  it once per profile.{" "}
                  <a href={CERT_URL} target="_blank" rel="noopener">
                    Open {CERT_URL} in a new tab
                  </a>
                  , click <em>Advanced → Proceed</em> on the warning page, then come back and click Connect again.
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
              <p style={{ marginBottom: 12 }}>Pick a printer and send a one-page HTML test document.</p>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                style={{ padding: 8, borderRadius: 6, marginRight: 10, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                {printers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
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
