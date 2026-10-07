import { app, dialog } from "electron";
import { loadOrCreateCertBundle } from "./certManager";
import { PrintTraysServer, BridgeStatus } from "./wsServer";
import { createTray } from "./tray";
import { logger } from "./logger";

// Without this, an unexpected error anywhere (a bad port state, a driver
// call throwing outside its own try/catch, anything) surfaces as Electron's
// raw "A JavaScript error occurred in the main process" crash dialog with a
// stack trace — alarming for an end user and not actionable. Log it and fail
// visibly-but-calmly instead of crashing hard.
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.stack || err.message}`);
  dialog.showErrorBox(
    "PrintTrays hit an unexpected error",
    `${err.message}\n\nPrintTrays will keep running, but if printing stops working, restart it from the system tray icon.`
  );
});

// PrintTrays has no windows/dock icon by default — it is a background bridge
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
  let server: PrintTraysServer | undefined;

  const startBridge = () => {
    const bundle = loadOrCreateCertBundle();
    server = new PrintTraysServer(bundle);

    const trayHandle = createTray(
      () => currentStatus,
      () => {
        // app.exit() skips the "before-quit" event entirely (that's
        // documented Electron behavior), so server?.close() there would
        // never run on a manual restart — the old process could still hold
        // its port when the relaunched instance starts up and tries to bind
        // it. Closing explicitly here, before relaunching, avoids that race.
        server?.close();
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

    logger.info("PrintTrays starting...");
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
