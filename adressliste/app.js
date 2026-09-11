/* ============================================================
   Adressliste — Firmen-/Personenadressen verwalten. Jeder Kontakt
   ist eine eigene JSON-Datei auf Nextcloud (analog zu den Offerten:
   ein File pro Datensatz statt einer grossen Liste), damit zwei
   Personen gleichzeitig verschiedene Einträge bearbeiten können, ohne
   sich gegenseitig etwas zu überschreiben.

   Für den seltenen Fall, dass zwei Personen genau denselben Eintrag
   gleichzeitig öffnen: jeder Kontakt trägt updatedAt/updatedBy. Beim
   Speichern wird der aktuelle Stand auf Nextcloud nochmals frisch
   geladen und mit dem Stand beim Öffnen des Editors verglichen
   (siehe saveContact()). Weicht er ab, wurde der Eintrag zwischenzeitlich
   von jemand anderem geändert -- die Person am Bildschirm bekommt das
   angezeigt und kann entscheiden, ob sie trotzdem überschreiben will,
   statt dass die fremde Änderung stillschweigend verloren geht. Das
   ist kein echtes Locking (dafür bräuchte es einen Server), aber für
   zwei Personen im selben Adressbuch ausreichend.

   Ansichten (Spaltenauswahl inkl. Reihenfolge, Filter pro Spalte,
   Sortierung) lassen sich unter einem Namen speichern -- genau wie die
   Kontakte liegt jede Ansicht als eigene JSON-Datei im Unterordner
   "Ansichten" (siehe VIEWS_FOLDER_PATH), damit beide Personen dieselben
   Ansichten sehen und sich beim Speichern zweier Ansichten nicht
   gegenseitig überschreiben können.

   Die Tabelle ist bewusst nur für den Desktop-Browser gedacht (keine
   mobile Breitenbeschränkung wie bei den anderen Apps) -- Spalten lassen
   sich per Drag&Drop am Spaltenkopf umsortieren, jede Spalte hat ihr
   eigenes Filterfeld direkt unter dem Titel.

   Nextcloud-Login, proxyFetch/authHeader/davPath, chNumber usw. kommen
   aus ../shared/common.js (gemeinsam mit Zeiterfassung, Quittung,
   Wettbewerbsprogrammen und Offerten).
   ============================================================ */

const LS_KEYS = {
  contactsCache: "adressliste_cache",
  viewsCache: "adressliste_views_cache"
};

const ADRESSEN_TARGET_FOLDER_PATH = "Buero/Admin/Adressen";
const VIEWS_FOLDER_PATH = "Buero/Admin/Adressen/Ansichten";
const LEGACY_VIEWS_FILENAME = "_ansichten.json"; // vor der Umstellung auf ein File pro Ansicht

const COLUMNS = [
  { key: "kategorie", label: "Kategorie" },
  { key: "status", label: "Status" },
  { key: "name", label: "Name" },
  { key: "vorname", label: "Vorname" },
  { key: "firma", label: "Firma" },
  { key: "strasse", label: "Strasse" },
  { key: "ort", label: "Ort" },
  { key: "tel", label: "Tel." },
  { key: "mail", label: "Mail" },
  { key: "website", label: "Website" },
  { key: "bemerkungen", label: "Bemerkungen" },
  { key: "projekte", label: "Projekte" },
  { key: "weihnachtskarte", label: "Weihnachtskarte" },
  { key: "updatedInfo", label: "Zuletzt geändert" }
];
const DEFAULT_COLUMNS = ["kategorie", "name", "vorname", "firma", "ort", "status", "weihnachtskarte"];

function columnDef(key) {
  return COLUMNS.find((c) => c.key === key);
}

function blankView() {
  return {
    id: null,
    name: "",
    columns: [...DEFAULT_COLUMNS],
    filters: {}, // { [columnKey]: string } -- fehlend/leer = kein Filter auf dieser Spalte
    sort: { field: "name", dir: "asc" }
  };
}

