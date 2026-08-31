# Icons needed here

Drop real artwork in before building installers:

- `icon.ico` — Windows tray + installer icon (multi-size: 16/32/48/256)
- `icon.icns` — macOS app icon
- `icon.png` — Linux app icon (512x512 recommended)
- `iconTemplate.png` + `iconTemplate@2x.png` — macOS tray icon (template image, black/transparent, 16x16 and 32x32)

None are included in this scaffold — generate them from your brand mark (e.g. via `electron-icon-builder` from a single 1024x1024 PNG) before running `npm run dist:*`.
