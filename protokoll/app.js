/* ============================================================
   Protokoll — Sitzungsprotokolle (Aktennotizen) erfassen: Header
   (Titel/Projekt/Datum/Zeit/Ort), Teilnehmende (mit optionalem Kürzel
   für Pendenzen -- Büro-Personen bekommen automatisch ihre Initialen),
   Hauptteil als einfache Liste aus Zwischentiteln und Bullet Points
   (analog zu Phasen/Modulen bei den Offerten). Ein Bullet Point mit
   Kürzel einer BÜRO-Person wird beim Speichern automatisch als
   Pendenz in die Pendenzenliste übernommen (siehe syncInternePendenzen()).

   Struktur (ein File pro Protokoll, Liste + Editor) bewusst analog zu
   Offerten gehalten. PDF-Export kommt aus pdf.js (exportProtokollPdf()).

   Nextcloud-Login, proxyFetch/authHeader/davPath, Einstellungen-UI usw.
   kommen aus ../shared/common.js (gemeinsam mit den anderen Modulen).
   ============================================================ */

const LS_KEYS = {
  cache: "protokoll_cache",
  projectsCache: "protokoll_projects_cache"
};

const PROTOKOLL_TARGET_FOLDER_PATH = "Buero/Admin/Protokolle";

// Gleiche zentrale Projektliste + Farbpalette wie in Zeiterfassung/Pendenzen
// (siehe zeiterfassung/app.js) -- bewusst dupliziert statt geteilt, damit
// jedes Modul unabhängig ladbar bleibt (siehe Kommentar in pendenzen/app.js).
const PROJECTS_SHARE_TOKEN = "cRyoZG6fzBQYDeH";

// Pendenzen-Speicherort -- Kopie aus pendenzen/app.js: für die automatische
// Pendenz-Erfassung aus internen Bullet Points (siehe syncInternePendenzen()).
const PENDENZEN_TARGET_FOLDER_PATH = "Buero/Admin/Pendenzen";
const PENDENZEN_FILENAME = "pendenzen.json";

let protokolle = loadJSON(LS_KEYS.cache, []); // { filename, data }
let projectList = loadJSON(LS_KEYS.projectsCache, [
  { id: "P1", name: "P1" },
  { id: "P2", name: "P2" },
  { id: "P3", name: "P3" }
]);
let personen = []; // aus ../shared/personen.json -- Büro-Personen für Teilnehmende/Kürzel

let editingProtokoll = null;
let editingFilename = null;
let editingBaselineUpdatedAt = null;

let draggedRow = null; // beim Drag&Drop der Hauptteil-Zeilen (siehe renderAbschnitte())

// ---------- Zentral verwaltete Projektnamen (Kopie aus zeiterfassung/app.js) ----------

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

async function refreshProjectNames() {
  if (!PROJECTS_SHARE_TOKEN) return;
  try {
    const res = await proxyFetch(`s/${PROJECTS_SHARE_TOKEN}/download`, { method: "GET" });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const text = await res.text();
    const list = parseProjectList(text);
    if (list.length === 0) return;
    projectList = list;
    saveJSON(LS_KEYS.projectsCache, list);
    renderProjektSelect();
  } catch (err) {
    console.warn("Zentrale Projektnamen konnten nicht geladen werden:", err);
  }
}

// Beim Protokoll gelten Projektnummer UND Projektname (anders als bei
// Zeiterfassung/Pendenzen, die nur den Namen zeigen) -- "021 – Neubau
// Werkhof" statt nur "Neubau Werkhof".
function projectLabel(id) {
  const p = projectList.find((p) => p.id === id);
  return p ? `${p.id} – ${p.name}` : id || "";
}

