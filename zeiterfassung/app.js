/* ============================================================
   Zeiterfassung — App-Logik
   Zustand: aktueller Zähler + lokale Warteschlange, die per
   WebDAV auf eine Nextcloud-CSV-Datei synchronisiert wird.

   Nextcloud-Login, proxyFetch/authHeader/davPath, Einstellungen-UI
   usw. kommen aus ../shared/common.js (gemeinsam mit Quittung und
   Wettbewerbsprogramme).
   ============================================================ */

const LS_KEYS = {
  current: "zeit_current",
  entries: "zeit_entries",              // alle lokal bekannten Einträge (für "Heute")
  dirtyBuckets: "zeit_dirty_buckets",   // "Datum|Projekt"-Kombis, die noch synchronisiert werden müssen
  comments: "zeit_comments",            // Kommentare pro "Datum|Projekt"
  projectsCache: "zeit_projects_cache"  // letzte erfolgreich geladene Projektnamen (Offline-Fallback)
};

// Öffentlicher Nextcloud-Freigabelink für die zentral verwaltete
// Projektnamen-Datei (3 Zeilen Text: Name P1, Name P2, Name P3).
// Token aus dem Freigabelink eintragen, z.B. bei
// https://.../s/AbCdEfGh123 wäre der Token "AbCdEfGh123".
// Leer lassen ("") um die zentrale Verwaltung zu deaktivieren.
const PROJECTS_SHARE_TOKEN = "cRyoZG6fzBQYDeH";

// Zielordner innerhalb der persönlichen Nextcloud-Dateien, mit "/" getrennt.
// Wird bei Bedarf komplett angelegt (Ebene für Ebene).
const TARGET_FOLDER_PATH = "Buero/Admin/test_zeit";

// Farbpalette für dynamisch erzeugte Projekt-Buttons (zyklisch, falls mehr
// Projekte als Farben vorhanden sind) -- abgeleitet vom Referenzbild
// (gedeckte Erdtöne: Taubenblau, Salbeigrün, Terrakotta, Schiefergrün, Greige).
const PROJECT_COLOR_PALETTE = ["#4F7089", "#8F9A85", "#C97960", "#626F68", "#8C8171", "#7A95A6"];

// Zentral verwaltete Projektliste (Array beliebiger Länge). Fallback P1/P2/P3,
// falls noch nie erfolgreich geladen und keine zentrale Verwaltung aktiv ist.
let projectList = loadJSON(LS_KEYS.projectsCache, ["P1", "P2", "P3"]);

let current = loadJSON(LS_KEYS.current, null);       // { action: 'P1'|'P2'|..., start: ISOString }
let entries = loadJSON(LS_KEYS.entries, []);          // { id, date, start, end, durationSec, projectId }
let dirtyBuckets = loadJSON(LS_KEYS.dirtyBuckets, []); // ["2026-08-13|P1", ...] -- projectId, nicht Name!
let comments = loadJSON(LS_KEYS.comments, {});         // { "2026-08-13|P1": "Kommentartext" }

let timerHandle = null;

// ---------- Utilities ----------

function saveState() {
  saveJSON(LS_KEYS.current, current);
  saveJSON(LS_KEYS.entries, entries);
  saveJSON(LS_KEYS.dirtyBuckets, dirtyBuckets);
  saveJSON(LS_KEYS.comments, comments);
}
function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatHMS(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function formatHM(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  return h > 0 ? `${h} h ${pad(m)} min` : `${m} min`;
}
function projectIndexFromAction(action) {
  const m = /^P(\d+)$/.exec(action);
  return m ? parseInt(m[1], 10) - 1 : -1;
}
function projectLabel(action) {
  const idx = projectIndexFromAction(action);
  if (idx >= 0 && projectList[idx]) return projectList[idx];
  return action;
}
function projectColor(action) {
  const idx = projectIndexFromAction(action);
  if (idx < 0) return null;
  return PROJECT_COLOR_PALETTE[idx % PROJECT_COLOR_PALETTE.length];
}

// ---------- Zustandsautomat ----------

function handleButton(action) {
  const now = new Date();
  closeCurrentSession(now);

  if (action === "PAUSE" || action === "STOP") {
    current = null;
  } else {
    current = { action, start: now.toISOString() };
  }
  saveState();
  render();
  trySync();
}

function bucketKey(date, project) {
  return `${date}|${project}`;
}

function markDirty(key) {
  if (!dirtyBuckets.includes(key)) dirtyBuckets.push(key);
}

function closeCurrentSession(now) {
  if (!current) return;
  const start = new Date(current.start);
  const durationSec = Math.round((now - start) / 1000);
  if (durationSec < 5) return; // Miniklicks (Versehen) nicht loggen

  const date = formatDate(start);
  const projectId = current.action; // stabile ID, z.B. "P1" -- nicht der (änderbare) Anzeigename
  const entry = { id: uid(), date, start: formatTime(start), end: formatTime(now), durationSec, projectId };
  entries.push(entry);
  markDirty(bucketKey(date, projectId));
}

// ---------- Rendering ----------

function renderProjectButtons() {
  const container = document.getElementById("projectButtons");
  container.innerHTML = projectList
    .map((name, i) => {
      const color = PROJECT_COLOR_PALETTE[i % PROJECT_COLOR_PALETTE.length];
      return `<button class="proj-btn" data-action="P${i + 1}" style="--accent:${color}">${escapeHtml(name)}</button>`;
    })
    .join("");
  container.querySelectorAll(".proj-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleButton(btn.dataset.action));
  });
  // Aktiven Zustand nach Neuaufbau sofort wieder anwenden
  container.querySelectorAll(".proj-btn").forEach((btn) => {
    btn.classList.toggle("active", current && current.action === btn.dataset.action);
  });
}

