import crypto from "crypto";
import { CertBundle } from "./certManager";
import { OutgoingMessageEnvelope } from "./types";

/**
 * Canonicalizes and signs a response payload with the local RSA signing key,
 * so client-sdk can verify the message truly came from this PrintPort
 * instance (see client-sdk/src/printport.ts `verify`).
 */
export function signEnvelope<T>(
  bundle: CertBundle,
  base: Omit<OutgoingMessageEnvelope<T>, "signature" | "keyFingerprint">
): OutgoingMessageEnvelope<T> {
  const canonical = JSON.stringify(base);
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(canonical), bundle.signingPrivateKeyPem)
    .toString("base64");

  return {
    ...base,
    signature,
    keyFingerprint: bundle.keyFingerprint,
  };
}
