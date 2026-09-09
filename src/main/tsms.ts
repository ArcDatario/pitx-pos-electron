import axios from "axios";
import * as crypto from "crypto";
import { randomUUID } from "crypto";
import { AppConfig } from "./config";
import * as db from "./db";

/**
 * 1:1 port of tsms_common.py's submission logic (build_transaction,
 * build_submission, submit_payload, classify_response, submit_one,
 * void_transaction, void_transaction_after_submit).
 *
 * Rules from the TSMS POS Integration Guidelines v2.1.1 this module
 * enforces (same as the Python side):
 *   - transaction_id is generated ONCE when a row becomes 'pending' and is
 *     never regenerated on retry (Sec 13.4) -- EXCEPT the one deliberate
 *     case: a 409 conflict on a still-'pending' row gets a fresh
 *     transaction_id, which is then used consistently for the rest of that
 *     attempt (including any void call) -- see the note on the 409 branch
 *     below; an earlier version of this logic left that id stale, which
 *     caused post-submit voids to fail with "Transaction not found".
 *   - submission_uuid is a fresh envelope id per API *attempt* (Sec 6.1).
 *   - A 200 response with status/code "already_processed" counts as
 *     success (Sec 10 - idempotent duplicate).
 *   - 401/403/409/422 are terminal ("stop and fix") -- not retried
 *     automatically (Sec 12.2).
 *   - 429 respects Retry-After and does NOT consume retry budget (Sec 13.2).
 *   - 5xx/network errors use exponential backoff 2/4/8/16/32s (Sec 13.1).
 *   - A void that immediately follows a successful submit of the SAME
 *     transaction_id gets a short grace period + retries if TSMS reports
 *     "not found" -- the submit can be accepted before TSMS has finished
 *     indexing it for the void endpoint (see void_transaction_after_submit
 *     below).
 */

// TSMS Sec 13.1 -- exponential backoff for retryable (5xx/network) failures
export const BACKOFF_SECONDS = [2, 4, 8, 16, 32];
// TSMS Sec 13.2 -- default pause if a 429 response has no Retry-After header
export const DEFAULT_RATE_LIMIT_SECONDS = 60;
// TSMS Sec 12.2 -- these are "stop and fix", never auto-retried
export const TERMINAL_HTTP_STATUS = new Set([401, 403, 409, 422]);

export type Outcome = "success" | "rate_limited" | "retryable" | "terminal";

export interface ApiResult {
  outcome: Outcome;
  message: string;
  data: any;
  httpCode: number | null;
  headers?: Record<string, any>;
}

export interface SubmitOneResult extends ApiResult {
  transactionId?: string;
  submission?: any;
}

// ---------------------------------------------------------------------------
// Auth / misc
// ---------------------------------------------------------------------------
export function normalizeBearerToken(rawToken: string | undefined | null): string {
  const token = (rawToken ?? "").trim();
  if (token.toLowerCase().startsWith("bearer ")) return token.slice(7).trim();
  return token;
}

// ---------------------------------------------------------------------------
// Checksums / payload construction (TSMS Sec 9)
// ---------------------------------------------------------------------------
export function tsmsAmount(n: number | string | null | undefined): string {
  return Number(n ?? 0).toFixed(2);
}

export function tsmsGenerateUuidV4(): string {
  return randomUUID();
}

export function tsmsIsoTimestampNow(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`
    + `T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
    + `.${pad(now.getUTCMilliseconds(), 3)}Z`;
}

/** Converts a JS Date/string/null into an ISO-8601 string with millisecond
 * precision. Falls back to "now" only if nothing usable was given -- in
 * normal operation this always comes from transdatetime, so it stays
 * stable across every rebuild of the same transaction. */
function formatIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return tsmsIsoTimestampNow();
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return tsmsIsoTimestampNow();
  return d.toISOString().replace(/Z$/, "").slice(0, 23) + "Z";
}

/** Recursively sorts object keys so the checksum is stable regardless of
 * property insertion order -- mirrors tsms_sort_keys_recursive(). */