function render() {
  const statusLabel = document.getElementById("statusLabel");

  document.querySelectorAll(".proj-btn").forEach((btn) => {
    btn.classList.toggle("active", current && current.action === btn.dataset.action);
  });

  if (current) {
    statusLabel.textContent = projectLabel(current.action) + " läuft";
  } else {
    statusLabel.textContent = "Pausiert";
  }

  renderToday();
  renderSyncLine();
  tickTimer(); // sofort aktualisieren, nicht erst nach 1s
}

function tickTimer() {
  const statusTimer = document.getElementById("statusTimer");
  if (current) {
    const elapsed = Math.round((Date.now() - new Date(current.start)) / 1000);
    statusTimer.textContent = formatHMS(Math.max(0, elapsed));
  } else {
    statusTimer.textContent = "00:00:00";
  }
}

function computeTodayTotals(today) {
  const totals = {};
  entries
    .filter((e) => e.date === today)
    .forEach((e) => { totals[e.projectId] = (totals[e.projectId] || 0) + e.durationSec; });
  if (current) {
    const liveSec = Math.max(0, Math.round((Date.now() - new Date(current.start)) / 1000));
    totals[current.action] = (totals[current.action] || 0) + liveSec;
  }
  return totals;
}

function renderToday() {
  const list = document.getElementById("todayList");
  const today = formatDate(new Date());
  const totals = computeTodayTotals(today);
  // Nach numerischem Index sortieren (P1, P2, P10, ...) statt alphabetisch nach Name,
  // damit die Reihenfolge stabil bleibt und zur Button-Reihenfolge passt.
  const projectIds = Object.keys(totals).sort(
    (a, b) => projectIndexFromAction(a) - projectIndexFromAction(b)
  );

  if (projectIds.length === 0) {
    list.innerHTML = '<li class="empty">Noch keine Einträge</li>';
    return;
  }

  list.innerHTML = projectIds
    .map((id) => {
      const commentVal = comments[bucketKey(today, id)] || "";
      const name = projectLabel(id);
      const color = projectColor(id) || "inherit";
      return `<li data-project-id="${escapeHtml(id)}">
        <div class="today-row-main">
          <span class="proj-name" style="color:${color}">${escapeHtml(name)}</span>
          <span class="proj-time" data-role="time">${formatHM(totals[id])}</span>
        </div>
        <input type="text" class="comment-input" data-project-id="${escapeHtml(id)}"
               placeholder="Kommentar: was hast du gemacht?" value="${escapeHtml(commentVal)}">
      </li>`;
    })
    .join("");

  list.querySelectorAll(".comment-input").forEach((input) => {
    input.addEventListener("change", onCommentChange);
  });
}

// Wird jede Sekunde aufgerufen -> nur Zeitanzeige aktualisieren, damit
// Kommentarfelder beim Tippen nicht durch renderToday() neu aufgebaut
// (und damit der Fokus verloren) werden.
function updateTodayTimes() {
  const today = formatDate(new Date());
  const totals = computeTodayTotals(today);
  const list = document.getElementById("todayList");
  const rows = list.querySelectorAll("li[data-project-id]");
  const shownIds = new Set(Array.from(rows).map((li) => li.dataset.projectId));
  const currentIds = new Set(Object.keys(totals));

  const sameSet =
    shownIds.size === currentIds.size &&
    [...shownIds].every((id) => currentIds.has(id));

  if (!sameSet) {
    renderToday(); // neues Projekt heute zum ersten Mal -> Liste neu aufbauen
    return;
  }
  rows.forEach((li) => {
    const timeEl = li.querySelector('[data-role="time"]');
    if (timeEl) timeEl.textContent = formatHM(totals[li.dataset.projectId] || 0);
  });
}

