import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

const LOGS_DIR = path.join(
  app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath(),
  "logs"
);

function getLogFileName(): string {
  const now = new Date();
  const datePart = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${datePart}.txt`;
}

function getLogFilePath(): string {
  return path.join(LOGS_DIR, getLogFileName());
}

function ensureLogsReady(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function appendLog(message: string): void {
  ensureLogsReady();
  const timestamp = new Date().toISOString();
  const logFile = getLogFilePath();
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, "utf-8");
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

export { getLogFilePath };
