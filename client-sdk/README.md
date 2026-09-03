# @printtrays/client-sdk

Browser SDK for the PrintTrays local bridge app. Ships as a native ES module, so it drops straight into a `<script type="module">` tag — no bundler required.

## Usage

```html
<script type="module">
  import { PrintTrays, PrintTraysNotInstalledError } from "https://your-cdn.example.com/printtrays.js";

  const pp = new PrintTrays({ downloadUrl: "https://printtrays.example.com/download" });

  try {
    await pp.connect(); // throws PrintTraysNotInstalledError and shows a built-in prompt if not running
    const printers = await pp.getPrinters();
    await pp.print(printers[0].name, "<h1>Hello</h1>", { type: "html" });
  } catch (err) {
    if (err instanceof PrintTraysNotInstalledError) {
      console.warn("User needs to install PrintTrays");
    }
  }
</script>
```

## Build

```
npm run build
```

Compiles `src/printtrays.ts` to `dist/printtrays.js` (+ `.d.ts`) as an ES module targeting modern browsers (uses native `WebSocket`, `crypto.subtle`, and `crypto.randomUUID`).

## Trust model

On first `connect()`, the SDK fetches the bridge's signing public key and pins its fingerprint in `localStorage`. Every subsequent response is verified against that pinned key with `crypto.subtle.verify` (RSASSA-PKCS1-v1_5 / SHA-256). If the bridge's key ever changes without the user clearing site data, `connect()` throws `PrintTraysUntrustedError` instead of silently trusting a different signer — this is what stops another local process from impersonating an already-trusted PrintTrays install.

This is independent from the TLS certificate itself: the browser will still show a certificate warning on `wss://127.0.0.1:8181` unless the PrintTrays installer's local CA has been added to the OS trust store (see `/installers`).
