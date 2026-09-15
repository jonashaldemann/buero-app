/* ============================================================
   Pendenzen — einfache To-do-Liste, nach Projekt und Person filterbar.

   Alle Pendenzen liegen in EINER gemeinsamen JSON-Datei auf Nextcloud
   (Buero/Admin/Pendenzen/pendenzen.json), anders als z.B. die Adressliste
   (eine Datei pro Kontakt) -- bei kurzen Textzeilen, die oft schnell
   angehakt/ergänzt werden, wäre eine Datei pro Pendenz nur Overhead.
   Damit sich zwei Personen dabei nicht gegenseitig überschreiben, wird bei
   jedem Speichern der aktuelle Serverstand nochmals geholt und pro Pendenz
   (per id) gemergt -- die jeweils neuere updatedAt gewinnt, nur lokal oder
   nur serverseitig bekannte Pendenzen bleiben in jedem Fall erhalten (siehe
   mergePendenzenLists()). Das ist kein Feld-Merge wie bei den Offerten,
   sondern ein Merge auf Ebene ganzer Listeneinträge -- für eine Pendenz
   (kurzer Text, an/abgehakt) reicht das.

   Projekte + Farben kommen aus derselben zentral verwalteten Liste wie in
   der Zeiterfassung (PROJECTS_SHARE_TOKEN, PROJECT_COLOR_PALETTE) -- damit
   ein Projekt überall dieselbe Farbe hat. Bewusst dupliziert statt geteilt
   (siehe Kommentar in pdf.js/app.js der Offerten): jedes Modul bleibt so
   unabhängig ladbar, ohne Reihenfolge-Abhängigkeiten zwischen den Apps.

   Personen (aktuell 2, siehe personen.json) sind KEINE Nextcloud-Logins --
   das ist eine reine Auswahlliste für das optionale "Person"-Feld einer
   Pendenz und die Personen-Filterknöpfe, analog zu offerten/unterzeichner.json.

   Nextcloud-Login, proxyFetch/authHeader/davPath, Einstellungen-UI usw.
   kommen aus ../shared/common.js.
   ============================================================ */

const LS_KEYS = {
  cache: "pendenzen_cache",
  projectsCache: "pendenzen_projects_cache"
};

const PENDENZEN_TARGET_FOLDER_PATH = "Buero/Admin/Pendenzen";
const PENDENZEN_FILENAME = "pendenzen.json";

// Gleiche zentrale Projektliste + Farbpalette wie in der Zeiterfassung
// (siehe zeiterfassung/app.js) -- ein Projekt soll überall gleich heissen
// und gleich aussehen.
const PROJECTS_SHARE_TOKEN = "cRyoZG6fzBQYDeH";
const PROJECT_COLOR_PALETTE = ["#4F7089", "#8F9A85", "#C97960", "#626F68", "#8C8171", "#7A95A6"];
const FALLBACK_COLOR = "#B7AFA0";

let projectList = loadJSON(LS_KEYS.projectsCache, ["P1", "P2", "P3"]);
let personen = [];

// { id, text, projekt ("P1"/... oder null), person (key oder null),
//   erledigt, erledigtAt, createdAt, updatedAt, updatedBy }
let pendenzen = loadJSON(LS_KEYS.cache, []);

let filterPerson = "ALL";
let filterProjekt = "ALL";

// ---------- Zentral verwaltete Projektnamen (Kopie aus zeiterfassung/app.js) ----------

async function refreshProjectNames() {
  if (!PROJECTS_SHARE_TOKEN) return;
  try {
    const res = await proxyFetch(`s/${PROJECTS_SHARE_TOKEN}/download`, { method: "GET" });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const text = await res.text();
    const names = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (names.length === 0) return; // leere Datei -> alten Stand behalten
    projectList = names;
    saveJSON(LS_KEYS.projectsCache, names);
  } catch (err) {
    console.warn("Zentrale Projektnamen konnten nicht geladen werden:", err);
  }
}

function projectIndexFromId(id) {
  const m = /^P(\d+)$/.exec(id || "");
  return m ? parseInt(m[1], 10) - 1 : -1;
}
function projectLabel(id) {
  const idx = projectIndexFromId(id);
  if (idx >= 0 && projectList[idx]) return projectList[idx];
  return id || "";
}
function projectColor(id) {
  const idx = projectIndexFromId(id);
  if (idx < 0) return null;
  return PROJECT_COLOR_PALETTE[idx % PROJECT_COLOR_PALETTE.length];
}

async function loadPersonen() {
  try {
    const res = await fetch("personen.json");
    personen = res.ok ? await res.json() : [];
  } catch (e) {
    personen = [];
  }
}
function personLabel(key) {
  const p = personen.find((x) => x.key === key);
  return p ? p.name : "";
}