function sortKeysRecursive(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysRecursive);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysRecursive(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Recursively replaces undefined with null so JSON.stringify matches
 * Python's json.dumps(ensure_ascii=False) behavior for checksum inputs. */
function normalizeUndefined(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeUndefined);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      normalized[key] = value[key] === undefined ? null : normalizeUndefined(value[key]);
    }
    return normalized;
  }
  return value;
}

/** Matches Python's json.dumps(sorted_data, separators=(",", ":"), ensure_ascii=False) --
 * compact, no whitespace, keys already pre-sorted by sortKeysRecursive. */
export function tsmsChecksum(data: any): string {
  const sorted = sortKeysRecursive(data);
  const normalized = normalizeUndefined(sorted);
  const jsonStr = JSON.stringify(normalized);
  return crypto.createHash("sha256").update(jsonStr, "utf-8").digest("hex");
}

/** Record shape as read back from dbo.dts_pitx_payload -- uppercase-keyed,
 * mirroring how the Python side normalizes `rec = {k.upper(): v ...}`
 * before building a transaction. */
export function upperCaseKeys(rec: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(rec)) out[k.toUpperCase()] = v;
  return out;
}

/**
 * Rebuilds the transaction object to match the TSMS payload format:
 * {
 *   transaction_id, hardware_id, receipt_no, transaction_timestamp,
 *   gross_sales, net_sales, promo_status, customer_code,
 *   payload_checksum, adjustments[], taxes[]
 * }
 * receipt_no uses a generated value when auto_receipt_no is enabled;
 * otherwise it is taken directly from the database record (RECEIPT_NO).
 */
export function buildTransaction(cfg: AppConfig, agg: Record<string, any>, transactionId: string) {
  const tcfg = cfg.tsms;
  const grossSales = Number(agg.GROSS_SALES ?? 0);
  const netSales = Number(agg.NETSALES ?? 0);
  const vatAmount = Number(agg.VAT ?? 0);
  const lessPwd = Number(agg.LESSPWD ?? 0);
  const lessSc = Number(agg.LESSSC ?? 0);
  const lessSolo = Number(agg.LESSSOLOPARENT ?? 0);
  const lessNational = Number(agg.LESSNTNLATH ?? 0);
  const lessEmp = Number(agg.LESSEMP ?? 0);
  const lessVat = Number(agg.SC_VAT_EXCEMPT_SALES ?? 0);
  const serviceCharge = Number(agg.GC_SALES ?? 0);
  const vatableSales = Number(agg.VATABLE_SALES ?? 0);
  const gcExcess = Number(agg.GC_EXCESS ?? 0);
  const otherTax = Number(agg.OTHER_TAX ?? 0);
  const promoDiscountTotal = lessNational + lessSolo;
  const promoStatus = promoDiscountTotal > 0 ? "WITH_APPROVAL" : "NONE";

  const txn: Record<string, any> = {
    transaction_id: transactionId,
    hardware_id: tcfg.hardware_id ?? null,
    receipt_no: cfg.tsms.auto_receipt_no ? `AUTO-${transactionId}` : (agg.RECEIPT_NO ?? null),
    transaction_timestamp: formatIso(agg.TRANSDATETIME ?? agg.BUSINESSDATE),
    gross_sales: tsmsAmount(grossSales),
    net_sales: tsmsAmount(netSales),
    promo_status: promoStatus,
    customer_code: tcfg.customer_code ?? null,
    payload_checksum: "",
    adjustments: [
      { adjustment_type: "promo_discount", amount: tsmsAmount(promoDiscountTotal) },
      { adjustment_type: "senior_discount", amount: tsmsAmount(lessSc) },
      { adjustment_type: "pwd_discount", amount: tsmsAmount(lessPwd) },
      { adjustment_type: "vip_card_discount", amount: tsmsAmount(0) },
      { adjustment_type: "service_charge_distributed_to_employees", amount: tsmsAmount(serviceCharge) },
      { adjustment_type: "service_charge_retained_by_management", amount: tsmsAmount(gcExcess) },
      { adjustment_type: "employee_discount", amount: tsmsAmount(lessEmp) },
    ],
    taxes: [
      { tax_type: "VAT", amount: tsmsAmount(vatAmount) },
      { tax_type: "VATABLE_SALES", amount: tsmsAmount(vatableSales) },
      { tax_type: "SC_VAT_EXEMPT_SALES", amount: tsmsAmount(lessVat) },
      { tax_type: "OTHER_TAX", amount: tsmsAmount(otherTax) },
    ],
  };

  const checksumInput = { ...txn };
  delete checksumInput.payload_checksum;
  txn.payload_checksum = tsmsChecksum(checksumInput);
  return txn;
}

