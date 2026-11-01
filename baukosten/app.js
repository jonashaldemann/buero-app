/* ============================================================
   Baukosten — Kostenschätzung nach BKP (Baukostenplan).

   Ablöser der bisherigen Excel-Vorlage des Büros. Der BKP-Katalog selbst
   (ein-, zwei- und dreistellige Nummern) steht fix in bkp.js und ist für
   alle Schätzungen identisch; eine Schätzung speichert nur das, was
   tatsächlich erfasst wurde:

     positionen: { "224": [ {Unterposition}, ... ], "211.1": [ ... ] }
     eigenePositionen: [ { nr: "211.1", titel: "Gerüste" } ]
     module:           [ { id, name } ]
     druck:            { ...Druckoptionen, siehe DRUCK_DEFAULTS }

   Das hat zwei Vorteile gegenüber der Excel-Logik (dort ist der Katalog
   Teil jedes Dokuments): die Dateien bleiben klein, und eine Korrektur am
   Katalog gilt sofort für alle bestehenden Schätzungen.

   Eine Unterposition ist die eigentliche Eingabezeile. Ausmass und
   Kennwert werden als EINGETIPPTER TEXT gespeichert ("2x4x2", "136*1.08")
   und erst beim Anzeigen gerechnet (rechne()) -- so bleibt sichtbar,
   woher eine Zahl kommt, was bei einer Kostenschätzung der halbe Zweck
   ist. Kosten = Ausmass × Kennwert, leeres Ausmass zählt als 1 (damit
   Pauschal-/Budgetpositionen ohne Pseudo-Ausmass "1 Pl" auskommen).

   MODULE sind frei definierbare Teilbereiche (in der alten Excel waren
   das die Spalten "nur Dach", "UG & Fenster", "nur Wohnung", in denen der
   Betrag ein zweites Mal stand). Hier wird der Betrag NICHT kopiert:
   jede Unterposition trägt höchstens eine Modul-Zuordnung, die Teilsummen
   ergeben sich daraus. Will man eine Position auf zwei Module verteilen,
   teilt man sie in zwei Unterpositionen.

   Ein File pro Kostenschätzung auf Nextcloud (Liste + Editor), Struktur
   bewusst analog zu Offerten/Protokoll. Speichern wie dort/bei der
   Finanzplanung: jede Änderung ist eine reine Funktion, die sowohl lokal
   (sofort) als auch seriell auf einen frisch geholten Serverstand
   angewendet wird -- mit zwei Abweichungen, siehe persist() und
   onBodyClick()/"add-zeile".

   Nextcloud-Login, proxyFetch/authHeader/davPath/ncSegments/
   appModuleFolderPath/ensureFolderPath, Einstellungen-UI, uid() usw.
   kommen aus ../shared/common.js.
   ============================================================ */

const LS_KEYS = {
  cache: "baukosten_cache",
  ansicht: "baukosten_ansicht"
};

const BAUKOSTEN_TARGET_FOLDER_PATH = appModuleFolderPath("Baukosten");

let schaetzungen = loadJSON(LS_KEYS.cache, []); // [{ filename, data }]
let projectList = appConfig.projekte;

let offen = null; // die gerade geöffnete Schätzung (data), null = Listenansicht
let offenFilename = null;

// Ansichtszustand: bewusst NICHT Teil der Datei, sondern pro Gerät in
// localStorage -- zwei Leute dürfen dieselbe Schätzung gleichzeitig
// unterschiedlich tief aufgeklappt anschauen.
//
// Startsicht ist bewusst die VOLLSTÄNDIGE: alle Nummern, auch die leeren,
// auf allen Ebenen. Beim Erstellen einer Schätzung geht man den Katalog
// einmal ganz durch, und was man nicht sieht, vergisst man. Ausdünnen
// ("Nur verwendete", tiefere Ebene) ist etwas für später, wenn die
// Schätzung schon Form hat -- diese Wahl wird dann gemerkt.
const ansichtDefaults = { ebene: 4, nurVerwendet: false, bemerkungen: false, dichte: "komfortabel" };
let ansicht = { ...ansichtDefaults, ...loadJSON(LS_KEYS.ansicht, {}) };
let suche = "";
let zugeklappt = new Set(); // Knoten-Nummern, die zugeklappt sind
let gewaehlteZeile = null; // { nr, id } der im Detailfenster gezeigten Unterposition

// Gedämpfte Farbtöne für die Modul-Markierungen (Strich in der Tabelle,
// Rand an der Kennzahl-Kachel) -- aus derselben Palette wie die
// Startseiten-Kacheln, bewusst zurückhaltend.
const MODUL_FARBEN = ["#4F7089", "#8F9A85", "#C97960", "#8C6E86", "#BF9B4F", "#4A7856", "#7A95A6", "#8A7458"];

const DRUCK_DEFAULTS = {
  nurVerwendete: true,
  alleHauptgruppen: true,
  unterpositionen: false,
  bemerkungExtern: true,
  modulSpalten: false,
  modulSummen: true
};

// ---------- Zentrale Konfiguration ----------

async function refreshAppData() {
  await refreshAppConfig();
  projectList = appConfig.projekte;
  renderProjektSelects();
}

// Optionen-Werte sind der Array-Index in projectList, NICHT die Nummer --
// die zentrale Liste erlaubt dieselbe Nummer mehrfach (siehe README),
// über die Nummer allein liessen sich zwei solche Optionen nicht
// auseinanderhalten. Nummer UND Name stehen deshalb als data-Attribute.
function renderProjektSelects() {
  ["neuProjekt", "kopfProjekt"].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const bisher = select.value;
    select.innerHTML =
      '<option value="">– Projekt wählen –</option>' +
      projectList
        .map((p, i) => `<option value="${i}" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.id)} – ${escapeHtml(p.name)}</option>`)
        .join("");
    select.value = bisher;
  });
}

function projektSelectAufDaten(selectId, data) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const idx = projectList.findIndex((p) => p.id === data.projekt && p.name === data.projektName);
  select.value = idx >= 0 ? String(idx) : "";
}
function projektAusSelect(selectId) {
  const select = document.getElementById(selectId);
  const opt = select.selectedOptions[0];
  if (!opt || !opt.dataset.id) return { projekt: "", projektName: "" };
  return { projekt: opt.dataset.id, projektName: opt.dataset.name };
}

// ---------- Rechnen ----------

// Wertet eine eingetippte Rechnung aus: "2x4x2" -> 16, "105*1.15+30*0.8"
// -> 144.75, "136*1.08" -> 146.88. Erlaubt sind nur Ziffern und die vier
// Grundrechenarten mit Klammern; "x"/"×" gelten als Mal, Komma als
// Dezimaltrennzeichen, Apostrophe (Tausender) werden ignoriert.
// Rückgabe: null bei leerer Eingabe, NaN bei ungültiger.
function rechne(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const expr = s.replace(/[×xX]/g, "*").replace(/'/g, "").replace(/,/g, ".");
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) return NaN;
  try {
    const wert = Function(`"use strict"; return (${expr});`)();
    return typeof wert === "number" && isFinite(wert) ? wert : NaN;
  } catch (err) {
    return NaN;
  }
}

// Enthält die Eingabe überhaupt eine Rechnung? Nur dann lohnt es sich, sie
// unter dem Resultat stehen zu lassen (bei "12.5" wäre das bloss doppelt).
function istRechnung(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  return /[+*/x×()]/.test(s) || /\d\s*-\s*\d/.test(s);
}

function zahl(wert) {
  if (wert === null || isNaN(wert)) return "";
  return wert.toLocaleString("de-CH", { maximumFractionDigits: 2 });
}
function franken(wert) {
  if (!isFinite(wert)) return "0";
  return Math.round(wert).toLocaleString("de-CH");
}

function ausmassWert(zeile) {
  const v = rechne(zeile.ausmass);
  if (v === null) return 1; // leeres Ausmass = Pauschale
  return isNaN(v) ? 0 : v;
}
function kennwertWert(zeile) {
  const v = rechne(zeile.kennwert);
  return v === null || isNaN(v) ? 0 : v;
}
function zeilenKosten(zeile) {
  return ausmassWert(zeile) * kennwertWert(zeile);
}

// ---------- Module ----------

function module_() {
  return (offen && offen.module) || [];
}
function modulFarbe(modulId) {
  const idx = module_().findIndex((m) => m.id === modulId);
  return idx >= 0 ? MODUL_FARBEN[idx % MODUL_FARBEN.length] : "transparent";
}
function modulName(modulId) {
  const m = module_().find((x) => x.id === modulId);
  return m ? m.name : "";
}

// Summe pro Modul plus der nicht zugeordnete Rest.
function modulSummen() {
  const summen = {};
  module_().forEach((m) => {
    summen[m.id] = 0;
  });
  let ohne = 0;
  Object.values(offen.positionen || {}).forEach((zeilen) => {
    (zeilen || []).forEach((z) => {
      const kosten = zeilenKosten(z);
      if (z.modul && summen[z.modul] !== undefined) summen[z.modul] += kosten;
      else ohne += kosten;
    });
  });
  return { summen, ohne };
}