// { filename, data } -- data ist das geparste JSON eines Kontakts.
let contacts = loadJSON(LS_KEYS.contactsCache, []);
// Ansichten: { filename, id, name, columns, filters, sort }
let views = loadJSON(LS_KEYS.viewsCache, []);

let currentView = blankView();
let activeViewId = null; // null = nicht gespeicherte/angepasste Ansicht

// Beim Drag&Drop eines Spaltenkopfs (siehe renderTableHead()) der Key der
// gerade gezogenen Spalte, sonst null.
let draggedColumnKey = null;

// Aktuell im Editor offene Kontakt-Arbeitskopie, ihr Dateiname (null = neu)
// und der updatedAt-Stand beim Öffnen (für die Konflikt-Prüfung beim Speichern).
let editingContact = null;
let editingFilename = null;
let editingBaselineUpdatedAt = null;

// ---------- Nextcloud: Ordner/Dateien ----------

function adressenSegments() {
  return ncSegments(ADRESSEN_TARGET_FOLDER_PATH);
}
function viewsSegments() {
  return ncSegments(VIEWS_FOLDER_PATH);
}
function ensureAdressenFolder() {
  return ensureFolderPath(adressenSegments());
}
function ensureViewsFolder() {
  return ensureFolderPath(viewsSegments());
}
function pingRelPath() {
  return davPath([...adressenSegments(), "_ping"].join("/"));
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';

// Listet die .json-Dateinamen direkt in einem Ordner (nicht rekursiv) --
// Unterordner (z.B. "Ansichten" innerhalb von Adressen) tauchen zwar in der
// PROPFIND-Antwort auf, werden aber durch den .json-Filter automatisch
// ausgeschlossen.
async function listJsonFilenames(segments) {
  const relPath = davPath(segments.join("/") + "/");
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

async function fetchJsonFile(segments, filename) {
  const relPath = davPath([...segments, filename].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${filename}: Status ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function putJsonFile(segments, filename, data) {
  const relPath = davPath([...segments, filename].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

async function deleteJsonFile(segments, filename) {
  const relPath = davPath([...segments, filename].join("/"));
  const res = await proxyFetch(relPath, { method: "DELETE", headers: authHeader() });
  if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
}

// ---------- Laden: Kontakte ----------

async function refreshContacts() {
  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    renderAll();
    return;
  }
  if (!navigator.onLine) {
    line.textContent = "Offline · zeige zuletzt geladenen Stand";
    renderAll();
    return;
  }
  line.textContent = "Lädt…";
  try {
    await ensureAdressenFolder();
    const filenames = (await listJsonFilenames(adressenSegments())).filter((f) => f !== LEGACY_VIEWS_FILENAME);
    const loaded = await Promise.all(
      filenames.map(async (filename) => {
        try {
          const data = await fetchJsonFile(adressenSegments(), filename);
          return data ? { filename, data } : null;
        } catch (err) {
          console.warn("Konnte Kontakt nicht laden:", filename, err);
          return null;
        }
      })
    );
    contacts = loaded.filter(Boolean);
    saveJSON(LS_KEYS.contactsCache, contacts);
    line.textContent = `Synchronisiert · ${contacts.length} Einträge`;
    await refreshViews();
  } catch (err) {
    console.warn("Adressen konnten nicht geladen werden:", err);
    line.textContent = "Fehler beim Laden · zeige zuletzt geladenen Stand";
  }
  renderAll();
}

// ---------- Laden: Ansichten ----------

// Einmalige Migration: falls noch die alte, einzelne _ansichten.json aus
// einer früheren Version existiert, deren Einträge als einzelne Dateien im
// neuen Ansichten-Unterordner ablegen und die alte Datei löschen.
async function migrateLegacyViewsFile() {
  const legacy = await fetchJsonFile(adressenSegments(), LEGACY_VIEWS_FILENAME);
  if (!Array.isArray(legacy) || !legacy.length) return;
  for (const v of legacy) {
    const id = v.id || uid();
    await putJsonFile(viewsSegments(), `${id}.json`, { ...v, id });
  }
  await deleteJsonFile(adressenSegments(), LEGACY_VIEWS_FILENAME);
}

async function refreshViews() {
  await ensureViewsFolder();
  await migrateLegacyViewsFile();
  const filenames = await listJsonFilenames(viewsSegments());
  const loaded = await Promise.all(
    filenames.map(async (filename) => {
      try {
        const data = await fetchJsonFile(viewsSegments(), filename);
        return data ? { filename, ...data } : null;
      } catch (err) {
        console.warn("Konnte Ansicht nicht laden:", filename, err);
        return null;
      }
    })
  );
  views = loaded.filter(Boolean);
  saveJSON(LS_KEYS.viewsCache, views);
}

// ---------- Formatierung ----------

function chDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updatedInfoText(data) {
  if (!data.updatedAt) return "–";
  const who = data.updatedBy || "?";
  return `${who}, ${chDateTime(data.updatedAt)}`;
}

function cellValue(data, key) {
  switch (key) {
    case "weihnachtskarte":
      return data.weihnachtskarte ? "Ja" : "";
    case "updatedInfo":
      return updatedInfoText(data);
    default:
      return data[key] || "";
  }
}

// ---------- Filtern/Sortieren ----------

function matchesFilters(data) {
  const filters = currentView.filters || {};
  for (const key of Object.keys(filters)) {
    const raw = (filters[key] || "").trim();
    if (!raw) continue;
    if (key === "weihnachtskarte") {
      if (raw === "ja" && !data.weihnachtskarte) return false;
      if (raw === "nein" && data.weihnachtskarte) return false;
      continue;
    }
    const cellText = cellValue(data, key).toString().toLowerCase();
    if (!cellText.includes(raw.toLowerCase())) return false;
  }
  return true;
}

function visibleContacts() {
  const filtered = contacts.filter((c) => matchesFilters(c.data));
  const { field, dir } = currentView.sort;
  const mult = dir === "desc" ? -1 : 1;
  filtered.sort((a, b) => {
    let av, bv;
    if (field === "weihnachtskarte") {
      av = a.data.weihnachtskarte ? 1 : 0;
      bv = b.data.weihnachtskarte ? 1 : 0;
      return (av - bv) * mult;
    }
    if (field === "updatedInfo") {
      av = a.data.updatedAt || "";
      bv = b.data.updatedAt || "";
      return av.localeCompare(bv) * mult;
    }
    av = (a.data[field] || "").toString();
    bv = (b.data[field] || "").toString();
    return av.localeCompare(bv, "de") * mult;
  });
  return filtered;
}

// ---------- Rendering ----------

function renderAll() {
  renderColumnToggles();
  renderViewsSelect();
  renderTableHead();
  renderTableBody();
}

function visibleColumnDefs() {
  return currentView.columns.map(columnDef).filter(Boolean);
}

function renderColumnToggles() {
  const wrap = document.getElementById("columnToggles");
  wrap.innerHTML = COLUMNS.map(
    (col) => `<label>
      <input type="checkbox" data-col="${col.key}" ${currentView.columns.includes(col.key) ? "checked" : ""}>
      ${escapeHtml(col.label)}
    </label>`
  ).join("");
  wrap.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.col;
      if (cb.checked) {
        if (!currentView.columns.includes(key)) currentView.columns.push(key);
      } else {
        currentView.columns = currentView.columns.filter((k) => k !== key);
        delete currentView.filters[key];
      }
      renderTableHead();
      renderTableBody();
    });
  });
}

function renderViewsSelect() {
  const sel = document.getElementById("viewSelect");
  sel.innerHTML =
    '<option value="">– eigene/ungespeicherte Ansicht –</option>' +
    views.map((v) => `<option value="${escapeHtml(v.id)}" ${v.id === activeViewId ? "selected" : ""}>${escapeHtml(v.name)}</option>`).join("");
  if (!activeViewId) sel.value = "";
  document.getElementById("deleteViewBtn").disabled = !activeViewId;
}

function filterCellHtml(col) {
  if (col.key === "weihnachtskarte") {
    const v = currentView.filters.weihnachtskarte || "";
    return `<select data-filter="${col.key}">
      <option value="" ${v === "" ? "selected" : ""}>Alle</option>
      <option value="ja" ${v === "ja" ? "selected" : ""}>Ja</option>
      <option value="nein" ${v === "nein" ? "selected" : ""}>Nein</option>
    </select>`;
  }
  const v = currentView.filters[col.key] || "";
  return `<input type="text" data-filter="${col.key}" value="${escapeHtml(v)}" placeholder="Filter…">`;
}

// Kopfzeile (Titel, sortierbar + per Drag&Drop umsortierbar) und die
// Filter-Zeile direkt darunter -- getrennt von renderTableBody(), damit ein
// Tastendruck in einem Filterfeld nicht dessen eigenes DOM-Element (und
// damit Cursor/Fokus) neu aufbaut.
function renderTableHead() {
  const cols = visibleColumnDefs();

  const headRow = document.getElementById("listHeadRow");
  headRow.innerHTML =
    cols.map((c) => {
      const sorted = currentView.sort.field === c.key;
      const arrow = sorted ? (currentView.sort.dir === "desc" ? " ↓" : " ↑") : "";
      return `<th data-sort="${c.key}" draggable="true" class="sortable">${escapeHtml(c.label)}${arrow}</th>`;
    }).join("") + "<th></th>";

  headRow.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (currentView.sort.field === key) {
        currentView.sort.dir = currentView.sort.dir === "asc" ? "desc" : "asc";
      } else {
        currentView.sort = { field: key, dir: "asc" };
      }
      renderTableHead();
      renderTableBody();
    });
    th.addEventListener("dragstart", () => {
      draggedColumnKey = th.dataset.sort;
      th.classList.add("dragging");
    });
    th.addEventListener("dragend", () => {
      th.classList.remove("dragging");
      draggedColumnKey = null;
    });
    th.addEventListener("dragover", (e) => e.preventDefault());
    th.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetKey = th.dataset.sort;
      if (!draggedColumnKey || draggedColumnKey === targetKey) return;
      const cols2 = [...currentView.columns];
      const from = cols2.indexOf(draggedColumnKey);
      const to = cols2.indexOf(targetKey);
      if (from === -1 || to === -1) return;
      cols2.splice(from, 1);
      cols2.splice(to, 0, draggedColumnKey);
      currentView.columns = cols2;
      renderTableHead();
      renderTableBody();
    });
  });

  const filterRow = document.getElementById("listFilterRow");
  filterRow.innerHTML = cols.map((c) => `<th class="filter-cell">${filterCellHtml(c)}</th>`).join("") + "<th></th>";
  filterRow.querySelectorAll("[data-filter]").forEach((el) => {
    const key = el.dataset.filter;
    const eventName = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(eventName, () => {
      currentView.filters[key] = el.value;
      renderTableBody();
    });
  });
}

