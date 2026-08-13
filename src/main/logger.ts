import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

const LOGS_DIR = path.join(
  app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath(),
  "logs"
);
const LOG_FILE = path.join(LOGS_DIR, "logs.txt");

function ensureLogsReady(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "", "utf-8");
  }
}

function appendLog(message: string): void {
  ensureLogsReady();
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`, "utf-8");
}

function interceptConsole(): void {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  const write = (level: string, args: any[]) => {
    const msg = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)))
      .join(" ");
    appendLog(`[${level}] ${msg}`);
  };

  console.log = (...args: any[]) => { write("INFO", args); originalLog(...args); };
  console.info = (...args: any[]) => { write("INFO", args); originalInfo(...args); };
  console.warn = (...args: any[]) => { write("WARN", args); originalWarn(...args); };
  console.error = (...args: any[]) => { write("ERROR", args); originalError(...args); };
}

export function initLogger(): void {
  ensureLogsReady();
  appendLog("Logger initialized");
  interceptConsole();
}

export function log(message: string): void {
  appendLog(`[LOG] ${message}`);
}

export function getLogFilePath(): string {
  return LOG_FILE;
}