function onCommentChange(e) {
  const projectId = e.target.dataset.projectId;
  const today = formatDate(new Date());
  const key = bucketKey(today, projectId);
  comments[key] = e.target.value.replace(/[\r\n]+/g, " ").trim();
  markDirty(key); // auch reine Kommentaränderungen ohne neue Zeit müssen synchronisiert werden
  saveState();
  trySync();
}

function renderSyncLine() {
  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    return;
  }
  if (dirtyBuckets.length === 0) {
    line.textContent = "Synchronisiert";
  } else if (!navigator.onLine) {
    line.textContent = `Offline · ${dirtyBuckets.length} Projekttag(e) werden später synchronisiert`;
  } else {
    line.textContent = `${dirtyBuckets.length} Projekttag(e) werden synchronisiert…`;
  }
}

// ---------- CSV ----------
// Format: eine Zeile pro (Datum, Projekt) statt pro Sitzung -- mehrere Wechsel
// zum selben Projekt am selben Tag werden zu einer Summe zusammengefasst.
// ProjektID ist die stabile interne ID (z.B. "P1") -- damit bleibt die Zeile
// beim Sync auch dann korrekt wiedererkennbar, wenn der Projektname
// zwischenzeitlich umbenannt wurde (die Spalte "Projekt" zeigt immer den
// aktuellen Namen, "ProjektID" ist nur für die interne Zuordnung).
const CSV_HEADER = "Datum,Projekt,Dauer_Min,Kommentar,Person,ProjektID";

function csvField(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

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
    return { date, project, durationMin, comment: comment || "", person: person || "", projectId: projectId || "" };
  });
}

function rowToCsvLine(row) {
  return [row.date, row.project, row.durationMin, row.comment || "", row.person || "", row.projectId || ""]
    .map(csvField)
    .join(",");
}

function sumDurationSec(date, projectId) {
  return entries
    .filter((e) => e.date === date && e.projectId === projectId)
    .reduce((sum, e) => sum + e.durationSec, 0);
}

// ---------- Zentral verwaltete Projektnamen ----------

async function refreshProjectNames() {
  if (!PROJECTS_SHARE_TOKEN) return; // Feature nicht aktiviert
  try {
    const res = await proxyFetch(`s/${PROJECTS_SHARE_TOKEN}/download`, { method: "GET" });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const text = await res.text();
    const names = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (names.length === 0) return; // leere Datei -> alten Stand behalten

    const changed = JSON.stringify(names) !== JSON.stringify(projectList);
    projectList = names;
    saveJSON(LS_KEYS.projectsCache, names);
    if (changed) renderProjectButtons();
    render();
  } catch (err) {
    // Offline oder Datei (noch) nicht erreichbar -> letzten bekannten Stand
    // weiterverwenden, kein harter Fehler für die Zeiterfassung selbst.
    console.warn("Zentrale Projektnamen konnten nicht geladen werden:", err);
  }
}

// ---------- Manuell nachtragen ----------

function openManualEntry() {
  const dateInput = document.getElementById("manualDate");
  const today = formatDate(new Date());
  dateInput.value = today;
  dateInput.max = today; // kein Nachtragen in der Zukunft

  const projectSelect = document.getElementById("manualProject");
  projectSelect.innerHTML = projectList
    .map((name, i) => `<option value="P${i + 1}">${escapeHtml(name)}</option>`)
    .join("");

  document.getElementById("manualHours").value = "";
  document.getElementById("manualMinutes").value = "";
  document.getElementById("manualComment").value = "";
  document.getElementById("manualResult").textContent = "";
  document.getElementById("manualOverlay").classList.remove("hidden");
}

function closeManualEntry() {
  document.getElementById("manualOverlay").classList.add("hidden");
}

