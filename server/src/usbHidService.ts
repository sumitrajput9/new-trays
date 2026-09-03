import type { OutEndpoint, InEndpoint } from "usb";
import { DeviceInfo } from "./types";
import { logger } from "./logger";

/**
 * USB and HID access are optional native dependencies (`usb`, `node-hid`)
 * — both ship prebuilt binaries per-platform via electron-builder's native
 * rebuild step. Lazy-require them so a missing/unbuilt native module never
 * crashes the whole bridge, only the one device call that needed it.
 */
export async function listUsbDevices(): Promise<DeviceInfo[]> {
  try {
    const { usb } = await import("usb");
    return usb.getDeviceList().map((d) => ({
      kind: "usb" as const,
      path: `usb:${d.deviceDescriptor.idVendor.toString(16)}:${d.deviceDescriptor.idProduct.toString(16)}`,
      vendorId: d.deviceDescriptor.idVendor,
      productId: d.deviceDescriptor.idProduct,
    }));
  } catch (err) {
    logger.error(`USB enumeration unavailable: ${(err as Error).message}`);
    return [];
  }
}

export async function listHidDevices(): Promise<DeviceInfo[]> {
  try {
    const HID = await import("node-hid");
    return HID.devices().map((d) => ({
      kind: "hid" as const,
      path: d.path ?? `hid:${d.vendorId}:${d.productId}`,
      vendorId: d.vendorId,
      productId: d.productId,
      manufacturer: d.manufacturer,
      product: d.product,
      serialNumber: d.serialNumber,
    }));
  } catch (err) {
    logger.error(`HID enumeration unavailable: ${(err as Error).message}`);
    return [];
  }
}

/** Raw write to an HID device by path (e.g. a USB-HID barcode scanner,
 *  pole display, or signature pad that isn't a standard serial or
 *  spooler-based printer). */
export async function hidRawWrite(devicePath: string, bytes: Buffer): Promise<void> {
  const { HIDAsync } = await import("node-hid");
  const device = await HIDAsync.open(devicePath);
  try {
    await device.write(bytes);
  } finally {
    await device.close();
  }
}

/** Raw read from an HID device — e.g. a signature pad or card reader
 *  sending a report back. Resolves to an empty buffer on timeout rather
 *  than throwing, since "the device had nothing to say" is a normal
 *  outcome, not an error. */
export async function hidRawRead(devicePath: string, timeoutMs = 2000): Promise<Buffer> {
  const { HIDAsync } = await import("node-hid");
  const device = await HIDAsync.open(devicePath);
  try {
    const data = await device.read(timeoutMs);
    return data ?? Buffer.alloc(0);
  } finally {
    await device.close();
  }
}

/** Opens a USB device by VID/PID, claims whichever interface exposes the
 *  given endpoint address, and hands back that endpoint plus cleanup. Used
 *  by both usbRawWrite and usbRawRead so the claim/release/close dance
 *  only needs writing once. */
async function withUsbEndpoint<T>(
  vendorId: number,
  productId: number,
  endpointAddress: number,
  direction: "in" | "out",
  fn: (endpoint: InEndpoint | OutEndpoint) => Promise<T>
): Promise<T> {
  const { findByIds } = await import("usb");
  const device = findByIds(vendorId, productId);
  if (!device) {
    throw new Error(
      `USB device ${vendorId.toString(16)}:${productId.toString(16)} not found — is it connected?`
    );
  }

  device.open();
  try {
    const iface = device.interfaces?.find((i) => i.endpoints.some((e) => e.address === endpointAddress));
    if (!iface) {
      throw new Error(`No interface on this device exposes endpoint ${endpointAddress}`);
    }
    iface.claim();
    try {
      const endpoint = iface.endpoint(endpointAddress);
      if (!endpoint || endpoint.direction !== direction) {
        throw new Error(`Endpoint ${endpointAddress} is not a ${direction.toUpperCase()} endpoint`);
      }
      return await fn(endpoint as InEndpoint | OutEndpoint);
    } finally {
      await iface.releaseAsync();
    }
  } finally {
    device.close();
  }
}

/** Raw bulk/interrupt write directly to a USB endpoint — for devices that
 *  aren't HID-class (most thermal printers and some card readers/scanners
 *  talk raw USB instead). */
export async function usbRawWrite(
  vendorId: number,
  productId: number,
  endpointAddress: number,
  bytes: Buffer
): Promise<void> {
  await withUsbEndpoint(vendorId, productId, endpointAddress, "out", async (endpoint) => {
    await (endpoint as OutEndpoint).transferAsync(bytes);
  });
}

/** Raw bulk/interrupt read directly from a USB endpoint. */
export async function usbRawRead(
  vendorId: number,
  productId: number,
  endpointAddress: number,
  length = 64,
  timeoutMs = 2000
): Promise<Buffer> {
  return withUsbEndpoint(vendorId, productId, endpointAddress, "in", async (endpoint) => {
    const inEndpoint = endpoint as InEndpoint;
    inEndpoint.timeout = timeoutMs;
    const data = await inEndpoint.transferAsync(length);
    return data ?? Buffer.alloc(0);
  });
}

/** Low-level USB control transfer — the mechanism many USB devices use for
 *  configuration/status exchanges outside the normal bulk data endpoints
 *  (e.g. initializing a card reader, querying device status). */
export async function usbControlTransfer(
  vendorId: number,
  productId: number,
  bmRequestType: number,
  bRequest: number,
  wValue: number,
  wIndex: number,
  dataOrLength: Buffer | number
): Promise<Buffer> {
  const { findByIds } = await import("usb");
  const device = findByIds(vendorId, productId);
  if (!device) {
    throw new Error(
      `USB device ${vendorId.toString(16)}:${productId.toString(16)} not found — is it connected?`
    );
  }

  device.open();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      device.controlTransfer(bmRequestType, bRequest, wValue, wIndex, dataOrLength, (error, buffer) => {
        if (error) return reject(error);
        resolve(Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0));
      });
    });
  } finally {
    device.close();
  }
}