function renderTableBody() {
  const cols = visibleColumnDefs();
  const rows = visibleContacts();
  document.getElementById("countLabel").textContent = String(rows.length);
  const body = document.getElementById("listBody");

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="${cols.length + 1}">Keine Einträge (evtl. Filter anpassen oder "Aktualisieren").</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map(({ filename, data }) => {
      const tds = cols.map((c) => `<td>${escapeHtml(cellValue(data, c.key))}</td>`).join("");
      return `<tr data-clickable data-filename="${escapeHtml(filename)}">${tds}<td class="row-actions"><button type="button" class="row-action edit-btn" title="Bearbeiten">✎</button></td></tr>`;
    })
    .join("");

  body.querySelectorAll("tr[data-filename]").forEach((tr) => {
    tr.addEventListener("click", () => openEditor(tr.dataset.filename));
  });
}

// ---------- Ansichten speichern/laden/löschen ----------

async function saveCurrentView() {
  const suggested = views.find((v) => v.id === activeViewId)?.name || "";
  const name = prompt("Name der Ansicht:", suggested);
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  try {
    await ensureViewsFolder();
    // Frisch laden, damit eine zwischenzeitlich von der anderen Person neu
    // angelegte Ansicht bei der Namens-Kollisionsprüfung berücksichtigt wird.
    await refreshViews();
    const existing = views.find((v) => v.name.toLowerCase() === trimmed.toLowerCase());
    if (existing && existing.id !== activeViewId) {
      if (!confirm(`Es gibt schon eine Ansicht "${trimmed}". Überschreiben?`)) return;
    }
    const target = existing || views.find((v) => v.id === activeViewId);
    const id = target?.id || uid();
    const entry = {
      id,
      name: trimmed,
      columns: [...currentView.columns],
      filters: { ...currentView.filters },
      sort: { ...currentView.sort }
    };
    await putJsonFile(viewsSegments(), `${id}.json`, entry);
    await refreshViews();
    activeViewId = id;
    renderViewsSelect();
    alert(`Ansicht "${trimmed}" gespeichert.`);
  } catch (err) {
    alert("Ansicht speichern fehlgeschlagen: " + err.message);
  }
}

