/* ============================================================
   Zeitplanung — horizontaler Zeitbalken (Gantt-artig), Fenster immer
   "heute .. heute + 1 Jahr" (rollend, nicht ein festes Kalenderjahr).

   Zeilen von oben nach unten:
   - Mitarbeitende (aus ../shared/personen.json) -- hier werden Ferien/Frei
     eingetragen (immer grau dargestellt). Jeder Tag, an dem mindestens eine
     Person "Frei"/"Ferien" hat, wird als heller grauer Streifen über ALLE
     Zeilen gelegt (siehe renderVacationOverlay()) -- je mehr Personen frei
     haben, desto dunkler der Streifen.
   - Projekte (aus der zentral verwalteten Projektliste, siehe
     zeiterfassung/app.js) -- aufklappbar, die Projektzeile selbst zeigt als
     Übersicht alle Balken/Meilensteine ihrer Aufgaben zusammen.
     - Aufgaben (frei benannt) -- je Aufgabe eine eigene Zeile, darin
       beliebig viele Balken (Start+Ende) und/oder Meilensteine (ein Datum,
       als dicker Punkt) hintereinander.

   Balken/Meilensteine sind direkt mit der Maus verschiebbar (ganzer Balken)
   bzw. an den Enden ziehbar (Start/Ende einzeln) -- ein Klick ohne Ziehen
   öffnet stattdessen den Bearbeiten-Dialog mit Datumsfeldern.

   Rein browserbasiert (kein PDF-Export). Speicherung: EINE gemeinsame Datei
   auf Nextcloud (wie bei den Pendenzen), siehe ZEITPLANUNG_TARGET_FOLDER_PATH.
   Bewusst ohne Feld-Merge beim Speichern (anders als Offerten/Adressliste)
   -- letzter Speicherstand gewinnt, siehe README "Bekannte Grenzen".

   Nextcloud-Login, proxyFetch/authHeader/davPath, Einstellungen-UI usw.
   kommen aus ../shared/common.js.
   ============================================================ */

const LS_KEYS = {
  cache: "zeitplanung_cache",
  projectsCache: "zeitplanung_projects_cache"
};

const ZEITPLANUNG_TARGET_FOLDER_PATH = "Buero/Admin/Zeitplanung";
const ZEITPLANUNG_FILENAME = "zeitplanung.json";

// Gleiche zentrale Projektliste wie Zeiterfassung/Pendenzen (siehe dort für
// die Begründung der Dopplung) -- Projekte werden hier wie dort über den
// NAMEN identifiziert/eingefärbt, nicht über die Nummer (siehe README,
// "Projektnamen zentral verwalten").
const PROJECTS_SHARE_TOKEN = "cRyoZG6fzBQYDeH";
const PROJECT_COLOR_PALETTE = ["#4F7089", "#8F9A85", "#C97960", "#626F68", "#8C8171", "#7A95A6"];
const VACATION_COLOR = "#B7AFA0";

const DAY_MS = 86400000;
const DAY_WIDTH = 8; // px pro Tag
const LABEL_WIDTH = 200; // px, sticky linke Spalte

function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function projectColor(name) {
  if (!name) return "#8C8171";
  return PROJECT_COLOR_PALETTE[stringHash(name) % PROJECT_COLOR_PALETTE.length];
}

function blankZeitplan() {
  return {
    mitarbeiterEintraege: {}, // { [personKey]: [{id,titel,start,ende}] }
    projekte: [], // [{id,titel,aufgeklappt,aufgaben:[{id,titel,eintraege:[{id,typ,titel,start,ende}]}]}]
    updatedAt: null,
    updatedBy: null
  };
}

let zeitplan = loadJSON(LS_KEYS.cache, blankZeitplan());
let personen = [];
let projectNames = loadJSON(LS_KEYS.projectsCache, []); // Namen aus der zentralen Liste, für "+ Projekt"

let rangeStartDate, rangeEndDate, totalDays, totalWidth;

let editingEntryLocation = null;
let editingEntryId = null;

