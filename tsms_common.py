"""
tsms_common.py

Shared code used by both tsms_worker.py (background service) and
tsms_desktop.py (config/monitor GUI).

Key rules from TSMS POS Integration Guidelines v2.1.1 this module enforces:
  - transaction_id + transaction_checksum are immutable once generated
    (Sec 13.4) -- transaction_id is generated ONCE when a row is aggregated
    into 'pending' state and never regenerated on retry.
  - submission_uuid is a fresh envelope id per API *attempt* (Sec 6.1) --
    generated at send time, only persisted to the row on success.
  - A 200 response with status/code "already_processed" counts as success
    (Sec 10 - idempotent duplicate).
  - 401/403/409/422 are terminal ("stop and fix") -- not retried
    automatically (Sec 12.2).
  - 429 respects Retry-After and does NOT consume retry budget (Sec 13.2).
  - 5xx/network errors use exponential backoff 2/4/8/16/32s (Sec 13.1).
"""
import datetime
import hashlib
import json
import logging
import os
import time
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pyodbc
import requests
from cryptography.fernet import Fernet

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
APP_DIR = Path(os.environ.get("PROGRAMDATA", str(Path.home()))) / "TSMS"
APP_DIR.mkdir(parents=True, exist_ok=True)

CONFIG_PATH = APP_DIR / "config.json"
KEY_PATH = APP_DIR / "config.key"
LOG_PATH = APP_DIR / "logs" / "worker.log"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
LOCK_PATH = APP_DIR / "worker.lock"

SENSITIVE_FIELDS = [("sqlserver", "password"), ("tsms", "api_token")]

DEFAULT_CONFIG = {
    "sqlserver": {
        "server": "192.168.5.38",
        "database": "OracleDB",
        "username": "sa",
        "password": "",
        "driver": "ODBC Driver 17 for SQL Server",
    },
    "tsms": {
        "api_url": "https://stagingtsms.pitx.com.ph/api/v1/transactions/official",
        "api_token": "",
        "tenant_id": 26,
        "terminal_id": 131,
        "hardware_id": "4312BDC02001242",
        "customer_code": "C-C1031",
    },
    "filters": {
        "locationname": "PH085-PITX",
        "storenum": "2067",
        "lookback_days": 3,
    },
    "worker": {
        "poll_interval_seconds": 60,
        "batch_size": 100,
        "max_retries": 5,
    },
}

DISCOUNT_EXCLUSIONS = (
    "Employee Discount", "Less: PWD Disc", "Less: Sr Citizen Disc", "Less: VAT",
    "National Athlete", "Solo Parent 20%", "Solo Parent Max", "Solo Parent 5%",
    "NAC Disc",
)

# TSMS Sec 13.1 -- exponential backoff for retryable (5xx/network) failures
BACKOFF_SECONDS = [2, 4, 8, 16, 32]
# TSMS Sec 13.2 -- default pause if a 429 response has no Retry-After header
DEFAULT_RATE_LIMIT_SECONDS = 60
# TSMS Sec 12.2 -- these are "stop and fix", never auto-retried
TERMINAL_HTTP_STATUS = {401, 403, 409, 422}

TABLE_NAME = "tsmp_agg_data"

# ---------------------------------------------------------------------------
# Config: encrypted at rest, plain in memory
# ---------------------------------------------------------------------------
def _get_fernet():
    if KEY_PATH.exists():
        key = KEY_PATH.read_bytes()
    else:
        key = Fernet.generate_key()
        KEY_PATH.write_bytes(key)
        try:
            os.chmod(KEY_PATH, 0o600)
        except Exception:
            pass
    return Fernet(key)


def _encrypt(value):
    if not value:
        return value
    return "enc:" + _get_fernet().encrypt(str(value).encode()).decode()


def _decrypt(value):
    if not value or not str(value).startswith("enc:"):
        return value
    return _get_fernet().decrypt(str(value)[4:].encode()).decode()


def _deep_merge_defaults(cfg):
    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    for section, values in cfg.items():
        merged.setdefault(section, {})
        if isinstance(values, dict):
            merged[section].update(values)
        else:
            merged[section] = values
    return merged


def load_config():
    if not CONFIG_PATH.exists():
        save_config(DEFAULT_CONFIG)
        return json.loads(json.dumps(DEFAULT_CONFIG))

    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        raw = json.load(fh)

    for section, field in SENSITIVE_FIELDS:
        if section in raw and field in raw[section]:
            raw[section][field] = _decrypt(raw[section][field])

    return _deep_merge_defaults(raw)


def save_config(cfg):
    to_write = json.loads(json.dumps(cfg))
    for section, field in SENSITIVE_FIELDS:
        if section in to_write and field in to_write[section]:
            to_write[section][field] = _encrypt(to_write[section][field])
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(to_write, fh, indent=2)


def normalize_bearer_token(raw_token):
    """Accepts the token with or without a 'Bearer ' prefix already on it
    (both are common copy/paste mistakes) and returns just the raw token."""
    token = str(raw_token or "").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
