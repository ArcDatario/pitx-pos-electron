import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface SqlServerConfig {
  server: string;
  database: string;
  username: string;
  password: string;
  driver: string; // kept for parity with the old config.json; unused by mssql/tedious
}

export interface FiltersConfig {
  locationname: string;
  storenum: number;
}

export interface TsmsConfig {
  api_url: string;
  api_token: string;
  tenant_id: number;
  terminal_id: number;
  hardware_id: string;
  customer_code: string;
}

export interface WorkerConfig {
  poll_interval_seconds: number;
  batch_size: number;
  max_retries: number;
}

export interface AppConfig {
  sqlserver: SqlServerConfig;
  filters: FiltersConfig;
  tsms: TsmsConfig;
  worker: WorkerConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  sqlserver: {
    server: "POS1\\SQLEXPRESS",
    database: "CheckPostingDB",
    username: "sa",
    password: "",
    driver: "ODBC Driver 17 for SQL Server",
  },
  filters: {
    locationname: "PH085-PITX",
    storenum: 2067,
  },
  tsms: {
    api_url: "",
    api_token: "",
    tenant_id: 0,
    terminal_id: 0,
    hardware_id: "",
    customer_code: "",
  },
  worker: {
    poll_interval_seconds: 60,
    batch_size: 100,
    max_retries: 5,
  },
};

/**
 * Mirrors the Python app's behaviour: a persistent, editable config.json
 * lives next to the executable (userData in dev) and is seeded from a
 * bundled default on first run.
 */
function getConfigPath(): string {
  const dir = app.isPackaged
    ? path.dirname(app.getPath("exe"))
    : path.join(app.getAppPath());
  return path.join(dir, "config.json");
}

function getBundledDefaultPath(): string | null {
  const bundled = path.join(app.getAppPath(), "config.default.json");
  return fs.existsSync(bundled) ? bundled : null;
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    const bundled = getBundledDefaultPath();
    const seed = bundled
      ? (JSON.parse(fs.readFileSync(bundled, "utf-8")) as AppConfig)
      : DEFAULT_CONFIG;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(seed, null, 2), "utf-8");
    return seed;
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as AppConfig;
}

export function saveConfig(cfg: AppConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

export function getConfigFilePath(): string {
  return getConfigPath();
}
