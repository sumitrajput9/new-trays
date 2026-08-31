import { DeviceInfo } from "./types";
import { logger } from "./logger";

/**
 * USB and HID enumeration are optional native dependencies (`usb`, `node-hid`)
 * — both ship prebuilt binaries per-platform via electron-builder's native
 * rebuild step. Lazy-require them so a missing/unbuilt native module never
 * crashes the whole bridge, only the one device-listing call.
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

/** Raw write to an HID device by path (e.g. a USB-HID barcode scanner or
 *  pole display that isn't a standard serial or spooler-based printer). */
export async function hidRawWrite(devicePath: string, bytes: Buffer): Promise<void> {
  const HID = await import("node-hid");
  const device = new HID.HID(devicePath);
  try {
    device.write(Array.from(bytes));
  } finally {
    device.close();
  }
}
