import { SerialPort } from "serialport";
import { DeviceInfo } from "./types";

export type SerialParity = "none" | "even" | "mark" | "odd" | "space";

export interface SerialWriteOptions {
  baudRate?: number;
  readTimeoutMs?: number;
  /** Defaults to 8. */
  dataBits?: 5 | 6 | 7 | 8;
  /** Defaults to 1. */
  stopBits?: 1 | 1.5 | 2;
  /** Defaults to "none". Needed for some less-common scale/scanner protocols. */
  parity?: SerialParity;
  /** Hardware (RTS/CTS) flow control. Defaults to false. */
  rtscts?: boolean;
  /** Software (XON/XOFF) flow control. Defaults to false. */
  xon?: boolean;
  xoff?: boolean;
}

export async function listSerialDevices(): Promise<DeviceInfo[]> {
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    kind: "serial",
    path: p.path,
    vendorId: p.vendorId ? parseInt(p.vendorId, 16) : undefined,
    productId: p.productId ? parseInt(p.productId, 16) : undefined,
    manufacturer: p.manufacturer,
    serialNumber: p.serialNumber,
  }));
}

/**
 * Writes bytes to a serial port (e.g. a scale or barcode scanner) and, if
 * the device talks back, captures whatever it sends within `readTimeoutMs`.
 * Many scale/scanner protocols are request/response over serial, so this
 * covers the common case without requiring a persistent subscription.
 */
export function serialRawWrite(portPath: string, bytes: Buffer, options: SerialWriteOptions = {}): Promise<Buffer> {
  const {
    baudRate = 9600,
    readTimeoutMs = 300,
    dataBits = 8,
    stopBits = 1,
    parity = "none",
    rtscts = false,
    xon = false,
    xoff = false,
  } = options;

  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path: portPath,
      baudRate,
      dataBits,
      stopBits,
      parity,
      rtscts,
      xon,
      xoff,
      autoOpen: false,
    });
    const chunks: Buffer[] = [];

    port.open((err) => {
      if (err) return reject(err);

      port.on("data", (chunk: Buffer) => chunks.push(chunk));

      port.write(bytes, (writeErr) => {
        if (writeErr) {
          port.close();
          return reject(writeErr);
        }
        port.drain(() => {
          setTimeout(() => {
            port.close((closeErr) => {
              if (closeErr) return reject(closeErr);
              resolve(Buffer.concat(chunks));
            });
          }, readTimeoutMs);
        });
      });
    });
  });
}
