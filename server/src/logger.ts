import fs from "fs";
import path from "path";
import { appDataDir } from "./certManager";

const LOG_FILE = () => path.join(appDataDir(), "printport.log");

function write(level: string, msg: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE(), line);
  } catch {
    // logging must never crash the app
  }
}

export const logger = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
