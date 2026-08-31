import net from "net";
import { SerialPort } from "serialport";
import { logger } from "./logger";

/**
 * Sends raw bytes directly to a printer connection string, bypassing the OS
 * print spooler entirely. Used for thermal/label printers that speak
 * ESC/POS or ZPL over a raw socket.
 *
 * Supported connection strings:
 *   tcp:<host>:<port>   e.g. "tcp:192.168.1.50:9100"  (standard raw-print port)
 *   serial:<port>       e.g. "serial:COM3" or "serial:/dev/ttyUSB0"
 */
export async function sendRawBytes(connection: string, bytes: Buffer): Promise<void> {
  const [scheme, ...rest] = connection.split(":");

  if (scheme === "tcp") {
    const [host, portStr] = rest.join(":").split(":");
    const port = Number(portStr || 9100);
    return sendOverTcp(host, port, bytes);
  }

  if (scheme === "serial") {
    const portPath = rest.join(":");
    return sendOverSerial(portPath, bytes);
  }

  throw new Error(`Unsupported connection string: ${connection}`);
}

function sendOverTcp(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(bytes, (err) => {
        if (err) return reject(err);
        socket.end();
      });
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    });
    socket.on("close", () => resolve());
    socket.on("error", (err) => reject(err));
  });
}

function sendOverSerial(portPath: string, bytes: Buffer, baudRate = 9600): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
    port.open((err) => {
      if (err) return reject(err);
      port.write(bytes, (writeErr) => {
        if (writeErr) {
          port.close();
          return reject(writeErr);
        }
        port.drain(() => port.close((closeErr) => (closeErr ? reject(closeErr) : resolve())));
      });
    });
  });
}

export function decodePayload(data: string, encoding: "utf8" | "base64" | "hex" = "utf8"): Buffer {
  return Buffer.from(data, encoding);
}

export const rawPrintLogger = logger;
