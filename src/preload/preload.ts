import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pos", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  hasConfigFile: () => ipcRenderer.invoke("config:has-file"),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke("config:save", cfg),
  getConfigPath: () => ipcRenderer.invoke("config:path"),
  testConnection: (cfg: unknown) => ipcRenderer.invoke("config:test-connection", cfg),

  transfer: (start: string, end: string) => ipcRenderer.invoke("db:transfer", { start, end }),
  getStatusCounts: (filters: unknown) => ipcRenderer.invoke("db:status-counts", filters),
  getSummary: (filters: unknown) => ipcRenderer.invoke("db:summary", filters),
  getRecords: (filters: unknown, page: number, pageSize: number) =>
    ipcRenderer.invoke("db:records", { filters, page, pageSize }),
  getRecord: (guestCheckId: string) => ipcRenderer.invoke("db:record", guestCheckId),

  installCreateTable: () => ipcRenderer.invoke("install:create-table"),

  submitByDateRange: (start: string, end: string) =>
    ipcRenderer.invoke("submit:by-date-range", { start, end }),
  submitToday: () => ipcRenderer.invoke("submit:today"),
  submitDated: (date: string) => ipcRenderer.invoke("submit:dated", { date }),
  submitControl: (action: "pause" | "resume" | "abort") =>
    ipcRenderer.invoke("submit:control", action),
  resubmit: (guestCheckId: string) => ipcRenderer.invoke("submit:resubmit", guestCheckId),
  submitSingle: (guestCheckId: string) => ipcRenderer.invoke("submit:single", guestCheckId),
  voidRecord: (guestCheckId: string) => ipcRenderer.invoke("submit:void", guestCheckId),
  previewPayload: (guestCheckId: string) => ipcRenderer.invoke("preview:payload", guestCheckId),

  onSubmitEvent: (callback: (event: any) => void) => {
    const listener = (_e: unknown, payload: any) => callback(payload);
    ipcRenderer.on("submit:event", listener);
    return () => ipcRenderer.removeListener("submit:event", listener);
  },
  startAutomation: () => ipcRenderer.invoke("automation:start"),
  stopAutomation: () => ipcRenderer.invoke("automation:stop"),
  getAutomationStatus: () => ipcRenderer.invoke("automation:status"),
  onNavigateSettings: (callback: () => void) => {
  ipcRenderer.on("nav:settings", () => callback());
},
  quitApp: () => ipcRenderer.invoke("app:quit"),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  checkForUpdates: () => ipcRenderer.invoke("app:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("app:update-download"),
  installUpdate: () => ipcRenderer.invoke("app:update-install"),
  onUpdateEvent: (callback: (event: any) => void) => {
    const listener = (_e: unknown, payload: any) => callback(payload);
    ipcRenderer.on("app:update", listener);
    return () => ipcRenderer.removeListener("app:update", listener);
  },
});