/**
 * PrintTrays client SDK — include via <script src="printtrays.js"></script>
 * or `import { PrintTrays } from "@printtrays/client-sdk"`.
 *
 * Talks to the local PrintTrays bridge app over wss://127.0.0.1:8181.
 * Every response from the bridge is RSA-signed; this SDK verifies that
 * signature and pins the bridge's public key on first connect (trust-on-
 * first-use), so a page can tell a genuine local PrintTrays install apart
 * from some other process squatting on the port.
 */
/**
 * 8181 collides surprisingly often — it's QZ Tray's own default, and QZ Tray
 * also occupies 8282 as its own secondary port, which rules that out as a
 * fallback too. PrintTrays's server tries these same ports in this same
 * order (see server/src/wsServer.ts PORT_CANDIDATES) and binds whichever is
 * free first, so the SDK tries them in the same order to find it.
 */
const DEFAULT_PORT_CANDIDATES = [8181, 18181, 28181];
const PINNED_KEY_STORAGE = "printtrays:pinnedPublicKey";
const PINNED_FINGERPRINT_STORAGE = "printtrays:pinnedFingerprint";
export class PrintTraysUntrustedError extends Error {
}
export class PrintTraysNotInstalledError extends Error {
}
export class PrintTrays {
    constructor(options = {}) {
        var _a, _b, _c, _d, _e;
        this.pending = new Map();
        this.opts = {
            host: (_a = options.host) !== null && _a !== void 0 ? _a : "127.0.0.1",
            connectTimeoutMs: (_b = options.connectTimeoutMs) !== null && _b !== void 0 ? _b : 2500,
            onNotInstalled: (_c = options.onNotInstalled) !== null && _c !== void 0 ? _c : defaultNotInstalledPrompt,
            onIdentityChanged: (_d = options.onIdentityChanged) !== null && _d !== void 0 ? _d : defaultIdentityChangedPrompt,
            downloadUrl: (_e = options.downloadUrl) !== null && _e !== void 0 ? _e : "https://printtrays.example.com/download",
        };
        // An explicit port pins to only that one; otherwise try the same
        // fallback list the server itself tries, in order.
        this.portCandidates = options.port ? [options.port] : DEFAULT_PORT_CANDIDATES;
    }
    async connect() {
        let lastError = new PrintTraysNotInstalledError("PrintTrays bridge not reachable");
        for (const port of this.portCandidates) {
            try {
                this.ws = await this.connectToPort(port);
                lastError = undefined;
                break;
            }
            catch (err) {
                lastError = err;
            }
        }
        if (!this.ws) {
            this.opts.onNotInstalled(this.opts.downloadUrl);
            throw lastError;
        }
        // Fetch + pin the signing key the first time we ever see this bridge.
        // Always fetch the version, even on an already-pinned reconnect, so a
        // page (or a support conversation) can always tell exactly which build
        // is running rather than guessing from a downloaded file's name.
        const cert = await this.request("getCertificate", {}, 
        /* skipVerify */ true);
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
            socket.addEventListener("open", () => {
                clearTimeout(timer);
                resolve(socket);
            });
            socket.addEventListener("message", (ev) => this.onMessage(ev.data));
            socket.addEventListener("error", () => {
                clearTimeout(timer);
                reject(new Error(`Failed to connect to PrintTrays bridge on port ${port}`));
            });
            socket.addEventListener("close", () => {
                if (this.ws === socket)
                    this.ws = undefined;
            });
        });
    }
    async trustKey(fingerprint, publicKeyPem) {
        const stored = localStorage.getItem(PINNED_FINGERPRINT_STORAGE);
        if (stored && stored !== fingerprint) {
            // A changed identity is the normal, expected outcome of reinstalling
            // PrintTrays (a fresh install generates a fresh signing key) — the
            // overwhelmingly common case, not an attack. Rather than dead-ending
            // with instructions to go clear browser storage manually, ask once
            // and let the SDK re-pin itself on confirmation. A custom
            // onIdentityChanged callback can replace this native confirm() with
            // in-page UI; declining still refuses to trust it, same as before.
            const accepted = await this.opts.onIdentityChanged();
            if (!accepted) {
                throw new PrintTraysUntrustedError("PrintTrays bridge identity changed since last visit and the new one wasn't trusted.");
            }
        }
        this.pinnedPublicKey = await importSpkiPem(publicKeyPem);
        localStorage.setItem(PINNED_FINGERPRINT_STORAGE, fingerprint);
        localStorage.setItem(PINNED_KEY_STORAGE, publicKeyPem);
    }
    async getPrinters() {
        return this.request("listPrinters", {});
    }
    /** The printer's actual sizes, resolutions, media types, input bins, and
     *  orientations, read live from its Windows PrintCapabilities. All-empty
     *  on non-Windows or if the query fails — fall back to a static list in
     *  that case rather than treat it as an error. Note: only `sizes` and
     *  `inputBins` are currently applicable to a print job (as `paperSize`/
     *  `inputBin`); `resolutions` and `mediaTypes` are discoverable but not
     *  yet wired into printing. */
    async getPrinterDetails(printer) {
        return this.request("getPrinterDetails", { printer });
    }
    async listDevices(type) {
        return this.request("listDevices", { type });
    }
    async print(printer, data, options) {
        return this.request("print", { printer, data, ...options });
    }
    /**
     * Writes bytes to a serial/HID/USB/TCP target. `port` is one of:
     * "COM3" / "/dev/ttyUSB0" (serial), "tcp:host:port", "hid:<path>", or
     * "usb:<vendorIdHex>:<productIdHex>:<endpointAddress>".
     *
     * Pass `readTimeoutMs` to read a response back (e.g. a signature pad or
     * card reader replying, or a scale sending a weight) — `response` in the
     * result is base64. For hid:/serial ports, leave `bytes` empty ("") to
     * do a read-only request with no write first.
     */
    async sendRaw(port, bytes, options = {}) {
        return this.request("rawWrite", { port, bytes, ...options });
    }
    /**
     * Low-level USB control transfer — the mechanism many USB devices use
     * for configuration/status exchanges outside their normal data
     * endpoints. Pass `data` (base64) for an OUT transfer, or `readLength`
     * for an IN transfer.
     */
    async usbControlTransfer(params) {
        return this.request("usbControlTransfer", params);
    }
    disconnect() {
        var _a;
        (_a = this.ws) === null || _a === void 0 ? void 0 : _a.close();
        this.ws = undefined;
    }
    request(action, payload, skipVerify = false) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Not connected — call connect() first"));
        }
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: (v) => resolve(v),
                reject,
                skipVerify,
            });
            this.ws.send(JSON.stringify({ id, action, ...payload }));
        });
    }
    async onMessage(raw) {
        var _a;
        let envelope;
        try {
            envelope = JSON.parse(raw);
        }
        catch {
            return;
        }
        const waiter = this.pending.get(envelope.id);
        if (!waiter)
            return;
        this.pending.delete(envelope.id);
        if (!waiter.skipVerify && this.pinnedPublicKey) {
            const valid = await verifyEnvelope(envelope, this.pinnedPublicKey);
            if (!valid) {
                return waiter.reject(new PrintTraysUntrustedError("Response signature verification failed — message may be forged"));
            }
        }
        if (envelope.ok)
            waiter.resolve(envelope.result);
        else
            waiter.reject(new Error((_a = envelope.error) !== null && _a !== void 0 ? _a : "Unknown PrintTrays error"));
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
    for (let i = 0; i < bin.length; i++)
        bytes[i] = bin.charCodeAt(i);
    return bytes;
}
function defaultNotInstalledPrompt(downloadUrl) {
    if (typeof document === "undefined")
        return;
    const banner = document.createElement("div");
    banner.setAttribute("role", "alert");
    banner.style.cssText =
        "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#111827;color:#fff;" +
            "padding:14px 18px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;max-width:320px;" +
            "box-shadow:0 8px 24px rgba(0,0,0,.25)";
    banner.innerHTML =
        `<strong>PrintTrays isn't running.</strong><br>Install the local print bridge to enable printing from this page.` +
            `<br><a href="${downloadUrl}" target="_blank" rel="noopener" style="color:#60a5fa">Download PrintTrays</a>`;
    document.body.appendChild(banner);
}
function defaultIdentityChangedPrompt() {
    if (typeof confirm === "undefined")
        return false;
    return confirm("PrintTrays's certificate has changed since your last visit to this site. " +
        "This is expected if PrintTrays was reinstalled. Trust the new one and continue?");
}
//# sourceMappingURL=printtrays.js.map