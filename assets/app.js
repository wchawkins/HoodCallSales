const DATA_URL = "data/latest.json";
const POSITION_KEY = "hoodPositionOverride";

let allCandidates = [];
let defaults = null;
let spotPrice = null;
let latestData = null;
let sortState = { key: "annualizedYieldPct", dir: "desc" };

const $ = (id) => document.getElementById(id);

function fmtMoney(v) {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}
function fmtPct(v, digits = 1) {
  return v == null ? "—" : `${v.toFixed(digits)}%`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadData() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${DATA_URL}: ${res.status}`);
  return res.json();
}

function loadOverride() {
  try {
    return JSON.parse(localStorage.getItem(POSITION_KEY));
  } catch {
    return null;
  }
}
function saveOverride(pos) {
  localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
}
function clearOverride() {
  localStorage.removeItem(POSITION_KEY);
}

// Merges any locally-saved position (from the "Edit" panel) over the repo
// default from config.json/data.json, since the user may have rolled to a
// new strike/expiration that hasn't been committed to the repo yet.
function getEffectivePosition(data) {
  const override = loadOverride();
  const base = data.existingPosition;
  if (!override) return { ...base, isOverride: false };
  return {
    strike: override.strike,
    expiration: override.expiration,
    sharesOwned: override.sharesOwned,
    isOverride: true,
  };
}

function renderStats(data) {
  const updated = new Date(data.generatedAtUtc);
  $("updated-label").textContent =
    `Data as of ${updated.toLocaleString()} · ${data.ticker}`;

  $("stat-spot").textContent = fmtMoney(data.spotPrice);

  const pos = getEffectivePosition(data);
  $("stat-position").textContent = `${fmtMoney(pos.strike)} strike`;
  const dte = Math.max(
    0,
    Math.round((new Date(pos.expiration) - new Date(data.generatedAtUtc)) / 86400000)
  );
  const isInTheMoney = data.spotPrice > pos.strike;
  const badgeClass = isInTheMoney ? "critical" : "good";
  const badgeText = isInTheMoney ? "ITM" : "OTM";

  // The live mid-premium for this exact contract only exists if it's still
  // sitting in the fetched OTM candidate universe (or it's the repo default,
  // which the data script snapshots directly regardless of moneyness).
  let currentPremium = null;
  if (!pos.isOverride) {
    currentPremium = data.existingPosition.currentPremium;
  } else {
    const match = allCandidates.find(
      (c) => c.strike === Number(pos.strike) && c.expiration === pos.expiration
    );
    currentPremium = match ? match.premium : null;
  }

  $("stat-position-sub").innerHTML =
    `Exp ${escapeHtml(pos.expiration)} (${dte}d) · ${pos.sharesOwned} sh · ` +
    `<span class="badge ${badgeClass}">${badgeText}</span>` +
    (currentPremium != null ? ` · mid ${fmtMoney(currentPremium)}` : "");

  const hint = $("editor-hint");
  if (pos.isOverride) {
    hint.innerHTML =
      "Showing a position saved locally in this browser only. " +
      (currentPremium == null
        ? "Live mid-premium isn't available for this contract (not in the fetched OTM range). "
        : "") +
      `<a href="https://github.com/wchawkins/HoodCallSales/edit/main/config.json" target="_blank" rel="noopener">` +
      `Update config.json</a> to make this the shared default.`;
  } else {
    hint.textContent = "Showing the repo default from config.json.";
  }
}

function renderBestCandidate(filtered) {
  if (!filtered.length) {
    $("stat-best").textContent = "—";
    $("stat-best-sub").textContent = "No contracts match the current filters";
    return;
  }
  const best = [...filtered].sort((a, b) => b.annualizedYieldPct - a.annualizedYieldPct)[0];
  $("stat-best").textContent = `${fmtMoney(best.strike)} strike, ${best.expiration}`;
  $("stat-best-sub").textContent =
    `${fmtPct(best.annualizedYieldPct)} annualized · delta ${best.delta.toFixed(2)} · ${best.dte}d`;
}

function setupPositionEditor(data) {
  const panel = $("position-editor");
  const toggle = $("editor-toggle");
  const strikeInput = $("p-strike");
  const expInput = $("p-expiration");
  const sharesInput = $("p-shares");

  function prefill() {
    const pos = getEffectivePosition(data);
    strikeInput.value = pos.strike;
    expInput.value = pos.expiration;
    sharesInput.value = pos.sharesOwned;
  }
  prefill();

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });

  $("p-save").addEventListener("click", () => {
    const strike = parseFloat(strikeInput.value);
    const expiration = expInput.value;
    const sharesOwned = parseInt(sharesInput.value, 10);
    if (!strike || !expiration || !sharesOwned) {
      $("editor-hint").textContent = "Fill in strike, expiration, and shares owned before saving.";
      return;
    }
    saveOverride({ strike, expiration, sharesOwned });
    renderStats(data);
    applyFilters();
  });

  $("p-clear").addEventListener("click", () => {
    clearOverride();
    prefill();
    renderStats(data);
    applyFilters();
  });
}

function yieldTooltip(c, spot) {
  return (
    `Annualized yield = (premium ÷ spot price) × (365 ÷ days to expiration)\n` +
    `= ($${c.premium.toFixed(2)} ÷ $${spot.toFixed(2)}) × (365 ÷ ${c.dte})\n` +
    `= ${c.annualizedYieldPct.toFixed(2)}%\n\n` +
    `Premium is the bid/ask midpoint; this assumes the same premium repeats every period, which real options don't do.`
  );
}