function renderProjektSelect() {
  const select = document.getElementById("inputProjekt");
  if (!select) return;
  const current = editingProtokoll ? editingProtokoll.projekt : select.value;
  select.innerHTML =
    '<option value="">– kein Projekt –</option>' +
    projectList.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.id)} – ${escapeHtml(p.name)}</option>`).join("");
  select.value = current || "";
}

// ---------- Personen (Büro-Personen für Teilnehmende/Kürzel) ----------

async function loadPersonen() {
  try {
    const res = await fetch("../shared/personen.json");
    personen = res.ok ? await res.json() : [];
  } catch (e) {
    personen = [];
  }
}

// Kürzel für Büro-Personen: automatisch die Initialen (wie bei den
// Personen-Kürzeln in Pendenzen) -- externe Teilnehmende bekommen ihr
// Kürzel stattdessen frei eingetragen (siehe renderTeilnehmende()).
function personInitials(name) {
  return (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// ---------- Nextcloud: Protokolle ----------

function protokollSegments() {
  return ncSegments(PROTOKOLL_TARGET_FOLDER_PATH);
}
function ensureProtokollFolder() {
  return ensureFolderPath(protokollSegments());
}
function pingRelPath() {
  return davPath([...protokollSegments(), "_ping"].join("/"));
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';

async function listProtokollFilenames() {
  const relPath = davPath(protokollSegments().join("/") + "/");
  const res = await proxyFetch(relPath, {
    method: "PROPFIND",
    headers: { ...authHeader(), Depth: "1", "Content-Type": "application/xml" },
    body: PROPFIND_LIST_BODY
  });
  if (!res.ok) throw new Error(`Ordnerinhalt lesen fehlgeschlagen (${res.status})`);
  const xmlText = await res.text();
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const hrefs = Array.from(doc.getElementsByTagNameNS("DAV:", "href")).map((el) => el.textContent);
  return hrefs
    .map((href) => decodeURIComponent(href.replace(/\/$/, "").split("/").pop() || ""))
    .filter((name) => name.toLowerCase().endsWith(".json"));
}

async function fetchProtokollFile(filename) {
  const relPath = davPath([...protokollSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (!res.ok) throw new Error(`${filename}: Status ${res.status}`);
  const text = await res.text();
  return JSON.parse(text);
}

async function putProtokollFile(filename, data) {
  const relPath = davPath([...protokollSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

async function deleteProtokollFile(filename) {
  const relPath = davPath([...protokollSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "DELETE", headers: authHeader() });
  if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
}

async function refreshProtokolle() {
  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    renderList();
    return;
  }
  if (!navigator.onLine) {
    line.textContent = "Offline · zeige zuletzt geladenen Stand";
    renderList();
    return;
  }
  line.textContent = "Lädt…";
  try {
    await ensureProtokollFolder();
    const filenames = await listProtokollFilenames();
    const loaded = await Promise.all(
      filenames.map(async (filename) => {
        try {
          const data = await fetchProtokollFile(filename);
          if (!data || typeof data !== "object") throw new Error("ungültiger/leerer Inhalt");
          return { filename, data };
        } catch (err) {
          console.warn("Konnte Protokoll nicht laden:", filename, err);
          return null;
        }
      })
    );
    protokolle = loaded.filter(Boolean);
    saveJSON(LS_KEYS.cache, protokolle);
    line.textContent = "Synchronisiert";
  } catch (err) {
    console.warn("Protokolle konnten nicht geladen werden:", err);
    line.textContent = "Fehler beim Laden · zeige zuletzt geladenen Stand";
  }
  renderList();
}

function sanitizeJsonFilename(name) {
  let clean = name.trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) clean = `protokoll-${uid()}`;
  if (!clean.toLowerCase().endsWith(".json")) clean += ".json";
  return clean;
}

function uniqueFilename(base) {
  const known = new Set(protokolle.map((p) => p.filename));
  if (!known.has(base)) return base;
  const stem = base.replace(/\.json$/i, "");
  let n = 2;
  let candidate;
  do {
    candidate = `${stem} (${n}).json`;
    n++;
  } while (known.has(candidate));
  return candidate;
}

// ---------- Formatierung ----------

function chDate(dateStr) {
  if (!dateStr) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return dateStr;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
function chDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Rendering: Liste ----------

function renderList() {
  document.getElementById("countLabel").textContent = String(protokolle.length);
  const body = document.getElementById("protokollBody");

  if (protokolle.length === 0) {
    body.innerHTML = '<tr><td colspan="5">Noch keine Protokolle geladen.</td></tr>';
    return;
  }

  const sorted = protokolle
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p && p.data)
    .sort((a, b) => String(b.p.data.datum || "").localeCompare(String(a.p.data.datum || "")));

  body.innerHTML = sorted
    .map(({ p, i }) => {
      const d = p.data;
      return `<tr data-clickable data-index="${i}">
        <td>${escapeHtml(chDate(d.datum))}</td>
        <td>${escapeHtml(d.titel || "–")}</td>
        <td>${escapeHtml(projectLabel(d.projekt) || "–")}</td>
        <td>${escapeHtml(d.ort || "–")}</td>
        <td>${(d.teilnehmende || []).length}</td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("tr[data-clickable]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.index, 10);
      openEditor(protokolle[idx].data, protokolle[idx].filename);
    });
  });
}

