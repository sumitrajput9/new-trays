/**
 * PrintPort client SDK (plain-JS build for the demo site).
 * Source of truth: /client-sdk/src/printport.ts — keep in sync, or better,
 * point this path at the real compiled output of that package in production.
 */

const PINNED_FINGERPRINT_STORAGE = "printport:pinnedFingerprint";
// 8181 collides surprisingly often (it's QZ Tray's own default), and QZ Tray
// also occupies 8282 as its own secondary port, which rules that out as a
// fallback too. The server tries this same list in this same order
// (server/src/wsServer.ts PORT_CANDIDATES) and binds whichever is free
// first, so we try them in the same order to find it.
const DEFAULT_PORT_CANDIDATES = [8181, 18181, 28181];

export class PrintPortUntrustedError extends Error {}
export class PrintPortNotInstalledError extends Error {}

export class PrintPort {
  constructor(options = {}) {
    this.ws = undefined;
    this.pending = new Map();
    this.pinnedPublicKey = undefined;
    this.opts = {
      host: options.host ?? "127.0.0.1",
      connectTimeoutMs: options.connectTimeoutMs ?? 2500,
      onNotInstalled: options.onNotInstalled ?? defaultNotInstalledPrompt,
      downloadUrl: options.downloadUrl ?? "/download",
    };
    this.portCandidates = options.port ? [options.port] : DEFAULT_PORT_CANDIDATES;
  }

  async connect() {
    let lastError = new PrintPortNotInstalledError("PrintPort bridge not reachable");

    for (const port of this.portCandidates) {
      try {
        this.ws = await this.connectToPort(port);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!this.ws) {
      this.opts.onNotInstalled(this.opts.downloadUrl);
      throw lastError;
    }

    // Always fetch the version, even on an already-pinned reconnect, so a
    // page can tell exactly which build is running rather than guessing
    // from a downloaded file's name (a real source of confusion in testing).
    const cert = await this.request("getCertificate", {}, true);
    this.version = cert.version;
    if (!this.pinnedPublicKey) {
      await this.trustKey(cert.keyFingerprint, cert.signingPublicKeyPem);
    }
  }

  connectToPort(port) {
    const url = `wss://${this.opts.host}:${port}`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to port ${port}`));
      }, this.opts.connectTimeoutMs);

      socket.addEventListener("open", () => { clearTimeout(timer); resolve(socket); });
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

  async trustKey(fingerprint, publicKeyPem) {
    const stored = localStorage.getItem(PINNED_FINGERPRINT_STORAGE);
    if (stored && stored !== fingerprint) {
      // A changed identity is the normal result of reinstalling PrintPort
      // (a fresh install generates a fresh signing key), not an attack —
      // ask once and re-pin on confirmation instead of dead-ending with
      // "go clear your browser storage manually."
      const accepted = this.opts.onIdentityChanged
        ? await this.opts.onIdentityChanged()
        : typeof confirm !== "undefined" &&
          confirm(
            "PrintPort's certificate has changed since your last visit to this site. " +
              "This is expected if PrintPort was reinstalled. Trust the new one and continue?"
          );
      if (!accepted) {
        throw new PrintPortUntrustedError("PrintPort bridge identity changed since last visit and the new one wasn't trusted.");
      }
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
