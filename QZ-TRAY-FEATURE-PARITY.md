# PrintTrays vs. QZ Tray — feature parity specification

This is the accurate, complete comparison: everything QZ Tray offers, what PrintTrays has today, and what's left to reach full parity. Use this to prioritize what gets built next.

Status key: ✅ Done · ⚠️ Partial · ❌ Not started

## 1. Standard (OS) printing

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| List installed printers | ✅ | ✅ | `getPrinters()` |
| Print PDF | ✅ | ✅ | via OS spooler, silent |
| Print HTML | ✅ | ✅ | via OS spooler, silent |
| Print raster image / canvas ("pixel" printing) | ✅ | ❌ | Not implemented — QZ Tray can print a canvas/image object directly |
| Silent printing (no OS dialog) | ✅ | ✅ | Core requirement, already working |
| Copies | ✅ | ✅ | `options.copies` |
| Duplex (double-sided) | ✅ | ✅ | `options.duplex: "simplex" \| "shortEdge" \| "longEdge"` |
| Orientation (portrait/landscape) | ✅ | ✅ | `options.landscape: boolean` |
| Paper size | ✅ | ✅ | `options.paperSize: "A3" \| "A4" \| "A5" \| "Legal" \| "Letter" \| "Tabloid"` |
| Margins | ✅ | ✅ | `options.margins: { marginType, top, bottom, left, right }` |
| Color / grayscale | ✅ | ✅ | `options.color: boolean` |
| Scale factor | ✅ | ✅ | `options.scaleFactor: number` (percentage) |
| Density (DPI) | ✅ | ❌ | Not yet exposed — Electron's `dpi` option isn't wired in |
| Print job status callback (queued/printing/done) | ✅ | ❌ | PrintTrays currently only reports success/failure of the *send*, not the actual print job's OS-level lifecycle |

**Verdict:** core silent printing is solid; the print *options* surface needs to grow. This is the highest-value, lowest-effort gap to close — it's config plumbing, not new architecture.

## 2. Raw / thermal & label printing (ESC/POS, ZPL)

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| Raw byte send via OS spooler | ✅ | ✅ | |
| Raw byte send direct to network printer (TCP/9100) | ✅ | ✅ | |
| Raw byte send direct to serial-attached printer | ✅ | ✅ | |
| Raw byte send direct to USB-attached printer (bulk endpoint) | ✅ | ❌ | PrintTrays's USB support is enumeration-only today (see §4) |

## 3. Serial port I/O (scales, scanners)

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| List serial ports | ✅ | ✅ | |
| Open/write/close | ✅ | ✅ | |
| Configurable baud rate | ✅ | ✅ | |
| Configurable data bits / stop bits / parity / flow control | ✅ | ✅ | `sendRaw(port, bytes, { dataBits, stopBits, parity, rtscts, xon, xoff })` |
| Persistent open connection with streamed data events | ✅ | ❌ | PrintTrays's `rawWrite` is request/response only (write, wait briefly, capture reply) — no long-lived subscription for a device that streams continuously (e.g. a scale broadcasting weight) |

## 4. USB & HID

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| List USB devices | ✅ | ✅ | |
| List HID devices | ✅ | ✅ | |
| Claim/release USB interface | ✅ | ✅ | Handled internally by `sendRaw("usb:vid:pid:endpoint", ...)` |
| Raw USB read / write / control transfer | ✅ | ✅ | `sendRaw("usb:vid:pid:endpoint", ...)` for bulk I/O; `usbControlTransfer()` for control transfers |
| HID write | ✅ | ✅ | |
| HID read | ✅ | ✅ | `sendRaw("hid:<path>", "", { readTimeoutMs })` |

**Verdict:** closed. Raw USB bulk I/O, control transfers, and HID read all now work via `sendRaw()` and `usbControlTransfer()` — verified against the actual `usb`/`node-hid` package APIs (`InEndpoint`/`OutEndpoint`/`HIDAsync`), not assumed.

