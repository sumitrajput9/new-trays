import Link from "next/link";
import Nav from "./components/Nav";
import Footer from "./components/Footer";

export default function HomePage() {
  return (
    <>
      <Nav />
      <main className="container">
        <section className="hero" style={{ borderTop: "none" }}>
          <h1>Print from the browser. To any printer, scale, or scanner.</h1>
          <p>
            PrintPort is a small background app that gives web pages a secure, signed local bridge to your
            OS printers, thermal/label printers, and USB or serial devices — without a plugin, and without
            asking the user to click through certificate warnings.
          </p>
          <div className="hero-actions">
            <Link href="/download" className="btn">
              Download PrintPort
            </Link>
            <Link href="/demo" className="btn-ghost">
              Try the live demo
            </Link>
          </div>
        </section>

        <section>
          <h2>What it does</h2>
          <p className="lead">One background app, one JS include, full local device access.</p>
          <div className="grid">
            <div className="card">
              <h3>Standard printing</h3>
              <p>Send PDF or HTML straight to any installed OS printer, silently, with no print dialog.</p>
            </div>
            <div className="card">
              <h3>Thermal &amp; label printers</h3>
              <p>Write raw ESC/POS or ZPL directly to receipt and label printers over USB, serial, or IP.</p>
            </div>
            <div className="card">
              <h3>Scales &amp; scanners</h3>
              <p>Read and write raw bytes over serial or HID for connected scales, barcode scanners, and pole displays.</p>
            </div>
            <div className="card">
              <h3>Signed responses</h3>
              <p>Every message back from the bridge is RSA-signed and pinned client-side, so a page can trust it's really talking to PrintPort.</p>
            </div>
            <div className="card">
              <h3>Runs quietly</h3>
              <p>Lives in the system tray, starts with your OS, and shows how many pages are currently connected.</p>
            </div>
            <div className="card">
              <h3>Cross-platform</h3>
              <p>One codebase, native installers for Windows, macOS, and Linux.</p>
            </div>
          </div>
        </section>

        <section>
          <h2>Three lines of code</h2>
          <p className="lead">That's the whole integration.</p>
          <pre>
            <code>{`import { PrintPort } from "./printport.js";

const pp = new PrintPort();
await pp.connect();
await pp.print("EPSON TM-T88", "\\x1bHello world\\x1b", { type: "escpos" });`}</code>
          </pre>
        </section>
      </main>
      <Footer />
    </>
  );
}
