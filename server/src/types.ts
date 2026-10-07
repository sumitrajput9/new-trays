export type PrintDataType = "pdf" | "html" | "raw" | "zpl" | "escpos" | "image";

export type DeviceKind = "usb" | "serial" | "hid";

export interface ConnectionTarget {
  /** "usb:<vendorIdHex>:<productIdHex>:<endpointAddress>", "serial:COM3", or "tcp:192.168.1.50:9100" */
  connection?: string;
}

export interface ListPrintersRequest {
  id: string;
  action: "listPrinters";
}

export interface GetPrinterDetailsRequest {
  id: string;
  action: "getPrinterDetails";
  printer: string;
}

/** `name` is the option's human-readable display name (e.g. "Letter",
 *  "Index Card 3 x 5in", "Tray 3") — this is what a UI should show, and
 *  also what the print pipeline (SumatraPDF) actually matches against when
 *  selecting a paper size or bin, so pass it back verbatim, not some other
 *  internal identifier. */
export interface PrinterOption {
  name: string;
}

export interface PrinterMediaSize extends PrinterOption {
  /** In `units` — Windows' PrintCapabilities XML reports these in microns. */
  width: number;
  height: number;
  units: "micron";
}

export interface PrinterResolution extends PrinterOption {
  dpiX: number;
  dpiY: number;
}

export interface GetPrinterDetailsResult {
  sizes: PrinterMediaSize[];
  /** Discoverable, but NOT currently applied to a print job — the print
   *  pipeline (SumatraPDF) has no way to set a driver's DPI/quality option;
   *  changing it would need direct Win32 driver API calls, not built yet. */
  resolutions: PrinterResolution[];
  /** Discoverable only, same caveat as `resolutions`. */
  mediaTypes: PrinterOption[];
  /** Actually usable — pass an option's `name` as `inputBin` on a print job. */
  inputBins: PrinterOption[];
  orientations: PrinterOption[];
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
  /** type "pdf" only. "fit" (default) scales content to fill the selected
   *  paper — needed for anything beyond the exact nominal size (e.g. an
   *  "E2E" borderless media). "actual" prints at the PDF's own defined
   *  size, no scaling. "custom" scales content by `scaleFactor` percent,
   *  centered on a same-size page — matches how a real print dialog's
   *  custom-% scale behaves (the sheet size doesn't change, the content
   *  shrinks/grows within it). */
  scaleMode?: "fit" | "actual" | "custom";
  /** Percentage for scaleMode "custom", e.g. 50 = half size. Ignored for
   *  every other scaleMode. */
  scaleFactor?: number;
  /** type "pdf" only: rasterize server-side and send as a raw image feed
   *  instead of going through the OS's PDF-aware print pipeline. Much
   *  faster on drivers that are slow processing GDI/PDF jobs (e.g. some
   *  photo-lab printers), but only works if the target printer's queue
   *  actually accepts a raw image feed — test before relying on it. */
  fastRaster?: boolean;
  /** type "pdf" only, multi-page documents only (meaningless for a single
   *  page). "frontToBack" (default) prints 1,2,3…N. "backToFront" prints
   *  N…3,2,1, so a face-up output tray ends up in the right reading order. */
  pageOrder?: "frontToBack" | "backToFront";
  /** type "pdf" only: selects a paper source/tray by its driver-internal
   *  option name — use the `name` field from getPrinterDetails()'s
   *  `inputBins`, not the display name. */
  inputBin?: string;
  /** Image printing (type "image", and PDFs that are just one full-page
   *  photo): the exact page to print at. If omitted, `paperSize` is looked
   *  up by name in the printer's own reported sizes; failing that, the
   *  PDF's own page size (or Letter for a bare image) is used. */
  pageSize?: { width: number; height: number; units?: "in" | "mm" | "micron" };
  /** Image printing only: rotate the picture clockwise on the page (0, 90,
   *  180 or 270 degrees). */
  rotation?: number;
  /** Image printing only. "chromium" (default) prints through Chromium's
   *  print engine — the same one Ctrl+P uses — so the driver receives the
   *  image itself instead of a huge full-page bitmap. "sumatra" forces the
   *  classic image→PDF→SumatraPDF route (JPEG/PNG only). */
  imageEngine?: "chromium" | "sumatra";
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
  | GetPrinterDetailsRequest
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
