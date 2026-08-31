import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import forge from "node-forge";

/**
 * All PrintPort state (TLS cert, CA, signing keypair) lives under the OS
 * per-user app-data directory so every OS install behaves the same way.
 */
export function appDataDir(): string {
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  const dir = path.join(base, "PrintPort");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface CertBundle {
  tlsKeyPem: string;
  tlsCertPem: string;
  caCertPem: string;
  signingPublicKeyPem: string;
  signingPrivateKeyPem: string;
  keyFingerprint: string;
}

const FILES = {
  tlsKey: "tls-key.pem",
  tlsCert: "tls-cert.pem",
  caCert: "ca-cert.pem", // this is what gets imported into the OS/browser trust store
  signPub: "signing-public.pem",
  signPriv: "signing-private.pem",
};

function fingerprintOf(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem).digest("hex");
}

/**
 * Generates a self-signed local CA + a leaf TLS certificate signed by it, plus
 * a separate RSA keypair used purely for signing outgoing WS message payloads
 * (this is what the client SDK checks to verify a response really came from
 * the genuine local PrintPort instance, not some other localhost process).
 */
function generate(): CertBundle {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);
  const caAttrs = [{ name: "commonName", value: "PrintPort Local CA" }, { name: "organizationName", value: "PrintPort" }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true, cRLSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = "02";
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date();
  leafCert.validity.notAfter.setFullYear(leafCert.validity.notBefore.getFullYear() + 10);
  leafCert.setSubject([{ name: "commonName", value: "localhost" }]);
  leafCert.setIssuer(caAttrs);
  leafCert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const signingKeys = forge.pki.rsa.generateKeyPair(2048);
  const signingPublicKeyPem = forge.pki.publicKeyToPem(signingKeys.publicKey);

  return {
    tlsKeyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
    tlsCertPem: forge.pki.certificateToPem(leafCert),
    caCertPem: forge.pki.certificateToPem(caCert),
    signingPublicKeyPem,
    signingPrivateKeyPem: forge.pki.privateKeyToPem(signingKeys.privateKey),
    keyFingerprint: fingerprintOf(signingPublicKeyPem),
  };
}

/** Loads the existing cert/key bundle, generating one on first run. */
export function loadOrCreateCertBundle(): CertBundle {
  const dir = appDataDir();
  const p = (f: string) => path.join(dir, f);
  const allExist = Object.values(FILES).every((f) => fs.existsSync(p(f)));

  if (allExist) {
    const signingPublicKeyPem = fs.readFileSync(p(FILES.signPub), "utf8");
    return {
      tlsKeyPem: fs.readFileSync(p(FILES.tlsKey), "utf8"),
      tlsCertPem: fs.readFileSync(p(FILES.tlsCert), "utf8"),
      caCertPem: fs.readFileSync(p(FILES.caCert), "utf8"),
      signingPublicKeyPem,
      signingPrivateKeyPem: fs.readFileSync(p(FILES.signPriv), "utf8"),
      keyFingerprint: fingerprintOf(signingPublicKeyPem),
    };
  }

  const bundle = generate();
  fs.writeFileSync(p(FILES.tlsKey), bundle.tlsKeyPem, { mode: 0o600 });
  fs.writeFileSync(p(FILES.tlsCert), bundle.tlsCertPem);
  fs.writeFileSync(p(FILES.caCert), bundle.caCertPem);
  fs.writeFileSync(p(FILES.signPub), bundle.signingPublicKeyPem);
  fs.writeFileSync(p(FILES.signPriv), bundle.signingPrivateKeyPem, { mode: 0o600 });
  return bundle;
}

/** Path to the CA cert that installers/users import into the OS trust store
 *  to make the browser trust wss://localhost:8181 without a manual prompt. */
export function caCertPath(): string {
  return path.join(appDataDir(), FILES.caCert);
}