// ---------- Datum-Helfer ----------

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function daysBetween(a, b) {
  return Math.round((b - a) / DAY_MS);
}
function clampToRange(d) {
  if (d < rangeStartDate) return new Date(rangeStartDate);
  if (d > rangeEndDate) return new Date(rangeEndDate);
  return d;
}
function dateToX(iso) {
  return daysBetween(rangeStartDate, parseISO(iso)) * DAY_WIDTH;
}
function computeRange() {
  const now = new Date();
  rangeStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  rangeEndDate = addDays(rangeStartDate, 365);
  totalDays = 366;
  totalWidth = totalDays * DAY_WIDTH;
}

function isFreiTitle(titel) {
  return /^(frei|ferien)$/i.test((titel || "").trim());
}

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
    projectNames = [...new Set(list.map((p) => p.name))];
    saveJSON(LS_KEYS.projectsCache, projectNames);
    renderAll();
  } catch (err) {
    console.warn("Zentrale Projektnamen konnten nicht geladen werden:", err);
  }
}

async function loadPersonen() {
  try {
    const res = await fetch("../shared/personen.json");
    personen = res.ok ? await res.json() : [];
  } catch (e) {
    personen = [];
  }
}

// ---------- Nextcloud ----------

function zeitplanungSegments() {
  return ncSegments(ZEITPLANUNG_TARGET_FOLDER_PATH);
}
function ensureZeitplanungFolder() {
  return ensureFolderPath(zeitplanungSegments());
}
function pingRelPath() {
  return davPath([...zeitplanungSegments(), "_ping"].join("/"));
}

