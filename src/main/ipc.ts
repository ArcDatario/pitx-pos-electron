import { app, ipcMain, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { AppConfig, loadConfig, saveConfig, getConfigFilePath } from "./config";
import * as db from "./db";
import * as tsms from "./tsms";

interface SubmitController {
  abort: boolean;
  paused: boolean;
  pauseNotified: boolean;
}

let controller: SubmitController = { abort: false, paused: false, pauseNotified: false };

// ---------- Automation (top-level so resumeAutomation can access it) ----------
let automationEnabled = false;
let automationTimer: NodeJS.Timeout | null = null;
let automationRunning = false;

function getAutomationToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function runAutomationCycle(cfg: AppConfig, win: BrowserWindow) {
  if (automationRunning) return;
  if (!win || win.isDestroyed()) return;
  automationRunning = true;
  controller = { abort: false, paused: false, pauseNotified: false };

  try {
    const today = getAutomationToday();
    send(win, "submit:event", { type: "phase", message: `Automation: processing ${today}...` });

    let inserted = 0;
    try {
      inserted = await db.transfer(cfg, today, today);
      send(win, "submit:event", {
        type: "insert_done",
        date: today,
        inserted,
        message: `Automation: inserted ${inserted} new transaction(s) for ${today}`,
      });
    } catch (e: any) {
      send(win, "submit:event", {
        type: "insert_failed",
        date: today,
        message: `Automation insert failed for ${today}: ${e?.message ?? String(e)}`,
      });
    }

    const detectedVoids = await db.fetchSubmittedVoids(cfg);
    for (let voidIndex = 0; voidIndex < detectedVoids.length; voidIndex++) {
      const rec = detectedVoids[voidIndex];
      const guestCheckId = String(rec.GUESTCHECKID);
      send(win, "submit:event", {
        type: "sending",
        guest_check_id: guestCheckId,
        total: detectedVoids.length,
        index: voidIndex + 1,
        void: true,
        message: `Sending void for ${guestCheckId}`,
      });

      if (!rec.transaction_id) {
        send(win, "submit:event", {
          type: "failed_terminal",
          guest_check_id: guestCheckId,
          void: true,
          message: `${guestCheckId}: No TRANSACTION_ID found for void`,
        });
        continue;
      }

      try {
        const voidResult = await tsms.voidTransaction(cfg, rec.transaction_id);
        if (voidResult.outcome === "success") {
          await db.markVoided(cfg, guestCheckId, {});
          send(win, "submit:event", {
            type: "success",
            guest_check_id: guestCheckId,
            void: true,
            message: `${guestCheckId}: Void submitted successfully`,
          });
          continue;
        }
        send(win, "submit:event", {
          type: voidResult.outcome === "rate_limited" ? "rate_limited" : "failed_retry",
          guest_check_id: guestCheckId,
          void: true,
          message: `${guestCheckId}: Void failed: ${voidResult.message}`,
        });
      } catch (e: any) {
        send(win, "submit:event", {
          type: "failed_retry",
          guest_check_id: guestCheckId,
          void: true,
          message: `${guestCheckId}: Void failed: ${e?.message ?? String(e)}`,
        });
      }
    }

    send(win, "submit:event", { type: "phase", message: `Automation: submitting pending records for ${today}...` });

    const result = await runSubmitBatch(cfg, win, today, today);

    send(win, "submit:event", {
      type: "phase",
      message: `Automation cycle done for ${today} — ${inserted} inserted, ${result.successCount} submitted, ${result.failCount} failed`,
    });
  } catch (e: any) {
    send(win, "submit:event", { type: "phase", message: `Automation error: ${e?.message ?? String(e)}` });
  } finally {
    automationRunning = false;
  }
}

function startAutomationTimer(cfg: AppConfig, win: BrowserWindow) {
  stopAutomationTimer();
  const intervalMs = (cfg.worker.poll_interval_seconds || 60) * 1000;
  automationTimer = setInterval(() => {
    if (!automationEnabled) return;
    runAutomationCycle(cfg, win);
  }, intervalMs);
  runAutomationCycle(cfg, win);
}

function stopAutomationTimer() {
  if (automationTimer) {
    clearInterval(automationTimer);
    automationTimer = null;
  }
}

export function resumeAutomation(cfg: AppConfig, getWindow: () => BrowserWindow | null) {
  if (cfg.automation_enabled && !automationEnabled) {
    automationEnabled = true;
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      startAutomationTimer(cfg, win);
    }
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        path: process.execPath,
      });
    }
  }
}