/**
 * submission_uuid + submission_timestamp are generated fresh on every
 * call -- an envelope id per attempt (Sec 6.1), not immutable business
 * data -- so retries legitimately get a new one each time. 1:1 port of
 * build_submission().
 */
export function buildSubmission(cfg: AppConfig, txn: Record<string, any>) {
  const tcfg = cfg.tsms;
  const submission: Record<string, any> = {
    submission_uuid: tsmsGenerateUuidV4(),
    tenant_id: tcfg.tenant_id ?? null,
    terminal_id: tcfg.terminal_id ?? null,
    submission_timestamp: tsmsIsoTimestampNow(),
    transaction_count: 1,
    payload_checksum: "",
    transaction: txn,
  };
  const checksumInput = { ...submission };
  delete checksumInput.payload_checksum;
  submission.payload_checksum = tsmsChecksum(checksumInput);
  return submission;
}

function httpClient(cfg: AppConfig, timeoutMs = 30000) {
  const token = normalizeBearerToken(cfg.tsms.api_token);
  return axios.create({
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "TSMS-PITX-Desktop/1.0",
    },
    timeout: timeoutMs,
    validateStatus: () => true, // classify_response() decides what each status means
  });
}

export interface RawResponse {
  httpCode: number | null;
  data: any;
  headers: Record<string, any>;
  networkError: string | null;
}

/** 1:1 port of submit_payload(): POSTs the full submission envelope to
 * cfg.tsms.api_url and returns the raw response for classify_response(). */
export async function submitPayload(cfg: AppConfig, submission: Record<string, any>): Promise<RawResponse> {
  try {
    const res = await httpClient(cfg).post(cfg.tsms.api_url, submission);
    let data = res.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    return { httpCode: res.status, data, headers: res.headers as any, networkError: null };
  } catch (e: any) {
    return { httpCode: null, data: null, headers: {}, networkError: e?.message ?? String(e) };
  }
}

/** Maps a raw API response to one of success / rate_limited / retryable /
 * terminal, per the Action Matrix in Sec 12.2. 1:1 port of
 * classify_response(). */
export function classifyResponse(httpCode: number | null, data: any, networkError: string | null): { outcome: Outcome; message: string } {
  if (networkError) return { outcome: "retryable", message: `Network error: ${networkError}` };
  if (httpCode === null) return { outcome: "retryable", message: "No response from server" };
  if (httpCode >= 200 && httpCode < 300) {
    if (data && typeof data === "object") {
      if (data.status === "already_processed" || data.code === "already_processed") {
        return { outcome: "success", message: data.message ?? "Already processed (idempotent duplicate)" };
      }
      if (data.success === true) {
        return { outcome: "success", message: data.message ?? "Accepted" };
      }
    }
    return { outcome: "retryable", message: `Unexpected HTTP ${httpCode} response body` };
  }
  if (httpCode === 429) return { outcome: "rate_limited", message: data?.message ?? "Rate limited (429)" };
  if (TERMINAL_HTTP_STATUS.has(httpCode)) return { outcome: "terminal", message: data?.message ?? `HTTP ${httpCode}` };
  if (httpCode >= 500) return { outcome: "retryable", message: data?.message ?? `Server error (HTTP ${httpCode})` };
  return { outcome: "terminal", message: data?.message ?? `Unhandled HTTP ${httpCode}` };
}

/** True if the API response indicates an INVALID_CHECKSUM or
 * VALIDATION_FAILED error that warrants a one-time retry with a rebuilt
 * payload -- 1:1 port of _is_checksum_or_validation_error(). */
function isChecksumOrValidationError(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  const text = JSON.stringify(data).toLowerCase();
  return text.includes("invalid_checksum") || text.includes("validation_failed") || text.includes("invalid checksum");
}

