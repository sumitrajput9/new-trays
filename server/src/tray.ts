import { Tray, Menu, nativeImage, app, shell, dialog } from "electron";
import path from "path";
import { BridgeStatus } from "./wsServer";

function loadTrayIcon(): Electron.NativeImage {
  const iconName = process.platform === "win32" ? "icon.ico" : "iconTemplate.png";
  const iconPath = path.join(process.resourcesPath ?? path.join(__dirname, "..", "assets"), "assets", iconName);
  const img = nativeImage.createFromPath(iconPath);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

export interface TrayHandle {
  tray: Tray;
  refresh: () => void;
}

export function createTray(getStatus: () => BridgeStatus, onRestart: () => void): TrayHandle {
  const tray = new Tray(loadTrayIcon());
  tray.setToolTip("PrintPort — local print bridge");

  const rebuildMenu = () => {
    const status = getStatus();
    const menu = Menu.buildFromTemplate([
      {
        label: status.boundPort
          ? `● ${status.activeConnections} active connection${status.activeConnections === 1 ? "" : "s"} (port ${status.boundPort})`
          : "● Not running — see About for details",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Dashboard",
        enabled: !!status.boundPort,
        click: () => shell.openExternal(`https://127.0.0.1:${status.boundPort}`),
      },
      {
        label: "Restart",
        click: () => onRestart(),
      },
      {
        label: "About PrintPort",
        click: () =>
          dialog.showMessageBox({
            title: "About PrintPort",
            message: "PrintPort",
            detail: status.boundPort
              ? `Local print bridge\nVersion ${app.getVersion()}\nListening on wss://127.0.0.1:${status.boundPort}`
              : `Local print bridge\nVersion ${app.getVersion()}\nNot currently listening on any port — every candidate port was already in use. Close other apps using ports 8181/8282/8283 and restart PrintPort.`,
          }),
      },
      { type: "separator" },
      {
        label: "Quit PrintPort",
        click: () => app.quit(),
      },
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();
  return { tray, refresh: rebuildMenu };
}
