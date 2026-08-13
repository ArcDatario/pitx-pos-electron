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
  ["GUESTCHECKID", "Guest Check"],
  ["businessdate", "Date"],
  ["locationname", "Location"],
  ["status", "Status"],
  ["retry_count", "Retry"],
  ["netsales", "Net Sales"],
  ["vat_12", "VAT 12%"],
  ["gross_sales", "Gross Sales"],
  ["voidtotal_amt", "Void Amt"],
  ["receipt_no", "Receipt No"],
  ["transaction_id", "Transaction ID"],
  ["last_error", "Last Error"],
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
$("btnPause").addEventListener("click", async () => {
  paused = !paused;
  await window.pos.submitControl(paused ? "pause" : "resume");
  $("btnPause").textContent = paused ? "Resume" : "Pause";
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

// ---------- Install ----------
let installCfg = null;

$("btnInstallConnect").addEventListener("click", async () => {
  installCfg = {
    ...state.config,
    sqlserver: {
      server: $("i_server").value,
      database: $("i_database").value,
      username: $("i_username").value,
      password: $("i_password").value,
      driver: "ODBC Driver 17 for SQL Server",
    },
  };
  $("installStatus").textContent = "Connecting...";
  const res = await window.pos.testConnection(installCfg);
  if (res.ok) {
    $("installStatus").textContent = `Connected to ${res.dbName}`;
    $("btnCreateTable").disabled = false;
    $("btnInstallSave").disabled = false;
  } else {
    $("installStatus").textContent = `Failed: ${res.message}`;
  }
});

$("btnCreateTable").addEventListener("click", async () => {
  $("createTableStatus").textContent = "Creating...";
  try {
    await window.pos.saveConfig(installCfg); // installCreateTable reads config from disk
    await window.pos.installCreateTable();
    $("createTableStatus").textContent = "Table ready";
  } catch (e) {
    $("createTableStatus").textContent = `Failed: ${e.message}`;
  }
});

$("btnInstallSave").addEventListener("click", async () => {
  await window.pos.saveConfig(installCfg);
  state.config = installCfg;
  fillSettingsForm(installCfg);
  $("installSaveStatus").textContent = "Saved as active credentials";
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
