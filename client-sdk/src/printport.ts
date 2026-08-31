/**
 * PrintPort client SDK — include via <script src="printport.js"></script>
 * or `import { PrintPort } from "@printport/client-sdk"`.
 *
 * Talks to the local PrintPort bridge app over wss://127.0.0.1:8181.
 * Every response from the bridge is RSA-signed; this SDK verifies that
 * signature and pins the bridge's public key on first connect (trust-on-
 * first-use), so a page can tell a genuine local PrintPort install apart
 * from some other process squatting on the port.
 */

export type PrintDataType = "pdf" | "html" | "raw" | "zpl" | "escpos";
export type DeviceKind = "usb" | "serial" | "hid";

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
  status?: string;
  driver?: string;
}

export interface DeviceInfo {
  kind: DeviceKind;
  path: string;
  vendorId?: number;
  productId?: number;
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
}

export interface PrintOptions {
  type: PrintDataType;
  encoding?: "utf8" | "base64";
  copies?: number;
  /** For raw/zpl/escpos: bypass the OS spooler and talk to the printer
   *  directly, e.g. "tcp:192.168.1.50:9100" or "serial:COM3". */
  connection?: string;
}

/**
 * 8181 collides surprisingly often — it's QZ Tray's own default, and a
 * handful of unrelated dev tools default to it too. PrintPort's server tries
 * these same ports in this same order (see server/src/wsServer.ts
 * PORT_CANDIDATES) and binds whichever is free first, so the SDK tries them
 * in the same order to find it — the same fallback approach QZ Tray itself
 * uses.
 */
const DEFAULT_PORT_CANDIDATES = [8181, 8282, 8283];

export interface PrintPortOptions {
  host?: string;
  /** Pin to one specific port instead of trying the default candidate list. */
  port?: number;
  /** ms to wait per candidate port before trying the next one. */
  connectTimeoutMs?: number;
  /** Called if the bridge can't be reached — show your own "please install" UI,
   *  or leave unset to let the SDK show a built-in prompt. */
  onNotInstalled?: (downloadUrl: string) => void;
  downloadUrl?: string;
}

interface Envelope<T = unknown> {
  id: string;
  action: string;
  ok: boolean;
  result?: T;
  error?: string;
  timestamp: number;
  signature: string;
  keyFingerprint: string;
}

const PINNED_KEY_STORAGE = "printport:pinnedPublicKey";
const PINNED_FINGERPRINT_STORAGE = "printport:pinnedFingerprint";

export class PrintPortUntrustedError extends Error {}
export class PrintPortNotInstalledError extends Error {}

