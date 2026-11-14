/* ============================================================
   Gemeinsame Hilfsfunktionen für alle Büro-Apps (Zeiterfassung,
   Quittung, Wettbewerbsprogramme, Offerten, Adressliste, Pendenzen).

   Wird per <script src="../shared/common.js"> VOR dem jeweiligen
   app.js eingebunden. localStorage ist pro Origin (nicht pro
   Pfad) gültig -- die Nextcloud-Zugangsdaten (SETTINGS_KEY), einmal
   in irgendeiner der Apps gespeichert, sind automatisch in
   allen anderen ebenfalls verfügbar.

   Jede index.html, die dieses Skript einbindet, muss folgende
   Element-IDs für den Einstellungen-Dialog bereitstellen (Markup
   lässt sich ohne Build-Schritt nicht teilen, ist aber stabil):
   settingsBtn, settingsOverlay, closeSettings, inputUser, inputPass,
   saveSettingsBtn, testConnBtn, testResult. Kein eigenes Anzeigename-Feld
   (mehr) -- siehe deriveDisplayName().
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

// Schweizer Zahlenformat (Tausender-Apostroph, Komma-Dezimaltrennzeichen),
// gerundet auf 2 Nachkommastellen -- verhindert u.a. Fliesskomma-Artefakte
// wie "3.3000000000000003" in der Anzeige.
function chNumber(n) {
  if (n === undefined || n === null || n === "") return "–";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  return (Math.round(num * 100) / 100).toLocaleString("de-CH");
}

// ---------- Nextcloud / WebDAV ----------

let settings = loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS);

function personName() {
  if (istDemo()) return "Demo";
  return (settings.displayName && settings.displayName.trim()) || settings.username || "";
}

// "Eingerichtet" heisst: die App darf laden und speichern. Im Demomodus
// trifft das zu -- die Daten landen dann bei demoFetch() statt auf
// Nextcloud. Mit DEMO_ENABLED = false gilt wieder die reine Prüfung auf
// gespeicherte Zugangsdaten.
function isConfigured() {
  return istDemo() || !!(settings.username && settings.appPassword);
}

function authHeader() {
  const token = btoa(`${settings.username}:${settings.appPassword}`);
  return { Authorization: `Basic ${token}` };
}

// ---------- Demomodus ----------
//
// Ohne gespeicherte Zugangsdaten laufen alle Apps im DEMOMODUS: statt der
// Nextcloud antwortet eine kleine Attrappe (demoFetch) mit Beispieldaten
// eines erfundenen Büros aus demo/seed.json, Änderungen landen nur im
// localStorage dieses Browsers.
//
// Der Einstiegspunkt sitzt bewusst GANZ UNTEN in der Schicht -- auf Höhe
// von proxyFetch(), dort wo sonst der Worker-Proxy angesprochen wird.
// Dadurch funktionieren alle zehn Module unverändert: Laden, Speichern,
// Ordner auflisten, Löschen. Kein Modul kennt den Demomodus.
//
// Sobald Zugangsdaten gespeichert sind, ist der Demomodus aus und die
// Beispieldaten sind nicht mehr erreichbar: sie liegen unter einem eigenen
// localStorage-Schlüssel und unter einem eigenen Benutzer "demo", und beim
// Anmelden wird der localStorage ohnehin komplett geleert (siehe
// saveSettings()).
const DEMO_ENABLED = true; // falls der Demomodus je stören sollte: auf false
const DEMO_USER = "demo";
const LS_DEMO_OVERLAY = "demo_overlay";
// Relativ zu common.js selbst aufgelöst -- die Datei wird aus dem Repo-Root
// ("shared/common.js") UND aus den Modulen ("../shared/common.js") geladen,
// ein relativer Pfad zur Seite würde also je nach Modul woanders landen.
const DEMO_SEED_URL = new URL("../demo/seed.json", document.currentScript.src).href;

function istDemo() {
  return DEMO_ENABLED && !(settings.username && settings.appPassword);
}

let demoSeedPromise = null;
function ladeDemoSeed() {
  if (!demoSeedPromise) {
    demoSeedPromise = fetch(DEMO_SEED_URL, { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : {}))
      .catch((err) => {
        console.warn("Demodaten konnten nicht geladen werden:", err);
        return {};
      });
  }
  return demoSeedPromise;
}

// Aus "remote.php/dav/files/demo/Buero/Admin/..." wird der Schlüssel
// "Buero/Admin/..." -- so sind die Pfade in demo/seed.json lesbar.
const DEMO_PREFIX = `remote.php/dav/files/${DEMO_USER}/`;
function demoSchluessel(path) {
  const clean = String(path).replace(/^\/+/, "");
  return clean.startsWith(DEMO_PREFIX) ? clean.slice(DEMO_PREFIX.length) : clean;
}

function demoOverlay() {
  return loadJSON(LS_DEMO_OVERLAY, {});
}

// Seed, überschrieben durch die lokalen Änderungen. null im Overlay ist ein
// Grabstein: eine Datei, die im Demomodus gelöscht wurde und deshalb auch
// nicht mehr aus dem Seed auftauchen darf.
async function demoDateien() {
  const dateien = { ...(await ladeDemoSeed()), ...demoOverlay() };
  Object.keys(dateien).forEach((k) => {
    if (dateien[k] === null) delete dateien[k];
  });
  return dateien;
}

function demoAntwort(body, status, contentType) {
  return new Response(body, { status, headers: contentType ? { "Content-Type": contentType } : {} });
}

async function demoFetch(relativePath, options) {
  const method = (options.method || "GET").toUpperCase();
  const key = demoSchluessel(relativePath);

  if (method === "MKCOL") return demoAntwort("", 201);

  if (method === "PROPFIND") {
    const dateien = await demoDateien();
    const ordner = key.replace(/\/+$/, "");
    const hrefs = [`/${DEMO_PREFIX}${ordner}/`];
    Object.keys(dateien).forEach((k) => {
      if (k.startsWith(ordner + "/") && !k.slice(ordner.length + 1).includes("/")) {
        hrefs.push("/" + (DEMO_PREFIX + k).split("/").map(encodeURIComponent).join("/"));
      }
    });
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs
      .map((h) => `<d:response><d:href>${h}</d:href></d:response>`)
      .join("")}</d:multistatus>`;
    return demoAntwort(xml, 207, "application/xml");
  }

  if (method === "PUT") {
    const overlay = demoOverlay();
    // Hochgeladene Bilder/PDFs (Quittungs-Belege) kommen als Blob -- die
    // landen im Demomodus bewusst nicht im localStorage (Platz), der
    // Dateiname erscheint aber in der Ordnerliste, damit die Belegnummern
    // weiterzählen wie im Echtbetrieb.
    overlay[key] = typeof options.body === "string" ? options.body : "(Demo: Datei nicht gespeichert)";
    saveJSON(LS_DEMO_OVERLAY, overlay);
    return demoAntwort("", 201);
  }

  if (method === "DELETE") {
    const overlay = demoOverlay();
    overlay[key] = null;
    saveJSON(LS_DEMO_OVERLAY, overlay);
    return demoAntwort("", 204);
  }

  const dateien = await demoDateien();
  if (!(key in dateien)) return demoAntwort("", 404);
  const inhalt = dateien[key];
  // In seed.json dürfen JSON-Dateien als echte Objekte stehen (lesbar),
  // Textdateien wie projekte.txt als String.
  const text = typeof inhalt === "string" ? inhalt : JSON.stringify(inhalt, null, 2);
  return demoAntwort(text, 200, "application/json");
}

// Ruft den Cloudflare-Worker-Proxy statt Nextcloud direkt auf.
// relativePath ist komplett relativ zur Nextcloud-Domain (siehe worker.js).
function proxyFetch(relativePath, options = {}) {
  if (istDemo()) return demoFetch(relativePath, options);
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
  return [istDemo() ? DEMO_USER : settings.username, ...folderPath.split("/").filter(Boolean)];
}

// Alle Modul-Daten liegen zentral gebündelt unter diesem Ordner (Ausnahme:
// die eigentlichen Quittungen bleiben unter Buero/Admin/Finanzen, siehe
// README "Nextcloud-Ordnerstruktur"). appModuleFolderPath(name) baut daraus
// den vollen Pfad -- reine Konsolidierung, damit der gemeinsame Prefix nicht
// in jedem Modul einzeln ausgeschrieben werden muss.
const APP_DATA_ROOT = "Buero/Admin/App";
function appModuleFolderPath(name) {
  return `${APP_DATA_ROOT}/${name}`;
}

// ---------- Zentrale Konfiguration (Mitarbeitende + Projekte) ----------

// Mitarbeitende kommen aus config.json (ersetzt das frühere, im Repo
// liegende shared/personen.json). Projekte kommen bewusst NICHT aus
// config.json, sondern -- wie schon vor der Nextcloud-Reorg -- aus einer
// einfachen Textdatei (ein Projekt pro Zeile, optional "NNN Titel"): die
// Projektliste wird von beiden Personen oft bearbeitet, dafür ist eine
// Textdatei ohne JSON-Syntaxrisiko (Kommas/Anführungszeichen) praktischer.
// Beide Dateien erfordern Login wie jede andere bürospezifische Datei --
// bewusst KEIN Vor-Login-Fallback mit Platzhalterdaten mehr.
const LS_APP_CONFIG_CACHE = "app_config_cache";
const DEFAULT_BUERO_NAME = "Büro";
let appConfig = loadJSON(LS_APP_CONFIG_CACHE, { mitarbeitende: [], projekte: [], bueroName: DEFAULT_BUERO_NAME });

function appConfigDavPath() {
  return davPath([...ncSegments(APP_DATA_ROOT), "config.json"].join("/"));
}
function appProjectsDavPath() {
  return davPath([...ncSegments(APP_DATA_ROOT), "projekte.txt"].join("/"));
}

// Jede Zeile ist entweder "NNN Projekttitel" (dreistellige Projektnummer,
// Leerschlag, Titel -- die Nummer ist rein kosmetisch, siehe README) oder
// einfach nur der Titel.
function parseProjectList(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = /^(\d{3})\s+(.+)$/.exec(line);
      return m ? { id: m[1], name: m[2] } : { id: `P${i + 1}`, name: line };
    });
}

// Liest config.json einmal komplett -- neben mitarbeitende steht dort auch
// bueroName (Anzeigename fürs Dashboard/Browser-Tab, siehe index.html im
// Repo-Root; ersetzt dort das fest hinterlegte "Büro").
async function fetchAppConfigFile() {
  try {
    const res = await proxyFetch(appConfigDavPath(), { method: "GET", headers: authHeader() });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("config.json konnte nicht geladen werden:", err);
    return null;
  }
}
async function fetchAppProjekte() {
  try {
    const res = await proxyFetch(appProjectsDavPath(), { method: "GET", headers: authHeader() });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return parseProjectList(await res.text());
  } catch (err) {
    console.warn("Projektliste (projekte.txt) konnte nicht geladen werden:", err);
    return null;
  }
}

// config.json und projekte.txt unabhängig voneinander laden -- schlägt eine
// fehl (z.B. Datei noch nicht angelegt), bleibt für DIESEN Teil der letzte
// bekannte Stand erhalten, statt die ganze Konfiguration zu verwerfen.
async function refreshAppConfig() {
  if (!isConfigured()) return appConfig;
  const [configFile, projekte] = await Promise.all([fetchAppConfigFile(), fetchAppProjekte()]);
  appConfig = {
    mitarbeitende: configFile ? configFile.mitarbeitende || [] : appConfig.mitarbeitende,
    bueroName: configFile ? configFile.bueroName || DEFAULT_BUERO_NAME : appConfig.bueroName,
    // Fahrzeuge samt Kilometeransatz für die Kilometer-Quittung
    // (quittung/km.js). Fehlt das Feld, gilt dort eine eingebaute Liste --
    // die Ansätze gehören dem Büro, nicht dem Programm.
    fahrzeuge: configFile ? configFile.fahrzeuge || [] : appConfig.fahrzeuge || [],
    projekte: projekte !== null ? projekte : appConfig.projekte
  };
  saveJSON(LS_APP_CONFIG_CACHE, appConfig);
  return appConfig;
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

// ---------- Service Worker ----------

// Jeder Service Worker hier ruft bereits self.skipWaiting()/self.clients.claim()
// auf (übernimmt serverseitig also sofort) -- es fehlte nur die Client-Seite:
// ohne Reload merkt ein bereits offener Tab nichts davon. controllerchange
// feuert genau dann, wenn der neue Worker die Kontrolle übernimmt -> einmalig
// neu laden, damit z.B. beim Geschäftspartner garantiert die neuste Version
// läuft (wichtig bei Nextcloud-Pfad-Änderungen, sonst schreibt eine alte,
// weiterlaufende Version an inzwischen verschobene Ordner).
function registerServiceWorkerWithAutoUpdate() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// ---------- Einstellungen UI (Nextcloud-Login) ----------

const EYE_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 12a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z" fill="currentColor"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 12a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z" fill="currentColor" opacity="0.5"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2"/></svg>';

// Blendet das App-Passwort im Klartext ein/aus -- wird beim Öffnen des
// Dialogs (openSettings()) und nach dem Speichern jedes Mal auf "verborgen"
// zurückgesetzt, damit es nicht z.B. auf einem gemeinsam genutzten Gerät
// unbeabsichtigt sichtbar bleibt.
function resetPasswordVisibility() {
  const input = document.getElementById("inputPass");
  const btn = document.getElementById("togglePassBtn");
  if (!input || !btn) return;
  input.type = "password";
  btn.innerHTML = EYE_SVG;
  btn.setAttribute("aria-label", "Passwort anzeigen");
  btn.setAttribute("title", "Passwort anzeigen");
}
function togglePasswordVisibility() {
  const input = document.getElementById("inputPass");
  const btn = document.getElementById("togglePassBtn");
  const currentlyHidden = input.type === "password";
  input.type = currentlyHidden ? "text" : "password";
  btn.innerHTML = currentlyHidden ? EYE_OFF_SVG : EYE_SVG;
  const label = currentlyHidden ? "Passwort verbergen" : "Passwort anzeigen";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
}

function openSettings() {
  document.getElementById("inputUser").value = settings.username;
  document.getElementById("inputPass").value = settings.appPassword;
  resetPasswordVisibility();
  document.getElementById("testResult").textContent = "";
  document.getElementById("settingsOverlay").classList.remove("hidden");
}
function closeSettingsFn() {
  document.getElementById("settingsOverlay").classList.add("hidden");
}
// Kein eigenes Anzeigename-Feld mehr im Dialog -- der Name (z.B. für die
// Zeiterfassungs-CSV-Spalte "Person") wird automatisch aus dem Benutzernamen
// abgeleitet: bei einer E-Mail-Adresse der Teil vor dem "@", sonst der ganze
// Benutzername, erster Buchstabe gross (z.B. "max" -> "Max",
// "max@firma.ch" -> "Max").
function deriveDisplayName(username) {
  const namePart = (username || "").split("@")[0].trim();
  return namePart ? namePart.charAt(0).toUpperCase() + namePart.slice(1) : "";
}
function saveSettings(onSaved) {
  const warDemo = istDemo();
  const username = document.getElementById("inputUser").value.trim();
  const appPassword = document.getElementById("inputPass").value.trim();
  // Beim Wechsel vom Demomodus zum echten Konto wird der localStorage
  // komplett geleert -- dort liegen sonst die Demo-Änderungen UND die
  // Modul-Caches mit Demodaten. Danach wird die Seite neu geladen: die
  // bereits gerenderte Demo-Liste steckt ja noch im Arbeitsspeicher der
  // Seite und würde sonst bis zum nächsten erfolgreichen Sync weiter
  // angezeigt -- als wären es die eigenen Daten.
  if (warDemo && username && appPassword) {
    localStorage.clear();
    settings.username = username;
    settings.appPassword = appPassword;
    settings.displayName = deriveDisplayName(username);
    saveJSON(SETTINGS_KEY, settings);
    location.reload();
    return;
  }
  settings.username = username;
  settings.appPassword = appPassword;
  settings.displayName = deriveDisplayName(settings.username);
  saveJSON(SETTINGS_KEY, settings);
  closeSettingsFn();
  entferneDemoBanner();
  if (typeof onSaved === "function") onSaved();
}

// ---------- Demo-Banner ----------

// Wird von initSettingsUI() aufgerufen, also von jedem Modul automatisch --
// keine Änderung an den zehn index.html nötig.
function zeigeDemoBanner() {
  if (!istDemo() || document.getElementById("demoBanner")) return;
  const bar = document.createElement("div");
  bar.id = "demoBanner";
  bar.innerHTML =
    '<span><strong>Demomodus</strong> — Beispieldaten eines erfundenen Büros. ' +
    "Änderungen bleiben nur in diesem Browser und werden nirgends gespeichert.</span>" +
    '<button type="button" id="demoResetBtn">Beispieldaten zurücksetzen</button>';
  document.body.insertBefore(bar, document.body.firstChild);
  document.getElementById("demoResetBtn").addEventListener("click", () => {
    if (!confirm("Alle im Demomodus gemachten Änderungen verwerfen?")) return;
    // Im Demomodus liegt nichts Schützenswertes im localStorage (die
    // Zugangsdaten sind ja gerade leer) -- komplett leeren ist deshalb die
    // ehrlichste Variante: auch die Modul-Caches müssen weg, sonst zeigen
    // die Apps weiter den geänderten Stand.
    localStorage.clear();
    location.reload();
  });
}

function entferneDemoBanner() {
  const bar = document.getElementById("demoBanner");
  if (bar) bar.remove();
}

// checkRelPath: () => DAV-Pfad, der per GET geprüft wird (200 oder 404 = ok,
// die Datei muss nicht existieren, nur erreichbar sein).
// ensureFolderFn: () => Promise, baut vorher den jeweiligen Zielordner.
async function testConnection(checkRelPath, ensureFolderFn) {
  const el = document.getElementById("testResult");
  // Geprüft werden die GESPEICHERTEN Zugangsdaten, nicht die gerade
  // eingetippten. Ohne gespeicherte Daten liefe der Test gegen die
  // Demo-Attrappe und meldete fälschlich Erfolg.
  if (istDemo()) {
    el.textContent = "Noch keine Zugangsdaten gespeichert (Demomodus) – zuerst speichern.";
    el.className = "test-result err";
    return;
  }
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
  const toggleBtn = document.getElementById("togglePassBtn");
  if (toggleBtn) toggleBtn.addEventListener("click", togglePasswordVisibility);
  if (checkRelPath && ensureFolderFn) {
    document.getElementById("testConnBtn").addEventListener("click", () => testConnection(checkRelPath, ensureFolderFn));
  }
}

// Der Demo-Hinweis erscheint auf JEDER Seite -- auch auf der Startseite,
// die gar keinen Einstellungen-Dialog hat. Deshalb hier direkt verdrahtet
// statt in initSettingsUI().
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", zeigeDemoBanner);
} else {
  zeigeDemoBanner();
}
