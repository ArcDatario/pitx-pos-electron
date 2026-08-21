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
  ["transdatetime", "Date/Time"],
  ["ordertypename", "Order Type"],
  ["locationname", "Location"],
  ["status", "Status"],
  ["retry_count", "Retry"],
  ["netsales", "Net Sales"],
  ["vat_12", "VAT 12%"],
  ["lessvat", "Less VAT"],
  ["discount", "Discount"],
  ["gross_sales", "Gross Sales"],
  ["voidtotal_amt", "Void Amt"],
  ["submission_timestamp", "Submitted At"],
  ["submission_uuid", "Submission UUID"],
  ["transaction_id", "Transaction ID"],
  ["last_error", "Last Error"],
  ["last_payload_sent", "Sent Payload"],
  ["payload", "Payload"],
];

const $ = (id) => document.getElementById(id);
const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : n ?? "0.00");

const pad = (n) => String(n).padStart(2, "0");

// Formats a DATETIME2 value (string from tedious, or a Date) as a readable
// "YYYY-MM-DD HH:MM:SS", preserving the stored wall-clock time.
function fmtDate(v) {
  if (!v) return "";
  if (v instanceof Date) {
    return (
      pad(v.getFullYear()) + "-" + pad(v.getMonth() + 1) + "-" + pad(v.getDate()) +
      " " + pad(v.getHours()) + ":" + pad(v.getMinutes()) + ":" + pad(v.getSeconds())
    );
  }
  return String(v)
    .replace(/\.\d+(Z|[+-]\d{2}:?\d{2})?$/, "")
    .replace("T", " ")
    .trim();
}

function getVal(r, key) {
  const lower = key.toLowerCase();
  const found = Object.keys(r).find((k) => k.toLowerCase() === lower);
  return found !== undefined ? r[found] : undefined;
}

function discountFor(r) {
  for (const f of ["lessSoloparent", "lessPWD", "lessSC", "lessEMP", "lessNtnlAth", "otherdiscount"]) {
    const v = Number(getVal(r, f));
    if (!isNaN(v) && v !== 0) return v;
  }
  return 0;
}

// ---------- Dark mode ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-bs-theme", theme);
  const icon = $("themeIcon");
  if (icon) icon.className = theme === "dark" ? "bi bi-sun" : "bi bi-moon";
  const btn = $("btnThemeToggle");
  if (btn) btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function initTheme() {
  let theme = localStorage.getItem("theme");
  if (!theme) {
    theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  applyTheme(theme);
}

$("btnThemeToggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("theme", next);
});

// ---------- Tabs ----------
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.classList.add("active");
  const panel = $(`panel-${name}`);
  if (panel) panel.classList.add("active");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// Native File > Settings menu item (see preload.ts: onNavigateSettings)
window.pos.onNavigateSettings(() => switchTab("settings"));

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
    ["lessEMP", "Less EMP"],
    ["lessSoloParent", "Less Sol. Parent"],
    ["void_amt", "Void Amt"],
    ["total_revenue", "Total Revenue"],
  ];
  $("summaryStats").innerHTML = mSpecs
    .map(([k, l]) => `<div class="stat-pill"><span class="val">${fmt(summary[k])}</span><span class="lbl">${l}</span></div>`)
    .join("");
}

