import https from "https";
import type { IncomingMessage as HttpRequest, ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { app, dialog } from "electron";
import { CertBundle } from "./certManager";
import { signEnvelope } from "./signing";
import { logger } from "./logger";
import { listPrinters, handlePrint } from "./printerService";
import { listSerialDevices, serialRawWrite } from "./serialService";
import { listUsbDevices, listHidDevices, hidRawWrite } from "./usbHidService";
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
// list (client-sdk/src/printport.ts) must stay in sync with this one so a
// page can find whichever port we landed on.
export const PORT_CANDIDATES = process.env.PRINTPORT_PORT
  ? [Number(process.env.PRINTPORT_PORT)]
  : [8181, 18181, 28181];

export interface BridgeStatus {
  activeConnections: number;
  boundPort: number | undefined;
}

type StatusListener = (status: BridgeStatus) => void;

export class PrintPortServer {
  private wss: WebSocketServer;
  private httpsServer: https.Server;
  private statusListeners = new Set<StatusListener>();
  private connections = new Set<WebSocket>();
  private boundPort: number | undefined;

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

    this.tryListen(0);
  }

  private tryListen(candidateIndex: number): void {
    const port = PORT_CANDIDATES[candidateIndex];

    if (port === undefined) {
      const message =
        `PrintPort couldn't start: every port it tries (${PORT_CANDIDATES.join(", ")}) is already in use ` +
        `by another application on this computer. Close whichever app is using one of those ports, then ` +
        `restart PrintPort.`;
      logger.error(message);
      dialog.showErrorBox("PrintPort couldn't start", message);
      return;
    }

    const onError = (err: NodeJS.ErrnoException) => {
      this.httpsServer.removeListener("error", onError);
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        logger.error(`Port ${port} unavailable (${err.code}) — trying the next candidate port...`);
        this.tryListen(candidateIndex + 1);
      } else {
        logger.error(`Bridge server error: ${err.message}`);
      }
    };

    this.httpsServer.once("error", onError);
    this.httpsServer.listen(port, "127.0.0.1", () => {
      this.httpsServer.removeListener("error", onError);
      this.boundPort = port;
      logger.info(`PrintPort bridge listening on wss://127.0.0.1:${port}`);
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
      `<!doctype html><html><head><meta charset="utf-8"><title>PrintPort</title>
      <style>body{font:15px system-ui,sans-serif;background:#0b1220;color:#e7ecf5;padding:48px;text-align:center}
      p{color:#9aa7bd}</style></head><body>
      <h1>✅ PrintPort bridge is running</h1>
      <p>${this.connections.size} browser connection(s) currently active.</p>
      <p>If you opened this page to trust PrintPort's local certificate, you can close this tab now —
      pages using the PrintPort SDK will connect over <code>wss://127.0.0.1:${this.boundPort}</code> automatically.</p>
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
          let response: Buffer;
          if (msg.port.startsWith("hid:")) {
            await hidRawWrite(msg.port.slice(4), bytes);
            response = Buffer.alloc(0);
          } else if (msg.port.startsWith("tcp:")) {
            await sendRawBytes(msg.port, bytes);
            response = Buffer.alloc(0);
          } else {
            response = await serialRawWrite(msg.port, bytes, msg.baudRate ?? 9600);
          }
          return this.send(ws, msg, { bytesWritten: bytes.length, response: response.toString("base64") });
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
