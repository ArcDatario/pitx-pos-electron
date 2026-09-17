# PITX POS Transfer - Project Documentation

## 1. Project Overview

PITX POS Transfer is an Electron desktop application for moving sales data from a SQL Server source into a local staging table, building TSMS submission payloads, and sending those payloads to the TSMS API. It supports both normal submissions and void flows, tracks retry/backoff state, and includes automation for recurring business-date processing.

The project is a TypeScript reimplementation of the older Python-based TSMS workflow, with additional desktop-specific features such as update checks, tray/menu integration, connection testing, and an interactive dashboard for transaction monitoring.

---

## 2. Current Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Electron 32 |
| Main / preload language | TypeScript 5.5 |
| Renderer language | Plain JavaScript |
| UI framework | Bootstrap 5, local vendored assets |
| SQL driver | `mssql` / `tedious` |
| HTTP client | `axios` |
| Crypto | Node.js built-in `crypto` |
| Packaging | `electron-builder` with NSIS |
| Build | `tsc` |
| Update client | `electron-updater` |
| Reference implementation | Python TSMS logic in `tsms_common.py` |

---

## 3. Current Project Structure

```text
pitx-pos-electron/
├── package.json
├── tsconfig.json
├── config.default.json
├── config.json
├── documentation.md
├── tsms_common.py
├── src/
│   ├── main/
│   │   ├── config.ts
│   │   ├── db.ts
│   │   ├── ipc.ts
│   │   ├── logger.ts
│   │   ├── main.ts
│   │   └── tsms.ts
│   ├── preload/
│   │   └── preload.ts
│   └── renderer/
│       ├── index.html
│       ├── renderer.js
│       ├── styles.css
│       └── lib/
├── build/
├── release/
├── release-fixed/
├── release-fixed-new/
├── backup/
├── logs/
└── scripts/
    └── update-release.js
```

---

## 4. Application Purpose

The app is built around the following workflow:

1. Read sales records from SQL Server from `dbo.v_salesdetails`.
2. Aggregate and deduplicate them into the local staging table `dbo.dts_pitx_payload`.
3. Filter, review, and monitor records in the desktop UI.
4. Build TSMS JSON payloads for each pending transaction.
5. Submit those payloads through the TSMS API.
6. Handle retries, rate limiting, and terminal failures.
7. Support void transactions and post-submit void retries.
8. Run scheduled or date-based automation cycles.

---

## 5. Core Runtime Architecture

### 5.1 Process model

```text
Main process (src/main)
  - config loading / saving
  - SQL Server connection pooling
  - DB transfers and staging
  - API payload creation and submission
  - update handling and automation timer
  - IPC registration

      │ IPC bridge
      ▼
Preload script (src/preload/preload.ts)
  - exposes window.pos API
  - keeps Node access out of renderer

      │ window.pos.*
      ▼
Renderer process (src/renderer)
  - UI rendering and record management
  - filters, summary cards, table updates
  - submit controls and payload preview
```

### 5.2 Main responsibilities

The main process orchestrates:

- app startup and window creation
- tray and menu behavior
- config file lifecycle
- SQL Server test and validation
- aggregation and transfer jobs
- TSMS submission orchestration
- event streaming to the renderer
- app auto-update checks and installation
- scheduled automation

---

## 6. Current Configuration Model

The configuration is stored as `config.json` and loaded from the user data directory when packaged, or from the app root during development.

### 6.1 `AppConfig`

```ts
interface SqlServerConfig {
  server: string;
  database: string;
  username: string;
  password: string;
  driver: string;
}

interface FiltersConfig {
  locationname: string;
  storenum: number;
}

interface TsmsConfig {
  api_url: string;
  api_token: string;
  tenant_id: number;
  terminal_id: number;
  hardware_id: string;
  customer_code: string;
  auto_receipt_no: boolean;
}

interface WorkerConfig {
  poll_interval_seconds: number;
  batch_size: number;
  max_retries: number;
}

interface AppConfig {
  sqlserver: SqlServerConfig;
  filters: FiltersConfig;
  tsms: TsmsConfig;
  worker: WorkerConfig;
  automation_enabled?: boolean;
}
```

### 6.2 Key config behavior