// ---------- Table ----------
const copyCache = new Map(); // guestCheckId -> last_payload_sent text (only rows with data)

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
        if (["netsales", "vat_12", "lessvat", "gross_sales", "voidtotal_amt"].includes(key)) {
          return `<td>${fmt(r[key])}</td>`;
        }
        if (key === "discount") {
          return `<td>${fmt(discountFor(r))}</td>`;
        }
        if (key === "transdatetime" && r[key]) {
          return `<td>${fmtDate(r[key])}</td>`;
        }
        if (key === "submission_timestamp" && r[key]) {
          return `<td>${fmtDate(r[key])}</td>`;
        }
        if (key === "submission_uuid" && r[key]) {
          return `<td title="${r[key]}">${String(r[key]).slice(0, 8)}…</td>`;
        }
        if (key === "last_payload_sent") {
          if (!r[key]) return `<td></td>`;
          copyCache.set(r.GUESTCHECKID, r[key]);
          return `<td><button class="btn ghost sm copy-col-btn" data-id="${r.GUESTCHECKID}" title="Copy sent payload">${copyIconSvg}</button></td>`;
        }
        if (key === "payload") {
          return `<td><button class="btn ghost sm copy-payload-btn" data-id="${r.GUESTCHECKID}" title="Copy payload"><i class="bi bi-clipboard"></i></button></td>`;
        }
        return `<td>${r[key] ?? ""}</td>`;
      }).join("");
      return `<tr data-id="${r.GUESTCHECKID}" data-tx-id="${r.transaction_id ?? ""}">${cells}</tr>`;
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
const pauseIcon = `<i class="bi bi-pause-fill"></i>`;
const resumeIcon = `<i class="bi bi-play-fill"></i>`;
const copyIconSvg = `<i class="bi bi-clipboard"></i>`;
const checkIconSvg = `<i class="bi bi-check2"></i>`;
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
  if (!state.submitting) return;
  logEvent(event.type, event.message);
  if (event.type === "sending") {
    setStatus(`Sending ${event.guest_check_id} (${event.index}/${event.total})`);
  }
});

// ---------- Dated Submission (insert a chosen date's data + submit, animated) ----------
const datedState = { submitting: false, inFlight: {}, total: 0, processed: 0 };

(function initDatedDateDefault() {
  const el = $("datedDate");
  if (el && !el.value) el.value = new Date().toISOString().slice(0, 10);
})();

function setDatedStatus(msg) {
  $("datedStatusText").textContent = msg;
}

function datedLog(type, message) {
  const body = $("datedLogBody");
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}
$("btnDatedClearLog").addEventListener("click", () => {
  $("datedLogBody").innerHTML = "";
});

function hideDatedCompletion() {
  const el = $("datedCompletion");
  el.classList.add("hidden");
  el.classList.remove("state-success", "state-attention", "state-error");
}

function showDatedCompletion(state_, message) {
  const el = $("datedCompletion");
  el.classList.remove("hidden", "state-success", "state-attention", "state-error");
  el.classList.add(`state-${state_}`);
  const icon = $("datedCompletionIcon");
  icon.innerHTML =
    state_ === "success"
      ? `<i class="bi bi-check-circle-fill"></i>`
      : state_ === "attention"
      ? `<i class="bi bi-exclamation-triangle-fill"></i>`
      : `<i class="bi bi-x-circle-fill"></i>`;
  $("datedCompletionText").textContent = message;
}

function setProgress(percent, label, mode) {
  const fill = $("datedProgressFill");
  fill.classList.remove("indeterminate", "done", "error");
  if (mode) fill.classList.add(mode);
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $("datedProgressLabel").textContent = label;
}

function setProgressIndeterminate(label) {
  const fill = $("datedProgressFill");
  fill.classList.remove("done", "error");
  fill.classList.add("indeterminate");
  fill.style.width = "";
  $("datedProgressLabel").textContent = label;
}

function resetProgress() {
  const fill = $("datedProgressFill");
  fill.classList.remove("indeterminate", "done", "error");
  fill.style.width = "0%";
  $("datedProgressLabel").textContent = "Waiting to start";
}

function resetPipeline() {
  $("stageFetch").classList.remove("active");
  $("stageBuild").classList.remove("active");
  $("flowFetchToBuild").classList.remove("active");
  $("fetchCount").textContent = "0 inserted";
  $("buildCount").textContent = "0 in flight";
  $("buildTrack").innerHTML = "";
  ["Submitted", "Voided", "Failed"].forEach((lane) => {
    $(`count${lane}`).textContent = "0";
    $(`conn${lane}`).classList.remove("pulse");
    $(`circle${lane}`).classList.remove("bump");
  });
  $("circleFailed").classList.remove("attention");
  hideDatedCompletion();
  resetProgress();
  datedState.inFlight = {};
  datedState.total = 0;
  datedState.processed = 0;
}