async function deleteCurrentView() {
  const view = views.find((v) => v.id === activeViewId);
  if (!view) return;
  if (!confirm(`Ansicht "${view.name}" wirklich löschen?`)) return;
  try {
    await deleteJsonFile(viewsSegments(), view.filename);
    activeViewId = null;
    await refreshViews();
    renderViewsSelect();
  } catch (err) {
    alert("Ansicht löschen fehlgeschlagen: " + err.message);
  }
}

function applyView(viewId) {
  if (!viewId) {
    activeViewId = null;
    currentView = blankView();
  } else {
    const v = views.find((vv) => vv.id === viewId);
    if (!v) return;
    activeViewId = v.id;
    currentView = {
      columns: [...v.columns],
      filters: { ...v.filters },
      sort: { ...v.sort }
    };
  }
  renderAll();
}

// ---------- Editor ----------

function blankContact() {
  return {
    kategorie: "",
    status: "",
    vorname: "",
    name: "",
    firma: "",
    strasse: "",
    ort: "",
    tel: "",
    mail: "",
    website: "",
    bemerkungen: "",
    projekte: "",
    weihnachtskarte: false,
    updatedAt: null,
    updatedBy: null
  };
}

async function openEditor(filename) {
  const overlay = document.getElementById("editorOverlay");
  const resultEl = document.getElementById("editorResult");
  resultEl.textContent = "";
  resultEl.className = "test-result";

  if (!filename) {
    editingFilename = null;
    editingContact = blankContact();
    editingBaselineUpdatedAt = null;
    document.getElementById("editorTitle").textContent = "Neuer Kontakt";
    document.getElementById("lastEditedLine").textContent = "";
    fillEditorFields(editingContact);
    overlay.classList.remove("hidden");
    return;
  }

  document.getElementById("editorTitle").textContent = "Kontakt laden…";
  overlay.classList.remove("hidden");
  try {
    const fresh = isConfigured() && navigator.onLine ? await fetchJsonFile(adressenSegments(), filename) : null;
    const local = contacts.find((c) => c.filename === filename)?.data;
    const data = fresh || local;
    if (!data) throw new Error("Nicht gefunden");
    editingFilename = filename;
    editingContact = { ...blankContact(), ...data };
    editingBaselineUpdatedAt = editingContact.updatedAt || null;
    document.getElementById("editorTitle").textContent = `${editingContact.vorname || ""} ${editingContact.name || editingContact.firma || ""}`.trim() || "Kontakt";
    document.getElementById("lastEditedLine").textContent = editingContact.updatedAt
      ? `Zuletzt geändert: ${updatedInfoText(editingContact)}`
      : "Noch nie gespeichert.";
    fillEditorFields(editingContact);
  } catch (err) {
    overlay.classList.add("hidden");
    alert("Kontakt konnte nicht geladen werden: " + err.message);
  }
}

