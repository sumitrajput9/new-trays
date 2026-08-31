/**
 * PrintPort client SDK (plain-JS build for the demo site).
 * Source of truth: /client-sdk/src/printport.ts — keep in sync, or better,
 * point this path at the real compiled output of that package in production.
 */

const PINNED_FINGERPRINT_STORAGE = "printport:pinnedFingerprint";

export class PrintPortUntrustedError extends Error {}
export class PrintPortNotInstalledError extends Error {}

export class PrintPort {
  constructor(options = {}) {
    this.ws = undefined;
    this.pending = new Map();
    this.pinnedPublicKey = undefined;
    this.opts = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 8181,
      connectTimeoutMs: options.connectTimeoutMs ?? 2500,
      onNotInstalled: options.onNotInstalled ?? defaultNotInstalledPrompt,
      downloadUrl: options.downloadUrl ?? "/download",
    };
  }

  async connect() {
    const url = `wss://${this.opts.host}:${this.opts.port}`;

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        this.opts.onNotInstalled(this.opts.downloadUrl);
        reject(new PrintPortNotInstalledError("PrintPort bridge not reachable"));
      }, this.opts.connectTimeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.ws = socket;
        resolve();
      });
      socket.addEventListener("message", (ev) => this.onMessage(ev.data));
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Failed to connect to PrintPort bridge"));
      });
      socket.addEventListener("close", () => {
        this.ws = undefined;
      });
    });

    if (!this.pinnedPublicKey) {
      const cert = await this.request("getCertificate", {}, true);
      await this.trustKey(cert.keyFingerprint, cert.signingPublicKeyPem);
    }
  }

  async trustKey(fingerprint, publicKeyPem) {
    const stored = localStorage.getItem(PINNED_FINGERPRINT_STORAGE);
    if (stored && stored !== fingerprint) {
      throw new PrintPortUntrustedError(
        "PrintPort bridge identity changed since last visit. Clear this site's stored data if you just reinstalled PrintPort."
      );
    }
    this.pinnedPublicKey = await importSpkiPem(publicKeyPem);
    localStorage.setItem(PINNED_FINGERPRINT_STORAGE, fingerprint);
  }

  getPrinters() {
    return this.request("listPrinters", {});
  }

  listDevices(type) {
    return this.request("listDevices", { type });
  }

  print(printer, data, options) {
    return this.request("print", { printer, data, ...options });
  }

  sendRaw(port, bytes, encoding = "utf8", baudRate) {
    return this.request("rawWrite", { port, bytes, encoding, baudRate });
  }

  disconnect() {
    this.ws?.close();
    this.ws = undefined;
  }

  request(action, payload, skipVerify = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected — call connect() first"));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, skipVerify });
      this.ws.send(JSON.stringify({ id, action, ...payload }));
    });
  }

  async onMessage(raw) {
    let envelope;
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
        return waiter.reject(new PrintPortUntrustedError("Response signature verification failed"));
      }
    }

    if (envelope.ok) waiter.resolve(envelope.result);
    else waiter.reject(new Error(envelope.error ?? "Unknown PrintPort error"));
  }
}

async function verifyEnvelope(envelope, publicKey) {
  const { signature, keyFingerprint, ...base } = envelope;
  void keyFingerprint;
  const canonical = new TextEncoder().encode(JSON.stringify(base));
  const sigBytes = base64ToBytes(signature);
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, publicKey, sigBytes, canonical);
}

async function importSpkiPem(pem) {
  const der = base64ToBytes(pem.replace(/-----BEGIN PUBLIC KEY-----/, "").replace(/-----END PUBLIC KEY-----/, "").replace(/\s+/g, ""));
  return crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function defaultNotInstalledPrompt(downloadUrl) {
  if (typeof document === "undefined") return;
  const banner = document.createElement("div");
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#111827;color:#fff;padding:14px 18px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.25)";
  banner.innerHTML = `<strong>PrintPort isn't running.</strong><br>Install the local print bridge to enable printing from this page.<br><a href="${downloadUrl}" style="color:#60a5fa">Download PrintPort</a>`;
  document.body.appendChild(banner);
}
