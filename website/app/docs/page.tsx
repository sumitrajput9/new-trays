import Nav from "../components/Nav";
import Footer from "../components/Footer";

export default function DocsPage() {
  return (
    <>
      <Nav />
      <main className="container">
        <section style={{ borderTop: "none", paddingTop: 56 }}>
          <h2>API documentation</h2>
          <p className="lead">
            PrintTrays exposes a JSON-over-WebSocket protocol on <code>wss://127.0.0.1:8181</code> (with automatic
            fallback ports), plus a thin client SDK that wraps it.
          </p>
          <nav aria-label="On this page" style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", fontSize: 14 }}>
            <a href="#getting-started">Getting started</a>
            <a href="#client-sdk">Client SDK</a>
            <a href="#wire-protocol">Wire protocol</a>
            <a href="#trust-signing">Trust &amp; signing</a>
            <a href="#roadmap">Roadmap</a>
          </nav>
        </section>

        <section id="getting-started">
          <h2>Getting started</h2>
          <p className="lead">Four steps, start to finish.</p>
          <ol style={{ color: "var(--text-dim)", fontSize: 14, lineHeight: 1.9 }}>
            <li>
              <strong>Install PrintTrays</strong> on the machine that has the printer — see{" "}
              <a href="/download">Download</a>. It runs quietly in the system tray from then on, starting
              automatically at login.
            </li>
            <li>
              <strong>Include the client SDK</strong> in your page, as a native ES module (no build step, no
              bundler required):
              <pre style={{ marginTop: 8 }}><code>{`<script type="module">
  import { PrintTrays } from "https://your-host.example.com/printtrays.js";
</script>`}</code></pre>
            </li>
            <li>
              <strong>Connect</strong> — this is also the point where, the very first time on a given browser
              profile, the user may need to click through a one-time certificate trust step (PrintTrays opens this
              as a small self-closing popup rather than sending the user to a separate tab):
              <pre style={{ marginTop: 8 }}><code>{`const pp = new PrintTrays();
await pp.connect();
console.log("Connected to bridge v" + pp.version);`}</code></pre>
            </li>
            <li>
              <strong>Print</strong>:
              <pre style={{ marginTop: 8 }}><code>{`const printers = await pp.getPrinters();
await pp.print(printers[0].name, "<h1>Hello</h1>", { type: "html" });`}</code></pre>
            </li>
          </ol>
        </section>

        <section id="client-sdk">
          <h2>Client SDK</h2>
          <pre>
            <code>{`import { PrintTrays } from "./printtrays.js";

const pp = new PrintTrays({
  host: "127.0.0.1",             // default
  port: undefined,                // default: tries 8181, then 18181, then 28181
  connectTimeoutMs: 2500,
  downloadUrl: "https://your-site.example.com/download",
});

await pp.connect();`}</code>
          </pre>

          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>connect()</code></td>
                <td>Opens the WSS connection (trying each fallback port in turn), pins the bridge's signing key on first use, and sets <code>pp.version</code> to the connected bridge's version string. Throws <code>PrintTraysNotInstalledError</code> if unreachable.</td>
              </tr>
              <tr>
                <td><code>getPrinters()</code></td>
                <td>Resolves to <code>{`{ name, isDefault, status, driver }[]`}</code> for every OS-installed printer.</td>
              </tr>
              <tr>
                <td><code>print(printer, data, options)</code></td>
                <td><code>options.type</code> is one of <code>pdf | html | raw | zpl | escpos</code>. See below.</td>
              </tr>
              <tr>
                <td><code>sendRaw(port, bytes, options?)</code></td>
                <td>
                  Raw serial/HID/USB/TCP write (and optionally read). <code>port</code> is <code>"COM3"</code>, <code>"tcp:host:port"</code>,{" "}
                  <code>"hid:&lt;path&gt;"</code>, or <code>"usb:&lt;vid&gt;:&lt;pid&gt;:&lt;endpoint&gt;"</code>. <code>options.readTimeoutMs</code> reads a
                  response back (base64, in the result); leave <code>bytes</code> empty for a read-only request. Serial-only options: <code>baudRate</code>,{" "}
                  <code>dataBits</code>, <code>stopBits</code>, <code>parity</code>, <code>rtscts</code>, <code>xon</code>, <code>xoff</code>.
                </td>
              </tr>
              <tr>
                <td><code>usbControlTransfer(params)</code></td>
                <td>Low-level USB control transfer for device configuration/status exchanges outside normal data endpoints. <code>params.data</code> (base64) for an OUT transfer, or <code>params.readLength</code> for an IN transfer.</td>
              </tr>
              <tr>
                <td><code>listDevices(type)</code></td>
                <td><code>type</code> is <code>usb | serial | hid</code>.</td>
              </tr>
              <tr>
                <td><code>disconnect()</code></td>
                <td>Closes the socket.</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section id="wire-protocol">
          <h2>Wire protocol</h2>
          <p className="lead">Every request is a single JSON object with an <code>id</code> and <code>action</code>; every response mirrors that <code>id</code>.</p>

          <h3 style={{ fontSize: 16 }}>listPrinters</h3>
          <pre><code>{`// →
{ "id": "abc", "action": "listPrinters" }

// ←
{ "id": "abc", "action": "listPrinters", "ok": true,
  "result": [{ "name": "EPSON TM-T88", "isDefault": true }],
  "timestamp": 1234567890, "signature": "...", "keyFingerprint": "..." }`}</code></pre>

          <h3 style={{ fontSize: 16 }}>print</h3>
          <pre><code>{`{
  "id": "abc",
  "action": "print",
  "printer": "EPSON TM-T88",
  "type": "escpos",           // pdf | html | raw | zpl | escpos
  "data": "...",               // utf8 text, or base64 if binary
  "encoding": "base64",        // optional, defaults to utf8
  "copies": 1,                 // optional
  "connection": "tcp:192.168.1.50:9100",  // optional: bypass OS spooler

  // The following only apply to type "pdf"/"html":
  "duplex": "longEdge",        // optional: simplex | shortEdge | longEdge
  "landscape": true,           // optional
  "paperSize": "A4",           // optional: A3 | A4 | A5 | Legal | Letter | Tabloid
  "color": false,              // optional: defaults to true
  "scaleFactor": 100,          // optional: percentage
  "margins": { "marginType": "none" }  // optional
}`}</code></pre>

          <h3 style={{ fontSize: 16 }}>rawWrite</h3>
          <pre><code>{`{
  "id": "abc",
  "action": "rawWrite",
  "port": "COM3",              // or "/dev/ttyUSB0", "tcp:host:port",
                                // "hid:<path>", or "usb:<vidHex>:<pidHex>:<endpoint>"
  "bytes": "...",               // leave "" for a read-only request
  "encoding": "utf8",          // utf8 | base64 | hex
  "readTimeoutMs": 500,        // optional: read a response back (base64)
  "readLength": 64,            // optional, usb: ports only

  // Serial ports only, beyond baudRate:
  "baudRate": 9600,
  "dataBits": 8,                // 5 | 6 | 7 | 8
  "stopBits": 1,                 // 1 | 1.5 | 2
  "parity": "none",             // none | even | mark | odd | space
  "rtscts": false,
  "xon": false,
  "xoff": false
}`}</code></pre>

          <h3 style={{ fontSize: 16 }}>usbControlTransfer</h3>
          <pre><code>{`{
  "id": "abc",
  "action": "usbControlTransfer",
  "vendorId": 1155,
  "productId": 22352,
  "bmRequestType": 33,
  "bRequest": 9,
  "wValue": 512,
  "wIndex": 0,
  "data": "..."                 // base64, for an OUT transfer
  // or: "readLength": 8        // for an IN transfer instead
}`}</code></pre>

          <h3 style={{ fontSize: 16 }}>listDevices</h3>
          <pre><code>{`{ "id": "abc", "action": "listDevices", "type": "serial" }  // usb | serial | hid`}</code></pre>
        </section>

        <section id="trust-signing">
          <h2>Trust &amp; signing</h2>
          <p className="lead">How PrintTrays avoids QZ Tray-style repeated certificate prompts.</p>
          <ul>
            <li>On first run, PrintTrays generates a local CA + TLS leaf certificate (see <code>server/src/certManager.ts</code>). The installer imports the CA into the OS trust store, so the WSS handshake itself is trusted by the browser.</li>
            <li>Independently, every response is signed with a separate RSA keypair (<code>server/src/signing.ts</code>). The client SDK verifies that signature with WebCrypto and pins the key's fingerprint in <code>localStorage</code> after the first connection — this is what lets a page assert "this really is my local PrintTrays install," not just "some TLS server on port 8181."</li>
            <li>If PrintTrays is reinstalled, its signing key changes — the SDK detects this and asks once via a confirmation prompt rather than silently trusting a different identity or dead-ending with no way to recover.</li>
          </ul>
        </section>

        <section id="roadmap">
          <h2>Roadmap</h2>
          <p className="lead">
            PrintTrays now covers essentially the full QZ Tray feature set — silent printing with full page-setup
            options, raw ESC/POS/ZPL, and USB/HID/serial device I/O including control transfers and configurable
            serial parameters. On the platform side:
          </p>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Windows</td>
                <td>Built and tested end-to-end across multiple real machines</td>
              </tr>
              <tr>
                <td>Linux (.deb / .AppImage)</td>
                <td>Built and functionally verified in a real Linux container: launches, generates its certificate, binds the bridge, and a real WebSocket client completed a full signed round-trip. Only the desktop tray icon and the .deb installer's certificate-import script remain unverified on real hardware</td>
              </tr>
              <tr>
                <td>macOS</td>
                <td>Confirmed hard-blocked (not assumed): .pkg fails on a missing Apple-only binary (productbuild), and .dmg's dependency explicitly restricts itself to macOS at the npm level. Needs real Mac hardware or cloud Mac CI to proceed</td>
              </tr>
            </tbody>
          </table>
          <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 10 }}>
            See <code>QZ-TRAY-FEATURE-PARITY.md</code> in the project source for the full, item-by-item comparison.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
