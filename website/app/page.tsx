import Link from "next/link";
import Nav from "./components/Nav";
import Footer from "./components/Footer";

export default function HomePage() {
  return (
    <>
      <Nav />
      <main className="container">
        <section className="hero" style={{ borderTop: "none" }}>
          <span className="eyebrow">Self-hosted · Open source you own</span>
          <h1>Print from the browser. To any printer, scale, or scanner.</h1>
          <p>
            PrintPort is a small background app that gives your web pages a secure, signed local bridge to
            OS printers, thermal/label printers, and USB, HID, or serial devices — without a plugin, and
            without a browser print dialog ever appearing.
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
          <h2>How it works</h2>
          <p className="lead">Install once per machine. Every page on your site can print from then on.</p>
          <div className="steps">
            <div className="step">
              <h3>Install PrintPort</h3>
              <p>One installer, runs quietly in the system tray, starts automatically at login. Nobody has to think about it again.</p>
            </div>
            <div className="step">
              <h3>Include the SDK</h3>
              <p>A small JS module, no bundler or build step required. Three lines to connect and print.</p>
            </div>
            <div className="step">
              <h3>Print silently</h3>
              <p>PDF, HTML, raw ESC/POS or ZPL — straight to the printer, with full control over duplex, paper size, and orientation.</p>
            </div>
          </div>
        </section>

        <section>
          <h2>What it does</h2>
          <p className="lead">One background app, one JS include, full local device access.</p>
          <div className="grid">
            <div className="card">
              <div className="icon-badge">Aa</div>
              <h3>Standard printing</h3>
              <p>Send PDF or HTML straight to any installed OS printer, silently, with full control over duplex, orientation, paper size, margins, and color.</p>
            </div>
            <div className="card">
              <div className="icon-badge">▤</div>
              <h3>Thermal &amp; label printers</h3>
              <p>Write raw ESC/POS or ZPL directly to receipt and label printers over USB, serial, or IP — bypassing the OS spooler entirely.</p>
            </div>
            <div className="card">
              <div className="icon-badge">◈</div>
              <h3>Scales, scanners &amp; USB devices</h3>
              <p>Read and write raw bytes over serial, HID, or direct USB endpoints — including control transfers — for scales, barcode scanners, card readers, and signature pads.</p>
            </div>
            <div className="card">
              <div className="icon-badge">✓</div>
              <h3>Verified, not just trusted</h3>
              <p>Every response from the bridge is RSA-signed and pinned client-side, so a page can confirm it's really talking to your PrintPort install — not an impostor on the same port.</p>
            </div>
            <div className="card">
              <div className="icon-badge">●</div>
              <h3>Runs quietly</h3>
              <p>Lives in the system tray, starts with the OS, and shows live connection status — nothing for staff to open or manage day to day.</p>
            </div>
            <div className="card">
              <div className="icon-badge">◎</div>
              <h3>Cross-platform by design</h3>
              <p>One codebase. Windows and Linux are both built and functionally verified end-to-end today; macOS is on the roadmap.</p>
            </div>
          </div>
        </section>

        <section>
          <h2>Why run your own bridge</h2>
          <p className="lead">The honest comparison, not a sales pitch.</p>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>PrintPort</th>
                <th>A third-party closed-source bridge</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Source code</td>
                <td className="good">Fully in-house, fully readable</td>
                <td className="neutral">Closed — you can't see what it does</td>
              </tr>
              <tr>
                <td>Fixing an issue</td>
                <td className="good">Your team ships a fix the same day</td>
                <td className="neutral">Wait on the vendor's release schedule</td>
              </tr>
              <tr>
                <td>Extending it</td>
                <td className="good">Add whatever your workflow needs</td>
                <td className="neutral">Limited to what the vendor exposes</td>
              </tr>
              <tr>
                <td>Security review</td>
                <td className="good">Fully auditable, line by line</td>
                <td className="neutral">You're trusting a third party's binary</td>
              </tr>
              <tr>
                <td>Branding &amp; certificate</td>
                <td className="good">Your own name, your own local certificate</td>
                <td className="neutral">Vendor-branded</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2>Where it fits</h2>
          <p className="lead">Any web app that needs to print without asking the customer to.</p>
          <div>
            <div className="use-case">
              <div className="icon-badge">$</div>
              <div>
                <h3>Point of sale &amp; retail</h3>
                <p>Print receipts to a thermal printer the instant an order completes — no dialog, no delay at the counter.</p>
              </div>
            </div>
            <div className="use-case">
              <div className="icon-badge">▦</div>
              <div>
                <h3>Warehouse &amp; logistics</h3>
                <p>Send ZPL straight to a label printer for shipping labels, bin tags, and barcodes as orders are picked.</p>
              </div>
            </div>
            <div className="use-case">
              <div className="icon-badge">◐</div>
              <div>
                <h3>Photo &amp; print kiosks</h3>
                <p>Drive large-format or specialty printers directly from a browser-based ordering flow, with full page-setup control.</p>
              </div>
            </div>
            <div className="use-case">
              <div className="icon-badge">✎</div>
              <div>
                <h3>Forms, checklists &amp; back-office</h3>
                <p>Print PDFs and documents from internal tools without ever routing staff through a browser print dialog.</p>
              </div>
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

      <div className="cta-band">
        <div className="container">
          <h2>Ready to print without the dialog?</h2>
          <p className="lead">Install PrintPort once, then include the SDK anywhere you need to print.</p>
          <div className="hero-actions">
            <Link href="/download" className="btn">
              Download PrintPort
            </Link>
            <Link href="/docs" className="btn-ghost">
              Read the docs
            </Link>
          </div>
        </div>
      </div>

      <Footer />
    </>
  );
}