- `loadConfig()` reads and initializes config if missing.
- `saveConfig()` writes the current config to disk in pretty JSON.
- `getConfigFilePath()` returns the active location.
- packaged builds use the user data folder to avoid permission issues with Program Files.
- a legacy `config.json` near the executable is copied into the user data folder if present.

### 6.3 Default config values

Current defaults include:

- SQL Server: `POS1\SQLEXPRESS`, database `CheckPostingDB`
- TSMS base API: `https://stagingtsms.pitx.com.ph/api/v1/transactions/official`
- default tenant/terminal IDs for the PITX environment
- hardware ID: `4312BDC02001242`
- customer code: `C-C1031`
- `auto_receipt_no: false`
- worker settings: poll interval 10s, batch size 100, max retries 5
- automation initially disabled

---

## 7. Database Layer

### 7.1 Connection pooling

`src/main/db.ts` keeps a singleton SQL Server pool keyed by the SQL server config. Before reusing a connection, it issues `SELECT 1` to verify health; a stale pool is closed and recreated.

The connection config is built as:

- server parsed from `POS1\SQLEXPRESS` into `{ server: "POS1", instanceName: "SQLEXPRESS" }`
- `trustServerCertificate: true`
- `encrypt: false`
- `connectionTimeout: 8000`
- `requestTimeout: 30000`

### 7.2 Staging table

The app targets `dbo.dts_pitx_payload` and creates it if needed using `installCreateTable()`.

Important columns include:

- `GUESTCHECKID`
- `receipt_no`
- `locationname`
- `storenum`
- `transdatetime`
- `businessdate`
- `netsales`, `vat_12`, `lessvat`, `gross_sales`
- `voidtotal_amt`, `voidtotal_qty`
- `status`
- `transaction_id`
- `uuid`
- `submission_uuid`
- `submission_timestamp`
- `last_payload_sent`
- `last_response_body`
- `last_response_code`
- `retry_count`
- `next_retry_at`
- `last_error`

### 7.3 Column migration

The app runs `ensureColumnsExist()` before operations, checking `INFORMATION_SCHEMA.COLUMNS` and adding missing columns in the staging table so older schemas continue to work.

### 7.4 Transfer behavior

`transfer(cfg, startDate, endDate)` aggregates records from `dbo.v_salesdetails` into `dts_pitx_payload` between the chosen dates.

The transfer logic:

- identifies voided FCR invoice numbers
- detects Solo Parent discount usage
- aggregates normal and void rows separately
- deduplicates by `receipt_no`
- inserts records with a default status of `pending`
- skips rows already present in the staging table

### 7.5 Key queries and helpers

The database layer exposes operations for:

- `fetchRecordByGuestCheckId()`
- `fetchRecords()`
- `getStatusCounts()`
- `getSummaryMetrics()`
- `testConnection()`
- `installCreateTable()`
- `fetchPendingByDate()`
- `markSubmitted()`
- `markVoided()`
- `markRateLimited()`
- `markFailed()`
- `resetForResubmit()`

---

## 8. TSMS Payload and Submission Engine

The TSMS logic is in `src/main/tsms.ts` and mirrors the Python implementation but with desktop-specific handling and more explicit retries.

### 8.1 Helper functions

The submission engine defines helpers such as:

- `tsmsAmount()` → formats numeric values as `0.00` strings
- `tsmsGenerateUuidV4()` → `crypto.randomUUID()`
- `tsmsIsoTimestampNow()` → timestamp in UTC with millisecond precision
- `tsmsChecksum()` → SHA-256 checksum over a sorted JSON payload
- `upperCaseKeys()` → uppercase record keys for compatibility with downstream logic

### 8.2 Payload construction

`buildTransaction()` builds the TSMS transaction object with:

- transaction ID
- hardware ID
- receipt no
- transaction timestamp
- gross sales and net sales
- promo status
- customer code
- payload checksum
- 7 adjustment entries
- 4 tax entries

`buildSubmission()` wraps the transaction inside the submission envelope with:

- `submission_uuid`
- `tenant_id`
- `terminal_id`
- `submission_timestamp`
- `transaction_count`
- payload checksum

### 8.3 HTTP client behavior

The client configuration sets:

- `Authorization: Bearer <token>`
- `Content-Type: application/json`
- `Accept: application/json`
- `User-Agent: TSMS-PITX-Desktop/1.0`
- 30-second timeout
- `validateStatus: () => true` so TSMS classification happens in app logic

