/* ============================================================
   Finanzplanung — Liquiditätsplanung pro Kalenderjahr (nicht rollend wie
   die Timeline, sondern ein festes Jahr nach dem anderen, per < Jahr >
   umschaltbar).

   Jedes Jahr ist eine eigene JSON-Datei auf Nextcloud
   (Buero/Admin/App/Finanzplanung/<Jahr>.json) -- ein Jahr ist eine in sich
   geschlossene Einheit, deshalb keine gemeinsame Datei wie bei den
   Pendenzen und keine Merge-Logik über Jahre hinweg nötig.

   Vier Kategorien von Zeilen:
   - Ausgaben (monatlich): EIN Betrag pro Zeile, gilt für alle 12 Monate
     gleich -- Klick auf irgendeine Monatszelle ändert ihn (für die ganze
     Zeile auf einmal).
   - Ausgaben (einmalig), Einnahmen, Auszahlungen: Betrag pro einzelnem
     Monat. Klick auf eine Monatszelle markiert sie (Toggle); bei
     mindestens einer markierten Zelle erscheint darunter eine Eingabezeile
     ("Übernehmen"), die den eingegebenen Betrag auf alle markierten Monate
     dieser Zeile schreibt.

   Beträge werden immer POSITIV eingegeben -- ob ein Betrag den Saldo
   erhöht oder verringert, ergibt sich allein aus der Kategorie
   (SECTIONS[].vorzeichen), siehe berechneSalden().

   Speichern: wie bei den Offerten (updateOfferStatus() in
   offerten/app.js) -- jede Änderung wird als reine Funktion (mutateFn)
   sowohl sofort auf den lokalen Stand (optimistisch, fürs UI) als auch,
   seriell in einer Warteschlange, auf einen frisch vom Server geholten
   Stand angewendet. Zwei Geräte, die kurz nacheinander je eine andere
   Änderung am selben Jahr speichern, überschreiben sich so nicht
   gegenseitig (kein Vergleichs-/Konflikt-Dialog nötig, da mutateFn gezielt
   nur die eine Teiländerung nachträgt statt den ganzen Stand zu
   überschreiben).

   Nextcloud-Login, proxyFetch/authHeader/davPath/ncSegments/
   appModuleFolderPath/ensureFolderPath, Einstellungen-UI, chNumber, uid()
   usw. kommen aus ../shared/common.js.
   ============================================================ */

const LS_KEYS_PREFIX = "finanzplanung_cache_";

const FINANZPLANUNG_TARGET_FOLDER_PATH = appModuleFolderPath("Finanzplanung");

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// Reihenfolge hier bestimmt auch die Reihenfolge der Abschnitte in der
// Tabelle. vorzeichen: wie sich ein Betrag dieser Kategorie auf den Saldo
// auswirkt (Ausgaben/Auszahlungen verringern ihn, Einnahmen erhöhen ihn).
const SECTIONS = [
  { key: "ausgabenMonatlich", label: "Ausgaben (monatlich)", typ: "monatlich", vorzeichen: -1 },
  { key: "ausgabenEinmalig", label: "Ausgaben (einmalig)", typ: "einmalig", vorzeichen: -1 },
  { key: "einnahmen", label: "Einnahmen", typ: "einmalig", vorzeichen: 1 },
  { key: "auszahlungen", label: "Auszahlungen (Gewinnausschüttungen)", typ: "einmalig", vorzeichen: -1 }
];
// Gesamtzahl Spalten der Tabelle (Bezeichnung + 12 Monate + Total + Aktion) --
// für colspan bei Abschnitts-/Subtotal-/"+ Zeile"-Zeilen.
const TABLE_COLSPAN = 15;

function cacheKey(jahr) {
  return `${LS_KEYS_PREFIX}${jahr}`;
}
function blankYear(jahr, anfangssaldo) {
  return {
    jahr,
    anfangssaldo: anfangssaldo || 0,
    ausgabenMonatlich: [],
    ausgabenEinmalig: [],
    einnahmen: [],
    auszahlungen: [],
    updatedAt: null,
    updatedBy: null
  };
}

