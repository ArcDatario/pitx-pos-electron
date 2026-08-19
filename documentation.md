# PITX POS Transfer - Project Documentation

## 1. Project Overview

**PITX POS Transfer** is an Electron desktop application that transfers sales data from a SQL Server database (`dbo.v_salesdetails`) into a local staging table (`dbo.dts_pitx_payload`), builds TSMS-compliant JSON payloads, and submits them to the TSMS API. It also supports voiding transactions that were voided at the POS before business day close.

The app is a 1:1 TypeScript port of a legacy Python system (`tsms_common.py`, `pos.py`, `pos_desktop.py`) that was previously split between a background worker and a Tkinter desktop GUI.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 32.x |
| Language | TypeScript 5.5 (main + preload), plain JS (renderer) |
| UI | HTML5 + CSS3 + Bootstrap 5 (vendored locally) |
| SQL Driver | `mssql` (tedious) for Node.js |
| HTTP Client | `axios` |
| Crypto | Node.js built-in `crypto` |
| Packaging | electron-builder (NSIS installer for Windows) |
| Build | `tsc` (TypeScript compiler) |
| Reference Implementation | Python 3 + `pyodbc` + `requests` + `cryptography` (`tsms_common.py`) |

---

## 3. Project Structure

```
pitx-pos-electron/
├── package.json                  # App metadata, scripts, build config
├── tsconfig.json                 # TypeScript configuration
├── .gitignore
├── README.md                     # Feature parity checklist and notes
├── tsms_common.py                # Reference Python implementation (1:1 logic port)
├── config.default.json           # Bundled default config (if present)
├── src/
│   ├── main/
│   │   ├── config.ts             # AppConfig loading/saving
│   │   ├── db.ts                 # SQL Server queries, pooling, table creation
│   │   ├── ipc.ts                # Electron IPC handlers (main process)
│   │   └── tsms.ts               # TSMS payload builder, submission, retry, void logic
│   ├── preload/
│   │   └── preload.ts            # Exposes window.pos API to renderer via contextBridge
│   └── renderer/
│       ├── index.html            # Single-page app UI (Transfer + Settings tabs, Bootstrap markup)
│       ├── lib/                  # Vendored Bootstrap (bootstrap.min.css, bootstrap.bundle.min.js)
│       ├── styles.css            # Bootstrap overrides + branded components (theming, badges, modals, stat pills)
│       └── renderer.js           # UI logic, event handlers, tab switching
└── dist/                         # Compiled output
    └── main/
        └── main.js               # Bundled main process entry
```

---

## 4. Architecture

### 4.1 Electron Process Model

```
┌─────────────────────────────────────────────┐
│              Main Process                   │
│  (src/main/*.ts)                            │
│  - Config management                        │
│  - SQL Server connection pooling            │
│  - DB queries (transfer, fetch, submit)     │
│  - TSMS payload construction & API calls    │
│  - IPC handlers                             │
└──────────────────┬──────────────────────────┘
                   │ ipcMain / ipcRenderer
                   ▼
┌─────────────────────────────────────────────┐
│             Preload Script                  │
│  (src/preload/preload.ts)                   │
│  - contextBridge.exposeInMainWorld("pos")   │
│  - Whitelisted API surface                  │
└──────────────────┬──────────────────────────┘
                   │ window.pos.*
                   ▼
┌─────────────────────────────────────────────┐
│            Renderer Process                 │
│  (src/renderer/*)                           │
│  - index.html (DOM structure)               │
│  - styles.css (styling)                     │
│  - renderer.js (UI logic, event handlers)   │
│  - No Node.js access directly               │
└─────────────────────────────────────────────┘
```

### 4.2 IPC Bridge (`src/preload/preload.ts`)

Exposes these methods to the renderer via `window.pos`:

| Method | IPC Channel | Purpose |
|--------|-------------|---------|
| `getConfig()` | `config:get` | Load `config.json` |
| `saveConfig(cfg)` | `config:save` | Persist `config.json` |
| `getConfigPath()` | `config:path` | Return config file path |
| `testConnection(cfg)` | `config:test-connection` | Test SQL Server connectivity |
| `transfer(start, end)` | `db:transfer` | Aggregate `v_salesdetails` into `dts_pitx_payload` |
| `getStatusCounts()` | `db:status-counts` | Get pending/submitted/failed/voided/total counts |
| `getSummary(filters)` | `db:summary` | Get summary metrics (netsales, VAT, etc.) |
| `getRecords(filters, page, pageSize)` | `db:records` | Paginated table data |
| `getRecord(guestCheckId)` | `db:record` | Single record by GUESTCHECKID |
| `installCreateTable()` | `install:create-table` | Create `dbo.dts_pitx_payload` if missing |
   | `submitByDateRange(start, end)` | `submit:by-date-range` | Batch submit pending records |
 | `submitToday()` | `submit:today` | Insert today's transactions then submit them |
 | `submitControl(action)` | `submit:control` | Pause/resume/abort batch submit |
