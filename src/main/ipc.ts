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
}