async function fetchZeitplanFile() {
  const relPath = davPath([...zeitplanungSegments(), ZEITPLANUNG_FILENAME].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function putZeitplanFile(data) {
  const relPath = davPath([...zeitplanungSegments(), ZEITPLANUNG_FILENAME].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

async function refreshZeitplan() {
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
    await ensureZeitplanungFolder();
    const data = await fetchZeitplanFile();
    if (data) {
      zeitplan = data;
      saveJSON(LS_KEYS.cache, zeitplan);
    }
    line.textContent = "Synchronisiert";
  } catch (err) {
    console.warn("Zeitplanung konnte nicht geladen werden:", err);
    line.textContent = "Fehler beim Laden · zeige zuletzt geladenen Stand";
  }
  renderAll();
}

// Bewusst kein Feld-/Item-Merge wie bei Offerten/Pendenzen -- letzter
// Speicherstand gewinnt (siehe README, "Bekannte Grenzen"). Änderungen
// (auch beim Ziehen eines Balkens) werden erst am ENDE einer Aktion
// synchronisiert, nicht während jeder Zwischenposition.
async function scheduleSync() {
  saveJSON(LS_KEYS.cache, zeitplan);
  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    return;
  }
  if (!navigator.onLine) {
    line.textContent = "Offline · Änderungen nur lokal gespeichert";
    return;
  }
  line.textContent = "Speichert…";
  try {
    await ensureZeitplanungFolder();
    zeitplan.updatedAt = new Date().toISOString();
    zeitplan.updatedBy = personName();
    await putZeitplanFile(zeitplan);
    line.textContent = "Gespeichert";
  } catch (err) {
    console.warn("Zeitplanung konnte nicht gespeichert werden:", err);
    line.textContent = "Fehler beim Speichern";
  }
}

// ---------- Daten-Helfer ----------

function resolveEintraegeArray(loc) {
  if (loc.type === "mitarbeiter") {
    if (!zeitplan.mitarbeiterEintraege[loc.key]) zeitplan.mitarbeiterEintraege[loc.key] = [];
    return zeitplan.mitarbeiterEintraege[loc.key];
  }
  const proj = zeitplan.projekte.find((p) => p.id === loc.projektId);
  const aufgabe = proj.aufgaben.find((a) => a.id === loc.aufgabeId);
  return aufgabe.eintraege;
}

// ---------- Rendering ----------

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function renderHeader() {
  const track = document.getElementById("tpHeaderTrack");
  track.style.width = totalWidth + "px";
  const ticks = [];
  let d = new Date(rangeStartDate.getFullYear(), rangeStartDate.getMonth(), 1);
  if (d < rangeStartDate) d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  while (d <= rangeEndDate) {
    ticks.push(new Date(d));
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  track.innerHTML = ticks
    .map((m) => {
      const x = daysBetween(rangeStartDate, m) * DAY_WIDTH;
      return `<div class="tp-month-tick" style="left:${x}px"><span class="tp-month-label">${MONTHS[m.getMonth()]} ${m.getFullYear()}</span></div>`;
    })
    .join("");
}

function renderEntryHtml(entry, loc, color) {
  const locAttr = escapeHtml(JSON.stringify(loc));
  const titleAttr = escapeHtml(entry.titel || "");
  if (entry.typ === "meilenstein") {
    const x = dateToX(entry.start);
    return `<div class="tp-milestone" style="left:${x - 7}px; background:${color};" data-entry-id="${entry.id}" data-loc='${locAttr}' title="${titleAttr}"></div>
      <div class="tp-milestone-label" style="left:${x + 9}px;">${titleAttr}</div>`;
  }
  const x = dateToX(entry.start);
  const w = Math.max(DAY_WIDTH, (daysBetween(parseISO(entry.start), parseISO(entry.ende)) + 1) * DAY_WIDTH);
  return `<div class="tp-bar" style="left:${x}px; width:${w}px; background:${color};" data-entry-id="${entry.id}" data-loc='${locAttr}'>
    <span class="tp-bar-handle" data-handle="left"></span>
    <span class="tp-bar-label">${titleAttr}</span>
    <span class="tp-bar-handle" data-handle="right"></span>
  </div>`;
}

function renderRowHtml({ labelHtml, addLoc, items, indent, summary }) {
  const trackHtml = items.map(({ entry, loc, color }) => renderEntryHtml(entry, loc, color)).join("");
  const addBtn = addLoc
    ? `<button type="button" class="tp-add-entry-btn" data-loc='${escapeHtml(JSON.stringify(addLoc))}' title="Balken/Meilenstein hinzufügen">+</button>`
    : "";
  return `<div class="tp-row${indent ? " tp-row-indent" : ""}${summary ? " tp-row-summary" : ""}">
    <div class="tp-label-cell">${labelHtml}${addBtn}</div>
    <div class="tp-track" style="width:${totalWidth}px">${trackHtml}</div>
  </div>`;
}

function projectRowLabelHtml(proj) {
  const arrow = proj.aufgeklappt ? "▾" : "▸";
  return `<button type="button" class="tp-toggle-btn" data-action="toggle-projekt" data-projekt="${proj.id}" title="${proj.aufgeklappt ? "Zuklappen" : "Aufklappen"}">${arrow}</button>
    <span class="tp-row-title tp-row-title-strong">${escapeHtml(proj.titel)}</span>
    <button type="button" class="tp-delete-btn" data-action="delete-projekt" data-projekt="${proj.id}" title="Projekt aus der Zeitplanung entfernen">×</button>`;
}
function aufgabeRowLabelHtml(proj, aufgabe) {
  return `<span class="tp-row-title" data-action="rename-aufgabe" data-projekt="${proj.id}" data-aufgabe="${aufgabe.id}" title="Klicken zum Umbenennen">${escapeHtml(aufgabe.titel)}</span>
    <button type="button" class="tp-delete-btn" data-action="delete-aufgabe" data-projekt="${proj.id}" data-aufgabe="${aufgabe.id}" title="Aufgabe entfernen">×</button>`;
}

function renderRows() {
  const container = document.getElementById("tpRows");
  let html = "";

  html += `<div class="tp-section-label">Mitarbeitende</div>`;
  personen.forEach((p) => {
    const loc = { type: "mitarbeiter", key: p.key };
    const eintraege = zeitplan.mitarbeiterEintraege[p.key] || [];
    html += renderRowHtml({
      labelHtml: `<span class="tp-row-title">${escapeHtml(p.name)}</span>`,
      addLoc: loc,
      items: eintraege.map((entry) => ({ entry, loc, color: VACATION_COLOR }))
    });
  });

  html += `<div class="tp-section-label">Projekte</div>`;
  zeitplan.projekte.forEach((proj) => {
    const color = projectColor(proj.titel);
    const summaryItems = proj.aufgaben.flatMap((a) =>
      a.eintraege.map((entry) => ({ entry, loc: { type: "aufgabe", projektId: proj.id, aufgabeId: a.id }, color }))
    );
    html += renderRowHtml({ labelHtml: projectRowLabelHtml(proj), items: summaryItems, summary: true });

    if (proj.aufgeklappt) {
      proj.aufgaben.forEach((aufgabe) => {
        const loc = { type: "aufgabe", projektId: proj.id, aufgabeId: aufgabe.id };
        html += renderRowHtml({
          labelHtml: aufgabeRowLabelHtml(proj, aufgabe),
          addLoc: loc,
          items: aufgabe.eintraege.map((entry) => ({ entry, loc, color })),
          indent: true
        });
      });
      html += `<div class="tp-row tp-row-indent tp-add-row">
        <div class="tp-label-cell"><button type="button" class="tp-link-btn" data-action="add-aufgabe" data-projekt="${proj.id}">+ Aufgabe</button></div>
        <div class="tp-track" style="width:${totalWidth}px"></div>
      </div>`;
    }
  });

  const already = new Set(zeitplan.projekte.map((p) => p.titel));
  const remaining = projectNames.filter((name) => !already.has(name));
  html += `<div class="tp-row tp-add-row">
    <div class="tp-label-cell">
      <select id="addProjektSelect">
        <option value="">+ Projekt hinzufügen…</option>
        ${remaining.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}
      </select>
    </div>
    <div class="tp-track" style="width:${totalWidth}px"></div>
  </div>`;

  container.innerHTML = html;
}

function renderVacationOverlay() {
  const layer = document.getElementById("tpVacationLayer");
  layer.style.width = totalWidth + "px";

  const counts = new Array(totalDays).fill(0);
  personen.forEach((p) => {
    (zeitplan.mitarbeiterEintraege[p.key] || []).forEach((e) => {
      if (!isFreiTitle(e.titel)) return;
      const s = clampToRange(parseISO(e.start));
      const en = clampToRange(parseISO(e.ende || e.start));
      const startIdx = daysBetween(rangeStartDate, s);
      const endIdx = daysBetween(rangeStartDate, en);
      for (let d = startIdx; d <= endIdx; d++) counts[d]++;
    });
  });

  const totalPersonen = Math.max(personen.length, 1);
  const runs = [];
  let cur = null;
  for (let d = 0; d < totalDays; d++) {
    const c = counts[d];
    if (c === 0) {
      if (cur) { runs.push(cur); cur = null; }
      continue;
    }
    if (cur && cur.count === c) cur.end = d;
    else { if (cur) runs.push(cur); cur = { start: d, end: d, count: c }; }
  }
  if (cur) runs.push(cur);

  layer.innerHTML = runs
    .map((r) => {
      const alpha = Math.min(0.16 * r.count, 0.6);
      const x = r.start * DAY_WIDTH;
      const w = (r.end - r.start + 1) * DAY_WIDTH;
      return `<div class="tp-vacation-stripe" style="left:${x}px; width:${w}px; background:rgba(60,50,40,${alpha});" title="${r.count} von ${totalPersonen} frei/Ferien"></div>`;
    })
    .join("");
}

function renderAll() {
  computeRange();
  renderHeader();
  renderRows();
  renderVacationOverlay();
}

// ---------- Bearbeiten-Dialog (Balken/Meilenstein) ----------

function applyEntryTypVisibility() {
  const typ = document.getElementById("entryTyp").value;
  document.getElementById("entryEndeGroup").style.display = typ === "meilenstein" ? "none" : "";
}

function openEntryDialog(loc, entryId) {
  editingEntryLocation = loc;
  editingEntryId = entryId || null;
  const entry = entryId ? resolveEintraegeArray(loc).find((e) => e.id === entryId) : null;

  document.getElementById("entryDialogTitle").textContent = entryId ? "Eintrag bearbeiten" : "Neuer Eintrag";
  document.getElementById("entryTitel").value = entry ? entry.titel : (loc.type === "mitarbeiter" ? "Ferien" : "");
  document.getElementById("entryTyp").value = entry ? entry.typ : "balken";
  document.getElementById("entryStart").value = entry ? entry.start : toISO(new Date());
  document.getElementById("entryEnde").value = entry ? entry.ende || entry.start : toISO(addDays(new Date(), 6));
  applyEntryTypVisibility();
  document.getElementById("deleteEntryBtn").style.display = entryId ? "" : "none";
  document.getElementById("entryResult").textContent = "";
  document.getElementById("entryOverlay").classList.remove("hidden");
}

function closeEntryDialog() {
  document.getElementById("entryOverlay").classList.add("hidden");
  editingEntryLocation = null;
  editingEntryId = null;
}

function saveEntryDialog() {
  const resultEl = document.getElementById("entryResult");
  const titel = document.getElementById("entryTitel").value.trim();
  const typ = document.getElementById("entryTyp").value;
  const start = document.getElementById("entryStart").value;
  let ende = typ === "meilenstein" ? start : document.getElementById("entryEnde").value || start;

  if (!titel) { resultEl.textContent = "Bitte einen Titel angeben."; resultEl.className = "test-result err"; return; }
  if (!start) { resultEl.textContent = "Bitte ein Startdatum angeben."; resultEl.className = "test-result err"; return; }
  if (typ === "balken" && ende < start) { resultEl.textContent = "Ende darf nicht vor Start liegen."; resultEl.className = "test-result err"; return; }

  const arr = resolveEintraegeArray(editingEntryLocation);
  if (editingEntryId) {
    const e = arr.find((x) => x.id === editingEntryId);
    Object.assign(e, { titel, typ, start, ende });
  } else {
    arr.push({ id: uid(), titel, typ, start, ende });
  }
  closeEntryDialog();
  renderAll();
  scheduleSync();
}

function deleteEntryDialog() {
  const arr = resolveEintraegeArray(editingEntryLocation);
  const idx = arr.findIndex((x) => x.id === editingEntryId);
  if (idx >= 0) arr.splice(idx, 1);
  closeEntryDialog();
  renderAll();
  scheduleSync();
}

// ---------- Verschieben/Grösse ändern per Maus/Touch ----------

function onRowsPointerDown(e) {
  const bar = e.target.closest(".tp-bar, .tp-milestone");
  if (!bar) return;
  e.preventDefault();

  const loc = JSON.parse(bar.dataset.loc);
  const entryId = bar.dataset.entryId;
  const arr = resolveEintraegeArray(loc);
  const entry = arr.find((x) => x.id === entryId);
  if (!entry) return;

  const handleEl = e.target.closest("[data-handle]");
  const mode = entry.typ === "meilenstein" ? "move" : handleEl ? handleEl.dataset.handle : "move";
  const startX = e.clientX;
  const originalStart = entry.start;
  const originalEnde = entry.ende;
  const durationDays = daysBetween(parseISO(originalStart), parseISO(originalEnde));
  let moved = false;

  const onMove = (ev) => {
    const deltaDays = Math.round((ev.clientX - startX) / DAY_WIDTH);
    if (deltaDays !== 0) moved = true;

    if (mode === "move") {
      const newStart = clampToRange(addDays(parseISO(originalStart), deltaDays));
      entry.start = toISO(newStart);
      entry.ende = entry.typ === "meilenstein" ? entry.start : toISO(addDays(newStart, durationDays));
    } else if (mode === "left") {
      let newStart = addDays(parseISO(originalStart), deltaDays);
      if (newStart > parseISO(originalEnde)) newStart = parseISO(originalEnde);
      entry.start = toISO(clampToRange(newStart));
    } else if (mode === "right") {
      let newEnde = addDays(parseISO(originalEnde), deltaDays);
      if (newEnde < parseISO(entry.start)) newEnde = parseISO(entry.start);
      entry.ende = toISO(clampToRange(newEnde));
    }

    const x = dateToX(entry.start);
    if (entry.typ === "meilenstein") {
      bar.style.left = x - 7 + "px";
    } else {
      bar.style.left = x + "px";
      bar.style.width = Math.max(DAY_WIDTH, (daysBetween(parseISO(entry.start), parseISO(entry.ende)) + 1) * DAY_WIDTH) + "px";
    }
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (moved) {
      renderAll();
      scheduleSync();
    } else if (!handleEl) {
      openEntryDialog(loc, entryId);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function onRowsClick(e) {
  const addBtn = e.target.closest(".tp-add-entry-btn");
  if (addBtn) {
    openEntryDialog(JSON.parse(addBtn.dataset.loc), null);
    return;
  }
  const toggleBtn = e.target.closest('[data-action="toggle-projekt"]');
  if (toggleBtn) {
    const proj = zeitplan.projekte.find((p) => p.id === toggleBtn.dataset.projekt);
    proj.aufgeklappt = !proj.aufgeklappt;
    renderAll();
    scheduleSync();
    return;
  }
  const addAufgabeBtn = e.target.closest('[data-action="add-aufgabe"]');
  if (addAufgabeBtn) {
    const titel = prompt("Titel der neuen Aufgabe:");
    if (!titel || !titel.trim()) return;
    const proj = zeitplan.projekte.find((p) => p.id === addAufgabeBtn.dataset.projekt);
    proj.aufgaben.push({ id: uid(), titel: titel.trim(), eintraege: [] });
    renderAll();
    scheduleSync();
    return;
  }
  const renameBtn = e.target.closest('[data-action="rename-aufgabe"]');
  if (renameBtn) {
    const proj = zeitplan.projekte.find((p) => p.id === renameBtn.dataset.projekt);
    const aufgabe = proj.aufgaben.find((a) => a.id === renameBtn.dataset.aufgabe);
    const neu = prompt("Titel der Aufgabe:", aufgabe.titel);
    if (neu && neu.trim()) {
      aufgabe.titel = neu.trim();
      renderAll();
      scheduleSync();
    }
    return;
  }
  const deleteAufgabeBtn = e.target.closest('[data-action="delete-aufgabe"]');
  if (deleteAufgabeBtn) {
    if (!confirm("Aufgabe wirklich löschen (inkl. aller Balken/Meilensteine)?")) return;
    const proj = zeitplan.projekte.find((p) => p.id === deleteAufgabeBtn.dataset.projekt);
    proj.aufgaben = proj.aufgaben.filter((a) => a.id !== deleteAufgabeBtn.dataset.aufgabe);
    renderAll();
    scheduleSync();
    return;
  }
  const deleteProjektBtn = e.target.closest('[data-action="delete-projekt"]');
  if (deleteProjektBtn) {
    if (!confirm("Projekt wirklich aus der Zeitplanung entfernen (inkl. aller Aufgaben)?")) return;
    zeitplan.projekte = zeitplan.projekte.filter((p) => p.id !== deleteProjektBtn.dataset.projekt);
    renderAll();
    scheduleSync();
    return;
  }
}

function onRowsChange(e) {
  if (e.target.id === "addProjektSelect" && e.target.value) {
    zeitplan.projekte.push({ id: uid(), titel: e.target.value, aufgeklappt: true, aufgaben: [] });
    renderAll();
    scheduleSync();
  }
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: pingRelPath,
    ensureFolderFn: ensureZeitplanungFolder,
    onSaved: refreshZeitplan
  });

  document.getElementById("tpRows").addEventListener("pointerdown", onRowsPointerDown);
  document.getElementById("tpRows").addEventListener("click", onRowsClick);
  document.getElementById("tpRows").addEventListener("change", onRowsChange);

  document.getElementById("closeEntryDialog").addEventListener("click", closeEntryDialog);
  document.getElementById("cancelEntryBtn").addEventListener("click", closeEntryDialog);
  document.getElementById("saveEntryBtn").addEventListener("click", saveEntryDialog);
  document.getElementById("deleteEntryBtn").addEventListener("click", deleteEntryDialog);
  document.getElementById("entryTyp").addEventListener("change", applyEntryTypVisibility);
  document.getElementById("refreshBtn").addEventListener("click", refreshZeitplan);

  window.addEventListener("online", refreshZeitplan);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { refreshZeitplan(); refreshProjectNames(); }
  });
  setInterval(refreshProjectNames, 60000);

  Promise.all([loadPersonen(), refreshProjectNames()]).then(renderAll);
  if (isConfigured()) refreshZeitplan();
  else renderAll();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
