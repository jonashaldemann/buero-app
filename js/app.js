/* ============================================================
   Zeiterfassung — App-Logik
   Zustand: aktueller Zähler + lokale Warteschlange, die per
   WebDAV auf eine Nextcloud-CSV-Datei synchronisiert wird.
   ============================================================ */

const LS_KEYS = {
  settings: "zeit_settings",
  current: "zeit_current",
  entries: "zeit_entries",              // alle lokal bekannten Einträge (für "Heute")
  dirtyBuckets: "zeit_dirty_buckets",   // "Datum|Projekt"-Kombis, die noch synchronisiert werden müssen
  comments: "zeit_comments",            // Kommentare pro "Datum|Projekt"
  projectsCache: "zeit_projects_cache"  // letzte erfolgreich geladene Projektnamen (Offline-Fallback)
};

// Die App spricht nicht mehr direkt mit Nextcloud, sondern mit einem
// Cloudflare-Worker-Proxy, der die fehlenden CORS-Header ergänzt.
const PROXY_URL = "https://zeit-proxy.haldejonas.workers.dev";

// Öffentlicher Nextcloud-Freigabelink für die zentral verwaltete
// Projektnamen-Datei (3 Zeilen Text: Name P1, Name P2, Name P3).
// Token aus dem Freigabelink eintragen, z.B. bei
// https://.../s/AbCdEfGh123 wäre der Token "AbCdEfGh123".
// Leer lassen ("") um die zentrale Verwaltung zu deaktivieren.
const PROJECTS_SHARE_TOKEN = "";

// Zielordner innerhalb der persönlichen Nextcloud-Dateien, mit "/" getrennt.
// Wird bei Bedarf komplett angelegt (Ebene für Ebene).
const TARGET_FOLDER_PATH = "Buero/Admin/test_zeit";

const DEFAULT_SETTINGS = {
  username: "",
  appPassword: "",
  displayName: ""
};

// Farbpalette für dynamisch erzeugte Projekt-Buttons (zyklisch, falls mehr
// Projekte als Farben vorhanden sind) -- abgeleitet vom Referenzbild
// (gedeckte Erdtöne: Taubenblau, Salbeigrün, Terrakotta, Schiefergrün, Greige).
const PROJECT_COLOR_PALETTE = ["#4F7089", "#8F9A85", "#C97960", "#626F68", "#8C8171", "#7A95A6"];

let settings = loadJSON(LS_KEYS.settings, DEFAULT_SETTINGS);
// Zentral verwaltete Projektliste (Array beliebiger Länge). Fallback P1/P2/P3,
// falls noch nie erfolgreich geladen und keine zentrale Verwaltung aktiv ist.
let projectList = loadJSON(LS_KEYS.projectsCache, ["P1", "P2", "P3"]);

let current = loadJSON(LS_KEYS.current, null);       // { action: 'P1'|'P2'|'P3', start: ISOString }
let entries = loadJSON(LS_KEYS.entries, []);          // { id, date, start, end, durationSec, project }
let dirtyBuckets = loadJSON(LS_KEYS.dirtyBuckets, []); // ["2026-08-13|Projekt Nord", ...]
let comments = loadJSON(LS_KEYS.comments, {});         // { "2026-08-13|Projekt Nord": "Kommentartext" }

let timerHandle = null;

// ---------- Utilities ----------

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function saveState() {
  saveJSON(LS_KEYS.current, current);
  saveJSON(LS_KEYS.entries, entries);
  saveJSON(LS_KEYS.dirtyBuckets, dirtyBuckets);
  saveJSON(LS_KEYS.comments, comments);
}
function pad(n) { return String(n).padStart(2, "0"); }
function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
  const project = projectLabel(current.action);
  const entry = { id: uid(), date, start: formatTime(start), end: formatTime(now), durationSec, project };
  entries.push(entry);
  markDirty(bucketKey(date, project));
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
    .forEach((e) => { totals[e.project] = (totals[e.project] || 0) + e.durationSec; });
  if (current) {
    const liveSec = Math.max(0, Math.round((Date.now() - new Date(current.start)) / 1000));
    const label = projectLabel(current.action);
    totals[label] = (totals[label] || 0) + liveSec;
  }
  return totals;
}