// ---------- Editor: Grunddaten ----------

function blankProtokoll() {
  return {
    titel: "",
    projekt: "",
    datum: formatDate(new Date()),
    zeitVon: "",
    zeitBis: "",
    ort: "",
    teilnehmende: [],
    abschnitte: [{ typ: "bullet", id: uid(), text: "", kuerzel: "" }],
    syncedPendenzIds: [],
    updatedAt: null,
    updatedBy: null
  };
}

function openEditor(protokoll, filename) {
  editingProtokoll = protokoll ? JSON.parse(JSON.stringify(protokoll)) : blankProtokoll();
  editingFilename = filename || null;
  editingBaselineUpdatedAt = editingProtokoll.updatedAt || null;

  document.getElementById("editorTitle").textContent = filename ? "Protokoll bearbeiten" : "Neues Protokoll";
  document.getElementById("inputTitel").value = editingProtokoll.titel || "";
  renderProjektSelect();
  document.getElementById("inputDatum").value = editingProtokoll.datum || formatDate(new Date());
  document.getElementById("inputZeitVon").value = editingProtokoll.zeitVon || "";
  document.getElementById("inputZeitBis").value = editingProtokoll.zeitBis || "";
  document.getElementById("inputOrt").value = editingProtokoll.ort || "";
  document.getElementById("editorResult").textContent = "";
  document.getElementById("editorResult").className = "test-result";
  document.getElementById("deleteProtokollBtn").style.display = filename ? "" : "none";

  renderTeilnehmende();
  renderAbschnitte();
  document.getElementById("editorOverlay").classList.remove("hidden");
}

function closeEditor() {
  document.getElementById("editorOverlay").classList.add("hidden");
  editingProtokoll = null;
  editingFilename = null;
  editingBaselineUpdatedAt = null;
}

function readHeaderFieldsIntoProtokoll() {
  editingProtokoll.titel = document.getElementById("inputTitel").value.trim();
  editingProtokoll.projekt = document.getElementById("inputProjekt").value || "";
  editingProtokoll.datum = document.getElementById("inputDatum").value || formatDate(new Date());
  editingProtokoll.zeitVon = document.getElementById("inputZeitVon").value || "";
  editingProtokoll.zeitBis = document.getElementById("inputZeitBis").value || "";
  editingProtokoll.ort = document.getElementById("inputOrt").value.trim();
}

// ---------- Editor: Teilnehmende ----------