// ---------- Nextcloud ----------

function pendenzenSegments() {
  return ncSegments(PENDENZEN_TARGET_FOLDER_PATH);
}
function ensurePendenzenFolder() {
  return ensureFolderPath(pendenzenSegments());
}
function pingRelPath() {
  return davPath([...pendenzenSegments(), "_ping"].join("/"));
}

async function fetchPendenzenFile() {
  const relPath = davPath([...pendenzenSegments(), PENDENZEN_FILENAME].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [];
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [];
}

async function putPendenzenFile(list) {
  const relPath = davPath([...pendenzenSegments(), PENDENZEN_FILENAME].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(list, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

// Führt Server- und lokalen Stand pro Pendenz (per id) zusammen -- die
// jeweils neuere updatedAt gewinnt, nur auf einer Seite bekannte Pendenzen
// bleiben in jedem Fall erhalten. Verhindert, dass zwei Geräte, die
// gleichzeitig verschiedene Pendenzen anlegen/abhaken, sich gegenseitig
// überschreiben (siehe Kommentar oben).
function mergePendenzenLists(serverList, localList) {
  const byId = new Map();
  serverList.forEach((p) => byId.set(p.id, p));
  localList.forEach((p) => {
    const existing = byId.get(p.id);
    if (!existing || String(p.updatedAt || "") > String(existing.updatedAt || "")) {
      byId.set(p.id, p);
    }
  });
  return Array.from(byId.values());
}

// Zentrale Stelle für jede Änderung: optionale lokale Änderung sofort
// anzeigen (optimistisch), danach mit dem Server mergen und zurückschreiben.
// deleteIds: Pendenzen, die endgültig entfernt werden sollen -- ohne das
// würde mergePendenzenLists() sie aus dem (noch nicht aktualisierten)
// Serverstand einfach wieder zurückholen.
async function syncPendenzen(localChange, deleteIds) {
  if (typeof localChange === "function") {
    pendenzen = localChange(pendenzen);
    saveJSON(LS_KEYS.cache, pendenzen);
    render();
  }

  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    if (line) line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    return;
  }
  if (!navigator.onLine) {
    if (line) line.textContent = "Offline · zeige zuletzt geladenen Stand";
    return;
  }
  if (line) line.textContent = "Lädt…";
  try {
    await ensurePendenzenFolder();
    const serverList = await fetchPendenzenFile();
    let merged = mergePendenzenLists(serverList, pendenzen);
    if (deleteIds && deleteIds.size) merged = merged.filter((p) => !deleteIds.has(p.id));
    await putPendenzenFile(merged);
    pendenzen = merged;
    saveJSON(LS_KEYS.cache, pendenzen);
    if (line) line.textContent = "Synchronisiert";
  } catch (err) {
    console.warn("Pendenzen konnten nicht synchronisiert werden:", err);
    if (line) line.textContent = "Fehler beim Synchronisieren · zeige zuletzt geladenen Stand";
  }
  render();
}

// ---------- Aktionen ----------

function handleAdd() {
  const textInput = document.getElementById("inputNeuText");
  const text = textInput.value.trim();
  if (!text) return;
  const personSelect = document.getElementById("inputNeuPerson");
  const person = personSelect.value || null;
  const projekt = filterProjekt === "ALL" ? null : filterProjekt;
  const now = new Date().toISOString();
  const item = {
    id: uid(),
    text,
    projekt,
    person,
    erledigt: false,
    erledigtAt: null,
    createdAt: now,
    updatedAt: now,
    updatedBy: personName()
  };
  syncPendenzen((list) => [...list, item]);
  textInput.value = "";
  personSelect.value = "";
  textInput.focus();
}

function toggleErledigt(id, erledigt) {
  const now = new Date().toISOString();
  syncPendenzen((list) =>
    list.map((p) =>
      p.id === id ? { ...p, erledigt, erledigtAt: erledigt ? now : null, updatedAt: now, updatedBy: personName() } : p
    )
  );
}

// Löscht nur die aktuell im Filter sichtbaren erledigten Pendenzen (nicht
// alle erledigten überhaupt) -- siehe Todo-Wortlaut "nur jeweils die, die
// gerade im Filter aktiv sind".
function deleteErledigteInFilter() {
  const ids = new Set(filteredPendenzen().filter((p) => p.erledigt).map((p) => p.id));
  if (!ids.size) return;
  if (!confirm(`${ids.size} erledigte Pendenz${ids.size === 1 ? "" : "en"} endgültig löschen?`)) return;
  syncPendenzen((list) => list.filter((p) => !ids.has(p.id)), ids);
}

// ---------- Filter ----------

function filteredPendenzen() {
  return pendenzen.filter((p) => {
    if (filterProjekt !== "ALL" && (p.projekt || null) !== filterProjekt) return false;
    if (filterPerson !== "ALL" && (p.person || null) !== filterPerson) return false;
    return true;
  });
}

// ---------- Rendering ----------

function renderPersonFilterRow() {
  const container = document.getElementById("personFilterRow");
  const chips = [{ key: "ALL", name: "Alle" }, ...personen];
  container.innerHTML = chips
    .map((p) => `<button type="button" class="filter-chip${filterPerson === p.key ? " active" : ""}" data-person="${escapeHtml(p.key)}">${escapeHtml(p.name)}</button>`)
    .join("");
  container.querySelectorAll("[data-person]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterPerson = btn.dataset.person;
      renderPersonFilterRow();
      render();
    });
  });
}