function renderToday() {
  const list = document.getElementById("todayList");
  const today = formatDate(new Date());
  const totals = computeTodayTotals(today);
  const projectKeys = Object.keys(totals).sort();

  if (projectKeys.length === 0) {
    list.innerHTML = '<li class="empty">Noch keine Einträge</li>';
    return;
  }

  list.innerHTML = projectKeys
    .map((p) => {
      const commentVal = comments[bucketKey(today, p)] || "";
      return `<li data-project="${escapeHtml(p)}">
        <div class="today-row-main">
          <span class="proj-name">${escapeHtml(p)}</span>
          <span class="proj-time" data-role="time">${formatHM(totals[p])}</span>
        </div>
        <input type="text" class="comment-input" data-project="${escapeHtml(p)}"
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
  const rows = list.querySelectorAll("li[data-project]");
  const shownProjects = new Set(Array.from(rows).map((li) => li.dataset.project));
  const currentProjects = new Set(Object.keys(totals));

  const sameSet =
    shownProjects.size === currentProjects.size &&
    [...shownProjects].every((p) => currentProjects.has(p));

  if (!sameSet) {
    renderToday(); // neues Projekt heute zum ersten Mal -> Liste neu aufbauen
    return;
  }
  rows.forEach((li) => {
    const timeEl = li.querySelector('[data-role="time"]');
    if (timeEl) timeEl.textContent = formatHM(totals[li.dataset.project] || 0);
  });
}

function onCommentChange(e) {
  const project = e.target.dataset.project;
  const today = formatDate(new Date());
  const key = bucketKey(today, project);
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- CSV ----------
// Format geändert: ein Zeile pro (Datum, Projekt) statt pro Sitzung -- mehrere
// Wechsel zum selben Projekt am selben Tag werden zu einer Summe zusammengefasst.
// ACHTUNG: Das ist ein anderes Spaltenformat als frühere Testversionen dieser
// App (damals Datum,Start,Ende,Dauer_Min,Projekt,Kommentar). Alte Testdateien
// im Zielordner vor dem ersten Sync mit dieser Version am besten löschen.
const CSV_HEADER = "Datum,Projekt,Dauer_Min,Kommentar,Person";

function csvField(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function personName() {
  return (settings.displayName && settings.displayName.trim()) || settings.username || "";
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
    const [date, project, durationMin, comment, person] = parseCsvLine(line);
    return { date, project, durationMin, comment: comment || "", person: person || "" };
  });
}

function rowToCsvLine(row) {
  return [row.date, row.project, row.durationMin, row.comment || "", row.person || ""].map(csvField).join(",");
}

function sumDurationSec(date, project) {
  return entries
    .filter((e) => e.date === date && e.project === project)
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

// ---------- WebDAV Sync ----------

function isConfigured() {
  return !!(settings.username && settings.appPassword);
}

function authHeader() {
  const token = btoa(`${settings.username}:${settings.appPassword}`);
  return { Authorization: `Basic ${token}` };
}

// Segmente relativ zum persönlichen Nextcloud-Dateibereich: [username, ordner1, ordner2, ...]
function davSegments() {
  return [settings.username, ...TARGET_FOLDER_PATH.split("/").filter(Boolean)];
}

// Ruft den Cloudflare-Worker-Proxy statt Nextcloud direkt auf.
// relativePath ist komplett relativ zur Nextcloud-Domain (siehe worker.js).
function proxyFetch(relativePath, options = {}) {
  const url = `${PROXY_URL}?path=${encodeURIComponent(relativePath)}`;
  return fetch(url, options);
}

// Baut den vollen DAV-Pfad für die persönlichen Zeiterfassungsdateien.
function davPath(relativeToUser) {
  return `remote.php/dav/files/${relativeToUser}`;
}

function davFileRelativePath() {
  const year = new Date().getFullYear();
  return davPath([...davSegments(), `zeiterfassung_${year}.csv`].join("/"));
}

async function ensureFolder() {
  // MKCOL legt jeweils nur eine Ebene an -> Pfad Stück für Stück aufbauen.
  const segments = davSegments(); // [username, Buero, Admin, test_zeit]
  let pathSoFar = segments[0]; // persönlicher Wurzelordner existiert immer schon
  for (let i = 1; i < segments.length; i++) {
    pathSoFar += `/${segments[i]}`;
    const res = await proxyFetch(davPath(pathSoFar), { method: "MKCOL", headers: authHeader() });
    // 201 = angelegt, 405 = existiert schon -> beides ok, sonst Fehler
    if (!res.ok && res.status !== 405) {
      throw new Error(`Ordner anlegen fehlgeschlagen bei "${segments[i]}" (${res.status})`);
    }
  }
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
      const project = key.slice(sepIdx + 1);
      const totalSec = sumDurationSec(date, project);
      const durationMin = (totalSec / 60).toFixed(2);
      const comment = comments[key] || "";

      const idx = rows.findIndex((r) => r.date === date && r.project === project && r.person === person);
      const rowObj = { date, project, durationMin, comment, person };
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

async function testConnection() {
  const el = document.getElementById("testResult");
  el.textContent = "Teste Verbindung…";
  el.className = "test-result";
  try {
    await ensureFolder();
    const res = await proxyFetch(davFileRelativePath(), { method: "GET", headers: authHeader() });
    if (res.status === 200 || res.status === 404) {
      el.textContent = "Verbindung erfolgreich.";
      el.className = "test-result ok";
    } else if (res.status === 401) {
      el.textContent = "Zugangsdaten falsch (401).";
      el.className = "test-result err";
    } else {
      el.textContent = `Unerwartete Antwort: ${res.status}`;
      el.className = "test-result err";
    }
  } catch (err) {
    el.textContent = "Fehler: " + err.message + " (evtl. CORS – siehe README)";
    el.className = "test-result err";
  }
}

// ---------- Einstellungen UI ----------

function openSettings() {
  document.getElementById("inputDisplayName").value = settings.displayName || "";
  document.getElementById("inputUser").value = settings.username;
  document.getElementById("inputPass").value = settings.appPassword;
  document.getElementById("testResult").textContent = "";
  document.getElementById("settingsOverlay").classList.remove("hidden");
}
function closeSettingsFn() {
  document.getElementById("settingsOverlay").classList.add("hidden");
}
function saveSettings() {
  settings.displayName = document.getElementById("inputDisplayName").value.trim();
  settings.username = document.getElementById("inputUser").value.trim();
  settings.appPassword = document.getElementById("inputPass").value;
  saveJSON(LS_KEYS.settings, settings);
  closeSettingsFn();
  render();
  trySync();
}

// ---------- Init ----------

function init() {
  renderProjectButtons(); // Projekt-Buttons dynamisch erzeugen (Klick-Listener inklusive)

  document.querySelectorAll(".control-buttons .proj-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleButton(btn.dataset.action));
  });
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("closeSettings").addEventListener("click", closeSettingsFn);
  document.getElementById("saveSettingsBtn").addEventListener("click", saveSettings);
  document.getElementById("testConnBtn").addEventListener("click", testConnection);

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
