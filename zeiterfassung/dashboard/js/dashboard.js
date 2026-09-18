/* ============================================================
   Zeiterfassung — Auswertungs-Dashboard
   Liest die Zeiterfassungs-CSVs beider Personen über öffentliche
   Nextcloud-Freigabelinks (read-only) und stellt sie filterbar dar.
   Kein Login nötig -- nur Lese-Freigaben.
   ============================================================ */

// Gleicher Cloudflare-Worker-Proxy wie die Haupt-App (CORS-Umweg).
const PROXY_URL = "https://zeit-proxy.haldejonas.workers.dev";

// Für jede Person: Token aus dem öffentlichen Freigabelink des GANZEN
// "Zeiterfassung"-Ordners (nicht nur einer einzelnen Datei) -- damit können auch
// künftige Jahres-CSVs ohne neuen Link gelesen werden.
// Bei https://.../s/AbCdEfGh123 ist der Token "AbCdEfGh123".
// Eintrag mit leerem Token wird übersprungen.
const PERSON_SOURCES = [
  { label: "Jonas", token: "276ipidyqirC7KP" },
  { label: "Partner", token: "" }
];

// Gleiche Palette wie die Haupt-App, für konsistente Farben pro Projekt.
const PROJECT_COLOR_PALETTE = ["#4F7089", "#8F9A85", "#C97960", "#626F68", "#8C8171", "#7A95A6"];

let allRows = []; // alle geladenen Zeilen (über alle Personen), ungefiltert

// ---------- CSV-Parsing (gleiche Logik wie Haupt-App) ----------

function parseCsvLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      result.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(1).map((line) => {
    const [date, project, durationMin, comment, person, projectId] = parseCsvLine(line);
    return {
      date,
      project,
      durationMin: parseFloat(durationMin) || 0,
      comment: comment || "",
      person: person || "",
      projectId: projectId || ""
    };
  });
}

// ---------- Proxy / Datenladen ----------

function proxyFetch(relativePath, options = {}) {
  const url = `${PROXY_URL}?path=${encodeURIComponent(relativePath)}`;
  return fetch(url, options);
}

function publicShareAuthHeader(token) {
  return { Authorization: `Basic ${btoa(`${token}:`)}` };
}

async function fetchPersonYearCsv(token, year) {
  const path = `public.php/webdav/zeiterfassung_${year}.csv`;
  const res = await proxyFetch(path, { method: "GET", headers: publicShareAuthHeader(token) });
  if (res.status === 404) return ""; // dieses Jahr hat für diese Person keine Datei
  if (!res.ok) throw new Error(`Status ${res.status}`);
  return await res.text();
}

async function loadAllData(year) {
  const statusLine = document.getElementById("statusLine");
  statusLine.textContent = "Lädt…";
  const activeSources = PERSON_SOURCES.filter((s) => s.token);

  if (activeSources.length === 0) {
    statusLine.textContent = "Keine Datenquelle konfiguriert (PERSON_SOURCES in dashboard.js leer).";
    allRows = [];
    return;
  }

  const results = await Promise.allSettled(
    activeSources.map((s) => fetchPersonYearCsv(s.token, year))
  );

  const rows = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value) rows.push(...parseCsvRows(r.value));
    } else {
      errors.push(activeSources[i].label);
    }
  });

  allRows = rows;

  if (errors.length > 0) {
    statusLine.textContent = `Achtung: Daten von ${errors.join(", ")} konnten nicht geladen werden.`;
  } else {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    statusLine.textContent = `Stand: ${hh}:${mm} · ${rows.length} Einträge geladen`;
  }
}

// ---------- Filter-UI ----------

function populateFilters() {
  const projectSelect = document.getElementById("filterProject");
  const personSelect = document.getElementById("filterPerson");

  const projects = [...new Set(allRows.map((r) => r.project))].sort();
  const persons = [...new Set(allRows.map((r) => r.person))].sort();

  projectSelect.innerHTML =
    '<option value="">Alle Projekte</option>' +
    projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  personSelect.innerHTML =
    '<option value="">Alle Personen</option>' +
    persons.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
}

function populateYearFilter() {
  const yearSelect = document.getElementById("filterYear");
  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear - 1, currentYear - 2];
  yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
  yearSelect.value = String(currentYear);
}