function renderProjectFilterRow() {
  const container = document.getElementById("projectFilterRow");
  let html = `<button type="button" class="filter-chip${filterProjekt === "ALL" ? " active" : ""}" data-projekt="ALL">Alle</button>`;
  html += projectList
    .map((name, i) => {
      const id = `P${i + 1}`;
      const color = PROJECT_COLOR_PALETTE[i % PROJECT_COLOR_PALETTE.length];
      return `<button type="button" class="filter-chip${filterProjekt === id ? " active" : ""}" data-projekt="${id}" style="--accent:${color}">
        <span class="chip-dot" style="background:${color}"></span>${escapeHtml(name)}
      </button>`;
    })
    .join("");
  container.innerHTML = html;
  container.querySelectorAll("[data-projekt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterProjekt = btn.dataset.projekt;
      renderProjectFilterRow();
      render();
    });
  });
}

function renderAddForm() {
  const personSelect = document.getElementById("inputNeuPerson");
  const current = personSelect.value;
  personSelect.innerHTML =
    `<option value="">Person (optional)</option>` +
    personen.map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.name)}</option>`).join("");
  personSelect.value = current;
}

function renderRow(p) {
  const color = projectColor(p.projekt) || FALLBACK_COLOR;
  const projLabel = p.projekt ? projectLabel(p.projekt) : "";
  const persLabel = p.person ? personLabel(p.person) : "";
  return `<div class="pendenz-row${p.erledigt ? " erledigt" : ""}" style="--accent:${color}">
    <label class="pendenz-check">
      <input type="checkbox" data-action="toggle" data-id="${p.id}" ${p.erledigt ? "checked" : ""}>
      <span class="pendenz-text">${escapeHtml(p.text)}</span>
    </label>
    <span class="pendenz-meta">
      ${projLabel ? `<span class="pendenz-tag" style="background:${color}22;color:${color}">${escapeHtml(projLabel)}</span>` : ""}
      ${persLabel ? `<span class="pendenz-tag">${escapeHtml(persLabel)}</span>` : ""}
    </span>
  </div>`;
}

function render() {
  const list = filteredPendenzen();
  const offen = list.filter((p) => !p.erledigt).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const erledigt = list
    .filter((p) => p.erledigt)
    .sort((a, b) => String(b.erledigtAt || b.updatedAt || "").localeCompare(String(a.erledigtAt || a.updatedAt || "")));

  const openList = document.getElementById("openList");
  openList.innerHTML = offen.length
    ? offen.map(renderRow).join("")
    : '<p class="hint" style="margin:0;">Keine offenen Pendenzen im aktuellen Filter.</p>';

  const doneSection = document.getElementById("doneSection");
  const doneList = document.getElementById("doneList");
  const deleteDoneBtn = document.getElementById("deleteDoneBtn");
  if (erledigt.length) {
    doneSection.style.display = "";
    doneList.innerHTML = erledigt.map(renderRow).join("");
    deleteDoneBtn.textContent = `🗑 ${erledigt.length} erledigte löschen`;
  } else {
    doneSection.style.display = "none";
  }

  document.querySelectorAll('[data-action="toggle"]').forEach((cb) => {
    cb.addEventListener("change", () => toggleErledigt(cb.dataset.id, cb.checked));
  });
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: pingRelPath,
    ensureFolderFn: ensurePendenzenFolder,
    onSaved: () => syncPendenzen()
  });

  document.getElementById("addPendenzBtn").addEventListener("click", handleAdd);
  document.getElementById("inputNeuText").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAdd();
  });
  document.getElementById("deleteDoneBtn").addEventListener("click", deleteErledigteInFilter);
  document.getElementById("refreshBtn").addEventListener("click", () => syncPendenzen());

  window.addEventListener("online", () => syncPendenzen());
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncPendenzen();
  });

  renderPersonFilterRow();
  renderProjectFilterRow();
  render();

  Promise.all([loadPersonen(), refreshProjectNames()]).then(() => {
    renderPersonFilterRow();
    renderProjectFilterRow();
    renderAddForm();
  });

  if (isConfigured()) syncPendenzen();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
