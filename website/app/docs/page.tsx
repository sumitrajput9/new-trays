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
            PrintPort exposes a JSON-over-WebSocket protocol on <code>wss://127.0.0.1:8181</code> (with automatic
            fallback ports), plus a thin client SDK that wraps it.
          </p>
        </section>

        <section>
          <h2>Getting started</h2>
          <p className="lead">Four steps, start to finish.</p>
          <ol style={{ color: "var(--text-dim)", fontSize: 14, lineHeight: 1.9 }}>
            <li>
              <strong>Install PrintPort</strong> on the machine that has the printer — see{" "}
              <a href="/download">Download</a>. It runs quietly in the system tray from then on, starting
              automatically at login.
            </li>
            <li>
              <strong>Include the client SDK</strong> in your page, as a native ES module (no build step, no
              bundler required):
              <pre style={{ marginTop: 8 }}><code>{`<script type="module">
  import { PrintPort } from "https://your-host.example.com/printport.js";
</script>`}</code></pre>
            </li>
            <li>
              <strong>Connect</strong> — this is also the point where, the very first time on a given browser
              profile, the user may need to click through a one-time certificate trust step (PrintPort opens this
              as a small self-closing popup rather than sending the user to a separate tab):
              <pre style={{ marginTop: 8 }}><code>{`const pp = new PrintPort();
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

        <section>
          <h2>Client SDK</h2>
          <pre>
            <code>{`import { PrintPort } from "./printport.js";

const pp = new PrintPort({
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
                <td>Opens the WSS connection (trying each fallback port in turn), pins the bridge's signing key on first use, and sets <code>pp.version</code> to the connected bridge's version string. Throws <code>PrintPortNotInstalledError</code> if unreachable.</td>
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
                <td><code>sendRaw(port, bytes, encoding?, baudRate?)</code></td>
                <td>Raw serial/HID/TCP write, e.g. for a connected scale or scanner.</td>
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

        <section>
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
  "connection": "tcp:192.168.1.50:9100"  // optional: bypass OS spooler
}`}</code></pre>

          <h3 style={{ fontSize: 16 }}>rawWrite</h3>
          <pre><code>{`{
  "id": "abc",
  "action": "rawWrite",
  "port": "COM3",              // or "/dev/ttyUSB0", "tcp:host:port", "hid:<path>"
  "bytes": "...",
  "encoding": "utf8",          // utf8 | base64 | hex
  "baudRate": 9600
}`}</code></pre>

          <h3 style={{ fontSize: 16 }}>listDevices</h3>
          <pre><code>{`{ "id": "abc", "action": "listDevices", "type": "serial" }  // usb | serial | hid`}</code></pre>
        </section>

        <section>
          <h2>Trust &amp; signing</h2>
          <p className="lead">How PrintPort avoids QZ Tray-style repeated certificate prompts.</p>
          <ul>
            <li>On first run, PrintPort generates a local CA + TLS leaf certificate (see <code>server/src/certManager.ts</code>). The installer imports the CA into the OS trust store, so the WSS handshake itself is trusted by the browser.</li>
            <li>Independently, every response is signed with a separate RSA keypair (<code>server/src/signing.ts</code>). The client SDK verifies that signature with WebCrypto and pins the key's fingerprint in <code>localStorage</code> after the first connection — this is what lets a page assert "this really is my local PrintPort install," not just "some TLS server on port 8181."</li>
            <li>If PrintPort is reinstalled, its signing key changes — the SDK detects this and asks once via a confirmation prompt rather than silently trusting a different identity or dead-ending with no way to recover.</li>
          </ul>
        </section>

        <section>
          <h2>Roadmap</h2>
          <p className="lead">
            PrintPort covers the core QZ Tray use case today — silent printing (PDF/HTML/ESC-POS/ZPL) over
            network, serial, and USB connections. A few gaps remain versus full QZ Tray parity:
          </p>
          <table>
            <thead>
              <tr>
                <th>Coming next</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Print options: duplex, orientation, paper size, margins, color</td>
                <td>Currently only <code>copies</code> is exposed — the underlying print API already supports the rest</td>
              </tr>
              <tr>
                <td>USB/HID raw read + control transfers</td>
                <td>Today's USB/HID support is enumeration and HID-write only — needed for signature pads, card readers, and similar devices</td>
              </tr>
              <tr>
                <td>Serial data bits / parity / flow control options</td>
                <td>Only baud rate is configurable today</td>
              </tr>
              <tr>
                <td>macOS and Linux installers</td>
                <td>Windows is built and tested; the other two are scaffolded but not yet produced</td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>
      <Footer />
    </>
  );
}
