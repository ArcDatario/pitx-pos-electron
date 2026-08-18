import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pos", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke("config:save", cfg),
  getConfigPath: () => ipcRenderer.invoke("config:path"),
  testConnection: (cfg: unknown) => ipcRenderer.invoke("config:test-connection", cfg),

  transfer: (start: string, end: string) => ipcRenderer.invoke("db:transfer", { start, end }),
  getStatusCounts: () => ipcRenderer.invoke("db:status-counts"),
  getSummary: (filters: unknown) => ipcRenderer.invoke("db:summary", filters),
  getRecords: (filters: unknown, page: number, pageSize: number) =>
    ipcRenderer.invoke("db:records", { filters, page, pageSize }),
  getRecord: (guestCheckId: string) => ipcRenderer.invoke("db:record", guestCheckId),

  installCreateTable: () => ipcRenderer.invoke("install:create-table"),

  submitByDateRange: (start: string, end: string) =>
    ipcRenderer.invoke("submit:by-date-range", { start, end }),
  submitControl: (action: "pause" | "resume" | "abort") =>
    ipcRenderer.invoke("submit:control", action),
  resubmit: (guestCheckId: string) => ipcRenderer.invoke("submit:resubmit", guestCheckId),
  voidRecord: (guestCheckId: string) => ipcRenderer.invoke("submit:void", guestCheckId),
  previewPayload: (guestCheckId: string) => ipcRenderer.invoke("preview:payload", guestCheckId),

  onSubmitEvent: (callback: (event: any) => void) => {
    const listener = (_e: unknown, payload: any) => callback(payload);
    ipcRenderer.on("submit:event", listener);
    return () => ipcRenderer.removeListener("submit:event", listener);
  },
});