function closeEditor() {
  document.getElementById("editorOverlay").classList.add("hidden");
  editingContact = null;
  editingFilename = null;
  editingBaselineUpdatedAt = null;
}

function fillEditorFields(data) {
  document.getElementById("inputKategorie").value = data.kategorie || "";
  document.getElementById("inputStatus").value = data.status || "";
  document.getElementById("inputVorname").value = data.vorname || "";
  document.getElementById("inputName").value = data.name || "";
  document.getElementById("inputFirma").value = data.firma || "";
  document.getElementById("inputStrasse").value = data.strasse || "";
  document.getElementById("inputOrt").value = data.ort || "";
  document.getElementById("inputTel").value = data.tel || "";
  document.getElementById("inputMail").value = data.mail || "";
  document.getElementById("inputWebsite").value = data.website || "";
  document.getElementById("inputBemerkungen").value = data.bemerkungen || "";
  document.getElementById("inputProjekte").value = data.projekte || "";
  document.getElementById("inputWeihnachtskarte").checked = !!data.weihnachtskarte;
}

function readEditorFields() {
  editingContact.kategorie = document.getElementById("inputKategorie").value.trim();
  editingContact.status = document.getElementById("inputStatus").value.trim();
  editingContact.vorname = document.getElementById("inputVorname").value.trim();
  editingContact.name = document.getElementById("inputName").value.trim();
  editingContact.firma = document.getElementById("inputFirma").value.trim();
  editingContact.strasse = document.getElementById("inputStrasse").value.trim();
  editingContact.ort = document.getElementById("inputOrt").value.trim();
  editingContact.tel = document.getElementById("inputTel").value.trim();
  editingContact.mail = document.getElementById("inputMail").value.trim();
  editingContact.website = document.getElementById("inputWebsite").value.trim();
  editingContact.bemerkungen = document.getElementById("inputBemerkungen").value.trim();
  editingContact.projekte = document.getElementById("inputProjekte").value.trim();
  editingContact.weihnachtskarte = document.getElementById("inputWeihnachtskarte").checked;
}