| `resubmit(guestCheckId)` | `submit:resubmit` | Reset and resubmit a single record |
| `voidRecord(guestCheckId)` | `submit:void` | Void a submitted transaction |
| `previewPayload(guestCheckId)` | `preview:payload` | Build and return the TSMS payload JSON |
| `onSubmitEvent(callback)` | `submit:event` | Live event listener for batch progress |

---

## 5. Configuration (`src/main/config.ts`)

### 5.1 Config Shape (`AppConfig`)

```typescript
{
  sqlserver: {
    server: string;      // e.g. "POS1\\SQLEXPRESS"
    database: string;    // e.g. "CheckPostingDB"
    username: string;
    password: string;
    driver: string;      // kept for parity, unused by tedious
  },
  filters: {
    locationname: string; // e.g. "PH085-PITX"
    storenum: number;     // e.g. 2067
  },
  tsms: {
    api_url: string;
    api_token: string;
    tenant_id: number;
    terminal_id: number;
    hardware_id: string;    // e.g. "4312BDC02001242"
    customer_code: string;  // e.g. "C-C1031"
  },
  worker: {
    poll_interval_seconds: number;
    batch_size: number;
    max_retries: number;
  }
}
```

### 5.2 Config Lifecycle

- **`loadConfig()`** (`src/main/config.ts:84`): Reads `config.json` from the executable directory (dev: `app.getAppPath()`). If missing, seeds from `DEFAULT_CONFIG` or `config.default.json`.
- **`saveConfig(cfg)`** (`src/main/config.ts:101`): Writes `config.json` to disk.
- **Default values** are defined at `src/main/config.ts:40`.

---

## 6. Database Layer (`src/main/db.ts`)

### 6.1 Connection Pool (`getPool`)

- Uses a module-level singleton `pool` (`src/main/db.ts:5`).
- **Pool key**: `JSON.stringify(cfg.sqlserver)`.
- **Health check**: Before returning a cached pool, runs `SELECT 1` to verify liveness. If the ping fails, closes the stale pool and creates a fresh one (`src/main/db.ts:33-39`).
- **Config**: `connectionTimeout: 8000ms`, `requestTimeout: 30000ms`, `trustServerCertificate: true`, `encrypt: false`.
- **Instance parsing**: `POS1\SQLEXPRESS` → `{ server: "POS1", instanceName: "SQLEXPRESS" }` (`src/main/db.ts:9`).

### 6.2 Table Schema (`dbo.dts_pitx_payload`)

