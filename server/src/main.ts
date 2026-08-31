import { app } from "electron";
import { loadOrCreateCertBundle } from "./certManager";
import { PrintPortServer, BridgeStatus } from "./wsServer";
import { createTray } from "./tray";
import { logger } from "./logger";

// PrintPort has no windows/dock icon by default — it is a background bridge
// that lives in the system tray, matching the "runs on startup, tray only"
// requirement.
app.setLoginItemSettings({
  openAtLogin: true,
  openAsHidden: true,
});

if (process.platform === "darwin") {
  app.dock?.hide();
}

// Only one instance of the bridge should ever run at a time. app.quit() only
// *requests* a quit — it doesn't stop this script from continuing to run —
// so the rest of startup must be skipped explicitly, not just assumed to
// stop here.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let currentStatus: BridgeStatus = { activeConnections: 0, boundPort: undefined };
  let server: PrintPortServer | undefined;

  const startBridge = () => {
    const bundle = loadOrCreateCertBundle();
    server = new PrintPortServer(bundle);

    const trayHandle = createTray(
      () => currentStatus,
      () => {
        app.relaunch();
        app.exit(0);
      }
    );

    server.onStatusChange((status) => {
      currentStatus = status;
      trayHandle.refresh();
    });
  };

  app.whenReady().then(() => {
    // Invoked once by the Windows/macOS installers (see installers/) purely
    // to materialize the self-signed cert on disk before it gets imported
    // into the OS trust store — no tray icon or server needed for that.
    if (process.argv.includes("--generate-cert-and-exit")) {
      loadOrCreateCertBundle();
      app.exit(0);
      return;
    }

    logger.info("PrintPort starting...");
    startBridge();
  });

  app.on("window-all-closed", () => {
    // Deliberately do nothing — this app has no visible windows, it should
    // just keep running in the tray. (Electron only auto-quits on this event
    // if you call app.quit() yourself; simply not doing so is enough here.)
  });

  app.on("before-quit", () => {
    server?.close();
  });
}
