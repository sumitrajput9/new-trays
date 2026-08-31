# PrintPort — team install & website integration guide

This is what to hand your teammates. PrintPort is our in-house replacement for QZ Tray: one small background app, installed once per machine, that lets any of our websites print silently (no Ctrl+P dialog, no "Save As" prompt) to that machine's printers.

## 1. Installing it on a machine (once per machine)

```powershell
cd server
npm install
npm run dist:win        # -> installers\out\PrintPort Setup 1.0.0.exe
```

Give that `.exe` to a teammate (network share, internal download page, however you already move internal tools around) and have them run it.

**About the "Windows protected your PC" warning:** the installer isn't code-signed (a real Authenticode certificate costs money and isn't needed for an internal tool) — Windows SmartScreen will show one warning on first run. Click **More info → Run anyway**. This is a one-time click per machine, same as most in-house tools. It's cosmetic, not a security problem with the app itself.

**What the installer does automatically** (see [`installers/windows/installer.nsh`](installers/windows/installer.nsh)):
- Runs PrintPort once to generate its local certificate
- Imports that certificate into the current Windows user's trusted store via `certutil`

That second step is the important one: **it's what makes step 2 below (website printing) work with zero certificate prompts** for that user, because their browser will already trust `wss://127.0.0.1:8181` the moment PrintPort is installed. Compare that to running it in raw dev mode (`npm run start` without the installer) — there, each browser profile has to manually visit `https://127.0.0.1:8181` once and click through a certificate warning, exactly like we hit while testing this ourselves.

After install, PrintPort auto-starts at login and sits quietly in the system tray. That's the whole install experience — same as QZ Tray was.

macOS/Linux teammates: same idea, different build command (`npm run dist:mac` / `npm run dist:linux`) — see [`installers/README.md`](installers/README.md) for what's still missing there (Apple notarization credentials) before those are as smooth as Windows.

## 2. Using it from a website — the generic pattern

Every site that wants to print just needs the client SDK and three calls:

```html
<script type="module">
  import { PrintPort } from "https://your-shared-host.example.com/printport.js";

  const pp = new PrintPort();
  await pp.connect();                     // fails fast if PrintPort isn't installed
  const printers = await pp.getPrinters();
  const target = printers.find(p => p.isDefault)?.name ?? printers[0].name;

  await pp.print(target, htmlOrPdfString, { type: "html" }); // no dialog, no popup
</script>
```

`type: "html"` and `type: "pdf"` both print silently — this is the direct equivalent of what QZ Tray did for us. `type: "raw" | "zpl" | "escpos"` is for receipt/label printers instead of standard ones.

**Where to host `printport.js`:** build it once (`npm run build --workspace client-sdk`, output at `client-sdk/dist/printport.js`) and put it somewhere every internal site can load it from — a shared static host, or just copy it into each site's own `public/` folder like the demo site does at [`website/public/printport.js`](website/public/printport.js). It's a plain ES module, no bundler required.

## 3. Wiring it into Qrinto specifically

Qrinto already generates print-ready PDFs server-side and stores them (`AssetUrl` on a `PrintJob`, produced by [`backend/src/lib/pdf/generate-print-pdf.ts`](../qrinto-next/backend/src/lib/pdf/generate-print-pdf.ts)). **Important distinction:** Qrinto already has a separate, existing system for this — the store-side polling agent in [`backend/src/routes/print-agent.routes.ts`](../qrinto-next/backend/src/routes/print-agent.routes.ts), which is a different, already-deployed client we are *not* touching here.

What you're asking for now is additive: a **manual print button** somewhere in the Qrinto admin/staff UI (e.g. the order detail page) that prints immediately from whoever's browser is open, via PrintPort — independent of that polling agent.

```ts
// e.g. in an admin order-detail component
import { PrintPort } from "@/lib/printport"; // your copy of client-sdk's build output

async function handlePrintNow(order: { assetUrl: string }) {
  const pp = new PrintPort();
  await pp.connect();

  const pdfBytes = await fetch(order.assetUrl).then(r => r.arrayBuffer());
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pdfBytes)));

  const printers = await pp.getPrinters();
  await pp.print(printers[0].name, base64, { type: "pdf", encoding: "base64" });
}
```

That's the entire integration — no backend changes needed on Qrinto's side, since it's just fetching the same `AssetUrl` PDF that already exists and handing it to PrintPort instead of a browser download.

**If you later want PrintPort to also replace the field polling agent** (unattended store printing without a browser open), that's a materially different piece of work — PrintPort would need a new background module that polls `GET /print-jobs/pending` and posts to `POST /agent/messages` using the frozen PascalCase contract in `print-agent.routes.ts`. Flag it separately if/when you want that scoped out; it's not part of this guide.

## 4. One-liner to explain it to teammates

> "PrintPort is our own local print bridge — like QZ Tray, but ours. Install it once (tray icon = it's running), and any of our internal websites can print straight to your printers with no popup, once the page includes our small JS SDK."