Created by `installCreateTable` (`src/main/db.ts:792`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | `INT IDENTITY(1,1)` | PK |
| `businessdate` | `DATE` | |
| `transdatetime` | `DATETIME2` | |
| `locationname` | `VARCHAR(255)` | |
| `storenum` | `INT` | |
| `GUESTCHECKID` | `VARCHAR(155)` | NOT NULL, unique key |
| `ordertypename` | `VARCHAR(255)` | |
| `receipt_no` | `VARCHAR(155)` | UNIQUE INDEX (non-null) |
| `netsales` | `DECIMAL(18,2)` | DEFAULT 0 |
| `vat_12` | `DECIMAL(18,2)` | DEFAULT 0 |
| `lessvat` | `DECIMAL(18,2)` | DEFAULT 0 |
| `lessPWD` | `DECIMAL(18,2)` | DEFAULT 0 |
| `lessSC` | `DECIMAL(18,2)` | DEFAULT 0 |
| `lessEMP` | `DECIMAL(18,2)` | DEFAULT 0 |
| `lessNtnlAth` | `DECIMAL(18,2)` | DEFAULT 0 |
| `lessSoloparent` | `DECIMAL(18,2)` | DEFAULT 0 |
| `voidtotal_amt` | `DECIMAL(18,2)` | DEFAULT 0 |
| `voidtotal_qty` | `DECIMAL(18,2)` | DEFAULT 0 |
| `gc_sales` | `DECIMAL(18,2)` | DEFAULT 0 |
| `gc_excess` | `DECIMAL(18,2)` | DEFAULT 0 |
| `otherdiscount` | `DECIMAL(18,2)` | DEFAULT 0 |
| `vat` | `DECIMAL(18,2)` | DEFAULT 0 |
| `gross_sales` | `DECIMAL(18,2)` | DEFAULT 0 |
| `vatable_sales` | `DECIMAL(18,2)` | DEFAULT 0 |
| `sc_vat_excempt_sales` | `DECIMAL(18,2)` | DEFAULT 0 |
| `other_tax` | `DECIMAL(18,2)` | DEFAULT 0 |
| `status` | `VARCHAR(20)` | DEFAULT 'pending' |
| `retry_count` | `INT` | DEFAULT 0 |
| `next_retry_at` | `DATETIME2` | Backoff window |
| `transaction_id` | `VARCHAR(155)` | Immutable once set |
| `uuid` | `VARCHAR(155)` | `submission_uuid` |
| `submission_checksum` | `VARCHAR(64)` | |
| `transaction_checksum` | `VARCHAR(64)` | |
| `last_error` | `VARCHAR(2000)` | |
| `last_payload_sent` | `NVARCHAR(MAX)` | Full JSON payload |
| `last_response_body` | `NVARCHAR(MAX)` | Full API response |
| `last_response_code` | `INT` | |
| `last_attempt_at` | `DATETIME2` | |
| `updated_at` | `DATETIME2` | DEFAULT SYSDATETIME() |

### 6.3 Column Auto-Migration (`ensureColumnsExist`)

`db.ts` checks `INFORMATION_SCHEMA.COLUMNS` for each required column and `ALTER TABLE ADD`s any missing ones. This allows the app to work with older table schemas.

### 6.4 Transfer / Aggregation Query (`transfer`)

**Function**: `transfer(cfg, startDate, endDate)` → `Promise<number>` (inserted count)

**Location**: `src/main/db.ts:138-445`

**Flow**:
1. Ensures all required columns exist.
2. Runs a large T-SQL CTE query that:
   - Identifies **voided FCRInvNumbers** (negative "Item Sale" rows) via `VoidFCR` CTE.
   - Identifies **Solo Parent discounts** via `SoloParentDiscount` CTE.
   - Aggregates **void rows** into `VoidAgg` (converts negative amounts to positive for submission).
   - Aggregates **normal rows** into `NormalAgg`.
   - `CombinedData` = UNION ALL of both.
   - `DeduplicatedData` = deduplicates by `receipt_no`, keeping the most recent `transdatetime`.
   - `INSERT INTO dbo.dts_pitx_payload` with `status = 'pending'`.
3. Deduplication: skips rows where `receipt_no` already exists in the table.
4. Returns `@@ROWCOUNT` as the inserted count.

**Key aggregation logic** (matching the latest SQL provided):
- **netsales**: Solo Parent = `(amt / 1.12) - ((amt / 1.12) * 0.10)`; Others = source `Netsales`.
- **vat_12**: Solo Parent + VAT-exempt = 0; Standard/Employee/National Athlete = 12% of netsales.
- **lessvat**: Solo Parent = `amt - (amt / 1.12)`; VAT-exempt = 12% of netsales; Others = 0.
- **lessSoloparent**: Solo Parent = 10% of `(amt / 1.12)`; Others = source `lessSoloparent`.
- **gross_sales**: Solo Parent = `amt / 1.12`; PWD = `netsales + lessPWD`; Senior Citizen = `netsales + lessSC`; Zero Rated = `netsales`; Standard/Employee/National Athlete = `netsales + vat + lessNtnlAth + lessSoloparent + lessEMP`.
- **vatable_sales**: If `lessvat = 0` then source `Netsales`, else 0.
- **sc_vat_excempt_sales**: Solo Parent = calculated netsales; VAT-exempt types = source `Netsales`; else 0.
- **gc_sales**: Source `srvc_amt`.
- **gc_excess**: Source `GC_excess`.

### 6.5 DB Helper Functions

| Function | Purpose |
|----------|---------|
| `fetchRecordByGuestCheckId(cfg, id)` | `SELECT TOP 1 * FROM dbo.dts_pitx_payload WHERE GUESTCHECKID = @id` |
| `fetchRecords(cfg, filters, page, pageSize)` | Paginated SELECT with optional date/location/status/guestcheckid filters |
| `getStatusCounts(cfg)` | `SELECT status, COUNT(*) ... GROUP BY status` + total |
| `getSummaryMetrics(cfg, filters)` | SUM aggregates for netsales, VAT, lessVAT, lessSC, lessPWD, gc_excess, void_amt, total_revenue |
| `ensureTransactionId(cfg, guestCheckId, existingId)` | Generate and persist `transaction_id` if null |
| `updateTransactionId(cfg, guestCheckId, newId)` | Update `transaction_id` (used on 409 conflict) |
| `recordAttempt(cfg, guestCheckId, submission, responseData, httpCode)` | Log every attempt: `last_payload_sent`, `last_response_body`, `last_response_code`, `last_attempt_at` |
| `markSubmitted(cfg, guestCheckId, submission)` | Set `status='submitted'`, persist `submission_uuid`, checksums |
| `markVoided(cfg, guestCheckId, voidPayload)` | Set `status='voided'`, persist `submission_uuid`, checksum |
| `markRateLimited(cfg, guestCheckId, retryAfter, message)` | Set `last_error`, `next_retry_at = SYSDATETIME() + retryAfter` |
| `markFailed(cfg, guestCheckId, message, currentRetryCount, maxRetries, backoffSeconds)` | Set `status='failed'`, increment `retry_count`, set `next_retry_at` if backoff > 0 |
| `resetForResubmit(cfg, guestCheckId)` | Reset `status='pending'`, `retry_count=0`, `next_retry_at=NULL` (only if not already submitted) |
| `installCreateTable(cfg)` | Create `dbo.dts_pitx_payload` with full schema if not exists |

---

## 7. TSMS Payload Builder (`src/main/tsms.ts`)

### 7.1 Payload Shape

The final payload matches this exact structure:

```json
{
  "submission_uuid": "<uuid>",
  "tenant_id": 26,
  "terminal_id": 131,
  "submission_timestamp": "2026-08-03T06:42:39.052Z",
  "transaction_count": 1,
  "payload_checksum": "<sha256>",
  "transaction": {
    "transaction_id": "<uuid>",
    "hardware_id": "4312BDC02001242",
    "receipt_no": "<from DB RECEIPT_NO column>",
    "transaction_timestamp": "2026-08-03T13:52:28.130Z",
    "gross_sales": "43.75",
    "net_sales": "43.75",
    "promo_status": "NONE",
    "customer_code": "C-C1031",
    "payload_checksum": "<sha256>",
    "adjustments": [
      { "adjustment_type": "promo_discount", "amount": "0.00" },
      { "adjustment_type": "senior_discount", "amount": "0.00" },
      { "adjustment_type": "pwd_discount", "amount": "0.00" },
      { "adjustment_type": "vip_card_discount", "amount": "0.00" },
      { "adjustment_type": "service_charge_distributed_to_employees", "amount": "0.00" },
      { "adjustment_type": "service_charge_retained_by_management", "amount": "0.00" },
      { "adjustment_type": "employee_discount", "amount": "0.00" }
    ],
    "taxes": [
      { "tax_type": "VAT", "amount": "0.00" },
      { "tax_type": "VATABLE_SALES", "amount": "0.00" },
      { "tax_type": "SC_VAT_EXEMPT_SALES", "amount": "43.75" },
      { "tax_type": "OTHER_TAX", "amount": "0.00" }
    ]
  }
}
```

### 7.2 Key Functions

#### `tsmsAmount(n)` (`src/main/tsms.ts:69`)
Formats a number as a 2-decimal string: `Number(n ?? 0).toFixed(2)`.

#### `tsmsGenerateUuidV4()` (`src/main/tsms.ts:73`)
Returns `crypto.randomUUID()`.

#### `tsmsIsoTimestampNow()` (`src/main/tsms.ts:77`)
Returns current UTC time with millisecond precision: `YYYY-MM-DDTHH:mm:ss.SSSZ`.

#### `formatIso(value)` (`src/main/tsms.ts:85`)
Converts a JS Date/string/null to ISO-8601 with millisecond precision. Falls back to `now` if null/invalid.

#### `upperCaseKeys(rec)` (`src/main/tsms.ts:132`)
Converts all keys to uppercase (mirrors Python's `rec = {k.upper(): v ...}`).

#### `sortKeysRecursive(value)` (`src/main/tsms.ts:109`)
Recursively sorts object keys for stable checksums.

#### `tsmsChecksum(data)` (`src/main/tsms.ts:123`)
SHA-256 of `JSON.stringify(sortedData)` (compact, no whitespace).

#### `buildTransaction(cfg, agg, transactionId)` (`src/main/tsms.ts:144`)
Constructs the `transaction` object:
- Maps DB columns to TSMS fields.
- `receipt_no` comes directly from `agg.RECEIPT_NO`.
- `promo_status` = `"WITH_APPROVAL"` if `promo_discount_total > 0`, else `"NONE"`.
- `adjustments` array always has 7 entries (promo_discount, senior_discount, pwd_discount, vip_card_discount, service_charge_distributed_to_employees, service_charge_retained_by_management, employee_discount).
- `taxes` array always has 4 entries (VAT, VATABLE_SALES, SC_VAT_EXEMPT_SALES, OTHER_TAX).
- Computes `payload_checksum` over the transaction object minus the `payload_checksum` field itself.

#### `buildSubmission(cfg, txn)` (`src/main/tsms.ts:201`)
Wraps `txn` in the submission envelope:
- `submission_uuid` = fresh UUID per attempt.
- `submission_timestamp` = current time.
- `transaction_count` = 1.
- Computes `payload_checksum` over the submission object minus the `payload_checksum` field.

### 7.3 HTTP Client (`httpClient`)

- Base URL: `cfg.tsms.api_url`
- Headers: `Content-Type: application/json`, `Accept: application/json`, `Authorization: Bearer <token>`, `User-Agent: TSMS-PITX-Desktop/1.0`
- Timeout: 30000ms
- `validateStatus: () => true` (status handled by `classifyResponse`)

### 7.4 Response Classification (`classifyResponse`)

| HTTP Code / Condition | Outcome | Meaning |
|-----------------------|---------|---------|
| 200-299 + `success: true` | `success` | Accepted |
| 200-299 + `status: "already_processed"` | `success` | Idempotent duplicate |
| 429 | `rate_limited` | Respect `Retry-After` |
| 401, 403, 409, 422 | `terminal` | Stop and fix |
| >= 500 | `retryable` | Exponential backoff |
| Network error | `retryable` | Retry |
| Other 4xx | `terminal` | Unhandled |

### 7.5 Submission Orchestration (`submitOne`)

**Location**: `src/main/tsms.ts:408-535`

**Flow**:
1. Load record, uppercase keys.
2. Detect void (`VOIDTOTAL_QTY != 0 || VOIDTOTAL_AMT != 0`).
3. Ensure `transaction_id` exists (generate if null).
4. If void: convert all negative amount fields to positive.
5. Build `transaction` via `buildTransaction`.
6. Build `submission` via `buildSubmission`.
7. **First submit**: `submitPayload` → `recordAttempt` → `classifyResponse`.
8. **409 conflict on pending row**: Generate fresh `transaction_id`, update DB, rebuild transaction+submission, resubmit.
9. **422 with checksum/validation error**: Rebuild transaction+submission with fresh envelope, resubmit once.
10. **Success**:
    - If void: call `voidTransactionAfterSubmit` (retries up to 3 times for "not yet indexed" race condition).
      - If void succeeds → `markVoided`.
      - If void rate-limited → `markRateLimited`.
      - If void fails → `markFailed`.
    - If normal → `markSubmitted`.
11. **Rate limited**: `markRateLimited`.
12. **Retryable (5xx/network)**: `markFailed` with exponential backoff (`[2, 4, 8, 16, 32]` seconds).
13. **422 without checksum error**: `markRateLimited` (60s backoff).
14. **Terminal**: `markFailed` with 0 backoff.

### 7.6 Void Transaction (`voidTransaction`)

**Location**: `src/main/tsms.ts:293-335`

- URL: `cfg.tsms.api_url` with last path segment replaced by `/{transactionId}/void`
- Payload: `{ transaction_id, void_reason, payload_checksum }`
- `payload_checksum` = SHA-256 of sorted payload minus checksum field.

### 7.7 Void After Submit (`voidTransactionAfterSubmit`)

**Location**: `src/main/tsms.ts:361-383`

- Retries up to 3 attempts with 2-second delays.
- Only retries if outcome is `terminal` AND message contains "not found" or "does not belong" (TSMS eventual consistency race).
- Any other outcome (success, rate_limited, genuine terminal) is returned immediately.

### 7.8 Payload Preview (`previewPayload`)

**Location**: `src/main/tsms.ts:537-565`

- Returns the full `submission` envelope (not wrapped in `{ transaction, submission }`).
- Does NOT persist anything to the DB.
- Does NOT call the TSMS API.
- Used by the renderer for payload preview modal and copy-to-clipboard.

---

## 8. IPC Handlers (`src/main/ipc.ts`)

### 8.1 `config:*`
- `config:get` → `loadConfig()`
- `config:save` → `saveConfig(cfg)`
- `config:path` → `getConfigFilePath()`
- `config:test-connection` → `db.testConnection(cfg)`

### 8.2 `db:*`
- `db:transfer` → `db.transfer(cfg, start, end)` → returns `{ inserted }`
- `db:status-counts` → `db.getStatusCounts(cfg)`
- `db:summary` → `db.getSummaryMetrics(cfg, filters)`
- `db:records` → `db.fetchRecords(cfg, filters, page, pageSize)`
- `db:record` → `db.fetchRecordByGuestCheckId(cfg, id)`

### 8.3 `install:*`
- `install:create-table` → `db.installCreateTable(cfg)` → returns `{ ok: true }`

   ### 8.4 `submit:*`
 - `submit:by-date-range` → Batch submit loop (see Section 9.2)
 - `submit:today` → Insert today's transactions (`db.transfer`) then run the batch submit for today's date
 - `submit:control` → Pause/resume/abort controller
- `submit:resubmit` → Reset row + `tsms.submitOne`
- `submit:void` → `tsms.voidTransaction` + `db.markVoided`

### 8.5 `preview:*`
- `preview:payload` → `tsms.previewPayload(cfg, rec)` → returns `{ ok, payload }`

---

## 9. Renderer UI (`src/renderer/`)

### 9.1 HTML Structure (`index.html`)

**Two tabs only**:
1. **Transfer** (`#panel-transfer`): Stats, filters, data range, table, pagination, activity log, payload preview modal.
2. **Settings** (`#panel-settings`): SQL Server config, TSMS API config, Filters, Worker settings, Test Connection, Save Settings, Create Table button.

**Removed**: The Install tab has been removed. "Create Table" is now directly available in Settings.

### 9.2 CSS (`styles.css`)

- CSS custom properties for theming.
- Modern card-based layout with sticky table headers.
- Color-coded status badges (pending=yellow, submitted=green, failed=red, voided=gray).
- Modal overlay for payload preview.
- **UI framework**: Bootstrap 5 (`src/renderer/lib/bootstrap.min.css` + `bootstrap.bundle.min.js`, vendored locally and packaged with `src/renderer/**/*`) provides the responsive grid, `row`/`col` form layout, flex/gap utilities, and baseline. Custom `styles.css` loads after Bootstrap and overrides the branded components (cards, table, badges, modals, stat pills, buttons), plus a small `(max-width: 768px)` media query that tightens gutters, font sizes, and stat pills for narrow windows. The Settings form now uses `row g-3` + `col-12 col-md-6` so it collapses to a single column instead of overlapping on small screens.

### 9.3 JavaScript (`renderer.js`)

#### State
```javascript
const state = {
  page: 1,
  pageSize: 50,
  filters: { guestCheckId: "", date: "", status: "" },
  total: 0,
  selectedGuestCheckId: null,
  config: null,
  submitting: false,
};
```

#### Tab Switching
- Clicking a `.tab` button removes `active` from all tabs/panels, adds it to the clicked one.

#### Stats (`refreshStats`)
- Calls `window.pos.getStatusCounts()` → renders stat pills (Total, Pending, Submitted, Failed, Voided).
 - Calls `window.pos.getStatusCounts()` → renders stat pills (Total, Pending, Submitted, Failed, Voided).
 - Calls `window.pos.getSummary(state.filters)` → renders metric pills (Net Sales, VAT 12%, Less VAT, Less SC, Less PWD, Less EMP, Less Sol. Parent, Void Amt, Total Revenue).

#### Table (`renderTableRows`)
   - Columns: Receipt No, Date/Time (transdatetime), Order Type, Location, Status, Retry, Net Sales, VAT 12%, Less VAT, Discount, Gross Sales, Void Amt, Submitted At, Submission UUID, Transaction ID, Last Error, **Sent Payload** (copy icon), Payload.

   - **Order Type** (`ordertypename`): `'Solo Parent'` when the guest check has a Solo Parent discount, `'Employee'` when `lessEMP > 0`, otherwise the source `order_type`.

   - **Discount** (centralized): the first non-zero value among `lessSoloparent`, `lessPWD`, `lessSC`, `lessEMP`, `lessNtnlAth`, `otherdiscount` (only one is non-zero per row, following the order type) — surfaces a single discount figure instead of listing every `less*` column.

   - **Sent Payload** (copy icon): shows a copy button only when `last_payload_sent` has data; clicking copies the stored payload JSON to the clipboard and briefly animates a check mark. The separate **Payload** column still rebuilds and copies the current (pre-submit) payload via `previewPayload`.
- Click → select row.
- Double-click → open payload preview modal.
- Payload column has a copy button.

#### Filters
- **Apply** (`btnApply`): Updates `state.filters`, resets to page 1, calls `refreshAll`.
- **Reset** (`btnReset`): Clears filters.

#### Pagination
- **Prev/Next**: Increments/decrements `state.page`, calls `loadRecords`.
- **Page Size**: Changes `state.pageSize`, resets to page 1.

#### Get Data / Transfer (`runGetData`)
- Reads `rangeStart` and `rangeEnd`.
- Calls `window.pos.transfer(start, end)`.
- Logs inserted count.

 #### Submit (`btnSubmit`)
 - Reads date range.
 - Calls `window.pos.submitByDateRange(start, end)`.
 - Shows pause/abort buttons during submission.
 - Pause toggles `paused` state, sends `submit:control("pause"/"resume")`.
 - Abort sends `submit:control("abort")`.
 - Listens to `window.pos.onSubmitEvent` for live progress events.

 #### Submit Today (`btnSubmitToday`)
 - Opens a confirmation modal showing today's date (computed in the renderer as `YYYY-MM-DD`).
 - Confirm runs `window.pos.submitToday()`, which in the main process:
   1. Inserts today's transactions via `db.transfer(cfg, today, today)`.
   2. Submits all pending rows for today via the shared batch submit loop (`runSubmitBatch`).
   3. Streams progress back over `submit:event`.
 - Pause/abort reuse the same `submit:control` controller.

#### Payload Preview / Copy
- **Double-click row**: Calls `window.pos.previewPayload(id)`, opens modal with formatted JSON.
- **Copy button in table**: Calls `window.pos.previewPayload(id)`, copies JSON to clipboard.
- **Copy button in modal**: Copies `currentPreviewPayload` to clipboard.

#### Settings Form
- `SETTINGS_FIELDS` array maps DOM IDs to config paths.
- `fillSettingsForm(cfg)`: Populates inputs from config.
- `collectSettingsForm()`: Reads inputs, converts numbers, returns new config object.
- **Save Settings** (`btnSaveSettings`): Calls `window.pos.saveConfig(cfg)`, updates `state.config`.
- **Test Connection** (`btnTestConn`): Calls `window.pos.testConnection(cfg)`, shows DB name + table existence/row counts.

#### Create Table (`btnCreateTable`)
- Located in Settings under a "Database" card.
- Calls `window.pos.installCreateTable()`.
- Uses the currently saved config (not a separate install config).

#### Boot
- `renderTableHead()`
- Loads config, fills settings form.
- Sets date range inputs to today.
- Calls `refreshAll()` (stats + records).

---

## 10. Reference Python Implementation (`tsms_common.py`)

The Electron app is a 1:1 port of this Python module. Key differences:

| Aspect | Python (`tsms_common.py`) | Electron (`src/main/tsms.ts`) |
|--------|---------------------------|-------------------------------|
| Config storage | `config.json` with Fernet-encrypted sensitive fields | Plain `config.json` (no encryption) |
| Config path | `%PROGRAMDATA%\TSMS\config.json` | Next to executable / `app.getAppPath()` |
| DB driver | `pyodbc` | `mssql` (tedious) |
| HTTP client | `requests` | `axios` |
| Table name | `tsmp_agg_data` | `dts_pitx_payload` |
| Table creation | Not in this file | `installCreateTable` in `db.ts` |
| Receipt No | Auto-generated per call (`R{bd}-{guestcheckid}-{unique}`) | Now taken from `RECEIPT_NO` DB column |
| Promo status | `"WITHOUT_APPROVAL"` / `"NONE"` | `"WITH_APPROVAL"` / `"NONE"` |
| Customer code null | `tcfg.get("customer_code") or None` | `tcfg.customer_code ?? null` |
| Pooling | New connection per operation | Singleton pool with health check |

### Python Functions (Reference)

| Function | Purpose |
|----------|---------|
| `load_config()` / `save_config()` | Config with Fernet encryption |
| `get_db_connection(cfg)` | pyodbc connection string |
| `fetch_pending(conn, cfg)` | Rows not submitted/voided, respecting backoff |
| `ensure_transaction_id(conn, guest_check_id, existing_id)` | Generate UUID if missing |
| `fetch_pending_by_date(conn, cfg, business_date)` | Date-filtered pending rows |
| `submit_by_date(conn, cfg, business_date, ...)` | Submit all pending for one date |
| `submit_by_date_range(conn, cfg, start, end, ...)` | Submit date range |
| `fetch_records(...)` / `count_filtered_records(...)` | Table queries with filters |
| `fetch_record_by_guestcheckid(conn, id)` | Single row lookup |
| `fetch_status_counts(conn, ...)` | Dashboard counts |
| `record_attempt(conn, guest_check_id, submission, response_data, http_code)` | Log attempt |
| `mark_submitted(...)` / `mark_voided(...)` / `mark_rate_limited(...)` / `mark_failed(...)` | State transitions |
| `reset_for_resubmit(conn, guest_check_id)` | Reset to pending |
| `tsms_amount(n)` / `tsms_generate_uuid_v4()` / `tsms_iso_timestamp_now()` | Helpers |
| `_format_iso(value)` | Date to ISO-8601 string |
| `tsms_sort_keys_recursive(data)` | Recursive key sort |
| `tsms_checksum(data)` | SHA-256 checksum |
| `build_transaction(cfg, agg, transaction_id)` | Build transaction object |
| `build_submission(cfg, txn)` | Wrap in submission envelope |
| `submit_payload(cfg, submission)` | POST to TSMS |
| `void_transaction(cfg, transaction_id, void_reason)` | POST to void endpoint |
| `void_transaction_after_submit(...)` | Retry wrapper for void race condition |
| `classify_response(http_code, data, network_error)` | Map response to outcome |
| `submit_one(conn, cfg, rec, stop_event)` | Full submit/void orchestration |
| `_is_checksum_or_validation_error(data)` | Detect 422 retry condition |

---

## 11. Data Flow Diagrams

### 11.1 Transfer (Get Data) Flow

```
User clicks "Get Data"
    │
    ▼
renderer.js: runGetData()
    │
    ▼
IPC: db:transfer(start, end)
    │
    ▼
db.ts: transfer()
    │
    ├─ ensureColumnsExist()
    │
    ├─ Execute CTE query on v_salesdetails
    │   ├─ VoidAgg (voided invoices)
    │   ├─ NormalAgg (normal sales)
    │   ├─ CombinedData (UNION ALL)
    │   └─ DeduplicatedData (ROW_NUMBER by receipt_no)
    │
    └─ INSERT INTO dts_pitx_payload ... status='pending'
    │
    ▼
Return inserted count to renderer
    │
    ▼
refreshAll() → refreshStats() + loadRecords()
```

### 11.2 Submit Flow

```
User clicks "Submit Pending"
    │
    ▼
renderer.js: btnSubmit click handler
    │
    ▼
IPC: submit:by-date-range(start, end)
    │
    ▼
ipc.ts: Loop over db.fetchPendingByDate()
    │
    ▼
For each record:
    │
    ▼
tsms.submitOne(cfg, rec)
    │
    ├─ upperCaseKeys(rec)
    ├─ Detect void? → abs() negative amounts
    ├─ db.ensureTransactionId()
    │
    ├─ buildTransaction(cfg, rec, transactionId)
    │   ├─ Map DB columns → TSMS fields
    │   ├─ receipt_no ← agg.RECEIPT_NO
    │   ├─ adjustments[] (7 items)
    │   ├─ taxes[] (4 items)
    │   └─ payload_checksum = SHA256(txn - checksum)
    │
    ├─ buildSubmission(cfg, txn)
    │   ├─ submission_uuid = fresh UUID
    │   ├─ submission_timestamp = now
    │   ├─ transaction_count = 1
    │   └─ payload_checksum = SHA256(submission - checksum)
    │
    ├─ submitPayload(cfg, submission)
    │   └─ axios.post(api_url, submission)
    │
    ├─ db.recordAttempt()
    │
    ├─ classifyResponse(httpCode, data, networkError)
    │
    ├─ 409 on pending? → new UUID → rebuild → resubmit
    ├─ 422 + checksum error? → rebuild → resubmit once
    │
    └─ Outcome:
        ├─ success + void → voidTransactionAfterSubmit()
        │   ├─ POST /{id}/void
        │   └─ retry "not found" × 3
        │       ├─ success → markVoided()
        │       ├─ rate_limited → markRateLimited()
        │       └─ failed → markFailed()
        │
        ├─ success + normal → markSubmitted()
        ├─ rate_limited → markRateLimited()
        ├─ retryable → markFailed(backoff=[2,4,8,16,32])
        ├─ 422 → markRateLimited(60s)
        └─ terminal → markFailed(backoff=0)
    │
    ▼
Emit submit:event to renderer (progress logging)
```

### 11.3 Resubmit Flow

```
User double-clicks row → Resubmit button
    │
    ▼
IPC: submit:resubmit(guestCheckId)
    │
    ├─ db.fetchRecordByGuestCheckId()
    ├─ db.resetForResubmit()  (status=pending, retry_count=0)
    ├─ db.fetchRecordByGuestCheckId()  (fresh rec)
    │
    ▼
tsms.submitOne(cfg, freshRec)
    │  (same flow as Section 11.2)
    ▼
Return { ok, message }
```

### 11.4 Void Flow

```
User clicks Void
    │
    ▼
IPC: submit:void(guestCheckId)
    │
    ├─ db.fetchRecordByGuestCheckId()
    ├─ tsms.voidTransaction(cfg, transactionId)
    │   └─ POST {transaction_id, void_reason, payload_checksum}
    │
    └─ If success → db.markVoided()
    ▼
Return { ok, message }
```

---

## 12. Retry & Backoff Rules

| Condition | Behavior |
|-----------|----------|
| 429 Rate Limited | `markRateLimited` with `Retry-After` header value (default 60s). Does NOT increment `retry_count`. |
| 5xx / Network Error | `markFailed` with exponential backoff: 2s, 4s, 8s, 16s, 32s (based on `retry_count`). |
| 401 / 403 / 409 (not pending) / 422 / Other 4xx | `markFailed` with 0 backoff (eligible next cycle). |
| 409 on pending | Regenerate `transaction_id`, persist to DB, rebuild payload, resubmit immediately (one retry only). |
| 422 + checksum/validation error | Rebuild payload with fresh envelope, resubmit once (transaction_id unchanged). |
| Max retries exhausted | Row stays in `failed` status, no more auto-attempts. Manual resubmit resets it. |

### Eligibility for Retry

A row is eligible for submission when:
```sql
status NOT IN ('submitted', 'voided')
AND (status = 'pending' OR retry_count < max_retries)
AND (next_retry_at IS NULL OR next_retry_at <= SYSDATETIME())
```

---

## 13. Payload Preview

**Trigger**: Double-click table row OR click copy button in Payload column.

**Flow**:
1. Renderer calls `window.pos.previewPayload(guestCheckId)`.
2. IPC handler loads config + record from DB.
3. `tsms.previewPayload` builds the full `submission` envelope (same as `submitOne` but without API call or DB writes).
4. Returns `{ ok: true, payload }` to renderer.
5. Renderer opens modal with `JSON.stringify(payload, null, 2)`.
6. Copy button copies the same JSON to clipboard.

---

## 14. Build & Run

### Scripts (`package.json`)

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `tsc -p tsconfig.json` | Compile TypeScript → `dist/` |
| `start` | `npm run build && electron .` | Run dev |
| `dev` | `tsc -p tsconfig.json --watch` | Watch mode |
| `dist` | `npm run build && electron-builder` | Build NSIS installer → `release/` |

### Build Output
- Main process: `dist/main/main.js`
- Preload: `dist/preload/preload.js`
- Renderer: `src/renderer/*` (copied as-is by electron-builder)

### Packaging
- `electron-builder` with `nsis` target (Windows one-click installer, allows changing install directory).

---

## 15. Key Design Decisions & Notes

1. **No separate Install page**: Configuration is managed entirely in Settings. "Create Table" is a button in Settings that uses the saved SQL Server credentials.

2. **receipt_no comes from DB**: Unlike the original Python implementation which auto-generated a unique receipt_no per attempt, the Electron app reads `RECEIPT_NO` directly from `dbo.dts_pitx_payload`. This makes the payload stable for the same row.

3. **promo_status**: Uses `"WITH_APPROVAL"` when `promo_discount_total > 0`, otherwise `"NONE"`.

4. **customer_code**: Preserved as-is (including empty string) rather than coerced to `null`.

5. **Connection pool health check**: Before reusing a cached pool, the app pings `SELECT 1` to detect stale connections that report `connected: true` but are actually closed.

6. **409 handling**: When TSMS returns 409 on a pending row, the app generates a fresh `transaction_id`, persists it, and resubmits. This ensures the post-submit void targets the correct transaction.

7. **Void race condition**: After a successful submit, the void endpoint may return "Transaction not found" because TSMS hasn't finished indexing. The app retries up to 3 times with 2-second delays for this specific case.

8. **Idempotency**: A 200 response with `status: "already_processed"` or `success: true` counts as success. Duplicate submissions are harmless.

9. **Reference Python code**: `tsms_common.py` is included in the repo as the reference implementation. The Electron app is a faithful 1:1 port with the adjustments noted above.