async function saveContact() {
  const resultEl = document.getElementById("editorResult");
  readEditorFields();

  if (!editingContact.name && !editingContact.firma) {
    resultEl.textContent = "Bitte mindestens Name oder Firma angeben.";
    resultEl.className = "test-result err";
    return;
  }

  resultEl.textContent = "Speichert…";
  resultEl.className = "test-result";

  try {
    let filename = editingFilename;
    if (filename) {
      // Konflikt-Prüfung: hat jemand anders den Eintrag geändert, seit wir
      // ihn geöffnet haben?
      const serverData = await fetchJsonFile(adressenSegments(), filename);
      if (serverData && serverData.updatedAt && serverData.updatedAt !== editingBaselineUpdatedAt) {
        const proceed = confirm(
          `Dieser Eintrag wurde von ${serverData.updatedBy || "jemandem"} am ${chDateTime(serverData.updatedAt)} geändert, ` +
            `nachdem du ihn geöffnet hast.\n\nOK = trotzdem mit deiner Version überschreiben\nAbbrechen = neuere Version laden (deine Änderungen gehen dabei verloren)`
        );
        if (!proceed) {
          editingContact = { ...blankContact(), ...serverData };
          editingBaselineUpdatedAt = serverData.updatedAt;
          fillEditorFields(editingContact);
          document.getElementById("lastEditedLine").textContent = `Zuletzt geändert: ${updatedInfoText(editingContact)}`;
          resultEl.textContent = "Neuere Version geladen. Bitte Änderungen erneut vornehmen.";
          resultEl.className = "test-result err";
          return;
        }
      }
    } else {
      filename = `${uid()}.json`;
    }

    editingContact.updatedAt = new Date().toISOString();
    editingContact.updatedBy = personName();
    await putJsonFile(adressenSegments(), filename, editingContact);

    const idx = contacts.findIndex((c) => c.filename === filename);
    if (idx >= 0) contacts[idx] = { filename, data: editingContact };
    else contacts.push({ filename, data: editingContact });
    saveJSON(LS_KEYS.contactsCache, contacts);

    editingFilename = filename;
    editingBaselineUpdatedAt = editingContact.updatedAt;
    document.getElementById("lastEditedLine").textContent = `Zuletzt geändert: ${updatedInfoText(editingContact)}`;
    resultEl.textContent = "Gespeichert.";
    resultEl.className = "test-result ok";
    renderAll();
  } catch (err) {
    resultEl.textContent = "Fehler: " + err.message;
    resultEl.className = "test-result err";
  }
}

