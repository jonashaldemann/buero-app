/* ============================================================
   Finanzplanung — Liquiditätsplanung pro Kalenderjahr (nicht rollend wie
   die Timeline, sondern ein festes Jahr nach dem anderen, per < Jahr >
   umschaltbar).

   Jedes Jahr ist eine eigene JSON-Datei auf Nextcloud
   (Buero/Admin/App/Finanzplanung/<Jahr>.json) -- ein Jahr ist eine in sich
   geschlossene Einheit, deshalb keine gemeinsame Datei wie bei den
   Pendenzen und keine Merge-Logik über Jahre hinweg nötig.

   Drei Abschnitte (SECTIONS): Ausgaben, Einnahmen, Auszahlungen. Jede
   Zeile trägt ihren eigenen Typ (row.typ):
   - "monatlich": EIN Betrag pro Zeile, gilt für alle 12 Monate gleich.
     Bei Ausgaben und Auszahlungen wählbar (+ monatlich) -- nur Einnahmen
     sind bei einem Architekturbüro erfahrungsgemäss immer einmalig, siehe
     Todo-Wortlaut.
   - "einmalig": Betrag pro einzelnem Monat.
   In beiden Fällen dasselbe simple Muster: Klick auf eine Monatszelle
   öffnet direkt ein Eingabefenster (prompt()) für den Betrag -- bei
   "monatlich" gilt er danach für alle 12 Monate, bei "einmalig" nur für
   den angeklickten Monat. (Eine frühere Version liess sich mehrere Monate
   markieren und den Betrag dann gesammelt übernehmen -- laut Feedback
   unintuitiv, deshalb wieder auf diesen einfachen Klick-pro-Monat
   zurückgebaut.)
   Die Ausgaben-Zeilen beider Typen stehen bewusst GEMEINSAM in einer
   Liste mit einer einzigen Summe (übersichtlicher als zwei getrennte
   Abschnitte) -- ein kleines Icon pro Zeile zeigt den Typ.

   ABGESCHLOSSENE MONATE (data.istSaldo = { monat, betrag }): Was vorbei
   ist, ist keine Planung mehr -- dort zählt der tatsächliche Kontostand.
   "Monate bis heute abschliessen" trägt den bis dahin berechneten Saldo
   als ISTWERT im aktuellen Monat ein und räumt die Beträge aller Monate
   bis und mit diesem weg. Danach beginnt die Rechnung im Folgemonat bei
   diesem Istwert, die Monate davor sind in der Tabelle leer. Der Istwert
   selbst bleibt jederzeit änderbar (Klick auf die Saldo-Zelle); eine leere
   Eingabe hebt den Abschluss wieder auf. Es gibt genau EINEN solchen
   Punkt pro Jahr, nicht einen je Monat: zwei Istwerte im selben Jahr
   würden sich widersprechen, sobald dazwischen noch etwas geplant ist.

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
// mixed: ob die Zeilen dieses Abschnitts beide typ-Werte mischen dürfen
// (Ausgaben, Auszahlungen) oder immer "einmalig" sind (Einnahmen) -- nur
// mixed-Abschnitte zeigen das Typ-Icon pro Zeile und zwei "+"-Knöpfe.
const SECTIONS = [
  { key: "ausgaben", label: "Ausgaben", vorzeichen: -1, mixed: true },
  { key: "einnahmen", label: "Einnahmen", vorzeichen: 1, mixed: false },
  { key: "auszahlungen", label: "Auszahlungen (Gewinnausschüttungen)", vorzeichen: -1, mixed: true }
];
// Gesamtzahl Spalten der Tabelle (Bezeichnung + 12 Monate + Total + Aktion) --
// für colspan bei Abschnitts-/Subtotal-/"+ Zeile"-Zeilen.
const TABLE_COLSPAN = 15;

const TYP_ICON = { monatlich: "🔁", einmalig: "📌" };
const TYP_LABEL = { monatlich: "Monatlich wiederkehrend", einmalig: "Einmalig" };

function cacheKey(jahr) {
  return `${LS_KEYS_PREFIX}${jahr}`;
}
function blankYear(jahr, anfangssaldo) {
  return {
    jahr,
    anfangssaldo: anfangssaldo || 0,
    ausgaben: [],
    einnahmen: [],
    auszahlungen: [],
    updatedAt: null,
    updatedBy: null
  };
}

// Migriert ältere, bereits auf Nextcloud gespeicherte Jahres-Dateien auf das
// aktuelle Format -- wichtig, damit schon eingegebene echte Daten nach einer
// UI-Umstellung nicht plötzlich leer erscheinen:
// - vor der Zusammenlegung der Ausgaben (siehe Kopf-Kommentar) gab es
//   getrennte Listen "ausgabenMonatlich"/"ausgabenEinmalig" statt der
//   gemeinsamen "ausgaben"-Liste mit typ pro Zeile.
// - noch früher hatten Zeilen in einnahmen/auszahlungen/ausgabenEinmalig gar
//   kein "typ"-Feld (das gab es erst seit der Zusammenlegung) -- ohne
//   nachträglich gesetztes typ bliebe z.B. das Typ-Icon bei den (seit
//   Kurzem ebenfalls gemischten) Auszahlungen leer/"undefined".
// Legacy-Felder werden nach der Migration entfernt, damit die Datei beim
// nächsten Speichern dauerhaft im neuen Format landet (selbstheilend).
function migrateYearData(data) {
  if (!data) return data;
  if (!data.ausgaben) {
    const monatlich = (data.ausgabenMonatlich || []).map((r) => ({ id: r.id, bezeichnung: r.bezeichnung, typ: "monatlich", betrag: r.betrag || 0 }));
    const einmalig = (data.ausgabenEinmalig || []).map((r) => ({ id: r.id, bezeichnung: r.bezeichnung, typ: "einmalig", monate: r.monate || {} }));
    data.ausgaben = [...monatlich, ...einmalig];
  }
  delete data.ausgabenMonatlich;
  delete data.ausgabenEinmalig;
  ["ausgaben", "einnahmen", "auszahlungen"].forEach((key) => {
    (data[key] || []).forEach((r) => { if (!r.typ) r.typ = "betrag" in r ? "monatlich" : "einmalig"; });
  });
  return data;
}

let currentJahr = new Date().getFullYear();
let yearData = migrateYearData(loadJSON(cacheKey(currentJahr), null)) || blankYear(currentJahr, 0);
// Anfangssaldo-Vorschlag (aus dem berechneten Endsaldo des Vorjahres), falls
// für currentJahr noch keine Datei existiert -- siehe refreshYear()/persist().
let carryOverVorschlag = 0;

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
  document.getElementById("yearLabel").textContent = String(jahr);

  const cached = migrateYearData(loadJSON(cacheKey(jahr), null));
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
    const serverData = migrateYearData(await fetchYearFile(jahr));
    if (serverData) {
      yearData = serverData;
      line.textContent = "Synchronisiert";
    } else {
      // Kein Jahr angelegt -- Anfangssaldo-Vorschlag aus dem berechneten
      // Endsaldo des Vorjahres (falls dessen Datei existiert), bleibt ein
      // ganz normales editierbares Feld.
      const prevData = migrateYearData(await fetchYearFile(jahr - 1).catch(() => null));
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
    const serverData = migrateYearData(await fetchYearFile(jahr)) || blankYear(jahr, vorschlag);
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

function rowBetragFuerMonat(row, monat) {
  if (row.typ === "monatlich") return Number(row.betrag) || 0;
  return Number(row.monate && row.monate[monat]) || 0;
}

// Bis und mit welchem Monat ist das Jahr abgeschlossen? 0 = gar nicht.
// Alles bis dahin ist erledigt und steht nicht mehr in der Tabelle -- auch
// nicht bei "monatlich"-Zeilen, deren einer Betrag sich gar nicht pro Monat
// löschen liesse.
function abgeschlossenBis(data) {
  const m = Number(data && data.istSaldo && data.istSaldo.monat) || 0;
  return m >= 1 && m <= 12 ? m : 0;
}
function istAbgeschlossen(data, monat) {
  return monat <= abgeschlossenBis(data);
}

// Jahrestotal einer Zeile -- NUR über die offenen Monate: stünde bei einer
// monatlichen Zeile weiter 12 × Betrag, während elf Monatszellen leer sind,
// wäre die Spalte schlicht falsch.
function rowJahresTotal(row, data) {
  const bis = abgeschlossenBis(data);
  if (row.typ === "monatlich") return (Number(row.betrag) || 0) * (12 - bis);
  return Object.entries(row.monate || {})
    .reduce((sum, [m, v]) => sum + (Number(m) > bis ? Number(v) || 0 : 0), 0);
}
function sectionSubtotal(sec, data, monat) {
  if (istAbgeschlossen(data, monat)) return 0;
  return (data[sec.key] || []).reduce((sum, row) => sum + rowBetragFuerMonat(row, monat), 0);
}

// salden[0] = Anfangssaldo, salden[1..12] = Saldo am Ende von Monat 1..12.
// In einem abgeschlossenen Monat steht der eingetragene ISTWERT; davor ist
// der Saldo unbekannt (null) -- die Beträge dieser Monate sind ja weg, eine
// gerechnete Zahl wäre dort eine Erfindung.
function berechneSalden(data) {
  const bis = abgeschlossenBis(data);
  const salden = [Number(data.anfangssaldo) || 0];
  for (let m = 1; m <= 12; m++) {
    if (m < bis) { salden.push(null); continue; }
    if (m === bis) { salden.push(Number(data.istSaldo.betrag) || 0); continue; }
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

// Klick auf eine Monatszelle öffnet IMMER direkt ein Eingabefenster für
// genau diesen einen Klick (siehe onTableClick()) -- bei "monatlich" wirkt
// sich das auf alle 12 Monate der Zeile aus, bei "einmalig" nur auf den
// angeklickten. Keine Mehrfachauswahl mehr (frühere Version mit
// markierbaren Zellen + separater "Übernehmen"-Leiste war laut Feedback
// unintuitiv).
// Bei Einnahmen kann zusätzlich pro Monat eine kurze Info (z.B. "Bauprojekt",
// "Vorprojekt") hinterlegt werden -- row.notizen ist eine zu row.monate
// parallele, ebenso sparse Map. Erscheint als native Tooltip (title-Attribut)
// beim Überfahren der Zelle, zusätzlich optisch per gepunkteter Unterstreichung
// markiert (fp-has-note), damit man auch ohne Hover sieht, dass es dort eine
// Notiz gibt.
function monthCellHtml(sec, row, monat, bis) {
  // Abgeschlossen: leer und nicht anklickbar. Der Monat ist erledigt, dort
  // ist nichts mehr zu planen -- wieder öffnen geht über die Saldo-Zelle.
  if (monat <= bis) return `<td class="fp-month-cell fp-zu" title="Abgeschlossen"></td>`;
  const val = row.typ === "monatlich" ? Number(row.betrag) || 0 : Number(row.monate && row.monate[monat]) || 0;
  const notiz = row.notizen && row.notizen[monat];
  const titleAttr = notiz ? ` title="${escapeHtml(notiz)}"` : "";
  const noteClass = notiz ? " fp-has-note" : "";
  return `<td class="fp-month-cell${noteClass}" data-action="edit-month" data-section="${sec.key}" data-row="${row.id}" data-month="${monat}"${titleAttr}>${val ? chNumber(val) : ""}</td>`;
}

function rowHtml(sec, row, index, count, data) {
  const bis = abgeschlossenBis(data);
  const cells = MONTH_LABELS.map((_, idx) => monthCellHtml(sec, row, idx + 1, bis)).join("");
  const total = rowJahresTotal(row, data);
  const icon = sec.mixed ? `<span class="fp-typ-icon" title="${TYP_LABEL[row.typ]}">${TYP_ICON[row.typ]}</span>` : "";
  const canUp = index > 0;
  const canDown = index < count - 1;
  return `<tr class="fp-row" data-row-id="${row.id}">
    <td class="fp-bezeichnung">${icon}<span class="fp-row-title" data-action="rename-row" data-section="${sec.key}" data-row="${row.id}" title="Klicken zum Umbenennen">${escapeHtml(row.bezeichnung)}</span></td>
    ${cells}
    <td class="fp-total">${total ? chNumber(total) : ""}</td>
    <td class="fp-row-actions">
      <button type="button" class="row-action" data-action="move-row" data-section="${sec.key}" data-row="${row.id}" data-direction="-1" title="Nach oben verschieben"${canUp ? "" : " disabled"}>▲</button>
      <button type="button" class="row-action" data-action="move-row" data-section="${sec.key}" data-row="${row.id}" data-direction="1" title="Nach unten verschieben"${canDown ? "" : " disabled"}>▼</button>
      <button type="button" class="row-action" data-action="delete-row" data-section="${sec.key}" data-row="${row.id}" title="Zeile löschen">×</button>
    </td>
  </tr>`;
}

// "+ Zeile" (bzw. bei gemischten Abschnitten "+ monatlich"/"+ einmalig")
// steht bewusst VOR der Summen-Zeile, nicht danach -- sonst müsste man
// nach dem Hinzufügen immer erst an der Summe vorbei scrollen.
function addRowButtonsHtml(sec) {
  if (sec.mixed) {
    return `<tr class="fp-add-row"><td colspan="${TABLE_COLSPAN}">
      <button type="button" class="fp-link-btn" data-action="add-row" data-section="${sec.key}" data-typ="monatlich">+ monatlich</button>
      <button type="button" class="fp-link-btn" data-action="add-row" data-section="${sec.key}" data-typ="einmalig">+ einmalig</button>
    </td></tr>`;
  }
  return `<tr class="fp-add-row"><td colspan="${TABLE_COLSPAN}"><button type="button" class="fp-link-btn" data-action="add-row" data-section="${sec.key}" data-typ="einmalig">+ Zeile</button></td></tr>`;
}

// Titel UND Summe stehen bewusst in derselben, obersten Zeile des
// Abschnitts (statt Titel oben, Summe erst unten nach allen Zeilen) --
// so sieht man die Monats-/Jahrestotale sofort, ohne an den Zeilen
// vorbeizuscrollen.
function sectionHtml(sec, data) {
  const rows = data[sec.key] || [];
  const subtotalCells = MONTH_LABELS.map((_, idx) => {
    if (istAbgeschlossen(data, idx + 1)) return `<td class="fp-section-amount fp-zu"></td>`;
    const v = sectionSubtotal(sec, data, idx + 1);
    return `<td class="fp-section-amount">${v ? chNumber(v) : ""}</td>`;
  }).join("");
  const subtotalTotal = rows.reduce((sum, row) => sum + rowJahresTotal(row, data), 0);
  let html = `<tr class="fp-section-row">
    <td>${escapeHtml(sec.label)}</td>
    ${subtotalCells}
    <td class="fp-section-amount fp-total">${subtotalTotal ? chNumber(subtotalTotal) : ""}</td>
    <td></td>
  </tr>`;
  rows.forEach((row, idx) => { html += rowHtml(sec, row, idx, rows.length, data); });
  html += addRowButtonsHtml(sec);
  return html;
}

// Jede Saldo-Zelle ist anklickbar: dort wird der tatsächliche Kontostand
// eingetragen (und damit alles bis zu diesem Monat abgeschlossen). Der
// Istwert ist hervorgehoben -- man muss sehen, welche Zahl gemessen und
// welche gerechnet ist.
function saldoRowHtml(data) {
  const salden = berechneSalden(data);
  const bis = abgeschlossenBis(data);
  const cells = MONTH_LABELS.map((_, idx) => {
    const m = idx + 1;
    const v = salden[m];
    const klassen = ["fp-month-cell"];
    if (m === bis) klassen.push("fp-ist");
    if (m < bis) klassen.push("fp-zu");
    if (v !== null && v < 0) klassen.push("negative");
    const titel = m === bis
      ? `Tatsächlicher Stand per Ende ${MONTH_LABELS[idx]}, von Hand eingetragen`
      : `Stand per Ende ${MONTH_LABELS[idx]} eintragen`;
    return `<td class="${klassen.join(" ")}" data-action="edit-saldo" data-month="${m}" title="${titel}">${v === null ? "" : chNumber(v)}</td>`;
  }).join("");
  return `<tr class="fp-saldo-row">
    <td>Saldo</td>
    ${cells}
    <td class="fp-total${salden[12] < 0 ? " negative" : ""}">${chNumber(salden[12])}</td>
    <td></td>
  </tr>`;
}

// Der Abschluss-Knopf gilt nur fürs LAUFENDE Jahr: in einem vergangenen
// Jahr hiesse "bis heute" das ganze Jahr, in einem künftigen nichts.
function renderAbschluss() {
  const info = document.getElementById("abschlussInfo");
  const btn = document.getElementById("abschlussBtn");
  const bis = abgeschlossenBis(yearData);
  info.textContent = bis ? `Abgeschlossen bis Ende ${MONTH_LABELS[bis - 1]}` : "";
  // Der Anfangssaldo zählt nur, solange nichts abgeschlossen ist -- sonst
  // beginnt die Rechnung beim Istwert. Er bleibt änderbar (der Abschluss
  // lässt sich ja aufheben), steht aber sichtbar still.
  const saldoFeld = document.getElementById("inputAnfangssaldo");
  saldoFeld.closest(".fp-anfangssaldo").classList.toggle("fp-still", bis > 0);
  saldoFeld.title = bis ? "Zählt erst wieder, wenn der Abschluss aufgehoben ist" : "";
  const heute = new Date();
  const monat = heute.getMonth() + 1;
  btn.textContent = `Monate bis und mit ${MONTH_LABELS[monat - 1]} abschliessen`;
  btn.hidden = currentJahr !== heute.getFullYear() || bis >= monat;
}

function render() {
  document.getElementById("inputAnfangssaldo").value = yearData.anfangssaldo || "";
  renderAbschluss();

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
  const renameBtn = e.target.closest('[data-action="rename-row"]');
  if (renameBtn) {
    const { section, row: rowId } = renameBtn.dataset;
    const row = findRow(yearData, section, rowId);
    if (!row) return;
    const neu = (prompt("Bezeichnung:", row.bezeichnung) || "").trim();
    if (!neu || neu === row.bezeichnung) return;
    mutate((data) => {
      const r = findRow(data, section, rowId);
      if (r) r.bezeichnung = neu;
      return data;
    });
    return;
  }

  const editMonth = e.target.closest('[data-action="edit-month"]');
  if (editMonth) {
    const { section, row: rowId, month } = editMonth.dataset;
    const row = findRow(yearData, section, rowId);
    if (!row) return;
    if (row.typ === "monatlich") {
      const typed = prompt(`Betrag für "${row.bezeichnung}" (gilt für alle 12 Monate):`, row.betrag || 0);
      if (typed === null) return;
      const betrag = parseAmount(typed);
      mutate((data) => {
        const r = findRow(data, section, rowId);
        if (r) r.betrag = betrag;
        return data;
      });
    } else {
      const m = Number(month);
      const bisher = (row.monate && row.monate[m]) || 0;
      const typed = prompt(`Betrag für "${row.bezeichnung}" im ${MONTH_LABELS[m - 1]}:`, bisher);
      if (typed === null) return;
      const betrag = parseAmount(typed);

      // Bei Einnahmen kann zusätzlich eine kurze Info pro Monat vermerkt
      // werden (z.B. "Bauprojekt", "Vorprojekt") -- erscheint als Tooltip
      // über der Zahl. Nur relevant, wenn danach überhaupt noch ein Betrag
      // steht; beim Leeren der Zelle macht eine Notiz keinen Sinn mehr.
      let notiz;
      let notizCancelled = false;
      if (section === "einnahmen" && betrag) {
        const bisherigeNotiz = (row.notizen && row.notizen[m]) || "";
        const typedNotiz = prompt(`Info zu diesem Betrag (optional, z.B. "Bauprojekt"):`, bisherigeNotiz);
        if (typedNotiz === null) notizCancelled = true;
        else notiz = typedNotiz.trim();
      }

      mutate((data) => {
        const r = findRow(data, section, rowId);
        if (!r) return data;
        if (!r.monate) r.monate = {};
        if (betrag) r.monate[m] = betrag;
        else delete r.monate[m];
        if (!betrag) {
          if (r.notizen) delete r.notizen[m];
        } else if (!notizCancelled) {
          if (!r.notizen) r.notizen = {};
          if (notiz) r.notizen[m] = notiz;
          else delete r.notizen[m];
        }
        return data;
      });
    }
    return;
  }

  // Tatsächlicher Kontostand -- und damit der Abschluss bis zu diesem Monat.
  const editSaldo = e.target.closest('[data-action="edit-saldo"]');
  if (editSaldo) {
    const m = Number(editSaldo.dataset.month);
    const bis = abgeschlossenBis(yearData);
    const bisher = m === bis ? yearData.istSaldo.betrag : "";
    const typed = prompt(
      `Tatsächlicher Kontostand per Ende ${MONTH_LABELS[m - 1]}:\n\n` +
      `Damit gelten alle Monate bis und mit ${MONTH_LABELS[m - 1]} als abgeschlossen. ` +
      `Leer lassen hebt den Abschluss wieder auf.`,
      bisher
    );
    if (typed === null) return;
    const roh = String(typed).trim();
    const betrag = parseAmount(roh);
    mutate((data) => {
      if (!roh) delete data.istSaldo;
      else data.istSaldo = { monat: m, betrag };
      return data;
    });
    return;
  }

  const moveBtn = e.target.closest('[data-action="move-row"]');
  if (moveBtn) {
    const { section, row: rowId, direction } = moveBtn.dataset;
    const dir = Number(direction);
    mutate((data) => {
      const arr = data[section] || [];
      const idx = arr.findIndex((r) => r.id === rowId);
      const swapIdx = idx + dir;
      if (idx === -1 || swapIdx < 0 || swapIdx >= arr.length) return data;
      [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
      return data;
    });
    return;
  }

  const addRowBtn = e.target.closest('[data-action="add-row"]');
  if (addRowBtn) {
    const { section, typ } = addRowBtn.dataset;
    const bezeichnung = (prompt("Bezeichnung der neuen Zeile:") || "").trim();
    if (!bezeichnung) return;
    const newId = uid();
    mutate((data) => {
      if (!data[section]) data[section] = [];
      data[section].push(typ === "monatlich" ? { id: newId, bezeichnung, typ, betrag: 0 } : { id: newId, bezeichnung, typ, monate: {} });
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
    mutate((data) => {
      data[section] = (data[section] || []).filter((r) => r.id !== rowId);
      return data;
    });
  }
}

// Alles bis und mit dem laufenden Monat abschliessen: der bis dahin
// BERECHNETE Saldo wird als Istwert eingetragen (er steht ja genau für das,
// was tatsächlich passiert ist, solange die Planung stimmte -- korrigieren
// lässt er sich danach jederzeit), und die Beträge dieser Monate werden
// gelöscht. Monatliche Zeilen tragen nur EINEN Betrag für alle zwölf Monate
// und lassen sich gar nicht teilweise löschen -- sie gelten weiter, werden
// in den abgeschlossenen Monaten aber nicht mehr gezeigt und nicht gezählt.
// monat und betrag werden VOR dem mutate() festgehalten: mutateFn läuft
// zweimal (lokal und auf dem Serverstand) und muss beide Male dasselbe tun.
function schliesseVergangeneMonateAb() {
  const monat = new Date().getMonth() + 1;
  const betrag = berechneSalden(yearData)[monat];
  const label = MONTH_LABELS[monat - 1];
  const ok = confirm(
    `Alle Monate bis und mit ${label} abschliessen?\n\n` +
    `Die Beträge dieser Monate werden gelöscht. Als tatsächlicher Stand per ` +
    `Ende ${label} wird der bisher berechnete Saldo von CHF ${chNumber(betrag)} ` +
    `eingetragen -- er lässt sich danach jederzeit korrigieren.`
  );
  if (!ok) return;
  mutate((data) => {
    SECTIONS.forEach((sec) => {
      (data[sec.key] || []).forEach((row) => {
        if (row.typ === "monatlich") return;
        Object.keys(row.monate || {}).forEach((m) => { if (Number(m) <= monat) delete row.monate[m]; });
        Object.keys(row.notizen || {}).forEach((m) => { if (Number(m) <= monat) delete row.notizen[m]; });
      });
    });
    data.istSaldo = { monat, betrag };
    return data;
  });
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

  document.getElementById("abschlussBtn").addEventListener("click", schliesseVergangeneMonateAb);

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
