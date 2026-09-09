# PITX POS Transfer — Electron/TypeScript port

A modern desktop rebuild of the original Tkinter app (`pos.py` / `pos_desktop.py`
/ `pos_common.py`). Same job: aggregate `dbo.v_salesdetails` into
`dbo.dts_pitx_payload` on SQL Server, then submit pending records to the TSMS
API, with resubmit/void and a live activity log.

## ⚠️ One real gap — please read

`tsms_common.py` was **not** included in your upload (only `pos_common.py`,
which just re-exports from it). That file held the actual implementation of
`submit_one`, `submit_by_date_range`, `void_transaction`, `fetch_status_counts`,
etc. — i.e. the *exact* TSMS request/response shape.

Everything in this port that touches SQL Server (`src/main/db.ts`) is a
faithful 1:1 translation of `pos.py`'s SQL — that part is safe to trust.

Everything in `src/main/tsms.ts` (the HTTP calls to the TSMS API) is my best
reconstruction from `config.json`'s `tsms` block and how `pos_desktop.py`
*calls* those functions — not from their real bodies. It's clearly commented.
**Send me `tsms_common.py` and I'll swap it for an exact port** — until then,
treat submit/void as "should work, verify against a staging transaction
first."

## Architecture

```
src/
  main/            Electron main process (Node) — all privileged work happens here
    main.ts         creates the BrowserWindow
    config.ts       loads/saves config.json next to the .exe (same behavior as pos.py)
    db.ts           mssql connection pool + transfer()/records queries (ported from pos.py)
    tsms.ts         TSMS API client (submit/void) — see gap above
    ipc.ts          wires renderer requests to db.ts/tsms.ts, runs the pausable submit loop
  preload/
    preload.ts      contextBridge — the only thing the renderer can call (window.pos.*)
  renderer/          the UI — plain HTML/CSS/JS, no framework/bundler needed
    index.html
    styles.css       modern dark theme
    renderer.js
```

Why this shape: the renderer never touches SQL Server or the TSMS token
directly (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`)
— all of that lives in the main process behind `window.pos.*`, which is how
Electron apps are supposed to be built today. That's also strictly more
secure than the Python app, where the DB password and API token sit in a
plaintext `config.json` a user could open directly (this port keeps the same
config.json for drop-in familiarity, but nothing renders it to the page
un-redacted except the Settings/Install forms you're already typing into).

## Setup

```bash
cd pitx-pos-electron
npm install
```

You'll need the SQL Server Native Client / ODBC is **not** required anymore —
`mssql` (via `tedious`) talks TDS directly, so there's nothing extra to
install on the machine running this app.

```bash
npm run build   # compiles src/main + src/preload TypeScript -> dist/
npm start        # build + launch Electron
```

First launch creates `config.json` next to the app (seeded from
`config.default.json`, which ships with blank credentials — fill them in via
the **Install** tab, or paste your existing `config.json` values into
**Settings**).

## Building a distributable .exe

```bash
npm run dist
```

This runs `electron-builder` using the `build` block in `package.json`
(NSIS installer, targets `win`). Drop a real `.ico` at `build/icon.ico`
first — there's a placeholder gap there since I can't generate binary icon
files. Output lands in `release-fixed/`.

## Feature parity checklist (vs. the Tkinter app)

| Old (Tkinter) | New (Electron) |
|---|---|
| `Transfer` tab: stats, filters, table, log | ✅ same layout, modernized |
| `Settings` tab | ✅ |
| `Install` tab (connect → create table → save creds) | ✅ |
| Guest Check / Date / Status filters | ✅ |
| Pagination + page size | ✅ |
| Get Data (date range aggregation) | ✅ ported 1:1 from `pos.py` SQL |
| Submit Pending (batch, pause/abort, retries) | ✅ logic ported; **payload shape is a best guess** (see gap above) |
| Resubmit / Void single record | ✅ wired the same way, same caveat |
| Live activity log with icons | ✅ (color-coded instead of emoji, reads better in a dark UI) |
| Custom date-picker popup | replaced with native `<input type="date">` — same result, zero custom code to maintain |
| `logs.txt` rotating file | not yet ported — currently only the in-app log panel. Easy to add back with a Node logger (e.g. `winston`) if you want the file too — say the word |

## Notes on the `dts_pitx_payload` schema

The Install tab's "Create Table" button (`installCreateTable` in `db.ts`)
recreates the table using every column this app reads/writes, inferred from
`pos.py`'s `INSERT` list and `pos_desktop.py`'s tree/detail columns. If your
actual production table was created by a different schema script (there's a
`_schema_script_path()` in the old GUI implying one exists on disk that
wasn't uploaded), point Install at that script instead of relying on this
generated one — same caveat as the TSMS payload: I built this from evidence,
not from the original DDL.
