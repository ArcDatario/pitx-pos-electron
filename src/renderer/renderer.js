// PITX POS Transfer - renderer process (plain modern JS, no bundler needed)
// Talks to the main process exclusively through window.pos (see preload.ts)

const state = {
  page: 1,
  pageSize: 50,
  filters: { guestCheckId: "", date: "", status: "" },
  total: 0,
  selectedGuestCheckId: null,
  config: null,
  submitting: false,
};

const COLUMNS = [
  ["receipt_no", "Receipt No"],
  ["businessdate", "Date"],
  ["locationname", "Location"],
  ["status", "Status"],
  ["retry_count", "Retry"],
  ["netsales", "Net Sales"],
  ["vat_12", "VAT 12%"],
  ["gross_sales", "Gross Sales"],
  ["voidtotal_amt", "Void Amt"],
  ["transaction_id", "Transaction ID"],
  ["last_error", "Last Error"],
  ["payload", "Payload"],
];

const $ = (id) => document.getElementById(id);
const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : n ?? "0.00");

// ---------- Tabs ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`panel-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- Activity log ----------
function logEvent(type, message) {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${message}`;
  $("logBody").appendChild(line);
  $("logBody").scrollTop = $("logBody").scrollHeight;
  while ($("logBody").children.length > 500) $("logBody").removeChild($("logBody").firstChild);
}
$("btnClearLog").addEventListener("click", () => ($("logBody").innerHTML = ""));

function setStatus(text) {
  $("statusText").textContent = text;
}

// ---------- Stats ----------
async function refreshStats() {
  const counts = await window.pos.getStatusCounts();
  const specs = [
    ["total", "Total"],
    ["pending", "Pending"],
    ["submitted", "Submitted"],
    ["failed", "Failed"],
    ["voided", "Voided"],
  ];
  $("statusStats").innerHTML = specs
    .map(([k, l]) => `<div class="stat-pill"><span class="val">${counts[k] ?? 0}</span><span class="lbl">${l}</span></div>`)
    .join("");

  const summary = await window.pos.getSummary(state.filters);
  const mSpecs = [
    ["netsales", "Net Sales"],
    ["vat_12", "VAT 12%"],
    ["lessvat", "Less VAT"],
    ["lessSC", "Less SC"],
    ["lessPWD", "Less PWD"],
    ["void_amt", "Void Amt"],
    ["total_revenue", "Total Revenue"],
  ];
  $("summaryStats").innerHTML = mSpecs
    .map(([k, l]) => `<div class="stat-pill"><span class="val">${fmt(summary[k])}</span><span class="lbl">${l}</span></div>`)
    .join("");
}

// ---------- Table ----------
function renderTableHead() {
  $("recordsTable").querySelector("thead").innerHTML =
    "<tr>" + COLUMNS.map(([, label]) => `<th>${label}</th>`).join("") + "</tr>";
}

function renderTableRows(rows) {
  const tbody = $("recordsTable").querySelector("tbody");
  $("emptyState").classList.toggle("hidden", rows.length !== 0);

  tbody.innerHTML = rows
    .map((r) => {
      const cells = COLUMNS.map(([key]) => {
        if (key === "status") {
          const s = (r.status || "").toLowerCase();
          return `<td><span class="badge ${s}">${r.status ?? ""}</span></td>`;
        }
        if (["netsales", "vat_12", "gross_sales", "voidtotal_amt"].includes(key)) {
          return `<td>${fmt(r[key])}</td>`;
        }
        if (key === "businessdate" && r[key]) {
          return `<td>${String(r[key]).slice(0, 10)}</td>`;
        }
        if (key === "payload") {
          return `<td><button class="btn ghost sm copy-payload-btn" data-id="${r.GUESTCHECKID}" title="Copy payload"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button></td>`;
        }
        return `<td>${r[key] ?? ""}</td>`;
      }).join("");
      return `<tr data-id="${r.GUESTCHECKID}">${cells}</tr>`;
    })
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      tbody.querySelectorAll("tr").forEach((t) => t.classList.remove("selected"));
      tr.classList.add("selected");
      state.selectedGuestCheckId = tr.dataset.id;
    });
    tr.addEventListener("dblclick", async () => {
      const guestCheckId = tr.dataset.id;
      setStatus("Building payload...");
      try {
        const res = await window.pos.previewPayload(guestCheckId);
        if (res.ok) {
          openPayloadModal(JSON.stringify(res.payload, null, 2));
          setStatus("Payload preview ready");
        } else {
          setStatus("Failed: " + res.message);
        }
      } catch (err) {
        setStatus("Failed: " + err.message);
      }
    });
  });
}

async function loadRecords() {
  const { rows, total } = await window.pos.getRecords(state.filters, state.page, state.pageSize);
  state.total = total;
  renderTableRows(rows);
  const maxPage = Math.max(1, Math.ceil(total / state.pageSize));
  $("pageInfo").textContent = `Page ${state.page} of ${maxPage} (${total} records)`;
  $("btnPrev").disabled = state.page <= 1;
  $("btnNext").disabled = state.page >= maxPage;
}

async function refreshAll() {
  await Promise.all([refreshStats(), loadRecords()]);
}

// ---------- Filters ----------
$("btnApply").addEventListener("click", () => {
  state.filters = {
    guestCheckId: $("fGuest").value.trim(),
    date: $("fDate").value,
    status: $("fStatus").value,
  };
  state.page = 1;
  refreshAll();
});
$("btnReset").addEventListener("click", () => {
  $("fGuest").value = "";
  $("fDate").value = "";
  $("fStatus").value = "";
  state.filters = { guestCheckId: "", date: "", status: "" };
  state.page = 1;
  refreshAll();
});

$("btnPrev").addEventListener("click", () => {
  if (state.page > 1) {
    state.page--;
    loadRecords();
  }
});
$("btnNext").addEventListener("click", () => {
  state.page++;
  loadRecords();
});
$("pageSize").addEventListener("change", (e) => {
  state.pageSize = parseInt(e.target.value, 10);
  state.page = 1;
  loadRecords();
});

// ---------- Get Data (transfer) ----------
async function runGetData() {
  const start = $("rangeStart").value;
  const end = $("rangeEnd").value;
  if (!start || !end) {
    setStatus("Pick a start and end date first");
    return;
  }
  toggleBusy(true);
  setStatus(`Fetching data ${start} → ${end}...`);
  logEvent("phase", `Get Data: ${start} to ${end}`);
  try {
    const { inserted } = await window.pos.transfer(start, end);
    logEvent("success", `Inserted ${inserted} new guest check(s)`);
    setStatus(`Done — ${inserted} inserted`);
  } catch (e) {
    logEvent("error", `Get Data failed: ${e.message}`);
    setStatus("Get Data failed");
  } finally {
    toggleBusy(false);
    refreshAll();
  }
}
$("btnGetData").addEventListener("click", runGetData);
$("btnEmptyGetData").addEventListener("click", runGetData);

// ---------- Submit ----------
function toggleBusy(busy) {
  $("spinner").classList.toggle("hidden", !busy);
  $("btnGetData").disabled = busy;
  $("btnSubmit").disabled = busy;
}

function toggleSubmittingUi(on) {
  state.submitting = on;
  $("btnPause").classList.toggle("hidden", !on);
  $("btnAbort").classList.toggle("hidden", !on);
  $("btnSubmit").classList.toggle("hidden", on);
  $("btnGetData").disabled = on;
}

$("btnSubmit").addEventListener("click", async () => {
  const start = $("rangeStart").value;
  const end = $("rangeEnd").value;
  if (!start || !end) {
    setStatus("Pick a start and end date first");
    return;
  }
  toggleSubmittingUi(true);
  setStatus("Submitting...");
  logEvent("phase", `Submitting pending records ${start} to ${end}`);
  try {
    const result = await window.pos.submitByDateRange(start, end);
    setStatus(
      `Done: ${result.successCount} submitted, ${result.failCount} failed` +
        (result.aborted ? " (aborted)" : "")
    );
  } catch (e) {
    logEvent("error", `Submit failed: ${e.message}`);
    setStatus("Submit failed");
  } finally {
    toggleSubmittingUi(false);
    refreshAll();
  }
});

let paused = false;
const pauseIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>`;
const resumeIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
$("btnPause").addEventListener("click", async () => {
  paused = !paused;
  await window.pos.submitControl(paused ? "pause" : "resume");
  $("btnPause").innerHTML = paused ? resumeIcon : pauseIcon;
  $("btnPause").title = paused ? "Resume" : "Pause";
});
$("btnAbort").addEventListener("click", async () => {
  await window.pos.submitControl("abort");
  setStatus("Aborting...");
});

window.pos.onSubmitEvent((event) => {
  logEvent(event.type, event.message);
  if (event.type === "sending") {
    setStatus(`Sending ${event.guest_check_id} (${event.index}/${event.total})`);
  }
});

// ---------- Submit Today (insert today's data + submit) ----------
function openConfirmModal() {
  const today = new Date().toISOString().slice(0, 10);
  $("confirmTodayDate").textContent = today;
  $("confirmDateRange").textContent = `${today} to ${today}`;
  $("confirmModal").classList.remove("hidden");
}

function closeConfirmModal() {
  $("confirmModal").classList.add("hidden");
}

$("btnSubmitToday").addEventListener("click", () => {
  if (state.submitting) {
    setStatus("A submission is already in progress");
    return;
  }
  openConfirmModal();
});

$("confirmModal").addEventListener("click", (e) => {
  if (e.target === $("confirmModal")) closeConfirmModal();
});
$("btnCloseConfirmModal").addEventListener("click", closeConfirmModal);
$("btnConfirmCancel").addEventListener("click", closeConfirmModal);

$("btnConfirmSubmit").addEventListener("click", async () => {
  closeConfirmModal();
  toggleSubmittingUi(true);
  setStatus("Submitting today...");
  logEvent("phase", "Submit Today: inserting today's transactions then submitting");
  try {
    const result = await window.pos.submitToday();
    const inserted = result.inserted ?? 0;
    setStatus(
      `Done: ${inserted} inserted, ${result.successCount} submitted, ${result.failCount} failed` +
        (result.aborted ? " (aborted)" : "")
    );
    logEvent(
      "success",
      `Submit Today complete — ${inserted} inserted, ${result.successCount} submitted, ${result.failCount} failed`
    );
  } catch (e) {
    logEvent("error", `Submit Today failed: ${e.message}`);
    setStatus("Submit Today failed");
  } finally {
    toggleSubmittingUi(false);
    refreshAll();
  }
});

// ---------- Payload preview / copy ----------
let currentPreviewPayload = null;

function openPayloadModal(text) {
  currentPreviewPayload = text;
  $("payloadPreview").textContent = text;
  $("payloadModal").classList.remove("hidden");
}

function closePayloadModal() {
  $("payloadModal").classList.add("hidden");
  currentPreviewPayload = null;
}

$("payloadModal").addEventListener("click", (e) => {
  if (e.target === $("payloadModal")) closePayloadModal();
});
$("btnCloseModal").addEventListener("click", closePayloadModal);
$("btnCopyModal").addEventListener("click", async () => {
  if (currentPreviewPayload) {
    await navigator.clipboard.writeText(currentPreviewPayload);
    setStatus("Payload copied to clipboard");
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-payload-btn");
  if (!btn) return;
  const guestCheckId = btn.dataset.id;
  setStatus("Building payload...");
  try {
    const res = await window.pos.previewPayload(guestCheckId);
    if (res.ok) {
      const text = JSON.stringify(res.payload, null, 2);
      await navigator.clipboard.writeText(text);
      setStatus("Payload copied to clipboard");
    } else {
      setStatus("Failed: " + res.message);
    }
  } catch (err) {
    setStatus("Failed: " + err.message);
  }
});

// ---------- Settings ----------
const SETTINGS_FIELDS = [
  ["sqlserver", "server"],
  ["sqlserver", "database"],
  ["sqlserver", "username"],
  ["sqlserver", "password"],
  ["tsms", "api_url"],
  ["tsms", "api_token"],
  ["tsms", "tenant_id"],
  ["tsms", "terminal_id"],
  ["tsms", "hardware_id"],
  ["tsms", "customer_code"],
  ["filters", "locationname"],
  ["filters", "storenum"],
  ["worker", "poll_interval_seconds"],
  ["worker", "batch_size"],
  ["worker", "max_retries"],
];

function fillSettingsForm(cfg) {
  for (const [section, key] of SETTINGS_FIELDS) {
    const el = $(`s_${section}_${key}`);
    if (el) el.value = cfg[section]?.[key] ?? "";
  }
}

function collectSettingsForm() {
  const cfg = JSON.parse(JSON.stringify(state.config));
  for (const [section, key] of SETTINGS_FIELDS) {
    const el = $(`s_${section}_${key}`);
    if (!el) continue;
    const raw = el.value;
    cfg[section][key] = el.type === "number" ? Number(raw) : raw;
  }
  return cfg;
}

$("btnSaveSettings").addEventListener("click", async () => {
  const cfg = collectSettingsForm();
  await window.pos.saveConfig(cfg);
  state.config = cfg;
  $("settingsStatus").textContent = "Saved";
  setTimeout(() => ($("settingsStatus").textContent = ""), 2000);
});

$("btnTestConn").addEventListener("click", async () => {
  const cfg = collectSettingsForm();
  $("settingsStatus").textContent = "Testing...";
  const res = await window.pos.testConnection(cfg);
  if (res.ok) {
    const tableInfo = (res.tables || [])
      .map((t) => `${t.name}: ${t.exists ? `${t.rows} rows` : "missing"}`)
      .join(" · ");
    $("settingsStatus").textContent = `Connected to ${res.dbName} — ${tableInfo}`;
  } else {
    $("settingsStatus").textContent = `Failed: ${res.message}`;
  }
});

$("btnCreateTable").addEventListener("click", async () => {
  $("createTableStatus").textContent = "Creating...";
  try {
    await window.pos.installCreateTable();
    $("createTableStatus").textContent = "Table ready";
  } catch (e) {
    $("createTableStatus").textContent = `Failed: ${e.message}`;
  }
});

// ---------- Boot ----------
async function boot() {
  renderTableHead();
  state.config = await window.pos.getConfig();
  fillSettingsForm(state.config);
  $("connSub").textContent = `${state.config.sqlserver.server} / ${state.config.sqlserver.database}`;

  const today = new Date().toISOString().slice(0, 10);
  $("rangeStart").value = today;
  $("rangeEnd").value = today;

  await refreshAll();
}

boot().catch((e) => logEvent("error", `Startup error: ${e.message}`));
