/* ============================================================
   Zeiterfassung — App-Logik
   Zustand: aktueller Zähler + lokale Warteschlange, die per
   WebDAV auf eine Nextcloud-CSV-Datei synchronisiert wird.
   ============================================================ */

const LS_KEYS = {
  settings: "zeit_settings",
  current: "zeit_current",
  entries: "zeit_entries",       // alle lokal bekannten Einträge (für "Heute")
  pending: "zeit_pending",       // noch nicht synchronisierte Einträge
  projectsCache: "zeit_projects_cache" // letzte erfolgreich geladene Projektnamen (Offline-Fallback)
};

// Die App spricht nicht mehr direkt mit Nextcloud, sondern mit einem
// Cloudflare-Worker-Proxy, der die fehlenden CORS-Header ergänzt.
const PROXY_URL = "https://zeit-proxy.haldejonas.workers.dev";

// Öffentlicher Nextcloud-Freigabelink für die zentral verwaltete
// Projektnamen-Datei (3 Zeilen Text: Name P1, Name P2, Name P3).
// Token aus dem Freigabelink eintragen, z.B. bei
// https://.../s/AbCdEfGh123 wäre der Token "AbCdEfGh123".
// Leer lassen ("") um die zentrale Verwaltung zu deaktivieren.
const PROJECTS_SHARE_TOKEN = "cRyoZG6fzBQYDeH";

// Zielordner innerhalb der persönlichen Nextcloud-Dateien, mit "/" getrennt.
// Wird bei Bedarf komplett angelegt (Ebene für Ebene).
const TARGET_FOLDER_PATH = "Buero/Admin/test_zeit";

const DEFAULT_SETTINGS = {
  projectNames: { P1: "P1", P2: "P2", P3: "P3" },
  username: "",
  appPassword: ""
};

let settings = loadJSON(LS_KEYS.settings, DEFAULT_SETTINGS);
// Zentral verwaltete Projektnamen überschreiben die (veralteten) Default-Werte,
// falls schon einmal erfolgreich geladen -> vermeidet "P1/P2/P3" beim Start.
const cachedProjects = loadJSON(LS_KEYS.projectsCache, null);
if (cachedProjects) settings.projectNames = cachedProjects;