let currentJahr = new Date().getFullYear();
let yearData = loadJSON(cacheKey(currentJahr), null) || blankYear(currentJahr, 0);
// Anfangssaldo-Vorschlag (aus dem berechneten Endsaldo des Vorjahres), falls
// für currentJahr noch keine Datei existiert -- siehe refreshYear()/persist().
let carryOverVorschlag = 0;
// { [rowId]: Set<monatsNummer> } -- rein lokaler UI-Zustand (welche
// Monatszellen einer Zeile gerade markiert sind), nicht Teil der
// gespeicherten Daten. Wird beim Jahreswechsel geleert.
let selections = {};

// ---------- Nextcloud ----------

function finanzplanungSegments() {
  return ncSegments(FINANZPLANUNG_TARGET_FOLDER_PATH);
}
function ensureFinanzplanungFolder() {
  return ensureFolderPath(finanzplanungSegments());
}
function pingRelPath() {
  return davPath([...finanzplanungSegments(), "_ping"].join("/"));
}
function yearFilename(jahr) {
  return `${jahr}.json`;
}
async function fetchYearFile(jahr) {
  const relPath = davPath([...finanzplanungSegments(), yearFilename(jahr)].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}
async function putYearFile(jahr, data) {
  const relPath = davPath([...finanzplanungSegments(), yearFilename(jahr)].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

// ---------- Laden ----------

async function refreshYear(jahr) {
  currentJahr = jahr;
  selections = {};
  document.getElementById("yearLabel").textContent = String(jahr);

  const cached = loadJSON(cacheKey(jahr), null);
  yearData = cached || blankYear(jahr, 0);
  render();

  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    return;
  }
  if (!navigator.onLine) {
    line.textContent = "Offline · zeige zuletzt geladenen Stand";
    return;
  }
  line.textContent = "Lädt…";
  try {
    await ensureFinanzplanungFolder();
    const serverData = await fetchYearFile(jahr);
    if (serverData) {
      yearData = serverData;
      line.textContent = "Synchronisiert";
    } else {
      // Kein Jahr angelegt -- Anfangssaldo-Vorschlag aus dem berechneten
      // Endsaldo des Vorjahres (falls dessen Datei existiert), bleibt ein
      // ganz normales editierbares Feld.
      const prevData = await fetchYearFile(jahr - 1).catch(() => null);
      carryOverVorschlag = prevData ? berechneSalden(prevData)[12] : 0;
      yearData = blankYear(jahr, carryOverVorschlag);
      line.textContent = "Neues Jahr (noch nicht gespeichert)";
    }
    saveJSON(cacheKey(jahr), yearData);
  } catch (err) {
    console.warn("Finanzplanung konnte nicht geladen werden:", err);
    line.textContent = "Fehler beim Laden · zeige zuletzt geladenen Stand";
  }
  render();
}

// ---------- Speichern (siehe Kommentar oben) ----------

let syncQueue = Promise.resolve();

// jahr/vorschlag werden beim AUFRUF (nicht erst bei der tatsächlichen
// Ausführung in der Warteschlange) eingefroren -- sonst würde ein noch
// hängender Speichervorgang, während derer der Nutzer schon aufs nächste
// Jahr weiterklickt, versehentlich im FALSCHEN (inzwischen aktuellen) Jahr
// landen, weil currentJahr sich zwischenzeitlich geändert hat.
function mutate(mutateFn) {
  const jahr = currentJahr;
  const vorschlag = carryOverVorschlag;
  yearData = mutateFn(yearData) || yearData;
  saveJSON(cacheKey(jahr), yearData);
  render();
  syncQueue = syncQueue.then(() => persist(jahr, vorschlag, mutateFn));
  return syncQueue;
}

async function persist(jahr, vorschlag, mutateFn) {
  const line = document.getElementById("syncLine");
  // Nur das UI (Sync-Zeile, yearData, Tabelle) aktualisieren, wenn der
  // Nutzer zwischenzeitlich nicht schon weitergeklickt hat -- der
  // Speichervorgang selbst (unten) läuft so oder so zu Ende.
  const isCurrent = () => jahr === currentJahr;

  if (!isConfigured()) {
    if (isCurrent()) line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    return;
  }
  if (!navigator.onLine) {
    if (isCurrent()) line.textContent = "Offline · Änderungen nur lokal gespeichert";
    return;
  }
  if (isCurrent()) line.textContent = "Speichert…";
  try {
    await ensureFinanzplanungFolder();
    const serverData = (await fetchYearFile(jahr)) || blankYear(jahr, vorschlag);
    const merged = mutateFn(serverData) || serverData;
    merged.jahr = jahr;
    merged.updatedAt = new Date().toISOString();
    merged.updatedBy = personName();
    await putYearFile(jahr, merged);
    saveJSON(cacheKey(jahr), merged);
    if (isCurrent()) { yearData = merged; line.textContent = "Gespeichert"; }
  } catch (err) {
    console.warn("Finanzplanung konnte nicht gespeichert werden:", err);
    if (isCurrent()) line.textContent = "Fehler beim Speichern";
  }
  if (isCurrent()) render();
}

// ---------- Berechnung ----------

function rowBetragFuerMonat(sec, row, monat) {
  if (sec.typ === "monatlich") return Number(row.betrag) || 0;
  return Number(row.monate && row.monate[monat]) || 0;
}
function rowJahresTotal(sec, row) {
  if (sec.typ === "monatlich") return (Number(row.betrag) || 0) * 12;
  return Object.values(row.monate || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
}
function sectionSubtotal(sec, data, monat) {
  return (data[sec.key] || []).reduce((sum, row) => sum + rowBetragFuerMonat(sec, row, monat), 0);
}
// salden[0] = Anfangssaldo, salden[1..12] = Saldo am Ende von Monat 1..12.
function berechneSalden(data) {
  const salden = [Number(data.anfangssaldo) || 0];
  for (let m = 1; m <= 12; m++) {
    let delta = 0;
    SECTIONS.forEach((sec) => {
      delta += sec.vorzeichen * sectionSubtotal(sec, data, m);
    });
    salden.push(salden[m - 1] + delta);
  }
  return salden;
}

// ---------- Rendering ----------

function findRow(data, sectionKey, rowId) {
  return (data[sectionKey] || []).find((r) => r.id === rowId);
}

function rowSelectionSet(rowId) {
  if (!selections[rowId]) selections[rowId] = new Set();
  return selections[rowId];
}

// Vorbefüllung der "Übernehmen"-Eingabe: bei genau einer markierten Zelle
// deren bisheriger Wert, sonst leer (bei mehreren markierten Zellen mit
// unterschiedlichen Werten wäre eine Vorbefüllung ohnehin uneindeutig).
function selectionPrefill(row, selSet) {
  if (selSet.size !== 1) return "";
  const m = [...selSet][0];
  const v = row.monate && row.monate[m];
  return v ? v : "";
}

function monthCellHtml(sec, row, monat) {
  if (sec.typ === "monatlich") {
    const val = Number(row.betrag) || 0;
    return `<td class="fp-month-cell" data-action="edit-monthly" data-section="${sec.key}" data-row="${row.id}">${val ? chNumber(val) : ""}</td>`;
  }
  const selSet = selections[row.id];
  const selected = selSet && selSet.has(monat);
  const val = row.monate && row.monate[monat];
  return `<td class="fp-month-cell${selected ? " selected" : ""}" data-action="toggle-month" data-section="${sec.key}" data-row="${row.id}" data-month="${monat}">${val ? chNumber(val) : ""}</td>`;
}

function rowHtml(sec, row) {
  const cells = MONTH_LABELS.map((_, idx) => monthCellHtml(sec, row, idx + 1)).join("");
  const total = rowJahresTotal(sec, row);
  let html = `<tr class="fp-row" data-row-id="${row.id}">
    <td class="fp-bezeichnung">${escapeHtml(row.bezeichnung)}</td>
    ${cells}
    <td class="fp-total">${total ? chNumber(total) : ""}</td>
    <td class="fp-row-actions"><button type="button" class="row-action" data-action="delete-row" data-section="${sec.key}" data-row="${row.id}" title="Zeile löschen">×</button></td>
  </tr>`;

  const selSet = selections[row.id];
  if (sec.typ !== "monatlich" && selSet && selSet.size) {
    const monthNames = [...selSet].sort((a, b) => a - b).map((m) => MONTH_LABELS[m - 1]).join(", ");
    html += `<tr class="fp-apply-row">
      <td colspan="${TABLE_COLSPAN}">
        <div class="fp-apply-bar">
          <span>Betrag für ${escapeHtml(monthNames)}:</span>
          <input type="number" class="fp-apply-input" id="applyInput-${row.id}" value="${selectionPrefill(row, selSet)}" placeholder="0">
          <button type="button" class="btn-secondary" data-action="apply-selection" data-section="${sec.key}" data-row="${row.id}">Übernehmen</button>
          <button type="button" class="btn-secondary" data-action="cancel-selection" data-row="${row.id}">Abbrechen</button>
        </div>
      </td>
    </tr>`;
  }
  return html;
}

function sectionHtml(sec, data) {
  let html = `<tr class="fp-section-row"><td colspan="${TABLE_COLSPAN}">${escapeHtml(sec.label)}</td></tr>`;
  (data[sec.key] || []).forEach((row) => { html += rowHtml(sec, row); });
  const subtotalCells = MONTH_LABELS.map((_, idx) => {
    const v = sectionSubtotal(sec, data, idx + 1);
    return `<td class="fp-month-cell">${v ? chNumber(v) : ""}</td>`;
  }).join("");
  const subtotalTotal = (data[sec.key] || []).reduce((sum, row) => sum + rowJahresTotal(sec, row), 0);
  html += `<tr class="fp-subtotal-row">
    <td>Total ${escapeHtml(sec.label)}</td>
    ${subtotalCells}
    <td class="fp-total">${subtotalTotal ? chNumber(subtotalTotal) : ""}</td>
    <td></td>
  </tr>`;
  html += `<tr class="fp-add-row"><td colspan="${TABLE_COLSPAN}"><button type="button" class="fp-link-btn" data-action="add-row" data-section="${sec.key}">+ Zeile</button></td></tr>`;
  return html;
}

function saldoRowHtml(data) {
  const salden = berechneSalden(data);
  const cells = MONTH_LABELS.map((_, idx) => {
    const v = salden[idx + 1];
    return `<td class="fp-month-cell${v < 0 ? " negative" : ""}">${chNumber(v)}</td>`;
  }).join("");
  return `<tr class="fp-saldo-row">
    <td>Saldo</td>
    ${cells}
    <td class="fp-total${salden[12] < 0 ? " negative" : ""}">${chNumber(salden[12])}</td>
    <td></td>
  </tr>`;
}

function render() {
  document.getElementById("inputAnfangssaldo").value = yearData.anfangssaldo || "";

  let html = "";
  SECTIONS.forEach((sec) => { html += sectionHtml(sec, yearData); });
  html += saldoRowHtml(yearData);
  document.getElementById("fpBody").innerHTML = html;
}

// ---------- Interaktion ----------

function parseAmount(raw) {
  const n = Number(raw);
  return isNaN(n) ? 0 : n;
}

function onTableClick(e) {
  const editMonthly = e.target.closest('[data-action="edit-monthly"]');
  if (editMonthly) {
    const { section, row: rowId } = editMonthly.dataset;
    const row = findRow(yearData, section, rowId);
    if (!row) return;
    const typed = prompt(`Betrag für "${row.bezeichnung}" (gilt für alle 12 Monate):`, row.betrag || 0);
    if (typed === null) return;
    const betrag = parseAmount(typed);
    mutate((data) => {
      const r = findRow(data, section, rowId);
      if (r) r.betrag = betrag;
      return data;
    });
    return;
  }

  const toggleMonth = e.target.closest('[data-action="toggle-month"]');
  if (toggleMonth) {
    const { row: rowId, month } = toggleMonth.dataset;
    const m = Number(month);
    const set = rowSelectionSet(rowId);
    if (set.has(m)) set.delete(m);
    else set.add(m);
    render();
    return;
  }

  const applyBtn = e.target.closest('[data-action="apply-selection"]');
  if (applyBtn) {
    const { section, row: rowId } = applyBtn.dataset;
    const input = document.getElementById(`applyInput-${rowId}`);
    const betrag = parseAmount(input.value);
    const months = [...(selections[rowId] || [])];
    delete selections[rowId];
    mutate((data) => {
      const r = findRow(data, section, rowId);
      if (!r) return data;
      if (!r.monate) r.monate = {};
      months.forEach((m) => {
        if (betrag) r.monate[m] = betrag;
        else delete r.monate[m];
      });
      return data;
    });
    return;
  }

  const cancelBtn = e.target.closest('[data-action="cancel-selection"]');
  if (cancelBtn) {
    delete selections[cancelBtn.dataset.row];
    render();
    return;
  }

  const addRowBtn = e.target.closest('[data-action="add-row"]');
  if (addRowBtn) {
    const section = addRowBtn.dataset.section;
    const bezeichnung = (prompt("Bezeichnung der neuen Zeile:") || "").trim();
    if (!bezeichnung) return;
    const sec = SECTIONS.find((s) => s.key === section);
    const newId = uid();
    mutate((data) => {
      if (!data[section]) data[section] = [];
      data[section].push(sec.typ === "monatlich" ? { id: newId, bezeichnung, betrag: 0 } : { id: newId, bezeichnung, monate: {} });
      return data;
    });
    return;
  }

  const deleteBtn = e.target.closest('[data-action="delete-row"]');
  if (deleteBtn) {
    const { section, row: rowId } = deleteBtn.dataset;
    const row = findRow(yearData, section, rowId);
    if (!row) return;
    if (!confirm(`Zeile "${row.bezeichnung}" wirklich löschen?`)) return;
    delete selections[rowId];
    mutate((data) => {
      data[section] = (data[section] || []).filter((r) => r.id !== rowId);
      return data;
    });
  }
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: pingRelPath,
    ensureFolderFn: ensureFinanzplanungFolder,
    onSaved: () => refreshYear(currentJahr)
  });

  document.getElementById("prevYearBtn").addEventListener("click", () => refreshYear(currentJahr - 1));
  document.getElementById("nextYearBtn").addEventListener("click", () => refreshYear(currentJahr + 1));

  document.getElementById("inputAnfangssaldo").addEventListener("change", (e) => {
    const val = parseAmount(e.target.value);
    mutate((data) => { data.anfangssaldo = val; return data; });
  });

  document.getElementById("fpBody").addEventListener("click", onTableClick);

  document.getElementById("helpBtn").addEventListener("click", () => document.getElementById("helpOverlay").classList.remove("hidden"));
  document.getElementById("closeHelp").addEventListener("click", () => document.getElementById("helpOverlay").classList.add("hidden"));

  window.addEventListener("online", () => refreshYear(currentJahr));
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshYear(currentJahr);
  });

  refreshYear(currentJahr);

  registerServiceWorkerWithAutoUpdate();
}

document.addEventListener("DOMContentLoaded", init);