// Kürzel-Änderungen an einer Büro-Person sind nicht erlaubt (immer die
// automatisch berechneten Initialen) -- nur bei extern eingetragenen
// Teilnehmenden ist das Kürzel-Feld frei editierbar.
function renderTeilnehmende() {
  const list = document.getElementById("teilnehmendeList");
  const teilnehmende = editingProtokoll.teilnehmende;

  list.innerHTML = teilnehmende
    .map((t, i) => {
      const kuerzelField = t.personKey
        ? `<input type="text" value="${escapeHtml(t.kuerzel)}" disabled title="Automatisch aus dem Namen">`
        : `<input type="text" data-field="kuerzel" data-index="${i}" placeholder="Kürzel" value="${escapeHtml(t.kuerzel || "")}" maxlength="6">`;
      return `<div class="teilnehmer-row" data-index="${i}">
        ${
          t.personKey
            ? `<span class="teilnehmer-name">${escapeHtml(t.name)}</span>`
            : `<input type="text" class="teilnehmer-name-input" data-field="name" data-index="${i}" placeholder="Name" value="${escapeHtml(t.name || "")}">`
        }
        ${kuerzelField}
        <button type="button" class="mod-delete" data-action="delete-teilnehmer" data-index="${i}" aria-label="Entfernen">${TRASH_SVG}</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll('[data-field="name"]').forEach((el) => {
    el.addEventListener("input", () => {
      teilnehmende[parseInt(el.dataset.index, 10)].name = el.value;
    });
  });
  list.querySelectorAll('[data-field="kuerzel"]').forEach((el) => {
    el.addEventListener("input", () => {
      teilnehmende[parseInt(el.dataset.index, 10)].kuerzel = el.value.trim();
      renderAbschnitte(); // Kürzel-Auswahl in den Bullet Points aktualisieren
    });
  });
  list.querySelectorAll('[data-action="delete-teilnehmer"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      teilnehmende.splice(parseInt(btn.dataset.index, 10), 1);
      renderTeilnehmende();
      renderAbschnitte();
    });
  });

  renderPersonQuickAdd();
}

// "+ Jonas"/"+ Manuel"-Knöpfe für noch nicht hinzugefügte Büro-Personen.
function renderPersonQuickAdd() {
  const container = document.getElementById("personQuickAdd");
  const already = new Set(editingProtokoll.teilnehmende.map((t) => t.personKey).filter(Boolean));
  const remaining = personen.filter((p) => !already.has(p.key));
  container.innerHTML = remaining
    .map((p) => `<button type="button" class="add-mod-btn" data-action="quick-add" data-key="${escapeHtml(p.key)}">+ ${escapeHtml(p.name)}</button>`)
    .join("");
  container.querySelectorAll('[data-action="quick-add"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = personen.find((x) => x.key === btn.dataset.key);
      if (!p) return;
      editingProtokoll.teilnehmende.push({ name: p.name, kuerzel: personInitials(p.name), personKey: p.key });
      renderTeilnehmende();
    });
  });
}

function addFreierTeilnehmer() {
  editingProtokoll.teilnehmende.push({ name: "", kuerzel: "", personKey: null });
  renderTeilnehmende();
}

// ---------- Editor: Hauptteil (Zwischentitel + Bullet Points) ----------

const DRAG_HANDLE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="6" width="12" height="2.4" rx="1.2" fill="currentColor"/><rect x="6" y="10.8" width="12" height="2.4" rx="1.2" fill="currentColor"/><rect x="6" y="15.6" width="12" height="2.4" rx="1.2" fill="currentColor"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>';

// Kürzel-Auswahl in einem Bullet Point: nur Teilnehmende mit gesetztem
// Kürzel stehen zur Wahl -- die Auswahl selbst markiert den Punkt als
// Pendenz (kein separates Häkchen nötig, siehe blankProtokoll()-Kommentar
// im Todo).
function kuerzelOptionsHtml(selected) {
  const withKuerzel = editingProtokoll.teilnehmende.filter((t) => t.kuerzel);
  const options = withKuerzel
    .map((t) => `<option value="${escapeHtml(t.kuerzel)}" ${t.kuerzel === selected ? "selected" : ""}>${escapeHtml(t.kuerzel)} – ${escapeHtml(t.name)}</option>`)
    .join("");
  return `<option value="">– kein –</option>${options}`;
}

function renderAbschnitte() {
  const list = document.getElementById("abschnitteList");
  const abschnitte = editingProtokoll.abschnitte;

  list.innerHTML = abschnitte
    .map((a, i) => {
      const handle = `<span class="drag-handle" draggable="true" title="Ziehen zum Verschieben">${DRAG_HANDLE_SVG}</span>`;
      if (a.typ === "titel") {
        return `<div class="phase-row" data-index="${i}">
          ${handle}
          <input type="text" class="phase-titel" data-field="text" placeholder="Zwischentitel, z.B. Entscheide" value="${escapeHtml(a.text || "")}">
          <button type="button" class="mod-delete" data-action="delete" aria-label="Zwischentitel löschen">${TRASH_SVG}</button>
        </div>`;
      }
      return `<div class="bullet-row" data-index="${i}">
        ${handle}
        <textarea class="bullet-text" data-field="text" rows="1" placeholder="Stichpunkt">${escapeHtml(a.text || "")}</textarea>
        <select class="bullet-kuerzel" data-field="kuerzel" title="Kürzel wählen, falls dieser Punkt eine Pendenz ist">${kuerzelOptionsHtml(a.kuerzel)}</select>
        <button type="button" class="mod-delete" data-action="delete" aria-label="Punkt löschen">${TRASH_SVG}</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll(".bullet-row, .phase-row").forEach((row) => {
    const index = parseInt(row.dataset.index, 10);
    row.__abschnittRef = abschnitte[index];

    row.querySelectorAll("[data-field]").forEach((el) => {
      const field = el.dataset.field;
      el.addEventListener("input", () => {
        row.__abschnittRef[field] = el.value;
      });
      if (el.tagName === "SELECT") {
        el.addEventListener("change", () => {
          row.__abschnittRef[field] = el.value;
        });
      }
    });

    row.querySelector('[data-action="delete"]')?.addEventListener("click", () => removeAbschnitt(abschnitte.indexOf(row.__abschnittRef)));

    const handleEl = row.querySelector(".drag-handle");
    handleEl.addEventListener("dragstart", (e) => {
      draggedRow = row;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "");
      row.classList.add("dragging");
    });
    handleEl.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      draggedRow = null;
      editingProtokoll.abschnitte = Array.from(list.children).map((el) => el.__abschnittRef);
      renderAbschnitte();
    });
    row.addEventListener("dragover", (e) => {
      if (!draggedRow || draggedRow === row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = row.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      row.parentNode.insertBefore(draggedRow, before ? row : row.nextSibling);
    });
  });
}