function send(win: BrowserWindow, channel: string, payload: any) {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runSubmitBatch(
  cfg: AppConfig,
  win: BrowserWindow,
  start: string,
  end: string
): Promise<{ total: number; processed: number; successCount: number; failCount: number; aborted: boolean }> {
  const records = await db.fetchPendingByDate(cfg, start, end);
  const total = records.length;
  send(win, "submit:event", { type: "submit_start", total, message: `Found ${total} record(s) to submit` });

  let processed = 0;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < records.length; i++) {
    if (controller.abort) {
      send(win, "submit:event", { type: "phase", message: "Aborted" });
      break;
    }
    while (controller.paused && !controller.abort) {
      if (!controller.pauseNotified) {
        send(win, "submit:event", { type: "phase", message: "Paused" });
        controller.pauseNotified = true;
      }
      await sleep(400);
    }
    if (controller.abort) break;
    controller.pauseNotified = false;

    const rec = records[i];
    const guestCheckId = rec.GUESTCHECKID;
    const isVoid = isVoidRecord(rec);
    send(win, "submit:event", {
      type: "sending",
      guest_check_id: guestCheckId,
      index: i + 1,
      total,
      void: isVoid,
      message: `Sending ${guestCheckId}`,
    });

    let result: tsms.SubmitOneResult;
    try {
      result = await tsms.submitOne(cfg, rec);
    } catch (e: any) {
      result = { outcome: "retryable", message: e?.message ?? String(e), data: null, httpCode: null };
      const currentRetryCount = Number(rec.retry_count ?? 0);
      const backoff = tsms.BACKOFF_SECONDS[Math.min(currentRetryCount, tsms.BACKOFF_SECONDS.length - 1)];
      await db.markFailed(cfg, guestCheckId, result.message, currentRetryCount, cfg.worker.max_retries, backoff);
    }

    if (result.outcome === "success") {
      successCount++;
    } else {
      failCount++;
    }
    send(win, "submit:event", {
      type: eventTypeFor(result.outcome),
      guest_check_id: guestCheckId,
      void: isVoid,
      message: `${guestCheckId}: ${result.message}`,
    });

    processed++;
  }

  send(win, "submit:event", {
    type: "submit_done",
    total,
    processed,
    successCount,
    failCount,
    aborted: controller.abort,
    message: `Done: ${successCount} submitted, ${failCount} failed, ${processed}/${total} processed`,
  });

  return { total, processed, successCount, failCount, aborted: controller.abort };
}

/** Maps a tsms.submitOne() outcome to the "sending"/"success"/"rate_limited"/
 * "failed_retry"/"failed_terminal" event vocabulary the renderer expects. */
function eventTypeFor(outcome: tsms.Outcome): string {
  if (outcome === "success") return "success";
  if (outcome === "rate_limited") return "rate_limited";
  if (outcome === "retryable") return "failed_retry";
  return "failed_terminal";
}

/** Same void-detection rule as tsms.ts::submitOne (VOIDTOTAL_QTY/VOIDTOTAL_AMT
 * != 0), duplicated locally so the renderer can be told up front which lane
 * (Submitted vs Voided) a record is headed for once it succeeds. */
function isVoidRecord(rec: Record<string, any>): boolean {
  const upper: Record<string, any> = {};
  for (const k of Object.keys(rec)) upper[k.toUpperCase()] = rec[k];
  const voidQty = Number(upper.VOIDTOTAL_QTY ?? 0);
  const voidAmt = Number(upper.VOIDTOTAL_AMT ?? 0);
  return voidQty !== 0 || voidAmt !== 0;
}