function saveManualEntry() {
  const resultEl = document.getElementById("manualResult");
  const date = document.getElementById("manualDate").value;
  const projectId = document.getElementById("manualProject").value;
  const hours = parseInt(document.getElementById("manualHours").value, 10) || 0;
  const minutes = parseInt(document.getElementById("manualMinutes").value, 10) || 0;
  const commentText = document.getElementById("manualComment").value.trim();

  if (!date) {
    resultEl.textContent = "Bitte ein Datum wählen.";
    resultEl.className = "test-result err";
    return;
  }
  if (!projectId) {
    resultEl.textContent = "Bitte ein Projekt wählen.";
    resultEl.className = "test-result err";
    return;
  }
  const durationSec = hours * 3600 + minutes * 60;
  if (durationSec <= 0) {
    resultEl.textContent = "Bitte eine Dauer grösser als 0 eingeben.";
    resultEl.className = "test-result err";
    return;
  }

  const entry = { id: uid(), date, start: "", end: "", durationSec, projectId };
  entries.push(entry);

  const key = bucketKey(date, projectId);
  if (commentText) {
    comments[key] = comments[key] ? `${comments[key]}; ${commentText}` : commentText;
  }
  markDirty(key);
  saveState();
  closeManualEntry();
  render();
  trySync();
}

// ---------- WebDAV Sync ----------

function davSegments() {
  return ncSegments(TARGET_FOLDER_PATH);
}

function davFileRelativePath() {
  const year = new Date().getFullYear();
  return davPath([...davSegments(), `zeiterfassung_${year}.csv`].join("/"));
}

function ensureFolder() {
  return ensureFolderPath(davSegments());
}

let syncing = false;

async function trySync() {
  if (syncing) return;
  if (!isConfigured()) { renderSyncLine(); return; }
  if (dirtyBuckets.length === 0) { renderSyncLine(); return; }
  if (!navigator.onLine) { renderSyncLine(); return; }

  syncing = true;
  try {
    await ensureFolder();

    const relPath = davFileRelativePath();
    let existingText = "";
    const getRes = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
    if (getRes.status === 200) {
      existingText = await getRes.text();
    } else if (getRes.status === 404) {
      existingText = CSV_HEADER + "\n";
    } else {
      throw new Error(`Lesen fehlgeschlagen (${getRes.status})`);
    }

    const rows = parseCsvRows(existingText);
    const person = personName();
    const keysToSync = [...dirtyBuckets];

    keysToSync.forEach((key) => {
      const sepIdx = key.indexOf("|");
      const date = key.slice(0, sepIdx);
      const projectId = key.slice(sepIdx + 1);
      const totalSec = sumDurationSec(date, projectId);
      const durationMin = (totalSec / 60).toFixed(2);
      const comment = comments[key] || "";
      const name = projectLabel(projectId); // aktuellen Namen zum Sync-Zeitpunkt auflösen

      const idx = rows.findIndex((r) => r.date === date && r.projectId === projectId && r.person === person);
      const rowObj = { date, project: name, durationMin, comment, person, projectId };
      if (idx >= 0) rows[idx] = rowObj;
      else rows.push(rowObj);
    });

    const updated = CSV_HEADER + "\n" + rows.map(rowToCsvLine).join("\n") + "\n";

    const putRes = await proxyFetch(relPath, {
      method: "PUT",
      headers: { ...authHeader(), "Content-Type": "text/csv" },
      body: updated
    });
    if (!putRes.ok) throw new Error(`Schreiben fehlgeschlagen (${putRes.status})`);

    dirtyBuckets = dirtyBuckets.filter((k) => !keysToSync.includes(k));
    saveState();
    renderSyncLine();
  } catch (err) {
    console.warn("Sync fehlgeschlagen:", err);
    renderSyncLine();
  } finally {
    syncing = false;
  }
}

// ---------- Init ----------

function init() {
  renderProjectButtons(); // Projekt-Buttons dynamisch erzeugen (Klick-Listener inklusive)

  document.querySelectorAll(".control-buttons .proj-btn[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleButton(btn.dataset.action));
  });

  initSettingsUI({
    checkRelPath: davFileRelativePath,
    ensureFolderFn: ensureFolder,
    onSaved: () => { render(); trySync(); }
  });

  document.getElementById("manualEntryBtn").addEventListener("click", openManualEntry);
  document.getElementById("closeManual").addEventListener("click", closeManualEntry);
  document.getElementById("cancelManualBtn").addEventListener("click", closeManualEntry);
  document.getElementById("saveManualBtn").addEventListener("click", saveManualEntry);

  window.addEventListener("online", trySync);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { trySync(); refreshProjectNames(); }
  });

  render();
  timerHandle = setInterval(() => { tickTimer(); updateTodayTimes(); }, 1000);
  setInterval(trySync, 30000); // periodischer Retry, falls offline verpasst
  setInterval(refreshProjectNames, 60000); // zentrale Projektnamen alle 60s neu laden

  refreshProjectNames();
  if (isConfigured()) trySync();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
