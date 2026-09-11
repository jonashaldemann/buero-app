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

   Filter-Ansichten (Spaltenauswahl, Filter, Sortierung) lassen sich
   unter einem Namen speichern -- diese liegen zentral in einer
   einzigen Datei (_ansichten.json) im selben Nextcloud-Ordner, damit
   beide Personen dieselben Ansichten sehen.

   Nextcloud-Login, proxyFetch/authHeader/davPath, chNumber usw. kommen
   aus ../shared/common.js (gemeinsam mit Zeiterfassung, Quittung,
   Wettbewerbsprogrammen und Offerten).
   ============================================================ */

const LS_KEYS = {
  contactsCache: "adressliste_cache",
  viewsCache: "adressliste_views_cache"
};

const ADRESSEN_TARGET_FOLDER_PATH = "Buero/Admin/Adressen";
const VIEWS_FILENAME = "_ansichten.json";

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

function blankView() {
  return {
    id: null,
    name: "",
    columns: [...DEFAULT_COLUMNS],
    filters: { suche: "", kategorie: "", status: "", weihnachtskarte: "" },
    sort: { field: "name", dir: "asc" }
  };
}

// { filename, data } -- data ist das geparste JSON eines Kontakts.
let contacts = loadJSON(LS_KEYS.contactsCache, []);
let views = loadJSON(LS_KEYS.viewsCache, []);

let currentView = blankView();
let activeViewId = null; // null = nicht gespeicherte/angepasste Ansicht

// Aktuell im Editor offene Kontakt-Arbeitskopie, ihr Dateiname (null = neu)
// und der updatedAt-Stand beim Öffnen (für die Konflikt-Prüfung beim Speichern).
let editingContact = null;
let editingFilename = null;
let editingBaselineUpdatedAt = null;

// ---------- Nextcloud: Ordner/Dateien ----------