let current = loadJSON(LS_KEYS.current, null);       // { action: 'P1'|'P2'|'P3', start: ISOString }
let entries = loadJSON(LS_KEYS.entries, []);          // { date, start, end, durationSec, project, comment, synced }
let pending = loadJSON(LS_KEYS.pending, []);          // Teilmenge von entries (Referenzen per id)

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
  saveJSON(LS_KEYS.pending, pending);
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
function projectLabel(action) {
  return settings.projectNames[action] || action;
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

function closeCurrentSession(now) {
  if (!current) return;
  const start = new Date(current.start);
  const durationSec = Math.round((now - start) / 1000);
  if (durationSec < 5) return; // Miniklicks (Versehen) nicht loggen

  const entry = {
    id: uid(),
    date: formatDate(start),
    start: formatTime(start),
    end: formatTime(now),
    durationSec,
    project: projectLabel(current.action),
    comment: "",
    synced: false
  };
  entries.push(entry);
  pending.push(entry.id);
}

// ---------- Rendering ----------

function render() {
  const statusLabel = document.getElementById("statusLabel");
  const statusTimer = document.getElementById("statusTimer");

  document.querySelectorAll(".proj-btn").forEach((btn) => {
    btn.classList.toggle("active", current && current.action === btn.dataset.action);
  });

  if (current) {
    statusLabel.textContent = projectLabel(current.action) + " läuft";
  } else {
    statusLabel.textContent = "Pausiert";
  }

  document.getElementById("labelP1").textContent = projectLabel("P1");
  document.getElementById("labelP2").textContent = projectLabel("P2");
  document.getElementById("labelP3").textContent = projectLabel("P3");

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

function renderToday() {
  const list = document.getElementById("todayList");
  const today = formatDate(new Date());
  const todays = entries.filter((e) => e.date === today);

  // laufende Session live mitzählen
  const totals = {};
  todays.forEach((e) => {
    totals[e.project] = (totals[e.project] || 0) + e.durationSec;
  });
  if (current) {
    const liveSec = Math.round((Date.now() - new Date(current.start)) / 1000);
    const label = projectLabel(current.action);
    totals[label] = (totals[label] || 0) + Math.max(0, liveSec);
  }

  const projectKeys = Object.keys(totals);
  if (projectKeys.length === 0) {
    list.innerHTML = '<li class="empty">Noch keine Einträge</li>';
    return;
  }

  list.innerHTML = projectKeys
    .sort()
    .map(
      (p) =>
        `<li><span class="proj-name">${escapeHtml(p)}</span><span class="proj-time">${formatHM(totals[p])}</span></li>`
    )
    .join("");
}

function renderSyncLine() {
  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    return;
  }
  if (pending.length === 0) {
    line.textContent = "Synchronisiert";
  } else if (!navigator.onLine) {
    line.textContent = `Offline · ${pending.length} Eintrag/Einträge werden später synchronisiert`;
  } else {
    line.textContent = `${pending.length} Eintrag/Einträge werden synchronisiert…`;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- CSV ----------

const CSV_HEADER = "Datum,Start,Ende,Dauer_Min,Projekt,Kommentar";

function csvField(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function entryToCsvLine(e) {
  const durationMin = (e.durationSec / 60).toFixed(2);
  return [e.date, e.start, e.end, durationMin, e.project, e.comment || ""].map(csvField).join(",");
}

// ---------- Zentral verwaltete Projektnamen ----------

async function refreshProjectNames() {
  if (!PROJECTS_SHARE_TOKEN) return; // Feature nicht aktiviert
  try {
    const res = await proxyFetch(`s/${PROJECTS_SHARE_TOKEN}/download`, { method: "GET" });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const names = {
      P1: lines[0] || settings.projectNames.P1,
      P2: lines[1] || settings.projectNames.P2,
      P3: lines[2] || settings.projectNames.P3
    };
    settings.projectNames = names;
    saveJSON(LS_KEYS.projectsCache, names);
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
  if (pending.length === 0) { renderSyncLine(); return; }
  if (!navigator.onLine) { renderSyncLine(); return; }

  syncing = true;
  try {
    await ensureFolder();

    const relPath = davFileRelativePath();
    let existing = "";
    const getRes = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
    if (getRes.status === 200) {
      existing = await getRes.text();
    } else if (getRes.status === 404) {
      existing = CSV_HEADER + "\n";
    } else {
      throw new Error(`Lesen fehlgeschlagen (${getRes.status})`);
    }

    const idsToSync = [...pending];
    const linesToAppend = idsToSync
      .map((id) => entries.find((e) => e.id === id))
      .filter(Boolean)
      .map(entryToCsvLine);

    if (linesToAppend.length === 0) {
      pending = [];
      saveState();
      renderSyncLine();
      return;
    }

    const sep = existing.endsWith("\n") ? "" : "\n";
    const updated = existing + sep + linesToAppend.join("\n") + "\n";

    const putRes = await proxyFetch(relPath, {
      method: "PUT",
      headers: { ...authHeader(), "Content-Type": "text/csv" },
      body: updated
    });
    if (!putRes.ok) throw new Error(`Schreiben fehlgeschlagen (${putRes.status})`);

    idsToSync.forEach((id) => {
      const e = entries.find((x) => x.id === id);
      if (e) e.synced = true;
    });
    pending = pending.filter((id) => !idsToSync.includes(id));
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
  document.getElementById("inputUser").value = settings.username;
  document.getElementById("inputPass").value = settings.appPassword;
  document.getElementById("testResult").textContent = "";
  document.getElementById("settingsOverlay").classList.remove("hidden");
}
function closeSettingsFn() {
  document.getElementById("settingsOverlay").classList.add("hidden");
}
function saveSettings() {
  settings.username = document.getElementById("inputUser").value.trim();
  settings.appPassword = document.getElementById("inputPass").value;
  saveJSON(LS_KEYS.settings, settings);
  closeSettingsFn();
  render();
  trySync();
}

// ---------- Init ----------

function init() {
  document.querySelectorAll(".proj-btn").forEach((btn) => {
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
  timerHandle = setInterval(() => { tickTimer(); renderToday(); }, 1000);
  setInterval(trySync, 30000); // periodischer Retry, falls offline verpasst
  setInterval(refreshProjectNames, 60000); // zentrale Projektnamen alle 60s neu laden

  refreshProjectNames();
  if (isConfigured()) trySync();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