// ---------- Zeitraum-Filter (Tag/Woche/Monat/frei, zusätzlich zum Jahr) ----------
//
// Die Jahres-CSV wird weiterhin komplett geladen (siehe loadAllData()); der
// Zeitraum-Filter schränkt die schon geladenen Zeilen zusätzlich per
// Datumsvergleich ein (r.date ist "YYYY-MM-DD", funktioniert darum auch als
// simpler String-Vergleich). "Heute"/"Diese Woche"/"Dieser Monat" beziehen
// sich immer auf das echte heutige Datum -- weicht das vom gerade gewählten
// Jahr ab, wird das Jahr automatisch mitgewechselt (siehe onZeitraumChange()/
// onFreiRangeChange()), sonst gäbe es scheinbar keine Treffer. Ein
// "frei wählbar"-Zeitraum, der über einen Jahreswechsel hinausgeht, ist NICHT
// unterstützt -- gezeigt wird dann nur der Teil im gerade geladenen Jahr.
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfWeek(d) {
  // Montag als Wochenbeginn.
  const diff = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
  return monday;
}
function computeZeitraumRange(zeitraum) {
  const now = new Date();
  if (zeitraum === "heute") {
    const iso = toISODate(now);
    return { von: iso, bis: iso };
  }
  if (zeitraum === "woche") {
    const monday = startOfWeek(now);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return { von: toISODate(monday), bis: toISODate(sunday) };
  }
  if (zeitraum === "monat") {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { von: toISODate(first), bis: toISODate(last) };
  }
  return null;
}

function getFilteredRows() {
  const project = document.getElementById("filterProject").value;
  const person = document.getElementById("filterPerson").value;
  const zeitraum = document.getElementById("filterZeitraum").value;

  let von = null;
  let bis = null;
  if (zeitraum === "frei") {
    von = document.getElementById("filterVon").value || null;
    bis = document.getElementById("filterBis").value || null;
  } else if (zeitraum) {
    const range = computeZeitraumRange(zeitraum);
    von = range.von;
    bis = range.bis;
  }

  return allRows.filter((r) => {
    if (project && r.project !== project) return false;
    if (person && r.person !== person) return false;
    if (von && r.date < von) return false;
    if (bis && r.date > bis) return false;
    return true;
  });
}

// Bei "Heute"/"Diese Woche"/"Dieser Monat" (immer bezogen aufs echte
// heutige Datum) bzw. beim "von"-Datum des freien Zeitraums: falls das
// implizierte Jahr nicht dem gerade geladenen entspricht, das Jahr
// mitwechseln und neu laden -- sonst zeigt der Filter scheinbar nichts an.
function syncYearToImpliedDate(isoDate) {
  if (!isoDate) return false;
  const impliedYear = isoDate.slice(0, 4);
  const yearSelect = document.getElementById("filterYear");
  const hasOption = Array.from(yearSelect.options).some((o) => o.value === impliedYear);
  if (hasOption && yearSelect.value !== impliedYear) {
    yearSelect.value = impliedYear;
    return true;
  }
  return false;
}

function onZeitraumChange() {
  const zeitraum = document.getElementById("filterZeitraum").value;
  document.getElementById("freiRangeRow").style.display = zeitraum === "frei" ? "" : "none";

  const range = zeitraum && zeitraum !== "frei" ? computeZeitraumRange(zeitraum) : null;
  if (range && syncYearToImpliedDate(range.von)) {
    refresh();
    return;
  }
  renderAll();
}

function onFreiRangeChange() {
  const von = document.getElementById("filterVon").value;
  if (syncYearToImpliedDate(von)) {
    refresh();
    return;
  }
  renderAll();
}

// ---------- Rendering ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatHM(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

function projectColorFor(projectId) {
  const m = /^P(\d+)$/.exec(projectId || "");
  if (!m) return "#8C8171";
  const idx = parseInt(m[1], 10) - 1;
  return PROJECT_COLOR_PALETTE[idx % PROJECT_COLOR_PALETTE.length];
}

function renderAll() {
  const rows = getFilteredRows();
  renderSummary(rows);
  renderBarChart("chartByProject", groupSum(rows, "project"), true);
  renderDayBarChart("chartByDay", groupByDay(rows));
  renderTable(rows);
}