PROJECT_DIR = Path(__file__).parent
APP_DATA_LOG_PATH = PROJECT_DIR / "logs" / "logs_data.txt"
APP_DATA_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


def get_logger():
    logger = logging.getLogger("tsms")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)

    file_handler = RotatingFileHandler(LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(file_handler)

    app_data_handler = logging.FileHandler(APP_DATA_LOG_PATH, encoding="utf-8")
    app_data_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(app_data_handler)

    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(console)

    return logger


def _emit(progress, event_type, **kwargs):
    if progress is None:
        return
    try:
        progress({"type": event_type, **kwargs})
    except Exception:
        pass


def tail_log(n_lines=300):
    if not LOG_PATH.exists():
        return "(no log file yet)"
    with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    return "".join(lines[-n_lines:])


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def get_db_connection(cfg):
    sc = cfg["sqlserver"]
    conn_str = (
        f"DRIVER={{{sc['driver']}}};"
        f"SERVER={sc['server']};"
        f"DATABASE={sc['database']};"
        f"UID={sc['username']};"
        f"PWD={sc['password']};"
        f"TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn_str)


def fetch_pending(conn, cfg):
    """Everything in tsmp_agg_data that isn't submitted yet -- both fresh
    'pending' rows and 'failed' rows still under max_retries -- as long as
    any rate-limit/backoff window on it has elapsed. dts_details is never
    touched here; this only reads tsmp_agg_data. If cfg['filters']['locationname']
    is set, only that location's rows are submitted (useful if the table
    ever holds more than one store's data); leave it blank to submit
    everything regardless of location."""
    location = (cfg.get("filters") or {}).get("locationname")
    cur = conn.cursor()
    sql = f"""
        SELECT * FROM dbo.{TABLE_NAME}
        WHERE status NOT IN ('submitted', 'voided')
          AND (status = 'pending' OR retry_count < ?)
          AND (next_retry_at IS NULL OR next_retry_at <= SYSDATETIME())
    """
    params = [cfg["worker"]["max_retries"]]
    if location:
        sql += " AND locationname = ?"
        params.append(location)
    sql += " ORDER BY businessdate, GUESTCHECKID"
    cur.execute(sql, params)
    columns = [c[0].upper() for c in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def ensure_transaction_id(conn, guest_check_id, existing_transaction_id):
    """transaction_id must stay fixed across retries (Sec 13.4). Rows are no
    longer created by this app (aggregation into tsmp_agg_data now happens
    elsewhere), so this is a safety net: if a row shows up without one, it's
    generated once here and persisted immediately, before the first send
    attempt -- never regenerated afterwards."""
    if existing_transaction_id:
        return existing_transaction_id
    new_id = str(uuid.uuid4())
    cur = conn.cursor()
    cur.execute(
        f"UPDATE dbo.{TABLE_NAME} SET transaction_id = ?, updated_at = SYSDATETIME() "
        "WHERE GUESTCHECKID = ? AND transaction_id IS NULL",
        new_id, guest_check_id,
    )
    conn.commit()
    return new_id


def fetch_pending_by_date(conn, cfg, business_date):
    """Fetch all pending/failed rows for a specific businessdate, respecting
    max_retries and backoff windows, ordered by GUESTCHECKID."""
    location = (cfg.get("filters") or {}).get("locationname")
    cur = conn.cursor()
    sql = f"""
        SELECT * FROM dbo.{TABLE_NAME}
        WHERE businessdate = ?
          AND status NOT IN ('submitted', 'voided')
          AND (status = 'pending' OR retry_count < ?)
          AND (next_retry_at IS NULL OR next_retry_at <= SYSDATETIME())
    """
    params = [business_date, cfg["worker"]["max_retries"]]
    if location:
        sql += " AND locationname = ?"
        params.append(location)
    sql += " ORDER BY GUESTCHECKID"
    cur.execute(sql, params)
    columns = [c[0].upper() for c in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def submit_by_date(conn, cfg, business_date, progress=None, stop_event=None, pause_event=None):
    """Submit all pending/failed rows for a specific businessdate. Returns
    (attempted, succeeded, failed, errors)."""
    logger = get_logger()
    recs = fetch_pending_by_date(conn, cfg, business_date)
    total = len(recs)
    if not total:
        return 0, 0, 0, ["No pending/failed rows found for that date."]

    pending_count = sum(1 for r in recs if (r.get("STATUS") or "").lower() == "pending")
    failed_count = total - pending_count
    parts = []
    if pending_count:
        parts.append(f"{pending_count} pending")
    if failed_count:
        parts.append(f"{failed_count} failed (retryable)")
    logger.info(f"[Date:{business_date}] Submitting {' + '.join(parts)} ({total} total)...")

    succeeded = 0
    failed = 0
    errors = []
    for idx, rec in enumerate(recs, start=1):
        if stop_event and stop_event.is_set():
            break
        if pause_event and pause_event.is_set():
            _emit(progress, "phase", message="Paused...")
            while pause_event.is_set():
                time.sleep(0.1)
        guest_check_id = str(rec.get("GUESTCHECKID"))
        _emit(progress, "sending", guest_check_id=guest_check_id, index=idx, total=total,
              message=f"Date:{business_date} - Sending {guest_check_id} ({idx}/{total})...")
        try:
            outcome, message, data, http_code = submit_one(conn, cfg, rec, stop_event=stop_event)
            if outcome == "success":
                succeeded += 1
                logger.info(f"[Date:{business_date}][{guest_check_id}] manual date submit OK: {message}")
                _emit(progress, "success", guest_check_id=guest_check_id, message=f"{guest_check_id} submitted OK.")
            elif outcome == "rate_limited":
                logger.warning(f"[Date:{business_date}][{guest_check_id}] rate limited: {message}")
                _emit(progress, "rate_limited", guest_check_id=guest_check_id, message=f"{guest_check_id} rate limited - {message}")
            elif outcome == "retryable":
                failed += 1
                errors.append(f"{guest_check_id}: {message}")
                logger.warning(f"[Date:{business_date}][{guest_check_id}] failed, will retry: {message}")
                _emit(progress, "failed_retry", guest_check_id=guest_check_id, message=f"{guest_check_id} failed - {message}")
            else:
                failed += 1
                errors.append(f"{guest_check_id}: {message}")
                logger.error(f"[Date:{business_date}][{guest_check_id}] terminal failure: {message}")
                _emit(progress, "failed_terminal", guest_check_id=guest_check_id, message=f"{guest_check_id} failed permanently - {message}")
        except Exception as e:
            failed += 1
            errors.append(f"{guest_check_id}: {e}")
            logger.exception(f"[Date:{business_date}][{guest_check_id}] manual date submit error")
            _emit(progress, "failed_retry", guest_check_id=guest_check_id, message=f"{guest_check_id} error: {e}")

    logger.info(f"[Date:{business_date}] Date submit cycle complete. succeeded={succeeded}, failed={failed}")
    _emit(progress, "phase", message=f"Date:{business_date} cycle complete. succeeded={succeeded}, failed={failed}")
    return total, succeeded, failed, errors


def submit_by_date_range(conn, cfg, start_date, end_date, progress=None, stop_event=None, pause_event=None):
    """Submit all pending/failed rows for a date range. Returns
    (total_attempted, total_succeeded, total_failed, all_errors)."""
    from datetime import datetime, timedelta
    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    current = start
    grand_total = 0
    grand_succeeded = 0
    grand_failed = 0
    grand_errors = []
    while current <= end:
        if stop_event and stop_event.is_set():
            break
        if pause_event and pause_event.is_set():
            _emit(progress, "phase", message="Paused...")
            while pause_event.is_set():
                time.sleep(0.1)
        date_str = current.strftime("%Y-%m-%d")
        _emit(progress, "phase", message=f"Submitting date {date_str}...")
        try:
            attempted, succeeded, failed, errors = submit_by_date(conn, cfg, date_str, progress=progress, stop_event=stop_event, pause_event=pause_event)
            grand_total += attempted
            grand_succeeded += succeeded
            grand_failed += failed
            grand_errors.extend(errors)
        except Exception as e:
            grand_failed += 1
            grand_errors.append(f"{date_str}: {e}")
        current += timedelta(days=1)
    return grand_total, grand_succeeded, grand_failed, grand_errors


def fetch_records(conn, date_filter="", location_filter="", status_filter="", guestcheckid_filter="", limit=None, offset=None):
    cur = conn.cursor()
    sql = f"SELECT * FROM dbo.{TABLE_NAME} WHERE 1=1"
    params = []
    if date_filter:
        sql += " AND businessdate = ?"
        params.append(date_filter)
    if location_filter:
        sql += " AND locationname = ?"
        params.append(location_filter)
    if status_filter:
        sql += " AND status = ?"
        params.append(status_filter)
    if guestcheckid_filter:
        sql += " AND CAST(GUESTCHECKID AS NVARCHAR(MAX)) LIKE ?"
        params.append(f"%{guestcheckid_filter}%")
    sql += " ORDER BY businessdate DESC, GUESTCHECKID DESC"
    if limit is not None:
        sql += " OFFSET ? ROWS FETCH NEXT ? ROWS ONLY"
        params.extend([offset or 0, limit])
    cur.execute(sql, params)
    columns = [c[0].upper() for c in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def count_filtered_records(conn, date_filter="", location_filter="", status_filter="", guestcheckid_filter=""):
    cur = conn.cursor()
    sql = f"SELECT COUNT(*) FROM dbo.{TABLE_NAME} WHERE 1=1"
    params = []
    if date_filter:
        sql += " AND businessdate = ?"
        params.append(date_filter)
    if location_filter:
        sql += " AND locationname = ?"
        params.append(location_filter)
    if status_filter:
        sql += " AND status = ?"
        params.append(status_filter)
    if guestcheckid_filter:
        sql += " AND CAST(GUESTCHECKID AS NVARCHAR(MAX)) LIKE ?"
        params.append(f"%{guestcheckid_filter}%")
    cur.execute(sql, params)
    return cur.fetchone()[0]


def fetch_record_by_guestcheckid(conn, guest_check_id):
    cur = conn.cursor()
    sql = f"SELECT * FROM dbo.{TABLE_NAME} WHERE GUESTCHECKID = ?"
    cur.execute(sql, guest_check_id)
    columns = [c[0].upper() for c in cur.description]
    row = cur.fetchone()
    if row is None:
        return None
    return dict(zip(columns, row))


def fetch_status_counts(conn, date_filter="", location_filter=""):
    """Row counts grouped by status -- used for the Dashboard's totals bar.
    Deliberately ignores any status filter the user has applied to the
    table itself, so the breakdown stays meaningful (e.g. showing how many
    are pending/failed even while the table is filtered to just 'failed')."""
    cur = conn.cursor()
    sql = f"SELECT status, COUNT(*) FROM dbo.{TABLE_NAME} WHERE 1=1"
    params = []
    if date_filter:
        sql += " AND businessdate = ?"
        params.append(date_filter)
    if location_filter:
        sql += " AND locationname = ?"
        params.append(location_filter)
    sql += " GROUP BY status"
    cur.execute(sql, params)
    counts = {(row[0] or "unknown"): row[1] for row in cur.fetchall()}
    counts["total"] = sum(counts.values())
    return counts


def record_attempt(conn, guest_check_id, submission, response_data, http_code):
    """Logs every attempt -- success or failure -- so 'view details' always
    shows the full request payload and full API response, regardless of
    outcome."""
    cur = conn.cursor()
    cur.execute(
        f"""
        UPDATE dbo.{TABLE_NAME} SET
            last_payload_sent = ?,
            last_response_body = ?,
            last_response_code = ?,
            last_attempt_at = SYSDATETIME(),
            updated_at = SYSDATETIME()
        WHERE GUESTCHECKID = ?
        """,
        json.dumps(submission, indent=2, ensure_ascii=False),
        json.dumps(response_data, indent=2, ensure_ascii=False) if response_data is not None else None,
        http_code,
        guest_check_id,
    )
    conn.commit()


def mark_submitted(conn, guest_check_id, submission):
    """Only writes submission_uuid / submission_timestamp / both checksums
    once TSMS has actually accepted the transaction -- per your requirement
    that these stay blank until success. transaction_id was already set at
    aggregation time and is left untouched here."""
    cur = conn.cursor()
    cur.execute(
        f"""
        UPDATE dbo.{TABLE_NAME} SET
            status = 'submitted',
            submission_uuid = ?,
            submission_timestamp = SYSDATETIME(),
            submission_checksum = ?,
            transaction_checksum = ?,
            next_retry_at = NULL,
            last_error = NULL,
            updated_at = SYSDATETIME()
        WHERE GUESTCHECKID = ?
        """,
        submission["submission_uuid"],
        submission["payload_checksum"],
        submission["transaction"]["payload_checksum"],
        guest_check_id,
    )
    conn.commit()


def mark_voided(conn, guest_check_id, void_payload):
    """Marks a row as voided after a successful void API call."""
    cur = conn.cursor()
    cur.execute(
        f"""
        UPDATE dbo.{TABLE_NAME} SET
            status = 'voided',
            submission_uuid = ?,
            submission_timestamp = SYSDATETIME(),
            submission_checksum = ?,
            next_retry_at = NULL,
            last_error = NULL,
            updated_at = SYSDATETIME()
        WHERE GUESTCHECKID = ?
        """,
        void_payload.get("submission_uuid"),
        void_payload.get("payload_checksum"),
        guest_check_id,
    )
    conn.commit()


def mark_rate_limited(conn, guest_check_id, retry_after_seconds, message):
    """429 responses don't count against retry_count -- just pause and
    try again after the server-specified delay (Sec 13.2)."""
    cur = conn.cursor()
    cur.execute(
        f"""
        UPDATE dbo.{TABLE_NAME} SET
            last_error = ?,
            next_retry_at = DATEADD(SECOND, ?, SYSDATETIME()),
            updated_at = SYSDATETIME()
        WHERE GUESTCHECKID = ?
        """,
        message[:500],
        int(retry_after_seconds),
        guest_check_id,
    )
    conn.commit()


def mark_failed(conn, guest_check_id, message, current_retry_count, max_retries, backoff_seconds=0):
    """Used for every failure type (retryable 5xx/network AND terminal
    401/403/409/422) so both behave the same way in fetch_pending: retry_count
    increments by 1 per attempt, and the row stays eligible for resubmission
    until it's actually been tried max_retries times -- not instantly locked
    out after a single terminal error. (Terminal errors like a bad token are
    often fixed outside the payload -- e.g. updating the API token in
    Settings -- so it's reasonable to keep retrying them too; a 409 data
    conflict will just keep failing harmlessly until someone investigates.)
    backoff_seconds=0 means "eligible again next cycle" (used for terminal
    errors); a positive value applies exponential backoff (used for 5xx/
    network errors per Sec 13.1). Returns True once retries are exhausted."""
    new_count = current_retry_count + 1
    cur = conn.cursor()
    if backoff_seconds:
        cur.execute(
            f"""
            UPDATE dbo.{TABLE_NAME} SET
                status = 'failed',
                retry_count = ?,
                last_error = ?,
                next_retry_at = DATEADD(SECOND, ?, SYSDATETIME()),
                updated_at = SYSDATETIME()
            WHERE GUESTCHECKID = ?
            """,
            new_count, message[:500], backoff_seconds, guest_check_id,
        )
    else:
        cur.execute(
            f"""
            UPDATE dbo.{TABLE_NAME} SET
                status = 'failed',
                retry_count = ?,
                last_error = ?,
                next_retry_at = NULL,
                updated_at = SYSDATETIME()
            WHERE GUESTCHECKID = ?
            """,
            new_count, message[:500], guest_check_id,
        )
    conn.commit()
    return new_count >= max_retries


def reset_for_resubmit(conn, guest_check_id):
    """Used for a manual 'Resubmit' click. Refuses to touch a row that's
    already status='submitted' -- enforced here at the DB layer, not just
    in the GUI, so an already-accepted transaction can never be resent."""
    cur = conn.cursor()
    cur.execute(
        f"""
        UPDATE dbo.{TABLE_NAME} SET
            status = 'pending',
            retry_count = 0,
            next_retry_at = NULL,
            last_error = NULL,
            updated_at = SYSDATETIME()
        WHERE GUESTCHECKID = ? AND status <> 'submitted'
        """,
        guest_check_id,
    )
    conn.commit()
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Checksums / payload construction (TSMS Sec 9)
# ---------------------------------------------------------------------------
def tsms_amount(n):
    return f"{float(n):.2f}"


def tsms_generate_uuid_v4():
    return str(uuid.uuid4())


def tsms_iso_timestamp_now():
    now = datetime.datetime.utcnow()
    ms = int(now.microsecond / 1000)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


def _format_iso(value):
    """Converts a pyodbc DATETIME/DATE value (or None) into an ISO-8601
    string. Falls back to 'now' only if nothing usable was stored -- in
    normal operation this always comes from transdatetime, so it's stable
    across every rebuild of the same transaction."""
    if value is None:
        return tsms_iso_timestamp_now()
    if isinstance(value, str):
        return value
    if isinstance(value, datetime.date) and not isinstance(value, datetime.datetime):
        value = datetime.datetime.combine(value, datetime.time.min)
    ms = int(getattr(value, "microsecond", 0) / 1000)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


def tsms_receipt_no(businessdate, guest_check_id):
    """Unique per submission attempt for testing/resubmit support.
    Appends an 8-char hex suffix so each call produces a different receipt_no."""
    bd = str(businessdate)[:10].replace("-", "")
    unique = uuid.uuid4().hex[:8]
    return f"R{bd}-{guest_check_id}-{unique}"[:128]


def tsms_sort_keys_recursive(data):
    if isinstance(data, dict):
        return {k: tsms_sort_keys_recursive(v) for k, v in sorted(data.items())}
    if isinstance(data, list):
        return [tsms_sort_keys_recursive(i) for i in data]
    return data


def tsms_checksum(data):
    sorted_data = tsms_sort_keys_recursive(data)
    json_str = json.dumps(sorted_data, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(json_str.encode("utf-8")).hexdigest()


def build_transaction(cfg, agg, transaction_id):
    """Rebuilds the transaction object. Note: receipt_no is now unique per
    call (for testing/resubmit support), so the payload will differ across
    submission attempts even for the same row."""
    tcfg = cfg["tsms"]
    gross_sales = float(agg.get("GROSS_SALES", 0) or 0)
    net_sales = float(agg.get("NETSALES", 0) or 0)
    vat_amount = float(agg.get("VAT", 0) or 0)
    less_pwd = float(agg.get("LESSPWD", 0) or 0)
    less_sc = float(agg.get("LESSSC", 0) or 0)
    less_solo = float(agg.get("LESSSOLOPARENT", 0) or 0)
    less_national = float(agg.get("LESSNTNLATH", 0) or 0)
    less_emp = float(agg.get("LESSEMP", 0) or 0)
    less_vat = float(agg.get("SC_VAT_EXCEMPT_SALES", 0) or 0)
    service_charge = float(agg.get("GC_SALES", 0) or 0)
    vatable_sales = float(agg.get("VATABLE_SALES", 0) or 0)
    gc_excess = float(agg.get("GC_EXCESS", 0) or 0)
    other_tax = float(agg.get("OTHER_TAX", 0) or 0)
    promo_discount_total = less_national + less_solo
    promo_status = "WITHOUT_APPROVAL" if promo_discount_total > 0 else "NONE"

    txn = {
        "transaction_id": transaction_id,
        "hardware_id": tcfg["hardware_id"],
        "receipt_no": tsms_receipt_no(agg.get("BUSINESSDATE"), agg.get("GUESTCHECKID")),
        "transaction_timestamp": _format_iso(agg.get("TRANSDATETIME") or agg.get("BUSINESSDATE")),
        "gross_sales": tsms_amount(gross_sales),
        "net_sales": tsms_amount(net_sales),
        "promo_status": promo_status,
        "customer_code": tcfg.get("customer_code") or None,
        "payload_checksum": "",
        "adjustments": [
            {"adjustment_type": "promo_discount", "amount": tsms_amount(promo_discount_total)},
            {"adjustment_type": "senior_discount", "amount": tsms_amount(less_sc)},
            {"adjustment_type": "pwd_discount", "amount": tsms_amount(less_pwd)},
            {"adjustment_type": "vip_card_discount", "amount": tsms_amount(0)},
            {"adjustment_type": "service_charge_distributed_to_employees", "amount": tsms_amount(service_charge)},
            {"adjustment_type": "service_charge_retained_by_management", "amount": tsms_amount(gc_excess)},
            {"adjustment_type": "employee_discount", "amount": tsms_amount(less_emp)},
        ],
        "taxes": [
            {"tax_type": "VAT", "amount": tsms_amount(vat_amount)},
            {"tax_type": "VATABLE_SALES", "amount": tsms_amount(vatable_sales)},
            {"tax_type": "SC_VAT_EXEMPT_SALES", "amount": tsms_amount(less_vat)},
            {"tax_type": "OTHER_TAX", "amount": tsms_amount(other_tax)},
        ],
    }

    checksum_input = dict(txn)
    checksum_input.pop("payload_checksum")
    txn["payload_checksum"] = tsms_checksum(checksum_input)
    return txn


def build_submission(cfg, txn):
    """submission_uuid + submission_timestamp are generated fresh on every
    call -- they're an envelope id per attempt (Sec 6.1), not immutable
    business data -- so retries legitimately get a new one each time."""
    tcfg = cfg["tsms"]
    submission = {
        "submission_uuid": tsms_generate_uuid_v4(),
        "tenant_id": tcfg["tenant_id"],
        "terminal_id": tcfg["terminal_id"],
        "submission_timestamp": tsms_iso_timestamp_now(),
        "transaction_count": 1,
        "payload_checksum": "",
        "transaction": txn,
    }
    checksum_input = dict(submission)
    checksum_input.pop("payload_checksum")
    submission["payload_checksum"] = tsms_checksum(checksum_input)
    return submission


def submit_payload(cfg, submission):
    """Returns (http_code, response_json_or_None, response_headers, network_error_message)."""
    tcfg = cfg["tsms"]
    token = normalize_bearer_token(tcfg.get("api_token"))
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "TSMS-PITX-Worker/1.0",
    }
    body = json.dumps(submission, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    try:
        resp = requests.post(tcfg["api_url"], data=body, headers=headers, timeout=30, verify=True)
    except requests.RequestException as e:
        return None, None, {}, str(e)

    try:
        data = resp.json()
    except ValueError:
        data = None
    return resp.status_code, data, resp.headers, None


def void_transaction(cfg, transaction_id, void_reason="Voided at POS"):
    """Calls the TSMS void endpoint for a transaction that was voided at
    the POS before the business day closed (Sec 17.1). Returns
    (outcome, message, data, http_code)."""
    tcfg = cfg["tsms"]
    token = normalize_bearer_token(tcfg.get("api_token"))
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "TSMS-PITX-Worker/1.0",
    }
    void_payload = {
        "transaction_id": transaction_id,
        "void_reason": void_reason,
        "payload_checksum": "",
    }
    checksum_input = {k: v for k, v in sorted(void_payload.items()) if k != "payload_checksum"}
    void_payload["payload_checksum"] = tsms_checksum(checksum_input)
    body = json.dumps(void_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    url = tcfg["api_url"].rsplit("/", 1)[0] + f"/{transaction_id}/void"
    try:
        resp = requests.post(url, data=body, headers=headers, timeout=30, verify=True)
    except requests.RequestException as e:
        return "retryable", f"Could not reach TSMS void API: {e}", None, None

    try:
        data = resp.json()
    except ValueError:
        data = None

    if 200 <= resp.status_code < 300:
        if isinstance(data, dict) and data.get("success") is True:
            return "success", data.get("message", "Void accepted"), data, resp.status_code
        if isinstance(data, dict) and data.get("status") == "already_processed":
            return "success", data.get("message", "Already voided (idempotent)"), data, resp.status_code
        return "retryable", f"Unexpected HTTP {resp.status_code} void response", data, resp.status_code

    if resp.status_code == 429:
        return "rate_limited", (data or {}).get("message", "Rate limited (429)"), data, resp.status_code
    if resp.status_code in TERMINAL_HTTP_STATUS or resp.status_code >= 400:
        return "terminal", (data or {}).get("message", f"Void failed (HTTP {resp.status_code})"), data, resp.status_code
    return "terminal", (data or {}).get("message", f"Unhandled HTTP {resp.status_code}"), data, resp.status_code


def _looks_like_not_yet_indexed(message):
    """True if a void failure looks like TSMS hasn't finished indexing a
    transaction we JUST submitted a moment ago (race/eventual-consistency),
    as opposed to a genuinely invalid transaction_id."""
    if not message:
        return False
    text = str(message).lower()
    return "not found" in text or "does not belong" in text


def void_transaction_after_submit(cfg, transaction_id, void_reason="Voided at POS",
                                   attempts=3, delay_seconds=2):
    """Wraps void_transaction() with a short grace period for the case where
    we just called submit_payload() successfully and are voiding the SAME
    transaction_id in (near) the same breath. TSMS can accept a submission
    and index/process it asynchronously, so an immediate void can race ahead
    of that and come back 'Transaction not found' even though the submit
    genuinely succeeded. Only retries that specific not-yet-indexed case --
    any other outcome (success, rate_limited, or a genuinely terminal error)
    is returned immediately on the first try."""
    outcome = message = data = http_code = None
    for attempt in range(1, attempts + 1):
        outcome, message, data, http_code = void_transaction(cfg, transaction_id, void_reason)
        if outcome != "terminal" or not _looks_like_not_yet_indexed(message):
            return outcome, message, data, http_code
        if attempt < attempts:
            logging.getLogger("tsms").warning(
                f"Void for {transaction_id} not yet indexed by TSMS "
                f"(attempt {attempt}/{attempts}): {message} -- retrying in {delay_seconds}s"
            )
            time.sleep(delay_seconds)
    return outcome, message, data, http_code


def _parse_retry_after(headers):
    try:
        value = (headers or {}).get("Retry-After")
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def classify_response(http_code, data, network_error=None):
    """Maps an API response to one of: success / rate_limited / retryable /
    terminal, per the Action Matrix in Sec 12.2."""
    if network_error:
        return "retryable", f"Network error: {network_error}"
    if http_code is None:
        return "retryable", "No response from server"
    if 200 <= http_code < 300:
        if isinstance(data, dict):
            if data.get("status") == "already_processed" or data.get("code") == "already_processed":
                return "success", data.get("message", "Already processed (idempotent duplicate)")
            if data.get("success") is True:
                return "success", data.get("message", "Accepted")
        return "retryable", f"Unexpected HTTP {http_code} response body"
    if http_code == 429:
        return "rate_limited", (data or {}).get("message", "Rate limited (429)")
    if http_code in TERMINAL_HTTP_STATUS:
        return "terminal", (data or {}).get("message", f"HTTP {http_code}")
    if http_code >= 500:
        return "retryable", (data or {}).get("message", f"Server error (HTTP {http_code})")
    return "terminal", (data or {}).get("message", f"Unhandled HTTP {http_code}")


def submit_one(conn, cfg, rec, stop_event=None):
    """Shared by both the worker loop and the desktop app's manual
    Submit/Resubmit button, so both paths apply the exact same
    idempotency/backoff/logging rules. Returns (outcome, message, data, http_code).

    If the row is a void (VOIDTOTAL_QTY != 0 or VOIDTOTAL_AMT != 0), we first
    submit it as a normal transaction with positive values, then immediately
    void it via the TSMS void endpoint (Sec 17.1). On success, status becomes
    'voided'."""
    def _stopped():
        return stop_event is not None and stop_event.is_set()

    guest_check_id = str(rec.get("GUESTCHECKID"))
    rec = {k.upper(): v for k, v in rec.items()}
    void_qty = rec.get("VOIDTOTAL_QTY") or 0
    void_amt = rec.get("VOIDTOTAL_AMT") or 0
    is_void = float(void_qty) != 0 or float(void_amt) != 0
    if is_void:
        logging.getLogger("tsms").info(f"[{guest_check_id}] VOID detected: qty={void_qty}, amt={void_amt}")

    if _stopped():
        return "retryable", "Stopped by user", None, None

    transaction_id = ensure_transaction_id(conn, guest_check_id, rec.get("TRANSACTION_ID"))
    build_rec = dict(rec)

    if is_void:
        amount_fields = ["NETSALES", "VAT_12", "LESSVAT", "LESSPWD", "GC_SALES", "GC_EXCESS",
                        "VATABLE_SALES", "GROSS_SALES", "SC_VAT_EXCEMPT_SALES", "OTHER_TAX",
                        "OTHERDISCOUNT", "VOIDTOTAL_AMT", "VOIDTOTAL_QTY"]
        for field in amount_fields:
            val = build_rec.get(field)
            if val is not None and float(val) < 0:
                build_rec[field] = str(abs(float(val)))

    txn = build_transaction(cfg, build_rec if is_void else rec, transaction_id)
    submission = build_submission(cfg, txn)

    if _stopped():
        return "retryable", "Stopped by user", None, None

    http_code, data, headers, net_err = submit_payload(cfg, submission)
    record_attempt(conn, guest_check_id, submission, data, http_code)
    outcome, message = classify_response(http_code, data, net_err)

    if _stopped():
        return "retryable", "Stopped by user", None, None

    if http_code == 409 and (rec.get("STATUS") or "").lower() == "pending":
        new_transaction_id = str(uuid.uuid4())
        cur = conn.cursor()
        cur.execute(
            f"UPDATE dbo.{TABLE_NAME} SET transaction_id = ? WHERE GUESTCHECKID = ?",
            new_transaction_id, guest_check_id,
        )
        conn.commit()
        transaction_id = new_transaction_id  # keep the local id in sync with the DB so the
        # later void_transaction(cfg, transaction_id) call voids the transaction that was
        # actually submitted, not the stale pre-409 id.
        txn = build_transaction(cfg, rec, transaction_id)
        submission = build_submission(cfg, txn)

        if _stopped():
            return "retryable", "Stopped by user", None, None

        http_code, data, headers, net_err = submit_payload(cfg, submission)
        record_attempt(conn, guest_check_id, submission, data, http_code)
        outcome, message = classify_response(http_code, data, net_err)

    if _stopped():
        return "retryable", "Stopped by user", None, None

    if http_code == 422 and _is_checksum_or_validation_error(data):
        txn = build_transaction(cfg, rec, transaction_id)
        submission = build_submission(cfg, txn)

        if _stopped():
            return "retryable", "Stopped by user", None, None

        http_code, data, headers, net_err = submit_payload(cfg, submission)
        record_attempt(conn, guest_check_id, submission, data, http_code)
        outcome, message = classify_response(http_code, data, net_err)

    if _stopped():
        return "retryable", "Stopped by user", None, None

    if outcome == "success":
        if is_void:
            logging.getLogger("tsms").info(f"[{guest_check_id}] Transaction submitted OK, now calling void API...")

            if _stopped():
                return "retryable", "Stopped by user", None, None

            void_outcome, void_message, void_data, void_http = void_transaction_after_submit(cfg, transaction_id)
            logging.getLogger("tsms").info(f"[{guest_check_id}] Void API result: outcome={void_outcome}, http={void_http}, message={void_message}")
            record_attempt(conn, guest_check_id, {"transaction_id": transaction_id, "void_reason": "Voided at POS"}, void_data, void_http)

            if _stopped():
                return "retryable", "Stopped by user", None, None

            if void_outcome == "success":
                mark_voided(conn, guest_check_id, {"submission_uuid": submission["submission_uuid"], "payload_checksum": submission["payload_checksum"]})
                logging.getLogger("tsms").info(f"[{guest_check_id}] Successfully marked as voided.")
                return "success", f"Submitted then voided: {void_message}", void_data, void_http
            elif void_outcome == "rate_limited":
                retry_after = _parse_retry_after(getattr(void_data, "headers", {}) if void_data else {}) or DEFAULT_RATE_LIMIT_SECONDS
                mark_rate_limited(conn, guest_check_id, retry_after, f"Submitted but void failed: {void_message}")
                return "retryable", f"Submitted but void rate-limited: {void_message}", void_data, void_http
            else:
                current_retry_count = int(rec.get("RETRY_COUNT") or 0)
                mark_failed(conn, guest_check_id, f"Submitted but void failed: {void_message}", current_retry_count, cfg["worker"]["max_retries"], backoff_seconds=0)
                return "retryable", f"Submitted but void failed: {void_message}", void_data, void_http
        else:
            mark_submitted(conn, guest_check_id, submission)
    elif outcome == "rate_limited":
        retry_after = _parse_retry_after(headers) or DEFAULT_RATE_LIMIT_SECONDS
        mark_rate_limited(conn, guest_check_id, retry_after, message)
    elif outcome == "retryable":
        current_retry_count = int(rec.get("RETRY_COUNT") or 0)
        backoff = BACKOFF_SECONDS[min(current_retry_count, len(BACKOFF_SECONDS) - 1)]
        mark_failed(conn, guest_check_id, message, current_retry_count, cfg["worker"]["max_retries"], backoff_seconds=backoff)
    elif http_code == 422:
        mark_rate_limited(conn, guest_check_id, 60, f"422 validation error (kept for retry): {message}")
    else:  # terminal (401/403)
        current_retry_count = int(rec.get("RETRY_COUNT") or 0)
        mark_failed(conn, guest_check_id, message, current_retry_count, cfg["worker"]["max_retries"], backoff_seconds=0)

    return outcome, message, data, http_code


def _is_checksum_or_validation_error(data):
    """Return True if the API response indicates an INVALID_CHECKSUM or
    VALIDATION_FAILED error that warrants a one-time retry with a rebuilt
    payload."""
    if not isinstance(data, dict):
        return False
    text = json.dumps(data, ensure_ascii=False).lower()
    return "invalid_checksum" in text or "validation_failed" in text or "invalid checksum" in text