import { ipcMain, BrowserWindow } from "electron";
import { AppConfig, loadConfig, saveConfig, getConfigFilePath } from "./config";
import * as db from "./db";
import * as tsms from "./tsms";

interface SubmitController {
  abort: boolean;
  paused: boolean;
}

let controller: SubmitController = { abort: false, paused: false };

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

  ipcMain.handle(
    "submit:by-date-range",
    async (_e, args: { start: string; end: string }) => {
      const cfg = loadConfig();
      const win = getWindow();
      controller = { abort: false, paused: false };

      const records = await db.fetchPendingByDate(cfg, args.start, args.end);
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
          send(win, "submit:event", { type: "phase", message: "Paused" });
          await sleep(400);
        }
        if (controller.abort) break;

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
  );

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

  ipcMain.handle("submit:void", async (_e, guestCheckId: string) => {
    const cfg = loadConfig();
    const rec = await db.fetchRecordByGuestCheckId(cfg, guestCheckId);
    if (!rec) return { ok: false, message: "Record not found" };
    if (!rec.transaction_id) return { ok: false, message: "No TRANSACTION_ID found" };

    // Manual void: the transaction_id here was already accepted by TSMS at
    // some point in the past (however long ago the row was submitted), so
    // there's no post-submit indexing race to guard against -- plain
    // voidTransaction() is correct here, unlike the post-submit path in
    // submitOne() which uses voidTransactionAfterSubmit().
    const result = await tsms.voidTransaction(cfg, rec.transaction_id);
    if (result.outcome === "success") {
      await db.markVoided(cfg, guestCheckId, {});
      return { ok: true, message: "Voided" };
    }
    return { ok: false, message: result.message };
  });
}