// Die Modulliste wird als Textfeld gepflegt (eine Zeile pro Modul, wie
// projekte.txt). Die Zuordnungen an den Unterpositionen hängen aber an
// einer ID, nicht am Namen -- beim Übernehmen muss also jede Zeile ihrem
// bisherigen Modul zugeordnet werden. Das passiert in zwei Durchgängen:
//
//   1. gleiche Namen behalten ihre ID (Einschieben/Löschen/Umsortieren
//      einer anderen Zeile ändert dann nichts),
//   2. was danach übrig bleibt, wird der Reihe nach gepaart -- so behält
//      ein reines UMBENENNEN ("nur Wohnung" -> "Dachwohnung") seine
//      Zuordnungen, statt sie stillschweigend zu verlieren.
//
// Nur wirklich entfernte Module verlieren ihre Zuordnung (siehe
// uebernimmKopfDialog(), das sie dann auf "" zurücksetzt).
function moduleAusText(text, bisherige) {
  const namen = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ergebnis = new Array(namen.length).fill(null);
  const nochFrei = [...bisherige];

  namen.forEach((name, i) => {
    const idx = nochFrei.findIndex((m) => m.name === name);
    if (idx >= 0) {
      ergebnis[i] = { id: nochFrei[idx].id, name };
      nochFrei.splice(idx, 1);
    }
  });
  namen.forEach((name, i) => {
    if (ergebnis[i]) return;
    const uebrig = nochFrei.shift();
    ergebnis[i] = { id: uebrig ? uebrig.id : uid(), name };
  });
  return ergebnis;
}

// ---------- Baum aus Katalog + eigenen Positionen ----------

function knotenEbene(nr) {
  return nr.length === 1 ? 1 : nr.length === 2 ? 2 : 3;
}
function elterNummer(nr) {
  const e = knotenEbene(nr);
  if (e === 1) return null;
  return e === 2 ? nr.slice(0, 1) : nr.slice(0, 2);
}

// Katalog + die eigenen Positionen dieser Schätzung, hierarchisch sortiert.
// Lexikografisch sortierte Nummern ergeben genau die richtige Reihenfolge:
// "2" < "21" < "211" < "211.1" < "212" < "22".
function alleKnoten() {
  const eigene = (offen && offen.eigenePositionen) || [];
  const knoten = BKP_KATALOG.map(([nr, titel]) => ({ nr, titel, eigen: false }));
  eigene.forEach((p) => {
    if (!BKP_TITEL[p.nr]) knoten.push({ nr: p.nr, titel: p.titel, eigen: true });
  });
  knoten.sort((a, b) => (a.nr < b.nr ? -1 : a.nr > b.nr ? 1 : 0));
  return knoten;
}

function zeilenVon(nr) {
  return (offen.positionen && offen.positionen[nr]) || [];
}

// Summen für alle Knoten auf einmal: erst pro Position, dann auf die
// zwei- und einstelligen Eltern hochgezählt.
function alleSummen() {
  const summen = {};
  let gesamt = 0;
  Object.keys(offen.positionen || {}).forEach((nr) => {
    const summe = zeilenVon(nr).reduce((s, z) => s + zeilenKosten(z), 0);
    summen[nr] = (summen[nr] || 0) + summe;
    summen[nr.slice(0, 2)] = (summen[nr.slice(0, 2)] || 0) + summe;
    summen[nr.slice(0, 1)] = (summen[nr.slice(0, 1)] || 0) + summe;
    gesamt += summe;
  });
  return { summen, gesamt };
}

// "Verwendet" heisst: irgendwo darunter ist mindestens eine Unterposition
// erfasst -- bewusst unabhängig vom Betrag, eine Zeile mit noch offenem
// Preis (Kosten 0) soll nicht wieder verschwinden.
function verwendeteKnoten() {
  const set = new Set();
  Object.keys(offen.positionen || {}).forEach((nr) => {
    if (!zeilenVon(nr).length) return;
    set.add(nr);
    set.add(nr.slice(0, 2));
    set.add(nr.slice(0, 1));
  });
  return set;
}

function anzahlErfassterPositionen() {
  return Object.keys(offen.positionen || {}).filter((nr) => zeilenVon(nr).length).length;
}

// ---------- Suche ----------

// Trifft ein Knoten die Suche? Nummer-Anfang, Bezeichnung oder der Text
// einer seiner Unterpositionen (damit "Mulde" auch dann gefunden wird,
// wenn es nur im Beschrieb steht).
function knotenTrifft(knoten, q) {
  if (knoten.nr.startsWith(q)) return true;
  if (knoten.titel.toLowerCase().includes(q)) return true;
  return zeilenVon(knoten.nr).some(
    (z) =>
      (z.beschrieb || "").toLowerCase().includes(q) ||
      (z.extern || "").toLowerCase().includes(q) ||
      (z.intern || "").toLowerCase().includes(q)
  );
}

// Bei aktiver Suche zählt der Filter "Nur verwendete" und der Ein-/
// Ausklapp-Zustand bewusst NICHT: wer sucht, will die Position finden --
// auch eine noch leere, die er gleich benutzen möchte.
function sichtbarDurchSuche(knoten, q) {
  const treffer = new Set();
  knoten.forEach((k) => {
    if (!knotenTrifft(k, q)) return;
    treffer.add(k.nr);
    let eltern = elterNummer(k.nr);
    while (eltern) {
      treffer.add(eltern);
      eltern = elterNummer(eltern);
    }
  });
  return treffer;
}

// ---------- Spalten ----------

// Die Spalten der Bildschirmtabelle wechseln (Modul-Spalte nur wenn
// Module definiert sind, Bemerkungsspalten nur auf Wunsch) -- deshalb
// werden thead und die colspans aus dieser einen Liste abgeleitet statt
// fest im HTML zu stehen.
function spalten() {
  const cols = [
    { key: "nr", label: "BKP", cls: "bk-col-nr" },
    { key: "beschrieb", label: "Beschrieb", cls: "" },
    { key: "ausmass", label: "Ausmass", cls: "bk-col-ausmass bk-right" },
    { key: "einheit", label: "Einheit", cls: "bk-col-einheit" },
    { key: "kennwert", label: "Kennwert", cls: "bk-col-kennwert bk-right" },
    { key: "kosten", label: "Kosten", cls: "bk-col-kosten bk-right" }
  ];
  if (module_().length) cols.push({ key: "modul", label: "Modul", cls: "bk-col-modul" });
  if (ansicht.bemerkungen) {
    cols.push({ key: "intern", label: "Bemerkung intern", cls: "bk-col-bem" });
    cols.push({ key: "extern", label: "Bemerkung extern", cls: "bk-col-bem" });
  }
  cols.push({ key: "aktion", label: "", cls: "bk-col-aktion" });
  return cols;
}

// ---------- Rendering: Liste ----------

function schaetzungTotal(data) {
  let gesamt = 0;
  Object.values(data.positionen || {}).forEach((zeilen) => {
    (zeilen || []).forEach((z) => {
      gesamt += zeilenKosten(z);
    });
  });
  return gesamt;
}

function projektLabel(data) {
  if (!data.projekt) return data.projektName || "";
  return data.projektName ? `${data.projekt} – ${data.projektName}` : data.projekt;
}