export function registerIpcHandlers(getWindow: () => BrowserWindow) {
  ipcMain.handle("app:update-check", async () => {
    if (!app.isPackaged) return { ok: false, message: "Updates are available in the installed app." };
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo ?? null };
  });

  ipcMain.handle("app:update-download", async () => {
    if (!app.isPackaged) return { ok: false, message: "Updates are available in the installed app." };
    await autoUpdater.downloadUpdate();
    return { ok: true };
  });

  ipcMain.handle("app:update-install", () => {
    if (!app.isPackaged) return { ok: false, message: "Updates are available in the installed app." };
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle("config:get", () => loadConfig());

  ipcMain.handle("config:save", (_e, cfg: AppConfig) => {
    saveConfig(cfg);
    return { ok: true, path: getConfigFilePath() };
  });

  ipcMain.handle("config:path", () => getConfigFilePath());

  ipcMain.handle("app:quit", () => {
    app.quit();
  });

  ipcMain.handle("config:test-connection", async (_e, cfg: AppConfig) => {
    return db.testConnection(cfg);
  });

  ipcMain.handle("db:transfer", async (_e, args: { start: string; end: string }) => {
    const cfg = loadConfig();
    const inserted = await db.transfer(cfg, args.start, args.end);
    return { inserted };
  });

  ipcMain.handle("db:status-counts", async (_e, filters: db.RecordFilters) => {
    const cfg = loadConfig();
    return db.getStatusCounts(cfg, filters);
  });

  ipcMain.handle("db:summary", async (_e, filters: db.RecordFilters) => {
    const cfg = loadConfig();
    return db.getSummaryMetrics(cfg, filters);
  });

  ipcMain.handle(
    "db:records",
    async (_e, args: { filters: db.RecordFilters; page: number; pageSize: number }) => {
      const cfg = loadConfig();
      return db.fetchRecords(cfg, args.filters, args.page, args.pageSize);
    }
  );

  ipcMain.handle("db:record", async (_e, guestCheckId: string) => {
    const cfg = loadConfig();
    return db.fetchRecordByGuestCheckId(cfg, guestCheckId);
  });

  ipcMain.handle("install:create-table", async () => {
    const cfg = loadConfig();
    await db.installCreateTable(cfg);
    return { ok: true };
  });

  ipcMain.handle("submit:control", (_e, action: "pause" | "resume" | "abort") => {
    if (action === "pause") controller.paused = true;
    if (action === "resume") controller.paused = false;
    if (action === "abort") controller.abort = true;
    return { ok: true };
  });

  /**
   * Shared insert-then-submit pipeline for a single business date -- this is
   * what both "Submit Today" and the "Dated Submission" tab run. Emits
   * distinct insert_start/insert_done/insert_failed events around the
   * db.transfer() insert step (so the renderer's left pipeline stage can
   * light up independently of the per-record submit events), then delegates
   * to runSubmitBatch for the actual submission, then emits a final
   * batch_done event summarizing the whole insert+submit run.
   */
  async function runDatedSubmission(
    cfg: AppConfig,
    win: BrowserWindow,
    date: string
  ): Promise<{ date: string; inserted: number; total: number; processed: number; successCount: number; failCount: number; aborted: boolean }> {
    controller = { abort: false, paused: false, pauseNotified: false };

    send(win, "submit:event", { type: "insert_start", date, message: `Fetching transactions for ${date}...` });

    let inserted = 0;
    try {
      inserted = await db.transfer(cfg, date, date);
      send(win, "submit:event", {
        type: "insert_done",
        date,
        inserted,
        message: `Inserted ${inserted} new transaction(s) for ${date}`,
      });
    } catch (e: any) {
      send(win, "submit:event", {
        type: "insert_failed",
        date,
        message: `Insert failed: ${e?.message ?? String(e)}`,
      });
      return { date, inserted, total: 0, processed: 0, successCount: 0, failCount: 0, aborted: false };
    }

    const result = await runSubmitBatch(cfg, win, date, date);

    send(win, "submit:event", {
      type: "batch_done",
      date,
      inserted,
      ...result,
      message: `Finished: ${inserted} inserted, ${result.successCount} submitted, ${result.failCount} failed`,
    });

    return { date, inserted, ...result };
  }

  ipcMain.handle(
    "submit:by-date-range",
    async (_e, args: { start: string; end: string }) => {
      const cfg = loadConfig();
      const win = getWindow();
      controller = { abort: false, paused: false, pauseNotified: false };
      return runSubmitBatch(cfg, win, args.start, args.end);
    }
  );

  /**
   * "Dated Submission" -- inserts the chosen business date's transactions
   * from v_salesdetails into the staging table, then immediately submits
   * every pending row for that date. The renderer's Dated Submission tab
   * shows a confirmation modal with the chosen date before invoking this.
   */
  ipcMain.handle("submit:dated", async (_e, args: { date: string }) => {
    const cfg = loadConfig();
    const win = getWindow();
    return runDatedSubmission(cfg, win, args.date);
  });

  /** Back-compat wrapper: "Submit Today" is just a dated submission for
   * today's date. */
  ipcMain.handle("submit:today", async () => {
    const cfg = loadConfig();
    const win = getWindow();
    const today = new Date().toISOString().slice(0, 10);
    return runDatedSubmission(cfg, win, today);
  });

  ipcMain.handle("submit:resubmit", async (_e, guestCheckId: string) => {
    const cfg = loadConfig();
    const rec = await db.fetchRecordByGuestCheckId(cfg, guestCheckId);
    if (!rec) return { ok: false, message: "Record not found" };

    const reset = await db.resetForResubmit(cfg, guestCheckId);
    if (!reset) return { ok: false, message: "Row is already submitted -- cannot resubmit" };

    const freshRec = await db.fetchRecordByGuestCheckId(cfg, guestCheckId);
    const result = await tsms.submitOne(cfg, freshRec);
    // submitOne() already wrote the resulting DB state (submitted/voided/
    // rate_limited/failed) -- nothing left to persist here.
    return { ok: result.outcome === "success", message: result.message };
  });

  ipcMain.handle("submit:single", async (_e, guestCheckId: string) => {
    const cfg = loadConfig();
    const rec = await db.fetchRecordByGuestCheckId(cfg, guestCheckId);
    if (!rec) return { ok: false, message: "Record not found" };

    const result = await tsms.submitOne(cfg, rec);
    return { ok: result.outcome === "success", message: result.message };
  });

  ipcMain.handle("submit:void", async (_e, guestCheckId: string) => {
    const cfg = loadConfig();
    const rec = await db.fetchRecordByGuestCheckId(cfg, guestCheckId);
    if (!rec) return { ok: false, message: "Record not found" };
    if (!rec.transaction_id) return { ok: false, message: "No TRANSACTION_ID found" };

    const result = await tsms.voidTransaction(cfg, rec.transaction_id);
    if (result.outcome === "success") {
      await db.markVoided(cfg, guestCheckId, {});
      return { ok: true, message: "Voided" };
    }
    return { ok: false, message: result.message };
  });

  ipcMain.handle("preview:payload", async (_e, guestCheckId: string) => {
    const cfg = loadConfig();
    const rec = await db.fetchRecordByGuestCheckId(cfg, guestCheckId);
    if (!rec) return { ok: false, message: "Record not found" };
    const payload = await tsms.previewPayload(cfg, rec);
    return { ok: true, payload };
  });

  ipcMain.handle("automation:start", async (_e) => {
    const cfg = loadConfig();
    cfg.automation_enabled = true;
    saveConfig(cfg);

    const win = getWindow();
    automationEnabled = true;
    startAutomationTimer(cfg, win);

    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });

    return { ok: true, pollInterval: cfg.worker.poll_interval_seconds };
  });

  ipcMain.handle("automation:stop", async () => {
    const cfg = loadConfig();
    cfg.automation_enabled = false;
    saveConfig(cfg);

    automationEnabled = false;
    stopAutomationTimer();
    app.setLoginItemSettings({ openAtLogin: false });

    return { ok: true };
  });

  ipcMain.handle("automation:status", () => {
    return { enabled: automationEnabled, running: automationRunning };
  });
}