function toggleDatedSubmittingUi(on) {
  datedState.submitting = on;
  $("btnDatedPause").classList.toggle("hidden", !on);
  $("btnDatedAbort").classList.toggle("hidden", !on);
  $("btnDatedSubmit").classList.toggle("hidden", on);
  $("datedDate").disabled = on;
}

function buildChipId(guestCheckId) {
  return `chip-${guestCheckId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function addBuildChip(guestCheckId) {
  const track = $("buildTrack");
  const chip = document.createElement("div");
  chip.className = "build-chip";
  chip.id = buildChipId(guestCheckId);
  chip.textContent = guestCheckId;
  track.appendChild(chip);
  while (track.children.length > 6) track.removeChild(track.firstChild);
  datedState.inFlight[guestCheckId] = true;
  $("buildCount").textContent = `${Object.keys(datedState.inFlight).length} in flight`;
}

function bumpProgress() {
  if (datedState.total <= 0) return;
  datedState.processed++;
  const pct = Math.round((datedState.processed / datedState.total) * 100);
  setProgress(pct, `${datedState.processed} / ${datedState.total} (${pct}%)`);
}

function pulseOutcome(lane) {
  const conn = $(`conn${lane}`);
  conn.classList.remove("pulse");
  void conn.offsetWidth; // restart animation even if it fires again quickly
  conn.classList.add("pulse");

  const countEl = $(`count${lane}`);
  countEl.textContent = String(Number(countEl.textContent || "0") + 1);

  const circle = $(`circle${lane}`);
  circle.classList.remove("bump");
  void circle.offsetWidth;
  circle.classList.add("bump");
}

function resolveBuildChip(guestCheckId, lane) {
  const chip = document.getElementById(buildChipId(guestCheckId));
  if (chip) chip.remove();
  delete datedState.inFlight[guestCheckId];
  $("buildCount").textContent = `${Object.keys(datedState.inFlight).length} in flight`;

  pulseOutcome(lane);
}

window.pos.onSubmitEvent((event) => {
  if (!datedState.submitting) return;

  switch (event.type) {
    case "insert_start":
      $("stageFetch").classList.add("active");
      $("flowFetchToBuild").classList.add("active");
      setDatedStatus(event.message);
      setProgressIndeterminate("Fetching transactions...");
      datedLog("phase", event.message);
      break;
    case "insert_done":
      $("stageFetch").classList.remove("active");
      $("fetchCount").textContent = `${event.inserted} inserted`;
      setDatedStatus(event.message);
      setProgressIndeterminate("Preparing submission...");
      datedLog("success", event.message);
      break;
    case "insert_failed":
      $("stageFetch").classList.remove("active");
      $("flowFetchToBuild").classList.remove("active");
      setDatedStatus(event.message);
      setProgress(100, event.message, "error");
      datedLog("error", event.message);
      break;
    case "submit_start":
      $("stageBuild").classList.add("active");
      datedState.total = event.total || 0;
      datedState.processed = 0;
      if (datedState.total === 0) {
        setProgress(100, "No pending records for this date", "done");
      } else {
        setProgress(0, `0 / ${datedState.total} (0%)`);
      }
      datedLog("phase", event.message);
      break;
    case "sending":
      $("flowFetchToBuild").classList.remove("active");
      addBuildChip(event.guest_check_id);
      setDatedStatus(`Building payload for ${event.guest_check_id} (${event.index}/${event.total})`);
      break;
    case "success":
      resolveBuildChip(event.guest_check_id, event.void ? "Voided" : "Submitted");
      datedLog(event.void ? "warning" : "success", event.message);
      bumpProgress();
      break;
    case "rate_limited":
    case "failed_retry":
    case "failed_terminal":
      resolveBuildChip(event.guest_check_id, "Failed");
      datedLog(event.type, event.message);
      bumpProgress();
      break;
    case "submit_done":
      $("stageBuild").classList.remove("active");
      if (datedState.total > 0) {
        setProgress(100, `${datedState.total} / ${datedState.total} (100%)`, "done");
      }
      datedLog("phase", event.message);
      break;
    case "batch_done":
      datedLog("phase", event.message);
      break;
    case "phase":
      datedLog("phase", event.message);
      break;
  }
});

let datedPaused = false;
$("btnDatedPause").addEventListener("click", async () => {
  datedPaused = !datedPaused;
  await window.pos.submitControl(datedPaused ? "pause" : "resume");
  $("btnDatedPause").innerHTML = datedPaused ? resumeIcon : pauseIcon;
  $("btnDatedPause").title = datedPaused ? "Resume" : "Pause";
});
$("btnDatedAbort").addEventListener("click", async () => {
  await window.pos.submitControl("abort");
  setDatedStatus("Aborting...");
});

function openDatedConfirmModal() {
  const date = $("datedDate").value || new Date().toISOString().slice(0, 10);
  $("datedConfirmDate").textContent = date;
  $("datedConfirmModal").classList.remove("hidden");
}
function closeDatedConfirmModal() {
  $("datedConfirmModal").classList.add("hidden");
}

$("btnDatedSubmit").addEventListener("click", () => {
  if (datedState.submitting) {
    setDatedStatus("A submission is already in progress");
    return;
  }
  if (!$("datedDate").value) {
    setDatedStatus("Pick a date first");
    return;
  }
  openDatedConfirmModal();
});

$("datedConfirmModal").addEventListener("click", (e) => {
  if (e.target === $("datedConfirmModal")) closeDatedConfirmModal();
});
$("btnCloseDatedConfirmModal").addEventListener("click", closeDatedConfirmModal);
$("btnDatedConfirmCancel").addEventListener("click", closeDatedConfirmModal);

$("btnDatedConfirmSubmit").addEventListener("click", async () => {
  const date = $("datedDate").value;
  closeDatedConfirmModal();
  resetPipeline();
  toggleDatedSubmittingUi(true);
  setDatedStatus(`Submitting for ${date}...`);
  datedLog("phase", `Dated Submission started for ${date}`);
  try {
    const result = await window.pos.submitDated(date);
    const summary = `${result.inserted} inserted, ${result.successCount} submitted, ${result.failCount} failed`;
    setDatedStatus(`Done: ${summary}` + (result.aborted ? " (aborted)" : ""));
    datedLog("success", `Dated Submission complete — ${summary}`);

    if (result.aborted) {
      showDatedCompletion("attention", `Submission aborted — ${summary}`);
    } else if (result.failCount > 0) {
      $("circleFailed").classList.add("attention");
      showDatedCompletion("attention", `${result.failCount} transaction(s) failed and need attention — ${summary}`);
    } else {
      showDatedCompletion("success", `All transactions submitted successfully — ${summary}`);
    }
  } catch (e) {
    datedLog("error", `Dated Submission failed: ${e.message}`);
    setDatedStatus("Dated Submission failed");
    showDatedCompletion("error", `Dated Submission failed: ${e.message}`);
  } finally {
    toggleDatedSubmittingUi(false);
    $("stageFetch").classList.remove("active");
    $("stageBuild").classList.remove("active");
    $("flowFetchToBuild").classList.remove("active");
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

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy-col-btn");
  if (!btn) return;
  const text = copyCache.get(btn.dataset.id);
  if (text === undefined || text === null) return;
  navigator.clipboard.writeText(text).then(
    () => {
      animateCopyCheck(btn);
      setStatus("Copied to clipboard");
    },
    (err) => setStatus("Copy failed: " + err.message)
  );
});

function animateCopyCheck(btn) {
  const original = btn.innerHTML;
  btn.innerHTML = checkIconSvg;
  btn.classList.add("copied");
  btn.title = "Copied!";
  setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove("copied");
    btn.title = "Copy sent payload";
  }, 1500);
}

// ---------- Context menu ----------
let contextMenuGuestCheckId = null;

function showContextMenu(x, y, row) {
  const menu = $("contextMenu");
  if (!menu) return;
  contextMenuGuestCheckId = state.selectedGuestCheckId;
  if (!contextMenuGuestCheckId) return;
  const voidEl = $("ctxVoid");
  if (voidEl) {
    const txId = row ? row.dataset.txId || "" : "";
    voidEl.style.display = txId ? "" : "none";
  }
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.remove("hidden");
}

function hideContextMenu() {
  const menu = $("contextMenu");
  if (menu) menu.classList.add("hidden");
  contextMenuGuestCheckId = null;
}

async function ctxView() {
  const id = contextMenuGuestCheckId;
  hideContextMenu();
  if (!id) return;
  setStatus("Loading details...");
  try {
    const rec = await window.pos.getRecord(id);
    if (!rec) {
      setStatus("Record not found");
      return;
    }
    const lines = Object.entries(rec)
      .map(([k, v]) => `${k}: ${v ?? ""}`)
      .join("\n");
    $("viewModalBody").textContent = lines;
    $("viewModal").classList.remove("hidden");
  } catch (err) {
    setStatus("Failed: " + err.message);
  }
}

async function ctxSubmit() {
  const id = contextMenuGuestCheckId;
  hideContextMenu();
  if (!id) return;
  setStatus("Submitting...");
  try {
    const res = await window.pos.submitSingle(id);
    setStatus(res.ok ? "Submitted" : "Submit failed: " + res.message);
    refreshAll();
  } catch (err) {
    setStatus("Submit failed: " + err.message);
  }
}

async function ctxVoid() {
  const id = contextMenuGuestCheckId;
  hideContextMenu();
  if (!id) return;
  setStatus("Voiding...");
  try {
    const res = await window.pos.voidRecord(id);
    setStatus(res.ok ? "Void submitted" : "Void failed: " + res.message);
    refreshAll();
  } catch (err) {
    setStatus("Void failed: " + err.message);
  }
}

async function ctxBuildPayload() {
  const id = contextMenuGuestCheckId;
  hideContextMenu();
  if (!id) return;
  setStatus("Building payload...");
  try {
    const res = await window.pos.previewPayload(id);
    if (res.ok) {
      openPayloadModal(JSON.stringify(res.payload, null, 2));
      setStatus("Payload preview ready");
    } else {
      setStatus("Failed: " + res.message);
    }
  } catch (err) {
    setStatus("Failed: " + err.message);
  }
}

$("btnCloseViewModal").addEventListener("click", () => $("viewModal").classList.add("hidden"));
$("btnCloseViewModal2").addEventListener("click", () => $("viewModal").classList.add("hidden"));
$("viewModal").addEventListener("click", (e) => {
  if (e.target === $("viewModal")) $("viewModal").classList.add("hidden");
});

document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  e.preventDefault();
  state.selectedGuestCheckId = row.dataset.id;
  showContextMenu(e.clientX, e.clientY, row);
});

document.addEventListener("click", (e) => {
  const menu = $("contextMenu");
  if (menu && !menu.classList.contains("hidden")) {
    if (!menu.contains(e.target)) hideContextMenu();
  }
});

$("ctxView").addEventListener("click", ctxView);
$("ctxSubmit").addEventListener("click", ctxSubmit);
$("ctxVoid").addEventListener("click", ctxVoid);
$("ctxBuildPayload").addEventListener("click", ctxBuildPayload);

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
  const autoReceiptEl = $("s_tsms_auto_receipt_no");
  if (autoReceiptEl) autoReceiptEl.checked = cfg.tsms?.auto_receipt_no ?? false;
}

function collectSettingsForm() {
  const cfg = JSON.parse(JSON.stringify(state.config));
  for (const [section, key] of SETTINGS_FIELDS) {
    const el = $(`s_${section}_${key}`);
    if (!el) continue;
    const raw = el.value;
    cfg[section][key] = el.type === "number" ? Number(raw) : raw;
  }
  const autoReceiptEl = $("s_tsms_auto_receipt_no");
  if (autoReceiptEl) cfg.tsms.auto_receipt_no = autoReceiptEl.checked;
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
  initTheme();
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