function yieldTint(value, min, max) {
  if (max <= min) return "transparent";
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const alpha = 0.06 + t * 0.30;
  return `color-mix(in srgb, var(--series-blue) ${(alpha * 100).toFixed(1)}%, transparent)`;
}

function getFilters() {
  return {
    deltaMin: parseFloat($("f-delta-min").value),
    deltaMax: parseFloat($("f-delta-max").value),
    dteMin: parseFloat($("f-dte-min").value),
    dteMax: parseFloat($("f-dte-max").value),
    minOi: parseFloat($("f-min-oi").value) || 0,
  };
}

function applyFilters() {
  const f = getFilters();
  const filtered = allCandidates.filter((c) =>
    c.delta >= f.deltaMin &&
    c.delta <= f.deltaMax &&
    c.dte >= f.dteMin &&
    c.dte <= f.dteMax &&
    c.openInterest >= f.minOi
  );

  filtered.sort((a, b) => {
    const { key, dir } = sortState;
    const mult = dir === "asc" ? 1 : -1;
    if (a[key] < b[key]) return -1 * mult;
    if (a[key] > b[key]) return 1 * mult;
    return 0;
  });

  renderTable(filtered);
  renderBestCandidate(filtered);
}

function renderTable(rows) {
  const body = $("candidates-body");
  $("row-count").textContent = `${rows.length} contract${rows.length === 1 ? "" : "s"} matching filters`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="empty-state">No contracts match the current filters.</td></tr>`;
    return;
  }

  const yields = rows.map((r) => r.annualizedYieldPct);
  const yMin = Math.min(...yields);
  const yMax = Math.max(...yields);

  body.innerHTML = rows
    .map((c) => {
      const tint = yieldTint(c.annualizedYieldPct, yMin, yMax);
      const tooltip = escapeHtml(yieldTooltip(c, spotPrice));
      return `<tr>
        <td>${escapeHtml(c.expiration)}</td>
        <td>${c.dte}</td>
        <td>${fmtMoney(c.strike)}</td>
        <td>${fmtPct(c.pctOtm)}</td>
        <td>${fmtMoney(c.premium)}</td>
        <td>${c.impliedVolatility != null ? fmtPct(c.impliedVolatility * 100) : "—"}</td>
        <td>${c.delta.toFixed(3)}</td>
        <td class="yield-cell" style="background:${tint}" title="${tooltip}">${fmtPct(c.annualizedYieldPct)}</td>
        <td>${c.openInterest.toLocaleString()}</td>
        <td>${c.volume.toLocaleString()}</td>
      </tr>`;
    })
    .join("");
}

function setupSorting() {
  document.querySelectorAll("#candidates-table thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState = { key, dir: "desc" };
      }
      document
        .querySelectorAll("#candidates-table thead th")
        .forEach((h) => h.classList.toggle("sorted", h === th));
      applyFilters();
    });
  });
}

function setupFilters(data) {
  defaults = data.screenDefaults;
  $("f-delta-min").value = defaults.minDelta;
  $("f-delta-max").value = defaults.maxDelta;
  $("f-dte-min").value = defaults.minDte;
  $("f-dte-max").value = defaults.maxDte;
  $("f-min-oi").value = 0;

  ["f-delta-min", "f-delta-max", "f-dte-min", "f-dte-max", "f-min-oi"].forEach((id) =>
    $(id).addEventListener("input", applyFilters)
  );

  $("f-reset").addEventListener("click", () => {
    $("f-delta-min").value = defaults.minDelta;
    $("f-delta-max").value = defaults.maxDelta;
    $("f-dte-min").value = defaults.minDte;
    $("f-dte-max").value = defaults.maxDte;
    $("f-min-oi").value = 0;
    applyFilters();
  });
}

async function init() {
  try {
    const data = await loadData();
    latestData = data;
    allCandidates = data.candidates;
    spotPrice = data.spotPrice;
    renderStats(data);
    setupPositionEditor(data);
    setupFilters(data);
    setupSorting();
    document
      .querySelector('#candidates-table thead th[data-key="annualizedYieldPct"]')
      .classList.add("sorted");
    applyFilters();
  } catch (err) {
    $("updated-label").textContent = "Couldn't load data.";
    $("candidates-body").innerHTML =
      `<tr><td colspan="10" class="empty-state">Failed to load data/latest.json: ${err.message}</td></tr>`;
    console.error(err);
  }
}

init();