export class PrintPort {
  private ws: WebSocket | undefined;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; skipVerify: boolean }
  >();
  private pinnedPublicKey: CryptoKey | undefined;
  private opts: Omit<Required<PrintPortOptions>, "port">;
  private portCandidates: number[];

  constructor(options: PrintPortOptions = {}) {
    this.opts = {
      host: options.host ?? "127.0.0.1",
      connectTimeoutMs: options.connectTimeoutMs ?? 2500,
      onNotInstalled: options.onNotInstalled ?? defaultNotInstalledPrompt,
      downloadUrl: options.downloadUrl ?? "https://printport.example.com/download",
    };
    // An explicit port pins to only that one; otherwise try the same
    // fallback list the server itself tries, in order.
    this.portCandidates = options.port ? [options.port] : DEFAULT_PORT_CANDIDATES;
  }

  async connect(): Promise<void> {
    let lastError: Error = new PrintPortNotInstalledError("PrintPort bridge not reachable");

    for (const port of this.portCandidates) {
      try {
        this.ws = await this.connectToPort(port);
        lastError = undefined as unknown as Error;
        break;
      } catch (err) {
        lastError = err as Error;
      }
    }

    if (!this.ws) {
      this.opts.onNotInstalled(this.opts.downloadUrl);
      throw lastError;
    }

    // Fetch + pin the signing key the first time we ever see this bridge.
    if (!this.pinnedPublicKey) {
      const cert = await this.request<{ keyFingerprint: string; signingPublicKeyPem: string }>(
        "getCertificate",
        {},
        /* skipVerify */ true
      );
      await this.trustKey(cert.keyFingerprint, cert.signingPublicKeyPem);
    }
  }

  private connectToPort(port: number): Promise<WebSocket> {
    const url = `wss://${this.opts.host}:${port}`;

    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to port ${port}`));
      }, this.opts.connectTimeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(socket);
      });

      socket.addEventListener("message", (ev) => this.onMessage(ev.data));

      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to PrintPort bridge on port ${port}`));
      });

      socket.addEventListener("close", () => {
        if (this.ws === socket) this.ws = undefined;
      });
    });
  }

  private async trustKey(fingerprint: string, publicKeyPem: string): Promise<void> {
    const stored = localStorage.getItem(PINNED_FINGERPRINT_STORAGE);
    if (stored && stored !== fingerprint) {
      throw new PrintPortUntrustedError(
        "PrintPort bridge identity changed since last visit. Refusing to trust it automatically — " +
          "if you just reinstalled PrintPort, clear this site's stored data and reload."
      );
    }
    this.pinnedPublicKey = await importSpkiPem(publicKeyPem);
    localStorage.setItem(PINNED_FINGERPRINT_STORAGE, fingerprint);
    localStorage.setItem(PINNED_KEY_STORAGE, publicKeyPem);
  }

  async getPrinters(): Promise<PrinterInfo[]> {
    return this.request<PrinterInfo[]>("listPrinters", {});
  }

  async listDevices(type: DeviceKind): Promise<DeviceInfo[]> {
    return this.request<DeviceInfo[]>("listDevices", { type });
  }

  async print(printer: string, data: string, options: PrintOptions): Promise<{ printed: boolean }> {
    return this.request("print", { printer, data, ...options });
  }

  async sendRaw(
    port: string,
    bytes: string,
    encoding: "utf8" | "base64" | "hex" = "utf8",
    baudRate?: number
  ): Promise<{ bytesWritten: number; response: string }> {
    return this.request("rawWrite", { port, bytes, encoding, baudRate });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = undefined;
  }

  private request<T>(action: string, payload: Record<string, unknown>, skipVerify = false): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected — call connect() first"));
    }
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        skipVerify,
      });
      this.ws!.send(JSON.stringify({ id, action, ...payload }));
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }

    const waiter = this.pending.get(envelope.id);
    if (!waiter) return;
    this.pending.delete(envelope.id);

    if (!waiter.skipVerify && this.pinnedPublicKey) {
      const valid = await verifyEnvelope(envelope, this.pinnedPublicKey);
      if (!valid) {
        return waiter.reject(
          new PrintPortUntrustedError("Response signature verification failed — message may be forged")
        );
      }
    }

    if (envelope.ok) waiter.resolve(envelope.result);
    else waiter.reject(new Error(envelope.error ?? "Unknown PrintPort error"));
  }
}

async function verifyEnvelope(envelope: Envelope, publicKey: CryptoKey): Promise<boolean> {
  const { signature, keyFingerprint, ...base } = envelope;
  void keyFingerprint;
  const canonical = new TextEncoder().encode(JSON.stringify(base));
  const sigBytes = base64ToBytes(signature);
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    sigBytes as BufferSource,
    canonical as BufferSource
  );
}

async function importSpkiPem(pem: string): Promise<CryptoKey> {
  const der = base64ToBytes(
    pem.replace(/-----BEGIN PUBLIC KEY-----/, "").replace(/-----END PUBLIC KEY-----/, "").replace(/\s+/g, "")
  );
  return crypto.subtle.importKey(
    "spki",
    der as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function defaultNotInstalledPrompt(downloadUrl: string): void {
  if (typeof document === "undefined") return;
  const banner = document.createElement("div");
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#111827;color:#fff;" +
    "padding:14px 18px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;max-width:320px;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.25)";
  banner.innerHTML =
    `<strong>PrintPort isn't running.</strong><br>Install the local print bridge to enable printing from this page.` +
    `<br><a href="${downloadUrl}" target="_blank" rel="noopener" style="color:#60a5fa">Download PrintPort</a>`;
  document.body.appendChild(banner);
}