function adressenSegments() {
  return ncSegments(ADRESSEN_TARGET_FOLDER_PATH);
}
function ensureAdressenFolder() {
  return ensureFolderPath(adressenSegments());
}
function pingRelPath() {
  return davPath([...adressenSegments(), "_ping"].join("/"));
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';

async function listContactFilenames() {
  const relPath = davPath(adressenSegments().join("/") + "/");
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
    .filter((name) => name.toLowerCase().endsWith(".json") && name !== VIEWS_FILENAME);
}

async function fetchJsonFile(filename) {
  const relPath = davPath([...adressenSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${filename}: Status ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function putJsonFile(filename, data) {
  const relPath = davPath([...adressenSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

async function deleteJsonFile(filename) {
  const relPath = davPath([...adressenSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "DELETE", headers: authHeader() });
  if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
}

// ---------- Laden ----------

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
    const [filenames, viewsData] = await Promise.all([listContactFilenames(), fetchJsonFile(VIEWS_FILENAME)]);
    const loaded = await Promise.all(
      filenames.map(async (filename) => {
        try {
          const data = await fetchJsonFile(filename);
          return data ? { filename, data } : null;
        } catch (err) {
          console.warn("Konnte Kontakt nicht laden:", filename, err);
          return null;
        }
      })
    );
    contacts = loaded.filter(Boolean);
    views = Array.isArray(viewsData) ? viewsData : [];
    saveJSON(LS_KEYS.contactsCache, contacts);
    saveJSON(LS_KEYS.viewsCache, views);
    line.textContent = `Synchronisiert · ${contacts.length} Einträge`;
  } catch (err) {
    console.warn("Adressen konnten nicht geladen werden:", err);
    line.textContent = "Fehler beim Laden · zeige zuletzt geladenen Stand";
  }
  renderAll();
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

function distinctValues(key) {
  const set = new Set();
  contacts.forEach((c) => {
    const v = (c.data[key] || "").trim();
    if (v) set.add(v);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
}

function matchesFilters(data) {
  const f = currentView.filters;
  if (f.kategorie && data.kategorie !== f.kategorie) return false;
  if (f.status && data.status !== f.status) return false;
  if (f.weihnachtskarte === "ja" && !data.weihnachtskarte) return false;
  if (f.weihnachtskarte === "nein" && data.weihnachtskarte) return false;
  if (f.suche) {
    const needle = f.suche.trim().toLowerCase();
    if (needle) {
      const haystack = ["name", "vorname", "firma", "ort", "bemerkungen", "projekte"]
        .map((k) => (data[k] || "").toLowerCase())
        .join(" ");
      if (!haystack.includes(needle)) return false;
    }
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
  renderFilterBar();
  renderColumnToggles();
  renderViewsSelect();
  renderList();
}

function renderFilterBar() {
  const kategorieSel = document.getElementById("filterKategorie");
  const statusSel = document.getElementById("filterStatus");
  const xmasSel = document.getElementById("filterWeihnachtskarte");
  const searchInput = document.getElementById("filterSuche");

  const fillOptions = (sel, values, current) => {
    sel.innerHTML =
      '<option value="">Alle</option>' +
      values.map((v) => `<option value="${escapeHtml(v)}" ${v === current ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
  };
  fillOptions(kategorieSel, distinctValues("kategorie"), currentView.filters.kategorie);
  fillOptions(statusSel, distinctValues("status"), currentView.filters.status);
  xmasSel.value = currentView.filters.weihnachtskarte || "";
  if (document.activeElement !== searchInput) searchInput.value = currentView.filters.suche || "";
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
      }
      renderList();
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

function renderList() {
  const cols = COLUMNS.filter((c) => currentView.columns.includes(c.key));
  const thead = document.getElementById("listHead");
  thead.innerHTML =
    cols.map((c) => {
      const sorted = currentView.sort.field === c.key;
      const arrow = sorted ? (currentView.sort.dir === "desc" ? " ↓" : " ↑") : "";
      return `<th data-sort="${c.key}" class="sortable">${escapeHtml(c.label)}${arrow}</th>`;
    }).join("") + "<th></th>";
  thead.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (currentView.sort.field === key) {
        currentView.sort.dir = currentView.sort.dir === "asc" ? "desc" : "asc";
      } else {
        currentView.sort = { field: key, dir: "asc" };
      }
      renderList();
    });
  });

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

async function saveViewsFile() {
  await putJsonFile(VIEWS_FILENAME, views);
  saveJSON(LS_KEYS.viewsCache, views);
}

async function saveCurrentView() {
  const suggested = views.find((v) => v.id === activeViewId)?.name || "";
  const name = prompt("Name der Ansicht:", suggested);
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  try {
    // Frisch laden, damit eine zwischenzeitlich von der anderen Person
    // gespeicherte Ansicht nicht überschrieben wird.
    const fresh = await fetchJsonFile(VIEWS_FILENAME);
    views = Array.isArray(fresh) ? fresh : [];
    const existing = views.find((v) => v.name.toLowerCase() === trimmed.toLowerCase());
    if (existing && existing.id !== activeViewId) {
      if (!confirm(`Es gibt schon eine Ansicht "${trimmed}". Überschreiben?`)) return;
    }
    const target = existing || views.find((v) => v.id === activeViewId);
    const entry = {
      id: target?.id || uid(),
      name: trimmed,
      columns: [...currentView.columns],
      filters: { ...currentView.filters },
      sort: { ...currentView.sort }
    };
    if (target) {
      views = views.map((v) => (v.id === target.id ? entry : v));
    } else {
      views.push(entry);
    }
    await saveViewsFile();
    activeViewId = entry.id;
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
    const fresh = await fetchJsonFile(VIEWS_FILENAME);
    views = (Array.isArray(fresh) ? fresh : []).filter((v) => v.id !== view.id);
    await saveViewsFile();
    activeViewId = null;
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
      filters: { suche: "", kategorie: "", status: "", weihnachtskarte: "", ...v.filters },
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
    const fresh = isConfigured() && navigator.onLine ? await fetchJsonFile(filename) : null;
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
      const serverData = await fetchJsonFile(filename);
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
    await putJsonFile(filename, editingContact);

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
    await deleteJsonFile(editingFilename);
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
      await putJsonFile(filename, contact);
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

  document.getElementById("filterSuche").addEventListener("input", (e) => {
    currentView.filters.suche = e.target.value;
    renderList();
  });
  document.getElementById("filterKategorie").addEventListener("change", (e) => {
    currentView.filters.kategorie = e.target.value;
    renderList();
  });
  document.getElementById("filterStatus").addEventListener("change", (e) => {
    currentView.filters.status = e.target.value;
    renderList();
  });
  document.getElementById("filterWeihnachtskarte").addEventListener("change", (e) => {
    currentView.filters.weihnachtskarte = e.target.value;
    renderList();
  });

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