function wireAbschnitteListEndDrop() {
  const list = document.getElementById("abschnitteList");
  list.addEventListener("dragover", (e) => {
    if (!draggedRow) return;
    e.preventDefault();
    const rows = Array.from(list.children).filter((el) => el !== draggedRow);
    const last = rows[rows.length - 1];
    if (last && e.clientY > last.getBoundingClientRect().bottom) {
      list.appendChild(draggedRow);
    }
  });
}

function removeAbschnitt(index) {
  const abschnitte = editingProtokoll.abschnitte;
  abschnitte.splice(index, 1);
  if (abschnitte.length === 0) abschnitte.push({ typ: "bullet", id: uid(), text: "", kuerzel: "" });
  renderAbschnitte();
}

// ---------- Interne Pendenzen (aus Bullet Points mit Büro-Kürzel) ----------

function pendenzenSegments() {
  return ncSegments(PENDENZEN_TARGET_FOLDER_PATH);
}
function ensurePendenzenFolder() {
  return ensureFolderPath(pendenzenSegments());
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

// Jeder Bullet Point mit einem Kürzel, das zu einer BÜRO-Person gehört
// (personKey gesetzt -- externe Teilnehmende lösen keine Pendenz aus),
// bekommt eine über Protokoll- und Bullet-ID stabile Pendenz-ID. Dieselbe
// ID bei einem erneuten Speichern sorgt dafür, dass Text-Änderungen die
// bestehende Pendenz aktualisieren statt sie zu duplizieren.
function internePendenzKandidaten(protokoll, filename) {
  const byKuerzel = new Map(protokoll.teilnehmende.filter((t) => t.kuerzel).map((t) => [t.kuerzel, t]));
  return protokoll.abschnitte
    .filter((a) => a.typ === "bullet" && a.kuerzel && a.text && a.text.trim())
    .map((a) => ({ abschnitt: a, teilnehmer: byKuerzel.get(a.kuerzel) }))
    .filter((x) => x.teilnehmer && x.teilnehmer.personKey)
    .map(({ abschnitt, teilnehmer }) => ({
      id: `protokoll:${filename}:${abschnitt.id}`,
      text: abschnitt.text.trim(),
      person: teilnehmer.personKey
    }));
}

// Best-effort-Sync (kein Merge mit gleichzeitigen Änderungen aus der
// Pendenzen-App selbst wie bei syncPendenzen() dort -- Protokolle werden
// deutlich seltener gespeichert als einzelne Pendenzen bearbeitet). Bereits
// erledigte/verschobene Pendenzen bleiben beim Aktualisieren unangetastet
// (nur text/projekt/person werden nachgeführt), nur wirklich neue Punkte
// bekommen einen frischen Eintrag. Nicht mehr gewünschte, vom selben
// Protokoll früher angelegte Pendenzen werden entfernt.
async function syncInternePendenzen(protokoll, filename) {
  const kandidaten = internePendenzKandidaten(protokoll, filename);
  const desiredIds = kandidaten.map((k) => k.id);
  const previouslyOwned = new Set(protokoll.syncedPendenzIds || []);

  try {
    await ensurePendenzenFolder();
    const serverList = await fetchPendenzenFile();
    const byId = new Map(serverList.map((p) => [p.id, p]));
    const now = new Date().toISOString();

    kandidaten.forEach((k) => {
      const existing = byId.get(k.id);
      if (existing) {
        byId.set(k.id, { ...existing, text: k.text, projekt: protokoll.projekt || null, person: k.person, updatedAt: now, updatedBy: personName() });
      } else {
        const minOrder = serverList.filter((p) => !p.erledigt).reduce((min, p) => Math.min(min, p.order ?? 0), 0);
        byId.set(k.id, {
          id: k.id,
          text: k.text,
          projekt: protokoll.projekt || null,
          person: k.person,
          erledigt: false,
          erledigtAt: null,
          order: minOrder - 1,
          createdAt: now,
          updatedAt: now,
          updatedBy: personName()
        });
      }
    });

    previouslyOwned.forEach((id) => {
      if (!desiredIds.includes(id)) byId.delete(id);
    });

    await putPendenzenFile(Array.from(byId.values()));
  } catch (err) {
    console.warn("Interne Pendenzen konnten nicht synchronisiert werden:", err);
  }
  protokoll.syncedPendenzIds = desiredIds;
}

// ---------- Speichern/Löschen ----------

async function saveCurrentProtokoll() {
  const resultEl = document.getElementById("editorResult");
  readHeaderFieldsIntoProtokoll();

  if (!editingProtokoll.titel) {
    resultEl.textContent = "Bitte einen Sitzungstitel angeben.";
    resultEl.className = "test-result err";
    return;
  }
  if (!isConfigured()) {
    resultEl.textContent = "Bitte zuerst Nextcloud in den Einstellungen einrichten.";
    resultEl.className = "test-result err";
    return;
  }

  resultEl.textContent = "Speichert…";
  resultEl.className = "test-result";

  try {
    await ensureProtokollFolder();
    let filename = editingFilename;

    if (filename) {
      const serverData = await fetchProtokollFile(filename).catch(() => null);
      if (serverData && serverData.updatedAt && serverData.updatedAt !== editingBaselineUpdatedAt) {
        const proceed = confirm(
          `Dieses Protokoll wurde von ${serverData.updatedBy || "jemandem"} am ${chDateTime(serverData.updatedAt)} geändert, ` +
            `nachdem du es geöffnet hast.\n\nOK = trotzdem mit deiner Version überschreiben\nAbbrechen = neuere Version laden (deine Änderungen gehen dabei verloren)`
        );
        if (!proceed) {
          openEditor(serverData, filename);
          resultEl.textContent = "Neuere Version geladen. Bitte Änderungen erneut vornehmen.";
          resultEl.className = "test-result err";
          return;
        }
      }
    } else {
      filename = uniqueFilename(sanitizeJsonFilename(`${editingProtokoll.datum} ${editingProtokoll.titel}`));
    }

    await syncInternePendenzen(editingProtokoll, filename);

    editingProtokoll.updatedAt = new Date().toISOString();
    editingProtokoll.updatedBy = personName();

    await putProtokollFile(filename, editingProtokoll);
    editingFilename = filename;
    resultEl.textContent = "Gespeichert.";
    resultEl.className = "test-result ok";
    await refreshProtokolle();
    closeEditor();
  } catch (err) {
    resultEl.textContent = "Fehler: " + err.message;
    resultEl.className = "test-result err";
  }
}

async function deleteCurrentProtokoll() {
  if (!editingFilename) return;
  if (!confirm(`Protokoll "${editingProtokoll.titel || editingFilename}" wirklich löschen?`)) return;

  const deleteBtn = document.getElementById("deleteProtokollBtn");
  deleteBtn.disabled = true;
  try {
    // Vom Protokoll selbst angelegte interne Pendenzen ebenfalls entfernen
    // (leere Kandidatenliste = alles bisher Eigene wird gelöscht).
    await syncInternePendenzen({ ...editingProtokoll, abschnitte: [], teilnehmende: [] }, editingFilename);
    await deleteProtokollFile(editingFilename);
    protokolle = protokolle.filter((p) => p.filename !== editingFilename);
    saveJSON(LS_KEYS.cache, protokolle);
    closeEditor();
    renderList();
  } catch (err) {
    alert("Fehler beim Löschen: " + err.message);
  } finally {
    deleteBtn.disabled = false;
  }
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: pingRelPath,
    ensureFolderFn: ensureProtokollFolder,
    onSaved: refreshProtokolle
  });

  wireAbschnitteListEndDrop();

  document.getElementById("newProtokollBtn").addEventListener("click", () => openEditor(null, null));
  document.getElementById("refreshBtn").addEventListener("click", refreshProtokolle);
  document.getElementById("closeEditor").addEventListener("click", closeEditor);
  document.getElementById("saveProtokollBtn").addEventListener("click", saveCurrentProtokoll);
  document.getElementById("deleteProtokollBtn").addEventListener("click", deleteCurrentProtokoll);
  document.getElementById("addTeilnehmerBtn").addEventListener("click", addFreierTeilnehmer);
  document.getElementById("addBulletBtn").addEventListener("click", () => {
    editingProtokoll.abschnitte.push({ typ: "bullet", id: uid(), text: "", kuerzel: "" });
    renderAbschnitte();
  });
  document.getElementById("addTitelBtn").addEventListener("click", () => {
    editingProtokoll.abschnitte.push({ typ: "titel", id: uid(), text: "" });
    renderAbschnitte();
  });
  document.getElementById("pdfProtokollBtn").addEventListener("click", async () => {
    readHeaderFieldsIntoProtokoll();
    const resultEl = document.getElementById("editorResult");
    const btn = document.getElementById("pdfProtokollBtn");
    btn.disabled = true;
    resultEl.textContent = "Erstellt PDF…";
    resultEl.className = "test-result";
    try {
      await exportProtokollPdf(editingProtokoll, projectLabel);
      resultEl.textContent = "PDF erstellt.";
      resultEl.className = "test-result ok";
    } catch (err) {
      resultEl.textContent = "Fehler: " + err.message;
      resultEl.className = "test-result err";
    } finally {
      btn.disabled = false;
    }
  });

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshProjectNames();
  });
  setInterval(refreshProjectNames, 60000);

  Promise.all([loadPersonen(), refreshProjectNames()]).then(() => {
    if (editingProtokoll) {
      renderTeilnehmende();
      renderProjektSelect();
    }
  });

  if (isConfigured()) refreshProtokolle();
  else renderList();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
