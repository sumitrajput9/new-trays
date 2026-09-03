import { BrowserWindow } from "electron";
import { exec } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PrinterInfo, PrintRequest } from "./types";
import { logger } from "./logger";

function execAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/** Uses Electron's built-in printer enumeration (wraps the native OS print
 *  subsystem on Windows/macOS/Linux, so no platform-specific code needed). */
export async function listPrinters(): Promise<PrinterInfo[]> {
  const probe = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    const printers = await probe.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      isDefault: !!p.isDefault,
      status: String(p.status ?? ""),
      driver: (p as unknown as { driverName?: string }).driverName,
    }));
  } finally {
    probe.destroy();
  }
}

/** Maps PrintPort's wire-protocol print options onto Electron's native
 *  print() options — duplex/orientation/paper size/margins/color are all
 *  already supported by Chromium's print pipeline, just not previously
 *  exposed through PrintPort's own API. */
function buildElectronPrintOptions(req: PrintRequest, printer: string, copies: number): Electron.WebContentsPrintOptions {
  return {
    silent: true,
    deviceName: printer,
    copies,
    landscape: req.landscape,
    color: req.color,
    scaleFactor: req.scaleFactor,
    duplexMode: req.duplex,
    pageSize: req.paperSize,
    margins: req.margins,
  };
}

/** Renders HTML (or a PDF's built-in viewer) in a hidden window and sends it
 *  to a standard printer via the OS print spooler. */
async function printRendered(html: string, req: PrintRequest, printer: string, copies = 1): Promise<void> {
  const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(buildElectronPrintOptions(req, printer, copies), (ok, failureReason) => {
        if (ok) resolve();
        else reject(new Error(failureReason || "print failed"));
      });
    });
  } finally {
    win.destroy();
  }
}

async function printPdfBase64(base64: string, req: PrintRequest, printer: string, copies = 1): Promise<void> {
  const tmp = path.join(os.tmpdir(), `printport-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, Buffer.from(base64, "base64"));
  const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
  try {
    await win.loadURL(`file://${tmp.replace(/\\/g, "/")}`);
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(buildElectronPrintOptions(req, printer, copies), (ok, failureReason) => {
        if (ok) resolve();
        else reject(new Error(failureReason || "print failed"));
      });
    });
  } finally {
    win.destroy();
    fs.unlink(tmp, () => undefined);
  }
}

/** Sends raw bytes (ESC/POS or ZPL) straight through the OS spooler to a
 *  printer configured with a raw/passthrough (e.g. "Generic / Text Only")
 *  driver. This bypasses page rendering entirely. */
async function printRawToSpooler(bytes: Buffer, printer: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `printport-raw-${Date.now()}.bin`);
  fs.writeFileSync(tmp, bytes);
  try {
    if (process.platform === "win32") {
      // Requires the target printer to be shared/reachable as \\localhost\<name>,
      // or installed with a RAW-capable driver. This is the standard
      // workaround for raw printing on Windows without the WinSpool native API.
      await execAsync(`copy /b "${tmp}" "\\\\localhost\\${printer}"`);
    } else {
      await execAsync(`lp -d "${printer}" -o raw "${tmp}"`);
    }
  } finally {
    fs.unlink(tmp, () => undefined);
  }
}

export async function handlePrint(req: PrintRequest): Promise<void> {
  const copies = req.copies ?? 1;
  logger.info(`print -> printer="${req.printer}" type=${req.type} copies=${copies}`);

  switch (req.type) {
    case "html":
      return printRendered(req.data, req, req.printer, copies);
    case "pdf":
      return printPdfBase64(req.data, req, req.printer, copies);
    case "raw":
    case "zpl":
    case "escpos": {
      const bytes =
        req.encoding === "base64" ? Buffer.from(req.data, "base64") : Buffer.from(req.data, "utf8");
      return printRawToSpooler(bytes, req.printer);
    }
    default:
      throw new Error(`Unsupported print type: ${(req as PrintRequest).type}`);
  }
}
