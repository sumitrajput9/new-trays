import https from "https";
import type { IncomingMessage as HttpRequest, ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { app, dialog } from "electron";
import { CertBundle } from "./certManager";
import { signEnvelope } from "./signing";
import { logger } from "./logger";
import { listPrinters, getPrinterDetails, handlePrint } from "./printerService";
import { listSerialDevices, serialRawWrite } from "./serialService";
import {
  listUsbDevices,
  listHidDevices,
  hidRawWrite,
  hidRawRead,
  usbRawWrite,
  usbRawRead,
  usbControlTransfer,
} from "./usbHidService";
import { sendRawBytes, decodePayload } from "./rawPrint";
import {
  IncomingMessage,
  OutgoingMessageEnvelope,
  PrinterInfo,
  DeviceInfo,
} from "./types";

// 8181 collides surprisingly often — it's QZ Tray's own default, and a
// handful of unrelated dev tools (Java embedded servers, etc.) default to it
// too, as we found the hard way across several machines. QZ Tray itself
// also occupies 8282 as its own secondary port, which rules that out as a
// fallback choice too — so these fallbacks are deliberately distinctive
// numbers instead of just incrementing by 100. The client SDK's candidate
// list (client-sdk/src/printtrays.ts) must stay in sync with this one so a
// page can find whichever port we landed on.
export const PORT_CANDIDATES = process.env.PRINTTRAYS_PORT
  ? [Number(process.env.PRINTTRAYS_PORT)]
  : [8181, 18181, 28181];

export interface BridgeStatus {
  activeConnections: number;
  boundPort: number | undefined;
}

type StatusListener = (status: BridgeStatus) => void;

export class PrintTraysServer {
  private wss: WebSocketServer;
  private httpsServer: https.Server;
  private statusListeners = new Set<StatusListener>();
  private connections = new Set<WebSocket>();
  private boundPort: number | undefined;
  private candidateIndex = 0;

  constructor(private bundle: CertBundle) {
    this.httpsServer = https.createServer({
      key: bundle.tlsKeyPem,
      cert: bundle.tlsCertPem,
    });

    this.wss = new WebSocketServer({ server: this.httpsServer });
    this.wss.on("connection", (ws) => this.onConnection(ws));

    // A plain page visit (the tray's "Open Dashboard", or a user manually
    // trusting the certificate before their browser will allow the WSS
    // connection) has nowhere to go otherwise — 'ws' only handles the
    // WebSocket upgrade, so without this the TLS handshake completes but
    // the HTTP layer never answers, and the request just hangs/times out.
    this.httpsServer.on("request", (req, res) => this.handleHttpRequest(req, res));

    // A single persistent listener for the server's entire lifetime, rather
    // than tryListen() attaching/detaching its own `.once()` handler per
    // attempt. Node's EventEmitter throws an 'error' event as an uncaught
    // exception the moment it has zero listeners attached — and https.Server
    // (wrapping tls.Server wrapping net.Server) can surface the same bind
    // failure as more than one 'error' emission. A `.once()` handler removes
    // itself after the first, leaving a window where a second emission for
    // that same failure has nothing catching it and crashes the process.
    // This handler never detaches, so that window never opens.
    this.httpsServer.on("error", (err: NodeJS.ErrnoException) => this.onListenError(err));

    this.tryListen(0);
  }

  private onListenError(err: NodeJS.ErrnoException): void {
    if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
      logger.error(`Bridge server error: ${err.message}`);
      return;
    }
    logger.error(`Port ${PORT_CANDIDATES[this.candidateIndex]} unavailable (${err.code}) — trying the next candidate port...`);
    this.tryListen(this.candidateIndex + 1);
  }

  private tryListen(candidateIndex: number): void {
    this.candidateIndex = candidateIndex;
    const port = PORT_CANDIDATES[candidateIndex];

    if (port === undefined) {
      const message =
        `PrintTrays couldn't start: every port it tries (${PORT_CANDIDATES.join(", ")}) is already in use ` +
        `by another application on this computer. Close whichever app is using one of those ports, then ` +
        `restart PrintTrays.`;
      logger.error(message);
      dialog.showErrorBox("PrintTrays couldn't start", message);
      return;
    }

    this.httpsServer.listen(port, "127.0.0.1", () => {
      this.boundPort = port;
      logger.info(`PrintTrays bridge listening on wss://127.0.0.1:${port}`);
      this.notifyStatus();
    });
  }

  onStatusChange(listener: StatusListener): void {
    this.statusListeners.add(listener);
  }

  private notifyStatus(): void {
    const status: BridgeStatus = { activeConnections: this.connections.size, boundPort: this.boundPort };
    this.statusListeners.forEach((l) => l(status));
  }

  private handleHttpRequest(_req: HttpRequest, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>PrintTrays</title>
      <style>body{font:15px system-ui,sans-serif;background:#0b1220;color:#e7ecf5;padding:48px;text-align:center}
      p{color:#9aa7bd}</style></head><body>
      <h1>✅ PrintTrays bridge is running</h1>
      <p>${this.connections.size} browser connection(s) currently active.</p>
      <p>If you opened this page to trust PrintTrays's local certificate, this window will close itself —
      pages using the PrintTrays SDK will connect over <code>wss://127.0.0.1:${this.boundPort}</code> automatically.</p>
      <script>
        // Only auto-close if this was opened as a popup from another page's
        // "trust the certificate" button — never auto-close a tab someone
        // navigated to directly, that would be surprising.
        if (window.opener) setTimeout(() => window.close(), 1500);
      </script>
      </body></html>`
    );
  }

  private onConnection(ws: WebSocket): void {
    this.connections.add(ws);
    this.notifyStatus();
    logger.info(`Client connected (${this.connections.size} active)`);

    ws.on("message", (raw) => this.onMessage(ws, raw.toString()));

    ws.on("close", () => {
      this.connections.delete(ws);
      this.notifyStatus();
      logger.info(`Client disconnected (${this.connections.size} active)`);
    });

    ws.on("error", (err) => logger.error(`Socket error: ${err.message}`));
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { id: "unknown", action: "unknown" }, undefined, "Invalid JSON");
    }

    try {
      switch (msg.action) {
        case "listPrinters": {
          const printers: PrinterInfo[] = await listPrinters();
          return this.send(ws, msg, printers);
        }

        case "getPrinterDetails": {
          const details = await getPrinterDetails(msg.printer);
          return this.send(ws, msg, details);
        }

        case "print": {
          if (msg.connection && (msg.type === "raw" || msg.type === "zpl" || msg.type === "escpos")) {
            const bytes = decodePayload(msg.data, msg.encoding === "base64" ? "base64" : "utf8");
            await sendRawBytes(msg.connection, bytes);
          } else {
            await handlePrint(msg);
          }
          return this.send(ws, msg, { printed: true });
        }

        case "rawWrite": {
          const bytes = decodePayload(msg.bytes, msg.encoding ?? "utf8");
          let response: Buffer = Buffer.alloc(0);

          if (msg.port.startsWith("hid:")) {
            const devicePath = msg.port.slice(4);
            if (bytes.length > 0) await hidRawWrite(devicePath, bytes);
            if (msg.readTimeoutMs) response = await hidRawRead(devicePath, msg.readTimeoutMs);
          } else if (msg.port.startsWith("usb:")) {
            const [vendorIdHex, productIdHex, endpointStr] = msg.port.slice(4).split(":");
            const vendorId = parseInt(vendorIdHex, 16);
            const productId = parseInt(productIdHex, 16);
            const endpoint = Number(endpointStr);
            if (bytes.length > 0) await usbRawWrite(vendorId, productId, endpoint, bytes);
            if (msg.readTimeoutMs) {
              response = await usbRawRead(vendorId, productId, endpoint, msg.readLength ?? 64, msg.readTimeoutMs);
            }
          } else if (msg.port.startsWith("tcp:")) {
            await sendRawBytes(msg.port, bytes);
          } else {
            response = await serialRawWrite(msg.port, bytes, {
              baudRate: msg.baudRate,
              readTimeoutMs: msg.readTimeoutMs,
              dataBits: msg.dataBits,
              stopBits: msg.stopBits,
              parity: msg.parity,
              rtscts: msg.rtscts,
              xon: msg.xon,
              xoff: msg.xoff,
            });
          }

          return this.send(ws, msg, { bytesWritten: bytes.length, response: response.toString("base64") });
        }

        case "usbControlTransfer": {
          const dataOrLength =
            msg.data !== undefined ? decodePayload(msg.data, "base64") : msg.readLength ?? 0;
          const result = await usbControlTransfer(
            msg.vendorId,
            msg.productId,
            msg.bmRequestType,
            msg.bRequest,
            msg.wValue,
            msg.wIndex,
            dataOrLength
          );
          return this.send(ws, msg, { response: result.toString("base64") });
        }

        case "listDevices": {
          let devices: DeviceInfo[] = [];
          if (msg.type === "serial") devices = await listSerialDevices();
          else if (msg.type === "usb") devices = await listUsbDevices();
          else if (msg.type === "hid") devices = await listHidDevices();
          return this.send(ws, msg, devices);
        }

        case "getCertificate": {
          return this.send(ws, msg, {
            keyFingerprint: this.bundle.keyFingerprint,
            signingPublicKeyPem: this.bundle.signingPublicKeyPem,
            // Lets a page (or a support conversation) confirm exactly which
            // build a given machine is actually running, instead of
            // guessing from a downloaded file's name or timestamp — this
            // caused real confusion during testing (stale cached installers
            // looking identical to fresh ones).
            version: app.getVersion(),
          });
        }

        default:
          return this.send(ws, msg, undefined, `Unknown action: ${(msg as { action: string }).action}`);
      }
    } catch (err) {
      logger.error(`Error handling ${msg.action}: ${(err as Error).message}`);
      return this.send(ws, msg, undefined, (err as Error).message);
    }
  }

  private send<T>(
    ws: WebSocket,
    req: { id: string; action: string },
    result?: T,
    error?: string
  ): void {
    const envelope: Omit<OutgoingMessageEnvelope<T>, "signature" | "keyFingerprint"> = {
      id: req.id,
      action: req.action,
      ok: !error,
      result,
      error,
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(signEnvelope(this.bundle, envelope)));
  }

  close(): void {
    this.wss.clients.forEach((c) => c.close());
    this.wss.close();
    this.httpsServer.close();
  }
}