## 5. File system access

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| Read/write local files from a web page (with permission) | ✅ | ❌ | Not built at all — no `file.*` actions exist in PrintTrays's protocol |

**Verdict:** not requested in the original spec; lowest priority unless a specific use case needs it.

## 6. Networking / device info

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| Get local network device info (hostname, IP, MAC) | ✅ | ❌ | QZ Tray exposes this partly for licensing/fingerprinting; for PrintTrays it'd only matter if a future feature needs machine identification |

## 7. Security & trust

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| Certificate-based trust so a page can verify the bridge | ✅ | ✅ | PrintTrays's design (RSA-signed responses + client-side pinning) is arguably more transparent since it's our own code, fully documented in `client-sdk/README.md` |
| Self-signed cert + OS trust store import on install | ✅ | ✅ | Hardened today with retry + verification (see git log) |
| Paid commercial certificate option (removes trust prompt) | ✅ (QZ sells this) | ❌ | See "real CA-signed cert" plan already discussed — bigger infra investment, not started |

## 8. Platform / distribution

| Feature | QZ Tray | PrintTrays | Notes |
|---|---|---|---|
| Windows installer | ✅ | ✅ | Built, tested end-to-end across multiple machines today |
| macOS installer | ✅ | ⚠️ | Confirmed hard-blocked, not just assumed: `.pkg` fails on `spawn productbuild ENOENT` (Apple's Installer-framework binary, Darwin-only); `.dmg` fails because `dmg-license` — a dependency electron-builder's DMG code unconditionally loads — declares `"os": ["darwin"]` in its own package.json, so npm refuses to even install it elsewhere (`EBADPLATFORM`). The raw unpacked `.app` bundle *does* build fine (no installer tooling needed for that), but unsigned/unnotarized/Intel-only isn't worth shipping — real macOS or Apple CI access is required for a proper installer |
| Linux installer (.deb/.AppImage) | ✅ | ✅ | Built via Docker and actually run (headless, in-container): app launches stably, generates its certificate at the correct `~/.config/PrintTrays` path, binds the WSS port, serves the HTTP confirmation page, and a real WebSocket client completed a full signed `listPrinters` round-trip. Not yet verified on a real desktop: the system tray icon (needs a real tray protocol like AppIndicator, not present in a headless container) and the `.deb` postinstall script's certificate import |
| Auto-start on login | ✅ | ✅ | |
| Tray icon with status | ✅ | ✅ | Shows active connections + bound port |
| Code-signed installers (no SmartScreen/Gatekeeper warning) | ✅ | ❌ | Needs a purchased Windows Authenticode cert + Apple Developer ID — can't be generated, only purchased/enrolled |

## Priority recommendation for what to build next

1. ~~**Print options plumbing** (duplex, orientation, paper size, margins, color)~~ — **done**
2. ~~**USB/HID raw read/write + control transfers**~~ — **done**
3. ~~**Serial port config (data bits/parity/flow control)**~~ — **done**
4. ~~**Linux installer build (.deb/.AppImage)**~~ — **built and functionally verified** via Docker: app launch, certificate generation, WSS binding, and a full signed WebSocket round-trip all confirmed working headlessly in-container. Only the system tray icon and the `.deb` postinstall script remain unverified on a real desktop
5. **macOS installer build** — confirmed genuine hard blocker (see above), not an assumption: both `.pkg` and `.dmg` fail on Apple-only tooling that has no Linux/Windows equivalent and can't be worked around the way Linux's `fpm` dependency was. Needs real Mac hardware or a cloud Mac CI runner (e.g. GitHub Actions macOS runners) to proceed — and a paid Apple Developer account for the code signing + notarization a real release would need anyway
6. Everything else (file I/O, network device info, persistent serial streaming, real CA certificate) — lower priority unless a specific use case demands it

Say which of these to start on and I'll scope and build it the same way as today's work: implement, verify, commit.