### 8.4 Response classification

Outcomes include:

- `success` for HTTP 2xx with accepted payload
- `success` for idempotent duplicate responses such as `already_processed`
- `rate_limited` for 429 responses
- `retryable` for 5xx and network failures
- `terminal` for 401, 403, 409, and 422 conditions unless handled explicitly

### 8.5 `submitOne()` flow

`submitOne(cfg, rec)` performs the full orchestration for one row:

1. ensure record is loaded and uppercased
2. detect whether the row is a void row
3. ensure a `transaction_id` exists
4. build the transaction payload
5. build the final submission envelope
6. send to TSMS
7. classify and persist the result to the database
8. handle retry, resubmit, terminal, and void follow-up logic

Important behaviors:

- if TSMS responds `409` on a still-pending row, the app regenerates the `transaction_id`, stores it, and resubmits
- a checksum or validation `422` can trigger a one-time rebuild and retry
- `429` responses respect `Retry-After` and do not burn retry budget
- `5xx` and network failures use exponential backoff of `2, 4, 8, 16, 32` seconds
- post-submit voids can retry when TSMS is still indexing the transaction

### 8.6 Void behavior

The app supports:

- direct void transaction submissions via `voidTransaction()`
- automatic void follow-up after a successful submit
- retries when TSMS temporarily reports the transaction as missing

---

## 9. IPC API Surface

The preload script exposes a `window.pos` object used by the renderer. Important channels include:

| API | IPC Channel | Purpose |
|---|---|---|
| `getConfig()` | `config:get` | get config JSON |
| `saveConfig(cfg)` | `config:save` | save config |
| `getConfigPath()` | `config:path` | return config file path |
| `hasConfigFile()` | `config:has-file` | check if config exists |
| `testConnection(cfg)` | `config:test-connection` | test SQL Server availability |
| `transfer(start,end)` | `db:transfer` | fetch and insert transactions |
| `getStatusCounts(filters)` | `db:status-counts` | row counts per status |
| `getSummary(filters)` | `db:summary` | summary totals |
| `getRecords(filters,page,pageSize)` | `db:records` | paged record list |
| `getRecord(id)` | `db:record` | single record fetch |
| `installCreateTable()` | `install:create-table` | create or repair staging table |
| `submitByDateRange(start,end)` | `submit:by-date-range` | batch submit |
| `submitToday()` | `submit:today` | submit current date |
| `submitDated(date)` | `submit:dated` | date-specific insert + submit |
| `submitControl(action)` | `submit:control` | pause/resume/abort |
| `submitSingle(guestCheckId)` | `submit:single` | submit one record |
| `resubmit(guestCheckId)` | `submit:resubmit` | reset and retry one record |
| `voidRecord(guestCheckId)` | `submit:void` | void a transaction |
| `previewPayload(guestCheckId)` | `preview:payload` | return payload JSON |
| `onSubmitEvent(callback)` | `submit:event` | subscribe to live progress events |
| `startAutomation()` | `automation:start` | enable timed automation |
| `stopAutomation()` | `automation:stop` | disable automation |
| `getAutomationStatus()` | `automation:status` | automation state |
| `checkForUpdates()` | `app:update-check` | check for app updates |
| `downloadUpdate()` | `app:update-download` | download update |
| `installUpdate()` | `app:update-install` | install update |
| `onUpdateEvent(callback)` | `app:update` | listen for update events |

---

## 10. Renderer UI Overview

The renderer is a single-page Electron UI with tabs and dashboard panels for transfer, monitoring, submission, and settings.

### 10.1 Main UI sections

- Transfer / data fetch panel
- submission controls
- dashboard stats and summary cards
- paginated table of staged transactions
- payload preview modal
- settings screen
- dated submission / automation panel

### 10.2 Core UI behaviors

The renderer:

- loads config on startup
- tests database connectivity
- populates settings form values
- applies a saved or OS-based theme
- fetches records and summary metrics
- displays pending / submitted / failed / voided totals
- copies payloads or IDs to clipboard
- opens a preview modal for full JSON payloads
- supports context menu actions on table rows

### 10.3 Data table

The table includes columns for:

- receipt number
- transdatetime
- order type
- location
- status
- retry count
- net sales, VAT, less VAT, discount, gross sales
- void totals
- submission metadata
- last error and response body
- stored payload and current payload copy actions