function groupSum(rows, field) {
  const map = {};
  rows.forEach((r) => {
    const key = r[field] || "–";
    if (!map[key]) map[key] = { minutes: 0, projectId: r.projectId };
    map[key].minutes += r.durationMin;
  });
  return Object.entries(map)
    .map(([name, v]) => ({ name, minutes: v.minutes, projectId: v.projectId }))
    .sort((a, b) => b.minutes - a.minutes);
}

// Für "Nach Tag": Summe pro Kalendertag, chronologisch sortiert -- egal wie
// lang der gefilterte Zeitraum ist, ergibt das eine (ggf. sehr lange) Reihe
// schmaler Balken statt einzeln beschrifteter Zeilen wie bei groupSum().
function groupByDay(rows) {
  const map = {};
  rows.forEach((r) => {
    map[r.date] = (map[r.date] || 0) + r.durationMin;
  });
  return Object.entries(map)
    .map(([date, minutes]) => ({ date, minutes }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function renderSummary(rows) {
  const totalMin = rows.reduce((sum, r) => sum + r.durationMin, 0);
  document.getElementById("summaryTotal").textContent = formatHM(totalMin);
  document.getElementById("summarySub").textContent = `${rows.length} Eintrag/Einträge im aktuellen Filter`;
}

function renderBarChart(containerId, grouped, colorByProject) {
  const container = document.getElementById(containerId);
  if (grouped.length === 0) {
    container.innerHTML = '<div class="bar-empty">Keine Daten für diesen Filter</div>';
    return;
  }
  const max = Math.max(...grouped.map((g) => g.minutes), 1);
  container.innerHTML = grouped
    .map((g) => {
      const pct = Math.max(4, Math.round((g.minutes / max) * 100));
      const color = colorByProject ? projectColorFor(g.projectId) : "#4F7089";
      return `<div class="bar-row">
        <div class="bar-row-label">
          <span class="bar-row-name">${escapeHtml(g.name)}</span>
          <span class="bar-row-value">${formatHM(g.minutes)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      </div>`;
    })
    .join("");
}

// Vertikale Balken nebeneinander, ein Balken pro Tag -- bewusst ohne
// Einzelbeschriftung (bei langen Zeiträumen wären das zu viele Labels);
// stattdessen Datum+Dauer als title-Tooltip beim Hovern/Antippen.
function renderDayBarChart(containerId, grouped) {
  const container = document.getElementById(containerId);
  if (grouped.length === 0) {
    container.innerHTML = '<div class="bar-empty">Keine Daten für diesen Filter</div>';
    return;
  }
  const max = Math.max(...grouped.map((g) => g.minutes), 1);
  container.innerHTML = grouped
    .map((g) => {
      const pct = Math.max(4, Math.round((g.minutes / max) * 100));
      const title = `${g.date}: ${formatHM(g.minutes)}`;
      return `<div class="vbar" style="height:${pct}%" title="${escapeHtml(title)}"></div>`;
    })
    .join("");
}

function renderTable(rows) {
  const body = document.getElementById("entriesBody");
  if (rows.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">Keine Einträge für diesen Filter</td></tr>';
    return;
  }
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  body.innerHTML = sorted
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.date)}</td>
        <td>${escapeHtml(r.project)}</td>
        <td>${escapeHtml(r.person)}</td>
        <td>${formatHM(r.durationMin)}</td>
        <td class="comment-cell">${escapeHtml(r.comment)}</td>
      </tr>`
    )
    .join("");
}

// ---------- Init ----------

async function refresh() {
  const year = document.getElementById("filterYear").value;
  await loadAllData(year);
  populateFilters();
  renderAll();
}

function init() {
  populateYearFilter();

  document.getElementById("filterYear").addEventListener("change", refresh);
  document.getElementById("filterProject").addEventListener("change", renderAll);
  document.getElementById("filterPerson").addEventListener("change", renderAll);
  document.getElementById("filterZeitraum").addEventListener("change", onZeitraumChange);
  document.getElementById("filterVon").addEventListener("change", onFreiRangeChange);
  document.getElementById("filterBis").addEventListener("change", renderAll);
  document.getElementById("refreshBtn").addEventListener("click", refresh);

  refresh();
}

document.addEventListener("DOMContentLoaded", init);
