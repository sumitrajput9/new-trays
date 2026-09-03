# PrintPort vs. QZ Tray — feature parity specification

This is the accurate, complete comparison: everything QZ Tray offers, what PrintPort has today, and what's left to reach full parity. Use this to prioritize what gets built next.

Status key: ✅ Done · ⚠️ Partial · ❌ Not started

## 1. Standard (OS) printing

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| List installed printers | ✅ | ✅ | `getPrinters()` |
| Print PDF | ✅ | ✅ | via OS spooler, silent |
| Print HTML | ✅ | ✅ | via OS spooler, silent |
| Print raster image / canvas ("pixel" printing) | ✅ | ❌ | Not implemented — QZ Tray can print a canvas/image object directly |
| Silent printing (no OS dialog) | ✅ | ✅ | Core requirement, already working |
| Copies | ✅ | ✅ | `options.copies` |
| Duplex (double-sided) | ✅ | ❌ | Electron's `webContents.print()` supports `duplexMode` — just needs wiring into `PrintOptions` |
| Orientation (portrait/landscape) | ✅ | ❌ | Electron supports `landscape: boolean` — needs wiring |
| Paper size | ✅ | ❌ | Electron supports `pageSize` — needs wiring |
| Margins | ✅ | ❌ | Electron supports `margins` — needs wiring |
| Color / grayscale | ✅ | ❌ | Electron supports `color: boolean` — needs wiring |
| Scale / density (DPI) | ✅ | ❌ | Not yet exposed |
| Print job status callback (queued/printing/done) | ✅ | ❌ | PrintPort currently only reports success/failure of the *send*, not the actual print job's OS-level lifecycle |

**Verdict:** core silent printing is solid; the print *options* surface needs to grow. This is the highest-value, lowest-effort gap to close — it's config plumbing, not new architecture.

## 2. Raw / thermal & label printing (ESC/POS, ZPL)

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| Raw byte send via OS spooler | ✅ | ✅ | |
| Raw byte send direct to network printer (TCP/9100) | ✅ | ✅ | |
| Raw byte send direct to serial-attached printer | ✅ | ✅ | |
| Raw byte send direct to USB-attached printer (bulk endpoint) | ✅ | ❌ | PrintPort's USB support is enumeration-only today (see §4) |

## 3. Serial port I/O (scales, scanners)

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| List serial ports | ✅ | ✅ | |
| Open/write/close | ✅ | ✅ | |
| Configurable baud rate | ✅ | ✅ | |
| Configurable data bits / stop bits / parity / flow control | ✅ | ❌ | PrintPort only exposes baud rate today |
| Persistent open connection with streamed data events | ✅ | ❌ | PrintPort's `rawWrite` is request/response only (write, wait briefly, capture reply) — no long-lived subscription for a device that streams continuously (e.g. a scale broadcasting weight) |

## 4. USB & HID

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| List USB devices | ✅ | ✅ | |
| List HID devices | ✅ | ✅ | |
| Claim/release USB interface | ✅ | ❌ | |
| Raw USB read / write / control transfer | ✅ | ❌ | Enumeration exists (`usb` package already a dependency); read/write is unimplemented |
| HID write | ✅ | ✅ | |
| HID read | ✅ | ❌ | Write-only today |

**Verdict:** this is the single biggest real gap. USB/HID device *control*, not just listing, is what QZ Tray is often used for (signature pads, card readers, kiosks).

## 5. File system access

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| Read/write local files from a web page (with permission) | ✅ | ❌ | Not built at all — no `file.*` actions exist in PrintPort's protocol |

**Verdict:** not requested in the original spec; lowest priority unless a specific use case needs it.

## 6. Networking / device info

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| Get local network device info (hostname, IP, MAC) | ✅ | ❌ | QZ Tray exposes this partly for licensing/fingerprinting; for PrintPort it'd only matter if a future feature needs machine identification |

## 7. Security & trust

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| Certificate-based trust so a page can verify the bridge | ✅ | ✅ | PrintPort's design (RSA-signed responses + client-side pinning) is arguably more transparent since it's our own code, fully documented in `client-sdk/README.md` |
| Self-signed cert + OS trust store import on install | ✅ | ✅ | Hardened today with retry + verification (see git log) |
| Paid commercial certificate option (removes trust prompt) | ✅ (QZ sells this) | ❌ | See "real CA-signed cert" plan already discussed — bigger infra investment, not started |

## 8. Platform / distribution

| Feature | QZ Tray | PrintPort | Notes |
|---|---|---|---|
| Windows installer | ✅ | ✅ | Built, tested across multiple machines today |
| macOS installer | ✅ | ⚠️ | Config exists (`server/package.json` build.mac/pkg), never actually built or tested |
| Linux installer (.deb/.AppImage) | ✅ | ⚠️ | Config exists, never actually built or tested |
| Auto-start on login | ✅ | ✅ | |
| Tray icon with status | ✅ | ✅ | Shows active connections + bound port |
| Code-signed installers (no SmartScreen/Gatekeeper warning) | ✅ | ❌ | Needs a purchased Windows Authenticode cert + Apple Developer ID — can't be generated, only purchased/enrolled |

## Priority recommendation for what to build next

1. **Print options plumbing** (duplex, orientation, paper size, margins, color) — small effort, directly visible value, no new dependencies
2. **USB/HID raw read/write** — the biggest functional gap; needed for anything beyond basic printers (card readers, pole displays, signature pads)
3. **Serial port config (data bits/parity/flow control)** — small effort, needed for less-common scale/scanner protocols
4. **macOS/Linux installer builds** — needed before any non-Windows teammate/customer can use PrintPort at all
5. Everything else (file I/O, network device info, persistent serial streaming, real CA certificate) — lower priority unless a specific use case demands it

Say which of these to start on and I'll scope and build it the same way as today's work: implement, verify, commit.