/** Calls the TSMS void endpoint for a transaction that was voided at the
 * POS before the business day closed (Sec 17.1). 1:1 port of
 * void_transaction(). */
export async function voidTransaction(cfg: AppConfig, transactionId: string, voidReason = "Voided at POS"): Promise<ApiResult> {
  const tcfg = cfg.tsms;
  const voidPayload: Record<string, any> = {
    transaction_id: transactionId,
    void_reason: voidReason,
    payload_checksum: "",
  };
  const checksumInput = { ...voidPayload };
  delete checksumInput.payload_checksum;
  voidPayload.payload_checksum = tsmsChecksum(checksumInput);

  const url = tcfg.api_url.replace(/\/[^/]*$/, "") + `/${transactionId}/void`;

  let res;
  try {
    res = await httpClient(cfg).post(url, voidPayload);
  } catch (e: any) {
    return { outcome: "retryable", message: `Could not reach TSMS void API: ${e?.message ?? e}`, data: null, httpCode: null };
  }

  let data = res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }

  if (res.status >= 200 && res.status < 300) {
    if (data && typeof data === "object" && data.success === true) {
      return { outcome: "success", message: data.message ?? "Void accepted", data, httpCode: res.status };
    }
    if (data && typeof data === "object" && data.status === "already_processed") {
      return { outcome: "success", message: data.message ?? "Already voided (idempotent)", data, httpCode: res.status };
    }
    return { outcome: "retryable", message: `Unexpected HTTP ${res.status} void response`, data, httpCode: res.status };
  }
  if (res.status === 429) {
    return { outcome: "rate_limited", message: data?.message ?? "Rate limited (429)", data, httpCode: res.status, headers: res.headers as any };
  }
  return { outcome: "terminal", message: data?.message ?? `Void failed (HTTP ${res.status})`, data, httpCode: res.status };
}

/** True if a void failure looks like TSMS hasn't finished indexing a
 * transaction we JUST submitted a moment ago (race/eventual-consistency),
 * as opposed to a genuinely invalid transaction_id. */
function looksLikeNotYetIndexed(message: string | null | undefined): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return text.includes("not found") || text.includes("does not belong");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wraps voidTransaction() with a short grace period for the case where we
 * just called submitPayload() successfully and are voiding the SAME
 * transaction_id in (near) the same breath. TSMS can accept a submission
 * and index/process it asynchronously, so an immediate void can race ahead
 * of that and come back "Transaction not found" even though the submit
 * genuinely succeeded. Only retries that specific not-yet-indexed case --
 * any other outcome (success, rate_limited, or a genuinely terminal error)
 * is returned immediately on the first try. 1:1 port of
 * void_transaction_after_submit().
 */
export async function voidTransactionAfterSubmit(
  cfg: AppConfig,
  transactionId: string,
  voidReason = "Voided at POS",
  attempts = 3,
  delaySeconds = 5
): Promise<ApiResult> {
  let result: ApiResult = { outcome: "terminal", message: "Void not attempted", data: null, httpCode: null };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      console.warn(
        `Void for ${transactionId} not yet indexed by TSMS (attempt ${attempt}/${attempts}): ${result.message} -- retrying in ${delaySeconds}s`
      );
      await sleep(delaySeconds * 1000);
    } else {
      await sleep(5000);
    }
    result = await voidTransaction(cfg, transactionId, voidReason);
    if (result.outcome !== "terminal" || !looksLikeNotYetIndexed(result.message)) {
      return result;
    }
  }
  return result;
}

function parseRetryAfter(headers: Record<string, any> | undefined): number | null {
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (value === undefined || value === null) return null;
  const n = parseInt(String(value), 10);
  return isNaN(n) ? null : n;
}

/**
 * Shared submission orchestration -- 1:1 port of tsms_common.py::submit_one().
 *
 * If the row is a void (voidtotal_qty != 0 or voidtotal_amt != 0), it's
 * first submitted as a normal transaction with positive values, then
 * immediately voided via the TSMS void endpoint (Sec 17.1). On success,
 * status becomes 'voided'.
 *
 * All DB side effects (ensuring/updating transaction_id, logging attempts,
 * marking submitted/voided/rate_limited/failed) are delegated to db.ts so
 * this stays testable and the SQL lives in one place, but the *sequencing*
 * and *outcome classification* below match the Python version exactly --
 * including keeping `transactionId` in sync after a 409 retry, which is
 * what makes the post-submit void target the transaction that was actually
 * accepted rather than a stale pre-409 id.
 */
