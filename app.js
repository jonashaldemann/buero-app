/* ============================================================
   Zeiterfassung — App-Logik
   Zustand: aktueller Zähler + lokale Warteschlange, die per
   WebDAV auf eine Nextcloud-CSV-Datei synchronisiert wird.
   ============================================================ */

const LS_KEYS = {
  settings: "zeit_settings",
  current: "zeit_current",
  entries: "zeit_entries",       // alle lokal bekannten Einträge (für "Heute")
  pending: "zeit_pending"        // noch nicht synchronisierte Einträge
};

// Server ist für alle Nutzer gleich -> fest im Code statt in den Einstellungen.
// Ohne Slash am Ende.
const NEXTCLOUD_SERVER_URL = "https://EURE-DOMAIN.de";

const DEFAULT_SETTINGS = {
  projectNames: { P1: "P1", P2: "P2", P3: "P3" },
  username: "",
  appPassword: ""
};

let settings = loadJSON(LS_KEYS.settings, DEFAULT_SETTINGS);
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

// ---------- WebDAV Sync ----------

function isConfigured() {
  return !!(settings.username && settings.appPassword);
}

function authHeader() {
  const token = btoa(`${settings.username}:${settings.appPassword}`);
  return { Authorization: `Basic ${token}` };
}

function davBaseUrl() {
  const server = NEXTCLOUD_SERVER_URL.replace(/\/+$/, "");
  return `${server}/remote.php/dav/files/${encodeURIComponent(settings.username)}`;
}
function davFolderUrl() {
  return `${davBaseUrl()}/Zeiterfassung`;
}
function davFileUrl() {
  const year = new Date().getFullYear();
  return `${davFolderUrl()}/zeiterfassung_${year}.csv`;
}

async function ensureFolder() {
  const res = await fetch(davFolderUrl(), { method: "MKCOL", headers: authHeader() });
  // 201 = angelegt, 405 = existiert schon -> beides ok
  if (!res.ok && res.status !== 405) {
    throw new Error(`Ordner anlegen fehlgeschlagen (${res.status})`);
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

    const url = davFileUrl();
    let existing = "";
    const getRes = await fetch(url, { method: "GET", headers: authHeader() });
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

    const putRes = await fetch(url, {
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
    const res = await fetch(davFileUrl(), { method: "GET", headers: authHeader() });
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
  document.getElementById("inputP1").value = settings.projectNames.P1;
  document.getElementById("inputP2").value = settings.projectNames.P2;
  document.getElementById("inputP3").value = settings.projectNames.P3;
  document.getElementById("inputUser").value = settings.username;
  document.getElementById("inputPass").value = settings.appPassword;
  document.getElementById("testResult").textContent = "";
  document.getElementById("settingsOverlay").classList.remove("hidden");
}
function closeSettingsFn() {
  document.getElementById("settingsOverlay").classList.add("hidden");
}
function saveSettings() {
  settings.projectNames.P1 = document.getElementById("inputP1").value.trim() || "P1";
  settings.projectNames.P2 = document.getElementById("inputP2").value.trim() || "P2";
  settings.projectNames.P3 = document.getElementById("inputP3").value.trim() || "P3";
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
    if (document.visibilityState === "visible") trySync();
  });

  render();
  timerHandle = setInterval(() => { tickTimer(); renderToday(); }, 1000);
  setInterval(trySync, 30000); // periodischer Retry, falls offline verpasst

  if (isConfigured()) trySync();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
