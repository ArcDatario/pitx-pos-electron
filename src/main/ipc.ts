import { app, ipcMain, BrowserWindow } from "electron";
import { AppConfig, loadConfig, saveConfig, getConfigFilePath } from "./config";
import * as db from "./db";
import * as tsms from "./tsms";

interface SubmitController {
  abort: boolean;
  paused: boolean;
  pauseNotified: boolean;
}

let controller: SubmitController = { abort: false, paused: false, pauseNotified: false };

function send(win: BrowserWindow, channel: string, payload: any) {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Maps a tsms.submitOne() outcome to the "sending"/"success"/"rate_limited"/
 * "failed_retry"/"failed_terminal" event vocabulary the renderer expects. */
function eventTypeFor(outcome: tsms.Outcome): string {
  if (outcome === "success") return "success";
  if (outcome === "rate_limited") return "rate_limited";
  if (outcome === "retryable") return "failed_retry";
  return "failed_terminal";
}

export function registerIpcHandlers(getWindow: () => BrowserWindow) {
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

  ipcMain.handle("db:status-counts", async () => {
    const cfg = loadConfig();
    return db.getStatusCounts(cfg);
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
   * Shared batch-submission loop -- 1:1 with the submit phase that used to
   * live inline in `submit:by-date-range`. Both the normal "Submit Pending"
   * path and the "Submit Today" path run through here so the per-record
   * submit/void orchestration and the live `submit:event` progress logging
   * stay identical regardless of entry point.
   *
   * Reads `controller` (abort/paused) set by `submit:control` so the
   * renderer can pause/abort either flow.
   */
  async function runSubmitBatch(
    cfg: AppConfig,
    win: BrowserWindow,
    start: string,
    end: string
  ): Promise<{ total: number; processed: number; successCount: number; failCount: number; aborted: boolean }> {
    const records = await db.fetchPendingByDate(cfg, start, end);
    const total = records.length;
    send(win, "submit:event", { type: "phase", message: `Found ${total} record(s) to submit` });

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
      send(win, "submit:event", {
        type: "sending",
        guest_check_id: guestCheckId,
        index: i + 1,
        total,
        message: `Sending ${guestCheckId}`,
      });

      // tsms.submitOne() is a straight port of tsms_common.py::submit_one():
      // it builds the transaction/submission envelope with checksums,
      // sends it, handles the 409 (regenerate transaction_id) and 422
      // (checksum/validation retry) cases internally, then -- for a void
      // row -- submits first and voids the SAME transaction right after
      // (with the race-condition retry for "not yet indexed" responses).
      // It also writes every DB side effect itself (record_attempt,
      // mark_submitted/voided/rate_limited/failed), exactly like the
      // Python version, so we don't duplicate any of that here.
      //
      // Unlike the previous placeholder logic, this does NOT loop
      // multiple full-submission attempts in a tight retry loop -- a
      // "retryable" outcome here means the row's retry_count/
      // next_retry_at were updated and it'll be picked up again the next
      // time submit:by-date-range (or a future poller) runs, same as the
      // Python worker's poll cycle.
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
        message: `${guestCheckId}: ${result.message}`,
      });

      processed++;
    }

    send(win, "submit:event", {
      type: failCount === 0 ? "success" : "failed_retry",
      message: `Done: ${successCount} submitted, ${failCount} failed, ${processed}/${total} processed`,
    });

    return { total, processed, successCount, failCount, aborted: controller.abort };
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
   * "Submit Today" -- inserts today's transactions from v_salesdetails into
   * the staging table (the same aggregation as "Get Data" / db:transfer),
   * then immediately submits every pending row for that date through the
   * normal batch submit path. The renderer shows a confirmation modal with
   * today's date before invoking this, so on confirm this runs the whole
   * insert + submit pipeline in one go and streams progress back via the
   * usual submit:event channel.
   */
  ipcMain.handle("submit:today", async () => {
    const cfg = loadConfig();
    const win = getWindow();
    controller = { abort: false, paused: false, pauseNotified: false };

    const today = new Date().toISOString().slice(0, 10);
    send(win, "submit:event", { type: "phase", message: `Submitting today's transactions for ${today}` });

    // Step 1: insert today's transactions into the staging table.
    send(win, "submit:event", { type: "phase", message: `Inserting today's transactions for ${today}...` });
    let inserted = 0;
    try {
      inserted = await db.transfer(cfg, today, today);
      send(win, "submit:event", {
        type: "success",
        message: `Inserted ${inserted} new transaction(s) for today`,
      });
    } catch (e: any) {
      send(win, "submit:event", {
        type: "failed_terminal",
        message: `Insert failed: ${e?.message ?? String(e)}`,
      });
      return { today, inserted, total: 0, processed: 0, successCount: 0, failCount: 0, aborted: false };
    }

    // Step 2: submit every pending row for today through the shared batch.
    const result = await runSubmitBatch(cfg, win, today, today);

    send(win, "submit:event", {
      type: "phase",
      message: `Finished: ${inserted} inserted, ${result.successCount} submitted, ${result.failCount} failed`,
    });

    return { today, inserted, ...result };
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
}