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
            PrintPort exposes a JSON-over-WebSocket protocol on <code>wss://127.0.0.1:8181</code>, plus a thin
            client SDK that wraps it.
          </p>
        </section>

        <section>
          <h2>Client SDK</h2>
          <pre>
            <code>{`import { PrintPort } from "./printport.js";

const pp = new PrintPort({
  host: "127.0.0.1",   // default
  port: 8181,           // default
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
                <td>Opens the WSS connection, pins the bridge's signing key on first use. Throws <code>PrintPortNotInstalledError</code> if unreachable.</td>
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
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}