export async function submitOne(cfg: AppConfig, rec: Record<string, any>): Promise<SubmitOneResult> {
  const guestCheckId = String(rec.GUESTCHECKID);
  const upper = upperCaseKeys(rec);
  const voidQty = Number(upper.VOIDTOTAL_QTY ?? 0);
  const voidAmt = Number(upper.VOIDTOTAL_AMT ?? 0);
  const isVoid = voidQty !== 0 || voidAmt !== 0;
  if (isVoid) {
    console.info(`[${guestCheckId}] VOID detected: qty=${voidQty}, amt=${voidAmt}`);
  }

  let transactionId = await db.ensureTransactionId(cfg, guestCheckId, upper.TRANSACTION_ID ?? null);

  let buildRec = upper;
  if (isVoid) {
    buildRec = { ...upper };
    const amountFields = [
      "NETSALES", "VAT_12", "LESSVAT", "LESSPWD", "GC_SALES", "GC_EXCESS",
      "VATABLE_SALES", "GROSS_SALES", "SC_VAT_EXCEMPT_SALES", "OTHER_TAX",
      "OTHERDISCOUNT", "VOIDTOTAL_AMT", "VOIDTOTAL_QTY",
    ];
    for (const field of amountFields) {
      const val = buildRec[field];
      if (val !== null && val !== undefined && Number(val) < 0) {
        buildRec[field] = String(Math.abs(Number(val)));
      }
    }
  }

  let txn = buildTransaction(cfg, buildRec, transactionId);
  let submission = buildSubmission(cfg, txn);

  let { httpCode, data, headers, networkError } = await submitPayload(cfg, submission);
  await db.recordAttempt(cfg, guestCheckId, submission, data, httpCode);
  let { outcome, message } = classifyResponse(httpCode, data, networkError);

  // 409 conflict on a still-pending row: TSMS already has a transaction under
  // this id, so generate a fresh one, persist it, and resubmit. `transactionId`
  // is reassigned here (not just the DB row) so every use below -- including
  // the post-submit void -- targets the transaction that actually got created.
  if (httpCode === 409 && String(upper.STATUS ?? "").toLowerCase() === "pending") {
    const newTransactionId = randomUUID();
    await db.updateTransactionId(cfg, guestCheckId, newTransactionId);
    transactionId = newTransactionId;

    txn = buildTransaction(cfg, buildRec, transactionId);
    submission = buildSubmission(cfg, txn);

    ({ httpCode, data, headers, networkError } = await submitPayload(cfg, submission));
    await db.recordAttempt(cfg, guestCheckId, submission, data, httpCode);
    ({ outcome, message } = classifyResponse(httpCode, data, networkError));
  }

  // 422 with an invalid-checksum/validation-failed body: rebuild once with a
  // fresh envelope and retry (transaction_id stays the same -- this is a
  // payload issue, not a conflict).
  if (httpCode === 422 && isChecksumOrValidationError(data)) {
    txn = buildTransaction(cfg, buildRec, transactionId);
    submission = buildSubmission(cfg, txn);

    ({ httpCode, data, headers, networkError } = await submitPayload(cfg, submission));
    await db.recordAttempt(cfg, guestCheckId, submission, data, httpCode);
    ({ outcome, message } = classifyResponse(httpCode, data, networkError));
  }

  if (outcome === "success") {
    if (isVoid) {
      console.info(`[${guestCheckId}] Transaction submitted OK, now calling void API...`);
      const voidResult = await voidTransactionAfterSubmit(cfg, transactionId);
      console.info(`[${guestCheckId}] Void API result: outcome=${voidResult.outcome}, http=${voidResult.httpCode}, message=${voidResult.message}`);
      await db.recordAttempt(cfg, guestCheckId, { transaction_id: transactionId, void_reason: "Voided at POS" }, voidResult.data, voidResult.httpCode);

      if (voidResult.outcome === "success") {
        await db.markVoided(cfg, guestCheckId, {
          submission_uuid: submission.submission_uuid,
          payload_checksum: submission.payload_checksum,
          submission_timestamp: submission.submission_timestamp,
        });
        console.info(`[${guestCheckId}] Successfully marked as voided.`);
        return {
          outcome: "success",
          message: `Submitted then voided: ${voidResult.message}`,
          data: voidResult.data,
          httpCode: voidResult.httpCode,
          transactionId,
          submission,
        };
      }
      if (voidResult.outcome === "rate_limited") {
        const retryAfter = parseRetryAfter(voidResult.headers) ?? DEFAULT_RATE_LIMIT_SECONDS;
        await db.markRateLimited(cfg, guestCheckId, retryAfter, `Submitted but void rate-limited: ${voidResult.message}`);
        return {
          outcome: "retryable",
          message: `Submitted but void rate-limited: ${voidResult.message}`,
          data: voidResult.data,
          httpCode: voidResult.httpCode,
          transactionId,
          submission,
        };
      }
      const currentRetryCount = Number(upper.RETRY_COUNT ?? 0);
      await db.markFailed(cfg, guestCheckId, `Submitted but void failed: ${voidResult.message}`, currentRetryCount, cfg.worker.max_retries, 0);
      return {
        outcome: "retryable",
        message: `Submitted but void failed: ${voidResult.message}`,
        data: voidResult.data,
        httpCode: voidResult.httpCode,
        transactionId,
        submission,
      };
    }
    await db.markSubmitted(cfg, guestCheckId, submission);
    console.info(`[${guestCheckId}] Successfully marked as submitted.`);
  } else if (outcome === "rate_limited") {
    const retryAfter = parseRetryAfter(headers) ?? DEFAULT_RATE_LIMIT_SECONDS;
    await db.markRateLimited(cfg, guestCheckId, retryAfter, message);
  } else if (outcome === "retryable") {
    const currentRetryCount = Number(upper.RETRY_COUNT ?? 0);
    const backoff = BACKOFF_SECONDS[Math.min(currentRetryCount, BACKOFF_SECONDS.length - 1)];
    await db.markFailed(cfg, guestCheckId, message, currentRetryCount, cfg.worker.max_retries, backoff);
  } else if (httpCode === 422) {
    await db.markRateLimited(cfg, guestCheckId, 60, `422 validation error (kept for retry): ${message}`);
  } else {
    // terminal (401/403/409-not-pending)
    const currentRetryCount = Number(upper.RETRY_COUNT ?? 0);
    await db.markFailed(cfg, guestCheckId, message, currentRetryCount, cfg.worker.max_retries, 0);
  }

  return { outcome, message, data, httpCode, transactionId, submission };
}

