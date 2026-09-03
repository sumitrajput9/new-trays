export type PrintDataType = "pdf" | "html" | "raw" | "zpl" | "escpos";

export type DeviceKind = "usb" | "serial" | "hid";

export interface ConnectionTarget {
  /** "usb:<vendorIdHex>:<productIdHex>:<endpointAddress>", "serial:COM3", or "tcp:192.168.1.50:9100" */
  connection?: string;
}

export interface ListPrintersRequest {
  id: string;
  action: "listPrinters";
}

export type DuplexMode = "simplex" | "shortEdge" | "longEdge";

export type PaperSize = "A3" | "A4" | "A5" | "Legal" | "Letter" | "Tabloid";

export interface PrintMargins {
  marginType?: "default" | "none" | "printableArea" | "custom";
  /** Only used when marginType is "custom". In microns. */
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
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
  /** Only applies to type "pdf"/"html" — raw/zpl/escpos bytes control their own page setup. */
  duplex?: DuplexMode;
  landscape?: boolean;
  paperSize?: PaperSize;
  margins?: PrintMargins;
  /** Defaults to true (color). Set false for grayscale/black & white. */
  color?: boolean;
  /** Percentage, e.g. 100 = actual size. */
  scaleFactor?: number;
}

export interface RawWriteRequest {
  id: string;
  action: "rawWrite";
  /** "COM3" / "/dev/ttyUSB0" (serial), "tcp:host:port", "hid:<path>",
   *  or "usb:<vendorIdHex>:<productIdHex>:<endpointAddress>" */
  port: string;
  /** Bytes to write. Leave empty ("") for a read-only request. */
  bytes: string;
  encoding?: "utf8" | "base64" | "hex";
  baudRate?: number;
  /** For hid:/usb: ports — read back a response after writing (or instead
   *  of writing, if bytes is empty). Omit to skip reading entirely.
   *  For plain serial ports, defaults to 300ms if omitted. */
  readTimeoutMs?: number;
  /** For usb: ports only — how many bytes to request in the read transfer.
   *  Defaults to 64. */
  readLength?: number;
  /** Serial ports only — beyond baud rate, for less-common protocols. */
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "mark" | "odd" | "space";
  rtscts?: boolean;
  xon?: boolean;
  xoff?: boolean;
}

export interface UsbControlTransferRequest {
  id: string;
  action: "usbControlTransfer";
  vendorId: number;
  productId: number;
  bmRequestType: number;
  bRequest: number;
  wValue: number;
  wIndex: number;
  /** Base64 payload for an OUT transfer. Omit (and set readLength instead) for an IN transfer. */
  data?: string;
  /** Byte count to read for an IN transfer. Omit for an OUT transfer. */
  readLength?: number;
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
  | UsbControlTransferRequest
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