function renderList() {
  const ul = document.getElementById("bkList");
  if (!schaetzungen.length) {
    ul.innerHTML = '<li class="empty">Noch keine Kostenschätzung erfasst.</li>';
    return;
  }
  const sortiert = [...schaetzungen].sort((a, b) =>
    String(b.data.updatedAt || "").localeCompare(String(a.data.updatedAt || ""))
  );
  ul.innerHTML = sortiert
    .map((eintrag) => {
      const d = eintrag.data;
      const meta = [projektLabel(d), d.genauigkeit, d.kostenstand ? `Stand ${d.kostenstand}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `<li>
        <div class="bk-list-main" data-action="open" data-file="${escapeHtml(eintrag.filename)}">
          <div class="bk-list-titel">${escapeHtml(d.titel || "(ohne Titel)")}</div>
          <div class="bk-list-meta">${escapeHtml(meta)}</div>
        </div>
        <div class="bk-list-total">CHF ${franken(schaetzungTotal(d))}</div>
        <button type="button" class="bk-toggle" data-action="duplicate" data-file="${escapeHtml(eintrag.filename)}">Duplizieren</button>
      </li>`;
    })
    .join("");
}

// ---------- Rendering: Kennzahlen ----------

// "±25%" o.ä. aus dem Freitext-Feld "Genauigkeit" herauslesen, um daraus
// die Bandbreite zu rechnen. Schlägt das fehl (anderer Wortlaut), bleibt
// die Kachel einfach weg -- das Feld soll frei beschreibbar bleiben.
function genauigkeitProzent() {
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(offen.genauigkeit || "");
  return m ? Number(m[1].replace(",", ".")) : null;
}

function renderKpis(gesamt) {
  const kacheln = [];
  kacheln.push(`<div class="bk-kpi gross">
    <div class="bk-kpi-label">Total</div>
    <div class="bk-kpi-wert">CHF ${franken(gesamt)}</div>
    ${offen.kostenstand ? `<div class="bk-kpi-sub">Stand ${escapeHtml(offen.kostenstand)}</div>` : ""}
  </div>`);

  const prozent = genauigkeitProzent();
  if (prozent !== null && gesamt) {
    kacheln.push(`<div class="bk-kpi">
      <div class="bk-kpi-label">Bandbreite ${escapeHtml(offen.genauigkeit)}</div>
      <div class="bk-kpi-wert">${franken(gesamt * (1 - prozent / 100))}</div>
      <div class="bk-kpi-sub">bis ${franken(gesamt * (1 + prozent / 100))}</div>
    </div>`);
  }

  kacheln.push(`<div class="bk-kpi">
    <div class="bk-kpi-label">Erfasste Positionen</div>
    <div class="bk-kpi-wert">${anzahlErfassterPositionen()}</div>
    <div class="bk-kpi-sub">von ${BKP_KATALOG.filter(([nr]) => nr.length === 3).length} im BKP</div>
  </div>`);

  if (module_().length) {
    const { summen, ohne } = modulSummen();
    module_().forEach((m) => {
      kacheln.push(`<div class="bk-kpi bk-kpi-modul" style="--modul-farbe:${modulFarbe(m.id)}">
        <div class="bk-kpi-label">${escapeHtml(m.name)}</div>
        <div class="bk-kpi-wert">${franken(summen[m.id])}</div>
        <div class="bk-kpi-sub">${gesamt ? Math.round((summen[m.id] / gesamt) * 100) : 0}% vom Total</div>
      </div>`);
    });
    if (ohne) {
      kacheln.push(`<div class="bk-kpi bk-kpi-modul">
        <div class="bk-kpi-label">Ohne Modul</div>
        <div class="bk-kpi-wert">${franken(ohne)}</div>
      </div>`);
    }
  }

  document.getElementById("kpis").innerHTML = kacheln.join("");
}

// ---------- Rendering: Tabelle ----------

function chevron(nr, hatKinder, offenJetzt) {
  if (!hatKinder) return '<button class="bk-chevron leer" tabindex="-1"></button>';
  return `<button type="button" class="bk-chevron" data-action="toggle" data-nr="${nr}" aria-label="Ein-/ausklappen">${offenJetzt ? "▾" : "▸"}</button>`;
}

function gruppenZeileHtml(knoten, summe, hatKinder, offenJetzt, cols) {
  const e = knotenEbene(knoten.nr);
  const indent = e === 1 ? "" : e === 2 ? " bk-indent-2" : " bk-indent-3";
  let aktionen = "";
  if (e === 2) {
    aktionen = `<button type="button" class="bk-add-btn" data-action="add-position" data-nr="${knoten.nr}" title="Eigene Unterteilung wie &quot;211.1 Gerüste&quot; ergänzen">+ eigene Pos.</button>`;
  } else if (e === 3) {
    aktionen = `<button type="button" class="bk-add-btn" data-action="add-zeile" data-nr="${knoten.nr}">+ Zeile</button>`;
    if (knoten.eigen) {
      aktionen += `<button type="button" class="bk-row-action" data-action="del-position" data-nr="${knoten.nr}" title="Eigene Position löschen">×</button>`;
    }
  }
  // Titel spannt von "Beschrieb" bis vor "Kosten", danach folgen die
  // optionalen Spalten und die Aktionsspalte.
  const titelSpan = cols.findIndex((c) => c.key === "kosten") - 1;
  const restSpan = cols.length - cols.findIndex((c) => c.key === "kosten") - 1;
  return `<tr class="bk-group bk-l${e}${summe ? "" : " leer"}" data-nr="${knoten.nr}">
    <td class="bk-col-nr${indent}">${chevron(knoten.nr, hatKinder, offenJetzt)}<span class="bk-nr-text">${escapeHtml(knoten.nr)}</span></td>
    <td class="bk-titel" colspan="${titelSpan}">${escapeHtml(knoten.titel)}</td>
    <td class="bk-total bk-right" data-total-for="${knoten.nr}">${summe ? franken(summe) : ""}</td>
    ${restSpan > 1 ? `<td colspan="${restSpan - 1}"></td>` : ""}
    <td class="bk-col-aktion">${aktionen}</td>
  </tr>`;
}

// Ausmass- und Kennwert-Zelle: im Feld steht das gerechnete Resultat, die
// eingetippte Rechnung bleibt klein darunter stehen (und erscheint beim
// Hineinklicken wieder im Feld, siehe onBodyFocusIn()).
function rechenZelle(zeile, feld, cssExtra) {
  const roh = zeile[feld] || "";
  const wert = rechne(roh);
  const anzeige = wert === null ? "" : isNaN(wert) ? roh : zahl(wert);
  const hinweis = isNaN(wert) ? "ungültig" : istRechnung(roh) ? roh : "";
  return `<td>
    <input type="text" class="bk-num ${cssExtra}" data-feld="${feld}" data-roh="${escapeHtml(roh)}" value="${escapeHtml(anzeige)}">
    <span class="bk-formel">${escapeHtml(hinweis)}</span>
  </td>`;
}

function modulSelectHtml(zeile, cssKlasse) {
  const optionen = module_()
    .map((m) => `<option value="${m.id}"${zeile.modul === m.id ? " selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");
  return `<select class="${cssKlasse}" data-feld="modul"><option value="">–</option>${optionen}</select>`;
}

function unterpositionHtml(nr, zeile, cols) {
  const gewaehlt = gewaehlteZeile && gewaehlteZeile.id === zeile.id ? " gewaehlt" : "";
  let zellen = "";
  cols.forEach((c) => {
    if (c.key === "nr") {
      zellen += '<td class="bk-col-nr"></td>';
    } else if (c.key === "beschrieb") {
      // Die Punkte zeigen auch bei ausgeblendeten Bemerkungsspalten, dass
      // zu dieser Zeile etwas hinterlegt ist.
      const punkte =
        (!ansicht.bemerkungen && zeile.intern ? '<span class="bk-bem-punkt" title="interne Bemerkung"></span>' : "") +
        (!ansicht.bemerkungen && zeile.extern ? '<span class="bk-bem-punkt extern" title="externe Bemerkung"></span>' : "");
      zellen += `<td>${punkte}<textarea rows="1" data-feld="beschrieb" placeholder="Beschrieb der Arbeiten">${escapeHtml(zeile.beschrieb || "")}</textarea></td>`;
    } else if (c.key === "ausmass") {
      zellen += rechenZelle(zeile, "ausmass", "bk-ausmass");
    } else if (c.key === "einheit") {
      zellen += `<td><input type="text" data-feld="einheit" list="einheitenListe" value="${escapeHtml(zeile.einheit || "")}"></td>`;
    } else if (c.key === "kennwert") {
      zellen += rechenZelle(zeile, "kennwert", "bk-kennwert");
    } else if (c.key === "kosten") {
      zellen += `<td class="bk-kosten" data-kosten-for="${zeile.id}">${zeilenKosten(zeile) ? franken(zeilenKosten(zeile)) : ""}</td>`;
    } else if (c.key === "modul") {
      zellen += `<td><span class="bk-modul-zelle"><span class="bk-modul-strich" style="--modul-farbe:${modulFarbe(zeile.modul)}"></span>${modulSelectHtml(zeile, "bk-modul-select")}</span></td>`;
    } else if (c.key === "intern") {
      zellen += `<td><textarea class="bk-bem" rows="1" data-feld="intern">${escapeHtml(zeile.intern || "")}</textarea></td>`;
    } else if (c.key === "extern") {
      zellen += `<td><textarea class="bk-bem" rows="1" data-feld="extern">${escapeHtml(zeile.extern || "")}</textarea></td>`;
    } else if (c.key === "aktion") {
      zellen += `<td class="bk-col-aktion"><button type="button" class="bk-row-action" data-action="del-zeile" data-nr="${nr}" data-row="${zeile.id}" title="Zeile löschen">×</button></td>`;
    }
  });
  return `<tr class="bk-sub${gewaehlt}" data-nr="${nr}" data-row="${zeile.id}">${zellen}</tr>`;
}

function renderTabelle() {
  const cols = spalten();
  const knoten = alleKnoten();
  const { summen, gesamt } = alleSummen();
  const q = suche.trim().toLowerCase();
  const sucheAktiv = q.length > 0;
  const trefferSet = sucheAktiv ? sichtbarDurchSuche(knoten, q) : null;
  const verwendet = verwendeteKnoten();

  document.getElementById("bkHead").innerHTML =
    "<tr>" + cols.map((c) => `<th class="${c.cls}">${escapeHtml(c.label)}</th>`).join("") + "</tr>";

  const hatKinder = {};
  knoten.forEach((k) => {
    const eltern = elterNummer(k.nr);
    if (eltern) hatKinder[eltern] = true;
    if (knotenEbene(k.nr) === 3 && zeilenVon(k.nr).length) hatKinder[k.nr] = true;
  });

  let html = "";
  let sichtbareZeilen = 0;

  knoten.forEach((k) => {
    if (sucheAktiv) {
      if (!trefferSet.has(k.nr)) return;
    } else {
      if (ansicht.nurVerwendet && !verwendet.has(k.nr)) return;
      let eltern = elterNummer(k.nr);
      let versteckt = false;
      while (eltern) {
        if (zugeklappt.has(eltern)) versteckt = true;
        eltern = elterNummer(eltern);
      }
      if (versteckt) return;
    }

    const kinderOffen = sucheAktiv || !zugeklappt.has(k.nr);
    html += gruppenZeileHtml(k, summen[k.nr] || 0, !!hatKinder[k.nr], kinderOffen, cols);
    sichtbareZeilen++;

    if (knotenEbene(k.nr) === 3 && kinderOffen) {
      zeilenVon(k.nr).forEach((z) => {
        html += unterpositionHtml(k.nr, z, cols);
      });
    }
  });

  if (!sichtbareZeilen) {
    html = `<tr><td colspan="${cols.length}"><div class="bk-leer-hinweis">${
      sucheAktiv ? "Keine Position gefunden." : 'Nichts sichtbar — "Nur verwendete" ausschalten.'
    }</div></td></tr>`;
  }

  const gesamtSpan = cols.findIndex((c) => c.key === "kosten");
  const restSpan = cols.length - gesamtSpan - 1;
  html += `<tr class="bk-gesamt">
    <td class="bk-col-nr"></td>
    <td colspan="${gesamtSpan - 1}">Total${offen.genauigkeit ? " " + escapeHtml(offen.genauigkeit) : ""}</td>
    <td class="bk-total bk-right" id="gesamtTotalZelle">CHF ${franken(gesamt)}</td>
    ${restSpan ? `<td colspan="${restSpan}"></td>` : ""}
  </tr>`;

  document.getElementById("bkBody").innerHTML = html;
  document.getElementById("bkTable").className = "bk-table" + (ansicht.dichte === "kompakt" ? " kompakt" : "");
  autoGrowAlle();
  return gesamt;
}

function renderEditor() {
  const gesamt = renderTabelle();
  renderKpis(gesamt);

  const meta = [projektLabel(offen), offen.genauigkeit, offen.kostenstand ? `Stand ${offen.kostenstand}` : ""]
    .filter(Boolean)
    .join(" · ");
  document.getElementById("headTitel").textContent = offen.titel || "(ohne Titel)";
  document.getElementById("headMeta").textContent = meta;
  document.getElementById("sucheHinweis").textContent = suche.trim()
    ? "Suche aktiv – Filter und Ein-/Ausklappen ausgesetzt"
    : "";
  // Der Einstiegshinweis ersetzt die dauerhaft sichtbaren "+ Zeile"-Knöpfe
  // (siehe .bk-add-btn in index.html) und verschwindet, sobald die erste
  // Position erfasst ist.
  document.getElementById("einstiegHinweis").hidden = anzahlErfassterPositionen() > 0;
  renderPanel();
}

function render() {
  const imEditor = !!offen;
  document.getElementById("listView").style.display = imEditor ? "none" : "";
  document.getElementById("editorView").style.display = imEditor ? "" : "none";
  if (imEditor) renderEditor();
  else renderList();
}

// Nach einer reinen Wertänderung müssen nur die gerechneten Zellen
// nachgeführt werden -- kein kompletter Neuaufbau, der den Cursor aus der
// Tabelle werfen würde.
function refreshSummen() {
  const { summen, gesamt } = alleSummen();
  document.querySelectorAll("[data-total-for]").forEach((el) => {
    const summe = summen[el.dataset.totalFor] || 0;
    el.textContent = summe ? franken(summe) : "";
    el.closest("tr").classList.toggle("leer", !summe);
  });
  document.querySelectorAll("[data-kosten-for]").forEach((el) => {
    const zeile = zeileSuchen(offen, el.dataset.kostenFor);
    if (zeile) el.textContent = zeilenKosten(zeile) ? franken(zeilenKosten(zeile)) : "";
  });
  const gesamtZelle = document.getElementById("gesamtTotalZelle");
  if (gesamtZelle) gesamtZelle.textContent = "CHF " + franken(gesamt);
  renderKpis(gesamt);
  renderPanelKosten();
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}
function autoGrowAlle() {
  document.querySelectorAll("#bkBody textarea").forEach(autoGrow);
}

// ---------- Detailfenster rechts ----------

// Zeigt die Zeile, in der gerade der Cursor steht, gross an -- inklusive
// Modul und beider Bemerkungsfelder. Dadurch darf die Tabelle selbst
// schmal und ruhig bleiben (siehe Layout-Kommentar in index.html).
function renderPanel() {
  const panel = document.getElementById("detailPanel");
  if (!gewaehlteZeile) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const zeile = zeileSuchen(offen, gewaehlteZeile.id);
  if (!zeile) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const nr = gewaehlteZeile.nr;
  const posTitel = BKP_TITEL[nr] || (offen.eigenePositionen.find((p) => p.nr === nr) || {}).titel || "";
  const modulFeld = module_().length
    ? `<label>Modul</label>${modulSelectHtml(zeile, "bk-panel-modul")}`
    : `<label>Modul</label><div class="hint" style="margin:0; font-size:11.5px;">Noch keine Module definiert — in den Kopfdaten anlegen.</div>`;

  panel.hidden = false;
  panel.innerHTML = `
    <div class="bk-panel-head">
      <div style="flex:1; min-width:0;">
        <div class="bk-panel-nr">BKP ${escapeHtml(nr)}</div>
        <div class="bk-panel-pos">${escapeHtml(posTitel)}</div>
      </div>
      <button type="button" class="bk-row-action" data-panel-action="close" title="Schliessen">×</button>
    </div>
    <label>Beschrieb</label>
    <textarea rows="4" data-panel-feld="beschrieb">${escapeHtml(zeile.beschrieb || "")}</textarea>
    <div class="bk-panel-dreispalt">
      <div><label>Ausmass</label><input type="text" data-panel-feld="ausmass" value="${escapeHtml(zeile.ausmass || "")}"></div>
      <div><label>Einheit</label><input type="text" data-panel-feld="einheit" list="einheitenListe" value="${escapeHtml(zeile.einheit || "")}"></div>
      <div><label>Kennwert</label><input type="text" data-panel-feld="kennwert" value="${escapeHtml(zeile.kennwert || "")}"></div>
    </div>
    <div class="bk-panel-kosten">
      <span style="font-size:11px; letter-spacing:0.4px; color:var(--text-muted); text-transform:uppercase;">Kosten</span>
      <span class="wert" id="panelKosten">CHF ${franken(zeilenKosten(zeile))}</span>
    </div>
    ${modulFeld}
    <label>Bemerkung intern <span style="text-transform:none; letter-spacing:0;">(nicht im Ausdruck)</span></label>
    <textarea rows="3" data-panel-feld="intern">${escapeHtml(zeile.intern || "")}</textarea>
    <label>Bemerkung extern</label>
    <textarea rows="3" data-panel-feld="extern">${escapeHtml(zeile.extern || "")}</textarea>
    <div class="bk-panel-fuss">
      <button type="button" class="bk-toggle" data-panel-action="delete">Zeile löschen</button>
    </div>`;
}

function renderPanelKosten() {
  const el = document.getElementById("panelKosten");
  if (!el || !gewaehlteZeile) return;
  const zeile = zeileSuchen(offen, gewaehlteZeile.id);
  if (zeile) el.textContent = "CHF " + franken(zeilenKosten(zeile));
}

function waehleZeile(nr, rowId) {
  if (gewaehlteZeile && gewaehlteZeile.id === rowId) return;
  gewaehlteZeile = { nr, id: rowId };
  document.querySelectorAll("#bkBody tr.bk-sub.gewaehlt").forEach((tr) => tr.classList.remove("gewaehlt"));
  const tr = document.querySelector(`#bkBody tr.bk-sub[data-row="${rowId}"]`);
  if (tr) tr.classList.add("gewaehlt");
  renderPanel();
}

// ---------- Nextcloud ----------

function bkSegments() {
  return ncSegments(BAUKOSTEN_TARGET_FOLDER_PATH);
}
function ensureBkFolder() {
  return ensureFolderPath(bkSegments());
}
function pingRelPath() {
  return davPath([...bkSegments(), "_ping"].join("/"));
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';

async function listFilenames() {
  const relPath = davPath(bkSegments().join("/") + "/");
  const res = await proxyFetch(relPath, {
    method: "PROPFIND",
    headers: { ...authHeader(), Depth: "1", "Content-Type": "application/xml" },
    body: PROPFIND_LIST_BODY
  });
  if (!res.ok) throw new Error(`Ordnerinhalt lesen fehlgeschlagen (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  return Array.from(doc.getElementsByTagNameNS("DAV:", "href"))
    .map((el) => decodeURIComponent(el.textContent.replace(/\/$/, "").split("/").pop() || ""))
    .filter((name) => name.toLowerCase().endsWith(".json"));
}

async function fetchFile(filename) {
  const relPath = davPath([...bkSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${filename}: Status ${res.status}`);
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function putFile(filename, data) {
  const relPath = davPath([...bkSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

async function deleteFile(filename) {
  const relPath = davPath([...bkSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "DELETE", headers: authHeader() });
  if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
}

function setSyncLine(text) {
  document.getElementById("syncLine").textContent = text || " ";
}

async function refreshAlle() {
  if (!isConfigured()) {
    setSyncLine("Nextcloud noch nicht eingerichtet · Einstellungen ⚙");
    render();
    return;
  }
  if (!navigator.onLine) {
    setSyncLine("Offline · zeige zuletzt geladenen Stand");
    render();
    return;
  }
  setSyncLine("Lädt…");
  try {
    await ensureBkFolder();
    const filenames = await listFilenames();
    const geladen = await Promise.all(
      filenames.map(async (filename) => {
        try {
          const data = await fetchFile(filename);
          if (!data || typeof data !== "object") throw new Error("ungültiger/leerer Inhalt");
          return { filename, data: migriere(data) };
        } catch (err) {
          console.warn("Konnte Kostenschätzung nicht laden:", filename, err);
          return null;
        }
      })
    );
    schaetzungen = geladen.filter(Boolean);
    saveJSON(LS_KEYS.cache, schaetzungen);
    setSyncLine("Synchronisiert");
    // Eine offene Schätzung auf den frischen Serverstand heben (z.B. nach
    // dem Zurückkehren aus einem anderen Tab).
    if (offenFilename) {
      const eintrag = schaetzungen.find((s) => s.filename === offenFilename);
      if (eintrag) offen = eintrag.data;
    }
  } catch (err) {
    console.warn("Baukosten konnten nicht geladen werden:", err);
    setSyncLine("Fehler beim Laden · zeige zuletzt geladenen Stand");
  }
  render();
}

// Fehlende Felder ergänzen, damit ältere/handgemachte Dateien nicht
// überall Sonderfälle brauchen.
function migriere(data) {
  if (!data.positionen) data.positionen = {};
  if (!data.eigenePositionen) data.eigenePositionen = [];
  if (!data.module) data.module = [];
  data.druck = { ...DRUCK_DEFAULTS, ...(data.druck || {}) };
  return data;
}

function leereSchaetzung({ titel, projekt, projektName, genauigkeit, kostenstand }) {
  return {
    id: uid(),
    titel: titel || "Kostenschätzung",
    projekt: projekt || "",
    projektName: projektName || "",
    genauigkeit: genauigkeit || "",
    kostenstand: kostenstand || "",
    grundlagen: "",
    positionen: {},
    eigenePositionen: [],
    module: [],
    druck: { ...DRUCK_DEFAULTS },
    updatedAt: null,
    updatedBy: null
  };
}

function sanitizeJsonFilename(name) {
  let clean = String(name).trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) clean = `kostenschaetzung-${uid()}`;
  if (!clean.toLowerCase().endsWith(".json")) clean += ".json";
  return clean;
}
function uniqueFilename(base) {
  const bekannt = new Set(schaetzungen.map((s) => s.filename));
  if (!bekannt.has(base)) return base;
  const stamm = base.replace(/\.json$/i, "");
  let n = 2;
  let kandidat;
  do {
    kandidat = `${stamm} (${n}).json`;
    n++;
  } while (bekannt.has(kandidat));
  return kandidat;
}
function dateinameFuer(data) {
  const teile = [data.projekt, data.projektName, data.titel].filter(Boolean);
  return uniqueFilename(sanitizeJsonFilename(teile.join(" ") || "Kostenschätzung"));
}

// ---------- Speichern (Muster wie Offerten/Finanzplanung) ----------

let syncQueue = Promise.resolve();

function cacheAktualisieren(filename, data) {
  const eintrag = schaetzungen.find((s) => s.filename === filename);
  if (eintrag) eintrag.data = data;
  else schaetzungen.push({ filename, data });
  saveJSON(LS_KEYS.cache, schaetzungen);
}

// mutateFn wird zweimal angewendet: sofort auf den lokalen Stand (fürs UI)
// und, seriell in der Warteschlange, auf einen frisch vom Server geholten
// Stand -- so überschreiben zwei Geräte, die kurz nacheinander je eine
// andere Änderung speichern, sich nicht gegenseitig.
function mutate(mutateFn, { neuRendern = false } = {}) {
  const filename = offenFilename;
  if (!filename) return Promise.resolve();
  offen = mutateFn(offen) || offen;
  cacheAktualisieren(filename, offen);
  if (neuRendern) render();
  else refreshSummen();
  syncQueue = syncQueue.then(() => persist(filename, mutateFn));
  return syncQueue;
}

async function persist(filename, mutateFn) {
  const istAktuell = () => filename === offenFilename;
  if (!isConfigured()) {
    if (istAktuell()) setSyncLine("Nextcloud noch nicht eingerichtet · Einstellungen ⚙");
    return;
  }
  if (!navigator.onLine) {
    if (istAktuell()) setSyncLine("Offline · Änderungen nur lokal gespeichert");
    return;
  }
  if (istAktuell()) setSyncLine("Speichert…");
  try {
    await ensureBkFolder();
    const serverStand = await fetchFile(filename);
    const basis = serverStand && typeof serverStand === "object" ? migriere(serverStand) : offen;
    const zusammen = mutateFn(basis) || basis;
    zusammen.updatedAt = new Date().toISOString();
    zusammen.updatedBy = personName();
    await putFile(filename, zusammen);
    // Der lokale Stand wird bewusst NICHT durch den gerade geschriebenen
    // Serverstand ersetzt (anders als bei der Finanzplanung, wo eine
    // Änderung immer ein abgeschlossener Dialog ist): hier tippt man vier
    // Felder in einer Zeile schnell hintereinander, und während dieses
    // Speichervorgangs sind die nächsten Änderungen schon in `offen`.
    // `zusammen` basiert auf dem Serverstand VON VORHIN und würde sie
    // wieder wegwerfen -- die Summen stünden dann auf 0, obwohl die Werte
    // noch in den Feldern stehen. Die nachfolgenden Einträge der
    // Warteschlange tragen ihre Änderung ohnehin je einzeln nach.
    if (istAktuell()) {
      offen.updatedAt = zusammen.updatedAt;
      offen.updatedBy = zusammen.updatedBy;
      setSyncLine("Gespeichert");
    }
    cacheAktualisieren(filename, istAktuell() ? offen : zusammen);
  } catch (err) {
    console.warn("Kostenschätzung konnte nicht gespeichert werden:", err);
    if (istAktuell()) setSyncLine("Fehler beim Speichern");
  }
}

// ---------- Zeilen finden/ändern ----------

function zeileSuchen(data, rowId) {
  for (const zeilen of Object.values(data.positionen || {})) {
    const treffer = (zeilen || []).find((z) => z.id === rowId);
    if (treffer) return treffer;
  }
  return null;
}

function neueZeile() {
  return { id: uid(), beschrieb: "", ausmass: "", einheit: "", kennwert: "", modul: "", intern: "", extern: "" };
}

// Einziger Weg, ein Feld einer Unterposition zu ändern -- egal ob die
// Eingabe aus der Tabelle oder aus dem Detailfenster kam. Danach wird die
// jeweils ANDERE Darstellung derselben Zeile nachgeführt, damit beide
// nicht auseinanderlaufen.
function setzeFeld(nr, rowId, feld, wert, quelle) {
  mutate((data) => {
    const zeile = (data.positionen[nr] || []).find((z) => z.id === rowId);
    if (zeile) zeile[feld] = wert;
    return data;
  });

  if (quelle !== "tabelle") {
    const tr = document.querySelector(`#bkBody tr.bk-sub[data-row="${rowId}"]`);
    const el = tr && tr.querySelector(`[data-feld="${feld}"]`);
    if (el) {
      if (el.classList.contains("bk-num")) {
        el.dataset.roh = wert;
        zeigeResultat(el);
      } else {
        el.value = wert;
        if (el.tagName === "TEXTAREA") autoGrow(el);
      }
    }
    if (feld === "modul") {
      const strich = tr && tr.querySelector(".bk-modul-strich");
      if (strich) strich.style.setProperty("--modul-farbe", modulFarbe(wert));
    }
  }
  if (quelle !== "panel" && gewaehlteZeile && gewaehlteZeile.id === rowId) {
    const el = document.querySelector(`#detailPanel [data-panel-feld="${feld}"]`);
    if (el) el.value = wert;
  }
  // Die Bemerkungs-Punkte in der Beschrieb-Spalte hängen am Inhalt.
  if ((feld === "intern" || feld === "extern") && !ansicht.bemerkungen) renderTabelleErhalten();
}

// Ein Neuaufbau der Tabelle, der die Auswahl und die Scrollposition behält
// -- für Änderungen, die nur die Darstellung betreffen (Bemerkungs-Punkte).
function renderTabelleErhalten() {
  const wrap = document.querySelector(".bk-table-wrap");
  const scroll = wrap ? wrap.scrollTop : 0;
  renderTabelle();
  if (wrap) wrap.scrollTop = scroll;
}

// ---------- Interaktion: Tabelle ----------

function setzeEbene(stufe) {
  ansicht.ebene = stufe;
  saveJSON(LS_KEYS.ansicht, ansicht);
  zugeklappt = new Set();
  if (stufe < 4) {
    alleKnoten().forEach((k) => {
      if (knotenEbene(k.nr) >= stufe) zugeklappt.add(k.nr);
    });
  }
  renderToolbar();
  render();
}

function renderToolbar() {
  document.querySelectorAll("#ebeneSeg button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.ebene) === ansicht.ebene);
  });
  document.querySelectorAll("#dichteSeg button").forEach((b) => {
    b.classList.toggle("active", b.dataset.dichte === ansicht.dichte);
  });
  document.getElementById("nurVerwendetBtn").classList.toggle("active", ansicht.nurVerwendet);
  document.getElementById("bemerkungenBtn").classList.toggle("active", ansicht.bemerkungen);
}

function onBodyClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, nr, row } = btn.dataset;

  if (action === "toggle") {
    // Ein einzeln angeklicktes Dreieck hebt die eingestellte Ebene für
    // genau diesen Knoten auf -- die Ebenen-Knöpfe bleiben eine
    // Ausgangslage, kein Zwang.
    if (zugeklappt.has(nr)) zugeklappt.delete(nr);
    else zugeklappt.add(nr);
    renderTabelleErhalten();
    return;
  }

  if (action === "add-zeile") {
    zugeklappt.delete(nr);
    // Die Zeile wird EINMAL vor dem mutate() erzeugt, nicht darin: mutateFn
    // läuft zweimal (lokal und auf dem frisch geholten Serverstand), und mit
    // einem uid() im Innern bekäme die Zeile dort eine andere ID -- alle
    // späteren Feldänderungen würden sie auf dem Server nicht mehr finden.
    const zeile = neueZeile();
    gewaehlteZeile = { nr, id: zeile.id };
    mutate(
      (data) => {
        if (!data.positionen[nr]) data.positionen[nr] = [];
        if (!data.positionen[nr].some((z) => z.id === zeile.id)) data.positionen[nr].push({ ...zeile });
        return data;
      },
      { neuRendern: true }
    );
    const neuesFeld = document.querySelector(`#bkBody tr.bk-sub[data-row="${zeile.id}"] textarea[data-feld="beschrieb"]`);
    if (neuesFeld) neuesFeld.focus();
    return;
  }

  if (action === "del-zeile") {
    loescheZeile(nr, row);
    return;
  }

  if (action === "add-position") {
    const eingabe = (prompt(`Eigene Position unter BKP ${nr} – Nummer (z.B. ${nr}1.1):`, "") || "").trim();
    if (!eingabe) return;
    if (!/^\d{3}(\.\d+)*$/.test(eingabe)) {
      alert('Die Nummer muss mit drei Ziffern beginnen, z.B. "211.1".');
      return;
    }
    if (!eingabe.startsWith(nr)) {
      alert(`Die Nummer muss mit ${nr} beginnen, damit sie unter dieser Elementgruppe einsortiert wird.`);
      return;
    }
    if (BKP_TITEL[eingabe] || (offen.eigenePositionen || []).some((p) => p.nr === eingabe)) {
      alert(`Die Nummer ${eingabe} gibt es bereits.`);
      return;
    }
    const titel = (prompt(`Bezeichnung für ${eingabe}:`, "") || "").trim();
    if (!titel) return;
    const ersteZeile = neueZeile(); // siehe Kommentar bei "add-zeile"
    gewaehlteZeile = { nr: eingabe, id: ersteZeile.id };
    mutate(
      (data) => {
        if (!data.eigenePositionen) data.eigenePositionen = [];
        if (!data.eigenePositionen.some((p) => p.nr === eingabe)) data.eigenePositionen.push({ nr: eingabe, titel });
        if (!data.positionen[eingabe]) data.positionen[eingabe] = [{ ...ersteZeile }];
        return data;
      },
      { neuRendern: true }
    );
    return;
  }

  if (action === "del-position") {
    const anzahl = zeilenVon(nr).length;
    if (!confirm(anzahl ? `Position ${nr} mit ${anzahl} Zeile(n) wirklich löschen?` : `Position ${nr} wirklich löschen?`)) return;
    if (gewaehlteZeile && gewaehlteZeile.nr === nr) gewaehlteZeile = null;
    mutate(
      (data) => {
        data.eigenePositionen = (data.eigenePositionen || []).filter((p) => p.nr !== nr);
        delete data.positionen[nr];
        return data;
      },
      { neuRendern: true }
    );
  }
}

function loescheZeile(nr, rowId) {
  const zeile = zeileSuchen(offen, rowId);
  const text = (zeile && zeile.beschrieb) || "";
  if (text && !confirm(`Zeile "${text}" wirklich löschen?`)) return;
  if (gewaehlteZeile && gewaehlteZeile.id === rowId) gewaehlteZeile = null;
  mutate(
    (data) => {
      data.positionen[nr] = (data.positionen[nr] || []).filter((z) => z.id !== rowId);
      if (!data.positionen[nr].length) delete data.positionen[nr];
      return data;
    },
    { neuRendern: true }
  );
}

// Beim Hineinklicken in ein Ausmass-/Kennwert-Feld erscheint wieder die
// eingetippte Rechnung statt des Resultats.
function onBodyFocusIn(e) {
  const tr = e.target.closest("tr.bk-sub");
  if (tr) waehleZeile(tr.dataset.nr, tr.dataset.row);
  const input = e.target.closest("input.bk-num");
  if (!input) return;
  input.value = input.dataset.roh || "";
  input.select();
}

function zeigeResultat(input) {
  const berechnet = rechne(input.dataset.roh);
  input.value = berechnet === null ? "" : isNaN(berechnet) ? input.dataset.roh : zahl(berechnet);
  const hinweis = input.parentElement.querySelector(".bk-formel");
  if (hinweis) {
    hinweis.textContent = isNaN(berechnet) ? "ungültig" : istRechnung(input.dataset.roh) ? input.dataset.roh : "";
  }
}

// Verlässt man ein Rechenfeld ohne Änderung, feuert kein change-Ereignis --
// ohne das hier bliebe dann die Rechnung statt des Resultats stehen.
function onBodyFocusOut(e) {
  const input = e.target.closest("input.bk-num");
  if (input) zeigeResultat(input);
}

function onBodyChange(e) {
  const feldEl = e.target.closest("[data-feld]");
  if (!feldEl) return;
  const tr = feldEl.closest("tr.bk-sub");
  if (!tr) return;
  if (feldEl.matches("input.bk-num")) feldEl.dataset.roh = feldEl.value;
  setzeFeld(tr.dataset.nr, tr.dataset.row, feldEl.dataset.feld, feldEl.value, "tabelle");
  if (feldEl.matches("input.bk-num")) zeigeResultat(feldEl);
  if (feldEl.dataset.feld === "modul") {
    const strich = tr.querySelector(".bk-modul-strich");
    if (strich) strich.style.setProperty("--modul-farbe", modulFarbe(feldEl.value));
  }
}

function onBodyInput(e) {
  if (e.target.tagName === "TEXTAREA") autoGrow(e.target);
}

// ---------- Interaktion: Detailfenster ----------

function onPanelChange(e) {
  const el = e.target.closest("[data-panel-feld]");
  if (!el || !gewaehlteZeile) return;
  setzeFeld(gewaehlteZeile.nr, gewaehlteZeile.id, el.dataset.panelFeld, el.value, "panel");
}

function onPanelClick(e) {
  const btn = e.target.closest("[data-panel-action]");
  if (!btn || !gewaehlteZeile) return;
  if (btn.dataset.panelAction === "close") {
    gewaehlteZeile = null;
    document.querySelectorAll("#bkBody tr.bk-sub.gewaehlt").forEach((tr) => tr.classList.remove("gewaehlt"));
    renderPanel();
  } else if (btn.dataset.panelAction === "delete") {
    loescheZeile(gewaehlteZeile.nr, gewaehlteZeile.id);
  }
}

// ---------- Interaktion: Liste ----------

function onListClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, file } = el.dataset;
  if (action === "open") {
    oeffne(file);
    return;
  }
  if (action === "duplicate") {
    const eintrag = schaetzungen.find((s) => s.filename === file);
    if (!eintrag) return;
    const titel = (prompt("Titel der Kopie:", `${eintrag.data.titel} (Kopie)`) || "").trim();
    if (!titel) return;
    const kopie = JSON.parse(JSON.stringify(eintrag.data));
    kopie.id = uid();
    kopie.titel = titel;
    kopie.updatedAt = null;
    // Neue IDs, damit sich die beiden Varianten beim Bearbeiten nicht in
    // die Quere kommen (zeileSuchen() geht über die ID).
    Object.values(kopie.positionen || {}).forEach((zeilen) => {
      (zeilen || []).forEach((z) => {
        z.id = uid();
      });
    });
    erstelleUndOeffne(kopie);
  }
}

function erstelleUndOeffne(data) {
  const filename = dateinameFuer(data);
  data.updatedAt = new Date().toISOString();
  data.updatedBy = personName();
  schaetzungen.push({ filename, data });
  saveJSON(LS_KEYS.cache, schaetzungen);
  offen = migriere(data);
  offenFilename = filename;
  gewaehlteZeile = null;
  setzeEbene(ansicht.ebene);
  setSyncLine("Speichert…");
  // Das erste Schreiben läuft durch dieselbe Warteschlange wie alle
  // Änderungen -- sonst könnte eine sofort danach erfasste Zeile VOR der
  // Neuanlage auf Nextcloud landen und von dieser wieder überschrieben
  // werden.
  syncQueue = syncQueue.then(async () => {
    try {
      await ensureBkFolder();
      await putFile(filename, data);
      if (filename === offenFilename) setSyncLine("Gespeichert");
    } catch (err) {
      console.warn("Neue Kostenschätzung konnte nicht gespeichert werden:", err);
      if (filename === offenFilename) setSyncLine("Fehler beim Speichern");
    }
  });
  return syncQueue;
}

function oeffne(filename) {
  const eintrag = schaetzungen.find((s) => s.filename === filename);
  if (!eintrag) return;
  offen = migriere(eintrag.data);
  offenFilename = filename;
  suche = "";
  gewaehlteZeile = null;
  document.getElementById("sucheInput").value = "";
  setzeEbene(ansicht.ebene);
}

function zurueckZurListe() {
  offen = null;
  offenFilename = null;
  gewaehlteZeile = null;
  render();
}

// ---------- Overlays ----------

function overlay(id, sichtbar) {
  document.getElementById(id).classList.toggle("hidden", !sichtbar);
}

function oeffneNeuDialog() {
  document.getElementById("neuTitel").value = "";
  document.getElementById("neuGenauigkeit").value = "±25%";
  document.getElementById("neuKostenstand").value = "";
  document.getElementById("neuProjekt").value = "";
  overlay("neuOverlay", true);
}

function erstelleAusDialog() {
  const { projekt, projektName } = projektAusSelect("neuProjekt");
  const titel = document.getElementById("neuTitel").value.trim();
  if (!titel) {
    alert("Bitte einen Titel angeben.");
    return;
  }
  overlay("neuOverlay", false);
  erstelleUndOeffne(
    leereSchaetzung({
      titel,
      projekt,
      projektName,
      genauigkeit: document.getElementById("neuGenauigkeit").value.trim(),
      kostenstand: document.getElementById("neuKostenstand").value.trim()
    })
  );
}

function oeffneKopfDialog() {
  projektSelectAufDaten("kopfProjekt", offen);
  document.getElementById("kopfTitel").value = offen.titel || "";
  document.getElementById("kopfGenauigkeit").value = offen.genauigkeit || "";
  document.getElementById("kopfKostenstand").value = offen.kostenstand || "";
  document.getElementById("kopfModule").value = module_().map((m) => m.name).join("\n");
  document.getElementById("kopfGrundlagen").value = offen.grundlagen || "";
  overlay("kopfOverlay", true);
}

function uebernimmKopfDialog() {
  const { projekt, projektName } = projektAusSelect("kopfProjekt");
  const titel = document.getElementById("kopfTitel").value.trim();
  const genauigkeit = document.getElementById("kopfGenauigkeit").value.trim();
  const kostenstand = document.getElementById("kopfKostenstand").value.trim();
  const grundlagen = document.getElementById("kopfGrundlagen").value;
  const neueModule = moduleAusText(document.getElementById("kopfModule").value, module_());
  const gueltigeIds = new Set(neueModule.map((m) => m.id));
  overlay("kopfOverlay", false);
  mutate(
    (data) => {
      data.projekt = projekt;
      data.projektName = projektName;
      data.titel = titel || data.titel;
      data.genauigkeit = genauigkeit;
      data.kostenstand = kostenstand;
      data.grundlagen = grundlagen;
      data.module = neueModule;
      // Zuordnungen auf entfernte Module zurücksetzen, sonst bliebe eine
      // Zeile unsichtbar einem Modul zugewiesen, das es nicht mehr gibt.
      Object.values(data.positionen || {}).forEach((zeilen) => {
        (zeilen || []).forEach((z) => {
          if (z.modul && !gueltigeIds.has(z.modul)) z.modul = "";
        });
      });
      return data;
    },
    { neuRendern: true }
  );
}

// Der Dateiname bleibt bewusst unverändert, auch wenn Titel/Projekt
// nachträglich geändert werden -- Umbenennen hiesse auf WebDAV kopieren +
// löschen, und ein Abbruch mittendrin würde eine Schätzung verlieren.
async function loescheOffene() {
  if (!confirm(`Kostenschätzung "${offen.titel}" wirklich komplett löschen?`)) return;
  const filename = offenFilename;
  overlay("kopfOverlay", false);
  schaetzungen = schaetzungen.filter((s) => s.filename !== filename);
  saveJSON(LS_KEYS.cache, schaetzungen);
  zurueckZurListe();
  try {
    await deleteFile(filename);
    setSyncLine("Gelöscht");
  } catch (err) {
    console.warn("Löschen fehlgeschlagen:", err);
    setSyncLine("Fehler beim Löschen");
  }
}

// ---------- Ausdruck ----------

const DRUCK_FELDER = {
  optNurVerwendete: "nurVerwendete",
  optAlleHauptgruppen: "alleHauptgruppen",
  optUnterpositionen: "unterpositionen",
  optBemerkungExtern: "bemerkungExtern",
  optModulSpalten: "modulSpalten",
  optModulSummen: "modulSummen"
};

function oeffneDruckDialog() {
  Object.entries(DRUCK_FELDER).forEach(([id, key]) => {
    document.getElementById(id).checked = !!offen.druck[key];
  });
  document.getElementById("druckModuleBlock").style.display = module_().length ? "" : "none";
  overlay("druckOverlay", true);
}

function druckOptionenLesen() {
  const neu = {};
  Object.entries(DRUCK_FELDER).forEach(([id, key]) => {
    neu[key] = document.getElementById(id).checked;
  });
  return neu;
}

function starteDruck() {
  const neu = druckOptionenLesen();
  overlay("druckOverlay", false);
  // Die Druckoptionen gehören zum Dokument, nicht zum Gerät: "so wird diese
  // Schätzung ausgegeben" ist eine Eigenschaft der Schätzung.
  mutate((data) => {
    data.druck = { ...DRUCK_DEFAULTS, ...neu };
    return data;
  });
  renderDruck(neu);
  window.print();
}

// Baut eine EIGENE Tabelle für den Ausdruck statt die Bildschirmansicht zu
// drucken. Nur so lassen sich die Druckregeln unabhängig von der gerade
// eingestellten Ansicht umsetzen: alle Hauptgruppen (auch leere), aber nur
// die verwendeten Positionen -- und die Unterpositionen wahlweise einzeln
// oder zu einem Beschrieb zusammengefasst (wie es in der alten Excel die
// TEXTJOIN-Formel in der Positionszeile tat).
function renderDruck(opt) {
  const { summen, gesamt } = alleSummen();
  const verwendet = verwendeteKnoten();
  const mods = opt.modulSpalten ? module_() : [];

  const kopf = [
    `<th>BKP</th>`,
    `<th>Bezeichnung</th>`,
    `<th class="r">Ausmass</th>`,
    `<th>Einheit</th>`,
    `<th class="r">Kennwert</th>`,
    `<th class="r">Kosten</th>`,
    ...mods.map((m) => `<th class="r">${escapeHtml(m.name)}</th>`),
    ...(opt.bemerkungExtern ? ["<th>Bemerkungen</th>"] : [])
  ];
  // Pro Modul die Teilsumme eines Knotens -- für die Modul-Spalten auf den
  // Gruppen- und Positionszeilen.
  function modulAnteile(nrPrefix) {
    const anteile = {};
    mods.forEach((m) => {
      anteile[m.id] = 0;
    });
    Object.keys(offen.positionen || {}).forEach((nr) => {
      if (!nr.startsWith(nrPrefix)) return;
      zeilenVon(nr).forEach((z) => {
        if (z.modul && anteile[z.modul] !== undefined) anteile[z.modul] += zeilenKosten(z);
      });
    });
    return anteile;
  }
  function modulZellen(anteile) {
    return mods.map((m) => `<td class="r">${anteile[m.id] ? franken(anteile[m.id]) : ""}</td>`).join("");
  }

  let zeilen = "";
  alleKnoten().forEach((k) => {
    const e = knotenEbene(k.nr);
    const summe = summen[k.nr] || 0;
    const istVerwendet = verwendet.has(k.nr);

    if (e === 1) {
      if (!opt.alleHauptgruppen && !istVerwendet) return;
    } else if (opt.nurVerwendete && !istVerwendet) {
      return;
    }

    const leerKlasse = istVerwendet ? "" : " pr-leer";
    if (e < 3) {
      zeilen += `<tr class="pr-l${e}${leerKlasse}">
        <td>${escapeHtml(k.nr)}</td>
        <td>${escapeHtml(k.titel)}</td>
        <td colspan="3"></td>
        <td class="r">${summe ? franken(summe) : ""}</td>
        ${mods.length ? modulZellen(modulAnteile(k.nr)) : ""}
        ${opt.bemerkungExtern ? "<td></td>" : ""}
      </tr>`;
      return;
    }

    // Position (dreistellig)
    const posZeilen = zeilenVon(k.nr);
    if (opt.unterpositionen && posZeilen.length) {
      zeilen += `<tr class="pr-pos">
        <td>${escapeHtml(k.nr)}</td>
        <td>${escapeHtml(k.titel)}</td>
        <td colspan="3"></td>
        <td class="r">${summe ? franken(summe) : ""}</td>
        ${mods.length ? modulZellen(modulAnteile(k.nr)) : ""}
        ${opt.bemerkungExtern ? "<td></td>" : ""}
      </tr>`;
      posZeilen.forEach((z) => {
        const anteile = {};
        mods.forEach((m) => {
          anteile[m.id] = z.modul === m.id ? zeilenKosten(z) : 0;
        });
        zeilen += `<tr class="pr-sub">
          <td></td>
          <td>${escapeHtml(z.beschrieb || "")}</td>
          <td class="r">${zahl(rechne(z.ausmass))}${istRechnung(z.ausmass) ? `<div class="pr-formel">${escapeHtml(z.ausmass)}</div>` : ""}</td>
          <td>${escapeHtml(z.einheit || "")}</td>
          <td class="r">${zahl(rechne(z.kennwert))}</td>
          <td class="r">${zeilenKosten(z) ? franken(zeilenKosten(z)) : ""}</td>
          ${mods.length ? modulZellen(anteile) : ""}
          ${opt.bemerkungExtern ? `<td>${escapeHtml(z.extern || "")}</td>` : ""}
        </tr>`;
      });
      return;
    }

    // Zusammengefasst: ein Beschrieb aus allen Unterpositionen, wie es in
    // der Excel die TEXTJOIN-Formel tat. Einheit/Ausmass/Kennwert bleiben
    // leer, sobald mehr als eine Unterposition dahintersteckt -- eine Summe
    // aus "m²" und "Stk" wäre schlicht falsch.
    const beschriebe = posZeilen.map((z) => (z.beschrieb || "").trim()).filter(Boolean);
    const einzeln = posZeilen.length === 1 ? posZeilen[0] : null;
    const bemerkungen = posZeilen.map((z) => (z.extern || "").trim()).filter(Boolean);
    zeilen += `<tr class="pr-pos${leerKlasse}">
      <td>${escapeHtml(k.nr)}</td>
      <td>${escapeHtml(k.titel)}${beschriebe.length ? `<div class="pr-formel">${escapeHtml(beschriebe.join("; "))}</div>` : ""}</td>
      <td class="r">${einzeln ? zahl(rechne(einzeln.ausmass)) : ""}</td>
      <td>${einzeln ? escapeHtml(einzeln.einheit || "") : ""}</td>
      <td class="r">${einzeln ? zahl(rechne(einzeln.kennwert)) : ""}</td>
      <td class="r">${summe ? franken(summe) : ""}</td>
      ${mods.length ? modulZellen(modulAnteile(k.nr)) : ""}
      ${opt.bemerkungExtern ? `<td>${escapeHtml(bemerkungen.join("; "))}</td>` : ""}
    </tr>`;
  });

  const gesamtModule = mods.length ? modulZellen(modulAnteile("")) : "";
  zeilen += `<tr class="pr-gesamt">
    <td></td>
    <td>Total${offen.genauigkeit ? " " + escapeHtml(offen.genauigkeit) : ""}</td>
    <td colspan="3"></td>
    <td class="r">CHF ${franken(gesamt)}</td>
    ${gesamtModule}
    ${opt.bemerkungExtern ? "<td></td>" : ""}
  </tr>`;

  let modulBlock = "";
  if (opt.modulSummen && module_().length) {
    const { summen: ms, ohne } = modulSummen();
    const zeilenHtml =
      module_()
        .map((m) => `<tr><td>${escapeHtml(m.name)}</td><td class="r">${franken(ms[m.id])}</td></tr>`)
        .join("") +
      (ohne ? `<tr><td>Ohne Modul</td><td class="r">${franken(ohne)}</td></tr>` : "") +
      `<tr><td>Total</td><td class="r">${franken(gesamt)}</td></tr>`;
    modulBlock = `<div class="pr-module"><h3>Zusammenstellung nach Modulen</h3><table>${zeilenHtml}</table></div>`;
  }

  const meta = [projektLabel(offen), offen.genauigkeit, offen.kostenstand ? `Kostenstand ${offen.kostenstand}` : ""]
    .filter(Boolean)
    .join(" · ");

  document.getElementById("printView").innerHTML = `
    <div class="pr-kopf">
      <h2>${escapeHtml(offen.titel || "")}</h2>
      <div class="pr-meta">${escapeHtml(meta)}</div>
      ${offen.grundlagen ? `<div class="pr-grundlagen">${escapeHtml(offen.grundlagen)}</div>` : ""}
    </div>
    <table class="pr-table">
      <thead><tr>${kopf.join("")}</tr></thead>
      <tbody>${zeilen}</tbody>
    </table>
    ${modulBlock}`;
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: pingRelPath,
    ensureFolderFn: ensureBkFolder,
    onSaved: () => {
      refreshAppData();
      refreshAlle();
    }
  });

  renderProjektSelects();
  renderToolbar();

  document.getElementById("bkList").addEventListener("click", onListClick);
  document.getElementById("neuBtn").addEventListener("click", oeffneNeuDialog);
  document.getElementById("backBtn").addEventListener("click", zurueckZurListe);
  document.getElementById("kopfBtn").addEventListener("click", oeffneKopfDialog);
  document.getElementById("druckBtn").addEventListener("click", oeffneDruckDialog);

  const body = document.getElementById("bkBody");
  body.addEventListener("click", onBodyClick);
  body.addEventListener("focusin", onBodyFocusIn);
  body.addEventListener("focusout", onBodyFocusOut);
  body.addEventListener("change", onBodyChange);
  body.addEventListener("input", onBodyInput);

  const panel = document.getElementById("detailPanel");
  panel.addEventListener("click", onPanelClick);
  panel.addEventListener("change", onPanelChange);

  document.getElementById("ebeneSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-ebene]");
    if (btn) setzeEbene(Number(btn.dataset.ebene));
  });
  document.getElementById("dichteSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-dichte]");
    if (!btn) return;
    ansicht.dichte = btn.dataset.dichte;
    saveJSON(LS_KEYS.ansicht, ansicht);
    renderToolbar();
    document.getElementById("bkTable").className = "bk-table" + (ansicht.dichte === "kompakt" ? " kompakt" : "");
    autoGrowAlle();
  });
  document.getElementById("nurVerwendetBtn").addEventListener("click", () => {
    ansicht.nurVerwendet = !ansicht.nurVerwendet;
    saveJSON(LS_KEYS.ansicht, ansicht);
    renderToolbar();
    renderTabelleErhalten();
  });
  document.getElementById("bemerkungenBtn").addEventListener("click", () => {
    ansicht.bemerkungen = !ansicht.bemerkungen;
    saveJSON(LS_KEYS.ansicht, ansicht);
    renderToolbar();
    renderTabelleErhalten();
  });
  document.getElementById("sucheInput").addEventListener("input", (e) => {
    suche = e.target.value;
    renderTabelleErhalten();
    document.getElementById("sucheHinweis").textContent = suche.trim()
      ? "Suche aktiv – Filter und Ein-/Ausklappen ausgesetzt"
      : "";
  });

  document.getElementById("closeNeu").addEventListener("click", () => overlay("neuOverlay", false));
  document.getElementById("neuAbbrechenBtn").addEventListener("click", () => overlay("neuOverlay", false));
  document.getElementById("neuErstellenBtn").addEventListener("click", erstelleAusDialog);
  document.getElementById("closeKopf").addEventListener("click", () => overlay("kopfOverlay", false));
  document.getElementById("kopfSpeichernBtn").addEventListener("click", uebernimmKopfDialog);
  document.getElementById("kopfLoeschenBtn").addEventListener("click", loescheOffene);
  document.getElementById("closeDruck").addEventListener("click", () => overlay("druckOverlay", false));
  document.getElementById("druckAbbrechenBtn").addEventListener("click", () => overlay("druckOverlay", false));
  document.getElementById("druckStartBtn").addEventListener("click", starteDruck);

  document.getElementById("helpBtn").addEventListener("click", () => overlay("helpOverlay", true));
  document.getElementById("closeHelp").addEventListener("click", () => overlay("helpOverlay", false));

  // ⌘K / Ctrl+K springt ins Suchfeld, Escape schliesst das Detailfenster
  // bzw. leert die Suche.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && offen) {
      e.preventDefault();
      document.getElementById("sucheInput").focus();
      document.getElementById("sucheInput").select();
      return;
    }
    if (e.key === "Escape" && offen) {
      const sucheEl = document.getElementById("sucheInput");
      if (document.activeElement === sucheEl && sucheEl.value) {
        sucheEl.value = "";
        suche = "";
        renderTabelleErhalten();
      } else if (gewaehlteZeile) {
        gewaehlteZeile = null;
        document.querySelectorAll("#bkBody tr.bk-sub.gewaehlt").forEach((tr) => tr.classList.remove("gewaehlt"));
        renderPanel();
      }
    }
  });

  window.addEventListener("online", refreshAlle);

  render();
  refreshAppData();
  refreshAlle();

  registerServiceWorkerWithAutoUpdate();
}

document.addEventListener("DOMContentLoaded", init);