export async function previewPayload(cfg: AppConfig, rec: Record<string, any>): Promise<any> {
  const guestCheckId = String(rec.GUESTCHECKID);
  const upper = upperCaseKeys(rec);
  const voidQty = Number(upper.VOIDTOTAL_QTY ?? 0);
  const voidAmt = Number(upper.VOIDTOTAL_AMT ?? 0);
  const isVoid = voidQty !== 0 || voidAmt !== 0;

  let transactionId = await db.ensureTransactionId(cfg, guestCheckId, upper.TRANSACTION_ID ?? null);

  let buildRec = upper;
  if (isVoid) {
    buildRec = { ...upper };
    const amountFields = [
      "NETSALES", "VAT_12", "LESSVAT", "LESSPWD", "GC_SALES", "GC_EXCESS",
      "VATABLE_SALES", "GROSS_SALES", "SC_VAT_EXCEMPT_SALES", "OTHER_TAX",
      "OTHERDISCOUNT", "VOIDTOTAL_AMT", "VOIDTOTAL_QTY",
    ];
    for (const field of amountFields) {
      const val = buildRec[field];
      if (val !== null && val !== undefined && Number(val) < 0) {
        buildRec[field] = String(Math.abs(Number(val)));
      }
    }
  }

  const txn = buildTransaction(cfg, buildRec, transactionId);
  const submission = buildSubmission(cfg, txn);
  return submission;
}