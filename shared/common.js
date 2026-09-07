/* ============================================================
   Gemeinsame Hilfsfunktionen für alle Büro-Apps (Zeiterfassung,
   Quittung, Wettbewerbsprogramme, Offerten).

   Wird per <script src="../shared/common.js"> VOR dem jeweiligen
   app.js eingebunden. localStorage ist pro Origin (nicht pro
   Pfad) gültig -- die Nextcloud-Zugangsdaten (SETTINGS_KEY), einmal
   in irgendeiner der vier Apps gespeichert, sind automatisch in
   allen anderen ebenfalls verfügbar.

   Jede index.html, die dieses Skript einbindet, muss folgende
   Element-IDs für den Einstellungen-Dialog bereitstellen (Markup
   lässt sich ohne Build-Schritt nicht teilen, ist aber stabil):
   settingsBtn, settingsOverlay, closeSettings, inputDisplayName,
   inputUser, inputPass, saveSettingsBtn, testConnBtn, testResult.
   ============================================================ */

const SETTINGS_KEY = "zeit_settings";

// Die Apps sprechen nicht direkt mit Nextcloud, sondern mit einem
// Cloudflare-Worker-Proxy, der die fehlenden CORS-Header ergänzt.
const PROXY_URL = "https://zeit-proxy.haldejonas.workers.dev";

const DEFAULT_SETTINGS = {
  username: "",
  appPassword: "",
  displayName: ""
};

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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- Nextcloud / WebDAV ----------

let settings = loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS);

function personName() {
  return (settings.displayName && settings.displayName.trim()) || settings.username || "";
}

function isConfigured() {
  return !!(settings.username && settings.appPassword);
}

function authHeader() {
  const token = btoa(`${settings.username}:${settings.appPassword}`);
  return { Authorization: `Basic ${token}` };
}

// Ruft den Cloudflare-Worker-Proxy statt Nextcloud direkt auf.
// relativePath ist komplett relativ zur Nextcloud-Domain (siehe worker.js).
function proxyFetch(relativePath, options = {}) {
  const url = `${PROXY_URL}?path=${encodeURIComponent(relativePath)}`;
  return fetch(url, options);
}

// Baut den vollen DAV-Pfad für die persönlichen Dateien.
function davPath(relativeToUser) {
  return `remote.php/dav/files/${relativeToUser}`;
}

// Segmente relativ zum persönlichen Nextcloud-Dateibereich, z.B.
// ncSegments("Buero/Admin/Finanzen") -> [username, "Buero", "Admin", "Finanzen"].
function ncSegments(folderPath) {
  return [settings.username, ...folderPath.split("/").filter(Boolean)];
}

// MKCOL legt jeweils nur eine Ebene an -> Pfad Stück für Stück aufbauen.
async function ensureFolderPath(segments) {
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

// ---------- Einstellungen UI (Nextcloud-Login) ----------

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
function saveSettings(onSaved) {
  settings.displayName = document.getElementById("inputDisplayName").value.trim();
  settings.username = document.getElementById("inputUser").value.trim();
  settings.appPassword = document.getElementById("inputPass").value;
  saveJSON(SETTINGS_KEY, settings);
  closeSettingsFn();
  if (typeof onSaved === "function") onSaved();
}

// checkRelPath: () => DAV-Pfad, der per GET geprüft wird (200 oder 404 = ok,
// die Datei muss nicht existieren, nur erreichbar sein).
// ensureFolderFn: () => Promise, baut vorher den jeweiligen Zielordner.
async function testConnection(checkRelPath, ensureFolderFn) {
  const el = document.getElementById("testResult");
  el.textContent = "Teste Verbindung…";
  el.className = "test-result";
  try {
    await ensureFolderFn();
    const res = await proxyFetch(checkRelPath(), { method: "GET", headers: authHeader() });
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

// Verdrahtet den kompletten Einstellungen-Dialog (Zahnrad-Icon, Speichern,
// Verbindung testen). onSaved wird nach dem Speichern aufgerufen (z.B. um
// die eigene App neu zu rendern/synchronisieren).
function initSettingsUI({ checkRelPath, ensureFolderFn, onSaved } = {}) {
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("closeSettings").addEventListener("click", closeSettingsFn);
  document.getElementById("saveSettingsBtn").addEventListener("click", () => saveSettings(onSaved));
  if (checkRelPath && ensureFolderFn) {
    document.getElementById("testConnBtn").addEventListener("click", () => testConnection(checkRelPath, ensureFolderFn));
  }
}