async function deleteContact() {
  if (!editingFilename) {
    closeEditor();
    return;
  }
  const label = `${editingContact.vorname || ""} ${editingContact.name || editingContact.firma || ""}`.trim();
  if (!confirm(`Kontakt "${label}" wirklich löschen?`)) return;
  try {
    await deleteJsonFile(adressenSegments(), editingFilename);
    contacts = contacts.filter((c) => c.filename !== editingFilename);
    saveJSON(LS_KEYS.contactsCache, contacts);
    closeEditor();
    renderAll();
  } catch (err) {
    alert("Löschen fehlgeschlagen: " + err.message);
  }
}

// ---------- CSV-Import ----------

// Einfacher RFC4180-Parser (Anführungszeichen, "" als Escape, Kommas/
// Zeilenumbrüche innerhalb von Anführungszeichen).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const CSV_FIELD_MAP = {
  kategorie: "kategorie", status: "status", vorname: "vorname", name: "name",
  firma: "firma", strasse: "strasse", ort: "ort", tel: "tel", mail: "mail",
  website: "website", bemerkungen: "bemerkungen", projekte: "projekte",
  weihnachtskarte: "weihnachtskarte"
};

async function importCsvFile(file) {
  const statusEl = document.getElementById("importResult");
  statusEl.textContent = "Lese Datei…";
  statusEl.className = "test-result";
  const text = await file.text();
  return importCsvText(text);
}

async function importCsvText(text) {
  const statusEl = document.getElementById("importResult");
  try {
    const rows = parseCsv(text);
    const headerRowIdx = rows.findIndex((r) => r.some((f) => f.trim().toLowerCase() === "kategorie"));
    if (headerRowIdx === -1) throw new Error('Kopfzeile mit "Kategorie" nicht gefunden.');
    const header = rows[headerRowIdx].map((h) => h.trim().toLowerCase());
    const dataRows = rows.slice(headerRowIdx + 1);

    await ensureAdressenFolder();
    let imported = 0;
    for (const r of dataRows) {
      const contact = blankContact();
      header.forEach((h, i) => {
        const field = CSV_FIELD_MAP[h];
        if (!field) return;
        const raw = (r[i] || "").trim();
        contact[field] = field === "weihnachtskarte" ? raw.toLowerCase() === "ja" : raw;
      });
      if (!contact.name && !contact.vorname && !contact.firma) continue;
      contact.updatedAt = new Date().toISOString();
      contact.updatedBy = personName() || "CSV-Import";
      const filename = `${uid()}.json`;
      await putJsonFile(adressenSegments(), filename, contact);
      imported++;
    }
    statusEl.textContent = `${imported} Einträge importiert.`;
    statusEl.className = "test-result ok";
    await refreshContacts();
  } catch (err) {
    statusEl.textContent = "Import fehlgeschlagen: " + err.message;
    statusEl.className = "test-result err";
  }
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: pingRelPath,
    ensureFolderFn: ensureAdressenFolder,
    onSaved: refreshContacts
  });

  document.getElementById("refreshBtn").addEventListener("click", refreshContacts);
  document.getElementById("newContactBtn").addEventListener("click", () => openEditor(null));
  document.getElementById("closeEditor").addEventListener("click", closeEditor);
  document.getElementById("saveContactBtn").addEventListener("click", saveContact);
  document.getElementById("deleteContactBtn").addEventListener("click", deleteContact);

  document.getElementById("viewSelect").addEventListener("change", (e) => applyView(e.target.value || null));
  document.getElementById("saveViewBtn").addEventListener("click", saveCurrentView);
  document.getElementById("deleteViewBtn").addEventListener("click", deleteCurrentView);

  document.getElementById("csvImportInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importCsvFile(file);
    e.target.value = "";
  });

  renderAll();
  refreshContacts();
}

init();