### 10.4 Submission UI

The UI supports:

- dated range submission
- single-day date submission
- pause / resume / abort controls
- live progress events from the main process
- automatic rerender after successful or failed submit runs

### 10.5 Settings UI

The settings page includes:

- SQL server credentials
- TSMS API settings
- filter values
- worker configuration
- automation toggle and save action
- connectivity test
- create table button

---

## 11. Automation and Scheduling

The app includes timed automation built into `src/main/ipc.ts`.

### 11.1 Automation flow

When automation is enabled:

- the app periodically runs an automation cycle
- it fetches the current date and transfers any new records for that date
- it scans submitted void records needing follow-up void submission
- it submits all pending rows for that date
- it emits status events back to the browser process

### 11.2 Automation state

State values include:

- `automationEnabled`
- `automationRunning`
- `automationTimer`

The app also configures startup login behavior when packaged:

- `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`

### 11.3 Automation UI

The renderer exposes:

- automation toggle
- Save button to persist configuration
- status badge and live pipeline indicators
- “Dated Submission” flow that can also be run manually

---

## 12. Update Support

The project includes automatic update support through `electron-updater`.

### 12.1 Update flow

- `checkForUpdates()` checks GitHub release metadata
- `downloadUpdate()` downloads the installer package
- `installUpdate()` triggers `autoUpdater.quitAndInstall()`
- update events are pushed to the renderer via `app:update`

### 12.2 Packaging configuration

In `package.json`:

- app ID: `ph.pitx.pos.transfer`
- product name: `PITX POS Transfer`
- output directory: `release-fixed`
- target: NSIS Windows installer
- GitHub publish metadata is configured for release publishing

---

## 13. Build, Run, and Dist

### 13.1 Scripts

| Script | Command | Purpose |
|---|---|---|
| `build` | `tsc -p tsconfig.json` | compile TypeScript |
| `start` | `npm run build && electron .` | run app in dev mode |
| `dev` | `tsc -p tsconfig.json --watch` | watch compilation |
| `dist` | `npm run build && electron-builder --win` | build Windows release |

### 13.2 Build output

- main process: `dist/main/main.js`
- preload: `dist/preload/preload.js`
- renderer assets remain in `src/renderer` and are bundled by Electron Builder

### 13.3 Runtime notes

- app starts with single-instance lock enforcement
- hardware acceleration is disabled
- tray icon support is enabled
- app hides on close by default unless quitting intentionally

---

## 14. Data Flow Summary

### 14.1 Transfer flow

```text
User selects date range
  -> renderer calls db:transfer
  -> main process executes staging aggregation query
  -> rows inserted into dbo.dts_pitx_payload
  -> status counts and table refresh update the UI
```

### 14.2 Submit flow

```text
User submits date range
  -> main process fetches pending records
  -> each record runs through tsms.submitOne()
  -> payload built and sent to TSMS
  -> response classified
  -> DB status updated
  -> renderer receives live progress events
```

### 14.3 Automation flow

```text
Automation enabled
  -> timer triggers cycle
  -> transfer current day rows
  -> detect void submissions
  -> submit pending rows for the date
  -> emit progress events and final batch status
```

---

## 15. Important Design Notes

1. The app keeps config outside the app directory when packaged so updates and Windows permissions do not overwrite it.
2. `receipt_no` is taken from the staging record rather than auto-generated on every attempt, which keeps payloads stable for the same row.
3. `promo_status` uses `WITH_APPROVAL` when applicable and otherwise `NONE`.
4. The app deliberately preserves the TSMS API contract while adding desktop monitoring and automation features.
5. Staging table schema is tolerant of older installations because missing columns are added automatically.
6. Retry logic is split between rate limiting, exponential backoff, and hard terminal conditions.
7. The project still maintains compatibility with the Python TSMS logic while being optimized for desktop use.

---

## 16. Current Status and Operational Notes

The current codebase is a working desktop submission tool for PITX operations and includes the following production-oriented features:

- SQL Server health checks
- staging table creation and migration
- TSMS payload creation and retries
- live status monitoring
- pause/abort submission control
- bulk and date-based submission
- automation cycle support
- update check and install support
- tray/menu-driven desktop behavior

This documentation reflects the code currently in the repository as of the 1.0.6 release and should be treated as the source of truth for implementation details.
