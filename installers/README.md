# PrintTrays installers

Packaging is driven by `electron-builder`, configured in [`server/package.json`](../server/package.json) (`"build"` field). Output lands in `installers/out/`.

```
npm run server:dist:win     # -> installers/out/PrintTrays Setup <version>.exe   (NSIS)
npm run server:dist:mac     # -> installers/out/PrintTrays-<version>.pkg / .dmg
npm run server:dist:linux   # -> installers/out/PrintTrays-<version>.AppImage / .deb
```

Each platform's installer does two extra things beyond dropping the app in place:

1. **Registers auto-start** — handled in-app via `app.setLoginItemSettings({ openAtLogin: true })` in [`server/src/main.ts`](../server/src/main.ts), so no separate OS-level autostart entry is strictly required. `linux/postinst.sh` additionally installs a `.desktop` autostart entry for desktop environments that don't honor Electron's login-item API (most non-GNOME/KDE setups).
2. **Trusts the local certificate** — see the per-OS scripts below. PrintTrays generates a self-signed local CA the first time it runs ([`server/src/certManager.ts`](../server/src/certManager.ts)). Importing that CA into the OS trust store is what lets browsers connect to `wss://127.0.0.1:8181` without a manual "unsafe certificate" click-through — this is the equivalent of QZ Tray's certificate step, implemented independently here.

## What you still need to provide (this scaffold does not, and cannot, generate these)

- **Code-signing certificates.** A real Windows Authenticode cert (EV or OV) and an Apple Developer ID Installer/Application certificate are required to ship installers that don't trip SmartScreen / Gatekeeper. These are purchased from a CA / Apple and configured via `electron-builder`'s `CSC_LINK` / `CSC_KEY_PASSWORD` env vars (Windows) and `-c.mac.identity` + notarization credentials (macOS). Nothing about the app's design depends on which cert you use.
- **Apple notarization** — run `xcrun notarytool submit` (or electron-builder's `afterSign` hook) against the built `.pkg`/`.dmg` using your own Apple ID + app-specific password/API key.
- **Real icon artwork** — see [`server/assets/README.md`](../server/assets/README.md).
- **A real download host** for `website/`'s download links.

## Directory contents

- `windows/installer.nsh` — NSIS include invoked by electron-builder; imports the local CA into the current user's Trusted Root store post-install.
- `macos/entitlements.mac.plist` — hardened runtime entitlements for network + USB/serial device access.
- `macos/pkg-scripts/postinstall` — pkgbuild postinstall script; imports the CA into the login keychain as trusted.
- `linux/postinst.sh` — Debian postinst; imports the CA via `update-ca-certificates` and installs an XDG autostart entry.
