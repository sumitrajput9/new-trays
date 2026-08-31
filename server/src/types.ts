export type PrintDataType = "pdf" | "html" | "raw" | "zpl" | "escpos";

export type DeviceKind = "usb" | "serial" | "hid";

export interface ConnectionTarget {
  /** "usb:<vendorId>:<productId>", "serial:COM3", or "tcp:192.168.1.50:9100" */
  connection?: string;
}

export interface ListPrintersRequest {
  id: string;
  action: "listPrinters";
}

export interface PrintRequest extends ConnectionTarget {
  id: string;
  action: "print";
  printer: string;
  data: string;
  type: PrintDataType;
  /** base64 encoded payload when type is raw/zpl/escpos and data contains binary */
  encoding?: "utf8" | "base64";
  copies?: number;
}

export interface RawWriteRequest {
  id: string;
  action: "rawWrite";
  port: string;
  bytes: string;
  encoding?: "utf8" | "base64" | "hex";
  baudRate?: number;
}

export interface ListDevicesRequest {
  id: string;
  action: "listDevices";
  type: DeviceKind;
}

export interface CertificateRequest {
  id: string;
  action: "getCertificate";
}

export type IncomingMessage =
  | ListPrintersRequest
  | PrintRequest
  | RawWriteRequest
  | ListDevicesRequest
  | CertificateRequest;

export interface OutgoingMessageEnvelope<T = unknown> {
  id: string;
  action: string;
  ok: boolean;
  result?: T;
  error?: string;
  timestamp: number;
  /** base64 RSA-SHA256 signature over the canonicalized payload (excluding this field) */
  signature: string;
  /** sha256 fingerprint of the signing public key, so clients can pin/verify it */
  keyFingerprint: string;
}

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
