import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

function getLogsDir(): string {
  const baseDir = app.isPackaged ? app.getPath("userData") : app.getAppPath();
  return path.join(baseDir, "logs");
}

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
  return path.join(getLogsDir(), getLogFileName());
}

function ensureLogsReady(): void {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
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
