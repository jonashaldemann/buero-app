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
let letzterStatus = {}; // zuletzt gerechneter Durchgeh-Status, für die Kennzahl-Kachel

// Gedämpfte Farbtöne für die Modul-Markierungen (Strich in der Tabelle,
// Rand an der Kennzahl-Kachel) -- aus derselben Palette wie die
// Startseiten-Kacheln, bewusst zurückhaltend.
const MODUL_FARBEN = ["#4F7089", "#8F9A85", "#C97960", "#8C6E86", "#BF9B4F", "#4A7856", "#7A95A6", "#8A7458"];

// Durchgeh-Status pro BKP-Nummer, zum gemeinsamen Abhaken zu zweit.
// Reihenfolge = Klick-Reihenfolge des Kästchens.
const STATUS_FOLGE = ["", "pendent", "erledigt", "verifiziert"];
const STATUS_RANG = { "": 0, pendent: 1, erledigt: 2, verifiziert: 3 };
const STATUS_LABEL = {
  "": "offen – noch nicht angeschaut",
  pendent: "pendent – angeschaut, noch offene Punkte",
  erledigt: "erledigt",
  verifiziert: "verifiziert – von der zweiten Person geprüft"
};
const STATUS_ZEICHEN = { "": "", pendent: "", erledigt: "✓", verifiziert: "✓" };

const DRUCK_DEFAULTS = {
  nurVerwendete: true,
  alleHauptgruppen: true,
  unterpositionen: false,
  unterteilungen: false,
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
function einfacheKosten(zeile) {
  return ausmassWert(zeile) * kennwertWert(zeile);
}

// ---------- Prozent-Zeilen (Honorar auf die Baukosten) ----------
//
// Eine Unterposition kann statt "Ausmass × Kennwert" auch als PROZENTSATZ
// der Baukosten gerechnet werden -- gedacht fürs Architektenhonorar (BKP
// 291), das sich damit automatisch mitbewegt, wenn sich die Schätzung
// ändert. Die übrigen Honorare werden weiterhin pauschal erfasst.
//
// zeile.basis sagt, worauf sich der Prozentsatz bezieht; zeile.ausmass
// hält dann den Prozentsatz (Einheit "%"), der Kennwert entfällt.
//
// ZIRKELSCHLUSS: BKP 291 liegt selbst in Hauptgruppe 2 und wäre damit Teil
// seiner eigenen Bemessungsgrundlage. Deshalb zählen Prozent-Zeilen NIE in
// die Basis -- egal welche. Ebenfalls draussen: die Hauptgruppe 0
// (Grundstück ist keine Baukost) und die Zusatz-/Options-Module (die
// stehen auch nicht im Total).
const BASIS_ARTEN = {
  bkp19: "% der Baukosten BKP 1–9",
  bkp19ohneHonorar: "% der Baukosten BKP 1–9 ohne Honorare"
};

function basisBetrag(art, data) {
  const quelle = data || offen;
  if (!quelle) return 0;
  const zIds = new Set((quelle.module || []).filter((m) => m.zusatz).map((m) => m.id));
  let summe = 0;
  Object.keys(quelle.positionen || {}).forEach((nr) => {
    if (nr[0] === "0") return; // Grundstück
    // Die Honorar-Elementgruppen enden auf 9 (09, 19, 29, ... 99).
    if (art === "bkp19ohneHonorar" && nr[1] === "9") return;
    (quelle.positionen[nr] || []).forEach((z) => {
      if (z.basis) return; // siehe Zirkelschluss oben
      if (z.modul && zIds.has(z.modul)) return;
      summe += einfacheKosten(z);
    });
  });
  return summe;
}

function zeilenKosten(zeile, data) {
  if (!zeile.basis) return einfacheKosten(zeile);
  const prozent = rechne(zeile.ausmass);
  const p = prozent === null || isNaN(prozent) ? 0 : prozent;
  return (p / 100) * basisBetrag(zeile.basis, data);
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

// Ein Modul ist entweder eine AUFTEILUNG der Schätzung ("nur Dach",
// "UG & Fenster" -- alle zusammen ergeben das Total) oder ein ZUSATZ,
// also eine noch nicht beschlossene Option ("Balkone vergrössern"). Die
// Positionen eines Zusatz-Moduls zählen bewusst NICHT ins Total: sie
// werden überall separat mit "+" ausgewiesen, damit der Bauherr
// Grundkosten und Option auseinanderhalten kann.
function zusatzModulIds() {
  return new Set(module_().filter((m) => m.zusatz).map((m) => m.id));
}
function istZusatzZeile(zeile, zIds) {
  return !!(zeile.modul && (zIds || zusatzModulIds()).has(zeile.modul));
}

// Summe pro Modul (beide Arten) plus der nicht zugeordnete Rest.
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

// Die Module werden in den Kopfdaten in einer kleinen Liste gepflegt
// (Name + "Im Total"/"Zusätzlich"). Solange der Dialog offen ist, liegt
// der Arbeitsstand hier; übernommen wird er erst beim Speichern. Jede
// Zeile behält dabei ihre ID -- Umbenennen verliert also keine
// Zuordnungen, nur ein wirklich gelöschtes Modul tut das (siehe
// uebernimmKopfDialog()).
let kopfModule = [];

function renderKopfModule() {
  const ziel = document.getElementById("kopfModulListe");
  if (!kopfModule.length) {
    ziel.innerHTML = '<div class="bk-modul-leer">Noch keine Module – mit "+ Modul" eines anlegen.</div>';
    return;
  }
  ziel.innerHTML = kopfModule
    .map(
      (m, i) => `<div class="bk-modul-row" data-idx="${i}">
      <input type="text" class="bk-modul-name" value="${escapeHtml(m.name)}" placeholder="z.B. nur Dach">
      <div class="bk-seg">
        <button type="button" data-zusatz="0" class="${m.zusatz ? "" : "active"}">Im Total</button>
        <button type="button" data-zusatz="1" class="${m.zusatz ? "active" : ""}">Zusätzlich</button>
      </div>
      <button type="button" class="bk-row-action" data-modul-del="1" title="Modul entfernen">×</button>
    </div>`
    )
    .join("");
}

// Namen aus den Eingabefeldern zurück in den Arbeitsstand holen -- nötig
// vor jeder Umschaltung und vor dem Speichern, weil die Felder sonst beim
// Neuzeichnen der Liste verloren gingen.
function lesKopfModulNamen() {
  document.querySelectorAll("#kopfModulListe .bk-modul-row").forEach((row) => {
    const m = kopfModule[Number(row.dataset.idx)];
    if (m) m.name = row.querySelector(".bk-modul-name").value;
  });
}

function onKopfModulClick(e) {
  const row = e.target.closest(".bk-modul-row");
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (e.target.closest("[data-modul-del]")) {
    lesKopfModulNamen();
    kopfModule.splice(idx, 1);
    renderKopfModule();
    return;
  }
  const art = e.target.closest("button[data-zusatz]");
  if (art) {
    lesKopfModulNamen();
    kopfModule[idx].zusatz = art.dataset.zusatz === "1";
    renderKopfModule();
  }
}

// ---------- Baum aus Katalog + eigenen Positionen ----------

// Eine Nummer mit Punkt ("211.1 Gerüste") ist im BKP ein TEIL der
// dreistelligen Position, nicht deren Nachbar -- sie bekommt deshalb eine
// eigene Ebene 4 und hängt unter "211". Im Katalog selbst kommt keine
// solche Nummer vor (auch die alte Excel hatte nur die von Hand
// ergänzte 211.1); sie entstehen ausschliesslich über "+ Unterteilung".
function knotenEbene(nr) {
  if (nr.includes(".")) return 4;
  return nr.length === 1 ? 1 : nr.length === 2 ? 2 : 3;
}
function elterNummer(nr) {
  const e = knotenEbene(nr);
  if (e === 1) return null;
  if (e === 4) return nr.slice(0, nr.lastIndexOf("."));
  return e === 2 ? nr.slice(0, 1) : nr.slice(0, 2);
}
// Alle Vorfahren einer Nummer, von innen nach aussen: "211.1" -> 211, 21, 2
function vorfahren(nr) {
  const liste = [];
  let eltern = elterNummer(nr);
  while (eltern) {
    liste.push(eltern);
    eltern = elterNummer(eltern);
  }
  return liste;
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

// Zeilen einer Position samt denen ihrer eigenen Unterteilungen
// ("211" liefert auch die Zeilen von "211.1") -- für den Ausdruck, wenn
// die Unterteilungen nicht separat ausgewiesen werden.
function zeilenUnter(nr) {
  const alle = [];
  Object.keys(offen.positionen || {}).forEach((k) => {
    if (k === nr || k.startsWith(nr + ".")) alle.push(...zeilenVon(k));
  });
  return alle;
}

// Summen für alle Knoten auf einmal: erst pro Position, dann auf die
// zwei- und einstelligen Eltern hochgezählt.
// Liefert zwei parallele Summenbäume: "summen" sind die Grundkosten,
// "summenZusatz" die Beträge aus Zusatz-/Options-Modulen, die bewusst
// NICHT ins Total zählen (siehe zusatzModulIds()).
function alleSummen() {
  const zIds = zusatzModulIds();
  const summen = {};
  const summenZusatz = {};
  let gesamt = 0;
  let gesamtZusatz = 0;
  Object.keys(offen.positionen || {}).forEach((nr) => {
    let basis = 0;
    let zusatz = 0;
    zeilenVon(nr).forEach((z) => {
      const kosten = zeilenKosten(z);
      if (istZusatzZeile(z, zIds)) zusatz += kosten;
      else basis += kosten;
    });
    [nr, ...vorfahren(nr)].forEach((ziel) => {
      summen[ziel] = (summen[ziel] || 0) + basis;
      summenZusatz[ziel] = (summenZusatz[ziel] || 0) + zusatz;
    });
    gesamt += basis;
    gesamtZusatz += zusatz;
  });
  return { summen, summenZusatz, gesamt, gesamtZusatz };
}

// "Verwendet" heisst: irgendwo darunter ist mindestens eine Unterposition
// erfasst -- bewusst unabhängig vom Betrag, eine Zeile mit noch offenem
// Preis (Kosten 0) soll nicht wieder verschwinden.
function verwendeteKnoten() {
  const set = new Set();
  Object.keys(offen.positionen || {}).forEach((nr) => {
    if (!zeilenVon(nr).length) return;
    set.add(nr);
    vorfahren(nr).forEach((v) => set.add(v));
  });
  return set;
}

// Welche Knoten hängen direkt unter welchem? Einmal pro Rendering gebaut
// und für Klappbarkeit, Status-Hochrechnung und Druck wiederverwendet.
function kinderMap(knoten) {
  const map = {};
  knoten.forEach((k) => {
    const eltern = elterNummer(k.nr);
    if (eltern) (map[eltern] = map[eltern] || []).push(k.nr);
  });
  return map;
}

// Der Status einer Gruppe wird NICHT gespeichert, sondern aus ihren Kindern
// gerechnet: sie nimmt den Stand an, den ALLE ihre Kinder mindestens
// erreicht haben (das Minimum). Eine Elementgruppe wird also erst grün,
// wenn jede ihrer Positionen grün ist -- genau das soll beim gemeinsamen
// Durchgehen sichtbar machen, wo noch niemand war. Gespeichert wird nur an
// den Blättern (dreistellige Positionen bzw. eigene Unterteilungen, und
// jene Reservegruppen, die gar keine Positionen haben).
function statusBerechnen(knoten, kinder) {
  const gespeichert = (offen && offen.status) || {};
  const ergebnis = {};
  // Tiefste zuerst, damit Kinder vor ihren Eltern feststehen.
  [...knoten]
    .sort((a, b) => knotenEbene(b.nr) - knotenEbene(a.nr))
    .forEach((k) => {
      const kids = kinder[k.nr];
      if (!kids || !kids.length) {
        ergebnis[k.nr] = gespeichert[k.nr] || "";
        return;
      }
      let min = 3;
      kids.forEach((c) => {
        min = Math.min(min, STATUS_RANG[ergebnis[c] || ""]);
      });
      ergebnis[k.nr] = STATUS_FOLGE[min];
    });
  return ergebnis;
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

// Für die Listenansicht: die Grundkosten (ohne Zusatz-/Options-Module).
function schaetzungTotal(data) {
  const zIds = new Set((data.module || []).filter((m) => m.zusatz).map((m) => m.id));
  let gesamt = 0;
  Object.values(data.positionen || {}).forEach((zeilen) => {
    (zeilen || []).forEach((z) => {
      if (!(z.modul && zIds.has(z.modul))) gesamt += zeilenKosten(z, data);
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
        <button type="button" class="bk-toggle" data-action="rename" data-file="${escapeHtml(eintrag.filename)}">Umbenennen</button>
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

function renderKpis(gesamt, gesamtZusatz) {
  const kacheln = [];
  kacheln.push(`<div class="bk-kpi gross">
    <div class="bk-kpi-label">${gesamtZusatz ? "Total ohne Optionen" : "Total"}</div>
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

  // Fortschritt beim gemeinsamen Durchgehen -- erscheint erst, sobald
  // überhaupt etwas abgehakt wurde.
  const abgehakt = Object.keys(offen.status || {}).length;
  if (abgehakt) {
    const dreistellig = BKP_KATALOG.filter(([nr]) => nr.length === 3).map(([nr]) => nr);
    const fertig = dreistellig.filter((nr) => STATUS_RANG[letzterStatus[nr] || ""] >= 2).length;
    kacheln.push(`<div class="bk-kpi">
      <div class="bk-kpi-label">Durchgegangen</div>
      <div class="bk-kpi-wert">${fertig}</div>
      <div class="bk-kpi-sub">von ${dreistellig.length} Positionen</div>
    </div>`);
  }

  if (module_().length) {
    const { summen, ohne } = modulSummen();
    module_().forEach((m) => {
      if (m.zusatz) {
        kacheln.push(`<div class="bk-kpi bk-kpi-zusatz">
          <div class="bk-kpi-label">Option · ${escapeHtml(m.name)}</div>
          <div class="bk-kpi-wert bk-zusatz">+ ${franken(summen[m.id])}</div>
          <div class="bk-kpi-sub">nicht im Total</div>
        </div>`);
      } else {
        kacheln.push(`<div class="bk-kpi bk-kpi-modul" style="--modul-farbe:${modulFarbe(m.id)}">
          <div class="bk-kpi-label">${escapeHtml(m.name)}</div>
          <div class="bk-kpi-wert">${franken(summen[m.id])}</div>
          <div class="bk-kpi-sub">${gesamt ? Math.round((summen[m.id] / gesamt) * 100) : 0}% vom Total</div>
        </div>`);
      }
    });
    if (ohne) {
      kacheln.push(`<div class="bk-kpi bk-kpi-modul">
        <div class="bk-kpi-label">Ohne Modul</div>
        <div class="bk-kpi-wert">${franken(ohne)}</div>
      </div>`);
    }
  }

  if (gesamtZusatz) {
    kacheln.push(`<div class="bk-kpi bk-kpi-inkl">
      <div class="bk-kpi-label">Total inkl. Optionen</div>
      <div class="bk-kpi-wert">CHF ${franken(gesamt + gesamtZusatz)}</div>
    </div>`);
  }

  document.getElementById("kpis").innerHTML = kacheln.join("");
}

// ---------- Rendering: Tabelle ----------

// Das Statuskästchen vor der Nummer. Auf Gruppen ist es nur Anzeige
// (der Stand kommt aus den Kindern, siehe statusBerechnen()), auf
// Blättern klickt es sich durch die vier Stände.
function statusHtml(nr, status, istBlatt) {
  const titel = istBlatt
    ? `${STATUS_LABEL[status]} – klicken zum Weiterschalten`
    : `${STATUS_LABEL[status]} (ergibt sich aus den Positionen darunter)`;
  return `<button type="button" class="bk-status s-${status || "leer"}${istBlatt ? "" : " nuranzeige"}" data-action="status" data-nr="${nr}"${
    istBlatt ? ' data-blatt="1"' : ""
  } title="${escapeHtml(titel)}">${STATUS_ZEICHEN[status] || ""}</button>`;
}

function totalZelleInhalt(summe, zusatz) {
  const basis = summe ? franken(summe) : "";
  return zusatz ? `${basis}<span class="bk-zusatz">+${franken(zusatz)}</span>` : basis;
}

function gruppenZeileHtml(knoten, summe, zusatz, klappbar, offenJetzt, cols, status, istBlatt) {
  const e = knotenEbene(knoten.nr);
  const indent = e === 1 ? "" : ` bk-indent-${e}`;
  let aktionen = "";
  if (e >= 3) {
    aktionen = `<button type="button" class="bk-add-btn" data-action="add-zeile" data-nr="${knoten.nr}">+ Zeile</button>`;
    if (e === 3) {
      aktionen += `<button type="button" class="bk-add-btn" data-action="add-position" data-nr="${knoten.nr}" title="Eigene Unterteilung wie &quot;211.1 Gerüste&quot; ergänzen">+ Unterteilung</button>`;
    }
    if (knoten.eigen) {
      aktionen += `<button type="button" class="bk-row-action" data-action="del-position" data-nr="${knoten.nr}" title="Eigene Unterteilung löschen">×</button>`;
    }
  }
  // Titel spannt von "Beschrieb" bis vor "Kosten", danach folgen die
  // optionalen Spalten und die Aktionsspalte.
  const titelSpan = cols.findIndex((c) => c.key === "kosten") - 1;
  const restSpan = cols.length - cols.findIndex((c) => c.key === "kosten") - 1;
  const klassen = [
    "bk-group",
    `bk-l${e}`,
    summe || zusatz ? "" : "leer",
    status ? `st-${status}` : "",
    klappbar ? "klappbar" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return `<tr class="${klassen}" data-nr="${knoten.nr}"${klappbar ? "" : ' data-fest="1"'}>
    <td class="bk-col-nr${indent}">${statusHtml(knoten.nr, status, istBlatt)}<span class="bk-nr-text">${escapeHtml(knoten.nr)}</span></td>
    <td class="bk-titel" colspan="${titelSpan}">${escapeHtml(knoten.titel)}</td>
    <td class="bk-total bk-right" data-total-for="${knoten.nr}">${totalZelleInhalt(summe, zusatz)}</td>
    ${restSpan > 1 ? `<td colspan="${restSpan - 1}"></td>` : ""}
    <td class="bk-col-aktion">${aktionen}</td>
  </tr>`;
}

// Ausmass- und Kennwert-Zelle: im Feld steht das gerechnete Resultat. Die
// eingetippte Rechnung steht NICHT mehr klein darunter (das war bei
// hunderten Zeilen zu unruhig) -- sie erscheint beim Hineinklicken wieder
// im Feld und hängt zusätzlich als Tooltip daran. Lässt sich eine Eingabe
// nicht rechnen, bleibt sie stehen und wird rot markiert.
function rechenZelle(zeile, feld, cssExtra) {
  const roh = zeile[feld] || "";
  const wert = rechne(roh);
  const ungueltig = isNaN(wert);
  const anzeige = wert === null ? "" : ungueltig ? roh : zahl(wert);
  return `<td><input type="text" class="bk-num ${cssExtra}${ungueltig ? " ungueltig" : ""}" data-feld="${feld}" data-roh="${escapeHtml(roh)}" value="${escapeHtml(anzeige)}" title="${escapeHtml(roh)}"></td>`;
}

function modulSelectHtml(zeile, cssKlasse) {
  const optionen = module_()
    .map((m) => `<option value="${m.id}"${zeile.modul === m.id ? " selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");
  return `<select class="${cssKlasse}" data-feld="modul"><option value="">–</option>${optionen}</select>`;
}

// Zeilen eines Zusatz-/Options-Moduls zeigen ihren Betrag mit "+" und
// abgesetzt -- sie stecken bewusst nicht im Total darüber.
function zeilenKostenText(zeile) {
  const kosten = zeilenKosten(zeile);
  if (!kosten) return "";
  return istZusatzZeile(zeile) ? `<span class="bk-zusatz">+${franken(kosten)}</span>` : franken(kosten);
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
      // Bei einer Prozent-Zeile steht hier der Prozentsatz.
      zellen += rechenZelle(zeile, "ausmass", "bk-ausmass");
    } else if (c.key === "einheit") {
      zellen += zeile.basis
        ? '<td class="bk-fest">%</td>'
        : `<td><input type="text" data-feld="einheit" list="einheitenListe" value="${escapeHtml(zeile.einheit || "")}"></td>`;
    } else if (c.key === "kennwert") {
      // Statt eines Kennwerts zeigt die Prozent-Zeile ihre Bemessungs-
      // grundlage -- sonst wäre nicht nachvollziehbar, worauf sich der
      // Prozentsatz bezieht.
      zellen += zeile.basis
        ? `<td class="bk-fest" title="${escapeHtml(BASIS_ARTEN[zeile.basis] || "")}">${franken(basisBetrag(zeile.basis))}</td>`
        : rechenZelle(zeile, "kennwert", "bk-kennwert");
    } else if (c.key === "kosten") {
      zellen += `<td class="bk-kosten" data-kosten-for="${zeile.id}">${zeilenKostenText(zeile)}</td>`;
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
  const kinder = kinderMap(knoten);
  const status = statusBerechnen(knoten, kinder);
  const { summen, summenZusatz, gesamt, gesamtZusatz } = alleSummen();
  const q = suche.trim().toLowerCase();
  const sucheAktiv = q.length > 0;
  const trefferSet = sucheAktiv ? sichtbarDurchSuche(knoten, q) : null;
  const verwendet = verwendeteKnoten();

  document.getElementById("bkHead").innerHTML =
    "<tr>" + cols.map((c) => `<th class="${c.cls}">${escapeHtml(c.label)}</th>`).join("") + "</tr>";

  let html = "";
  let sichtbareZeilen = 0;

  knoten.forEach((k) => {
    if (sucheAktiv) {
      if (!trefferSet.has(k.nr)) return;
    } else {
      if (ansicht.nurVerwendet && !verwendet.has(k.nr)) return;
      if (vorfahren(k.nr).some((v) => zugeklappt.has(v))) return;
    }

    const kids = kinder[k.nr] || [];
    const eigeneZeilen = knotenEbene(k.nr) >= 3 ? zeilenVon(k.nr).length : 0;
    const klappbar = kids.length > 0 || eigeneZeilen > 0;
    const kinderOffen = sucheAktiv || !zugeklappt.has(k.nr);

    html += gruppenZeileHtml(k, summen[k.nr] || 0, summenZusatz[k.nr] || 0, klappbar, kinderOffen, cols, status[k.nr], !kids.length);
    sichtbareZeilen++;

    if (eigeneZeilen && kinderOffen) {
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
  const fuss = (klasse, text, betrag, marker) => `<tr class="bk-gesamt${klasse}">
    <td class="bk-col-nr"></td>
    <td colspan="${gesamtSpan - 1}">${text}</td>
    <td class="bk-total bk-right"${marker || ""}>${betrag}</td>
    ${restSpan ? `<td colspan="${restSpan}"></td>` : ""}
  </tr>`;

  // Zusatz-/Options-Module stehen unter dem Total als eigene Zeilen, danach
  // folgt das Total inklusive.
  if (gesamtZusatz) {
    const { summen: ms } = modulSummen();
    html += fuss(" bk-gesamt-zusatz", `Total${offen.genauigkeit ? " " + escapeHtml(offen.genauigkeit) : ""} (ohne Optionen)`, "CHF " + franken(gesamt), ' id="gesamtTotalZelle"');
    module_()
      .filter((m) => m.zusatz)
      .forEach((m) => {
        html += fuss(
          " bk-gesamt-zusatz",
          `Option: ${escapeHtml(m.name)}`,
          `<span class="bk-zusatz">+ ${franken(ms[m.id])}</span>`,
          ` data-option-total="${m.id}"`
        );
      });
    html += fuss("", "Total inklusive Optionen", "CHF " + franken(gesamt + gesamtZusatz), ' id="gesamtInklusiveZelle"');
  } else {
    html += fuss("", `Total${offen.genauigkeit ? " " + escapeHtml(offen.genauigkeit) : ""}`, "CHF " + franken(gesamt), ' id="gesamtTotalZelle"');
  }

  document.getElementById("bkBody").innerHTML = html;
  document.getElementById("bkTable").className = "bk-table" + (ansicht.dichte === "kompakt" ? " kompakt" : "");
  autoGrowAlle();
  letzterStatus = status;
  return { gesamt, gesamtZusatz };
}

// Die Höhe des oben klebenden Blocks (Titel, Kennzahlen, Werkzeugleiste)
// ändert sich mit der Fensterbreite und der Zahl der Modul-Kacheln -- die
// Spaltentitel der Tabelle müssen aber exakt darunter einrasten. Deshalb
// wird sie gemessen und als CSS-Variable --bk-sticky-h gesetzt.
function messeSticky() {
  const sticky = document.getElementById("bkSticky");
  const editor = document.getElementById("editorView");
  if (sticky && editor) editor.style.setProperty("--bk-sticky-h", sticky.offsetHeight + "px");
}

function renderEditor() {
  const { gesamt, gesamtZusatz } = renderTabelle();
  renderKpis(gesamt, gesamtZusatz);

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
  messeSticky();
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
  const { summen, summenZusatz, gesamt, gesamtZusatz } = alleSummen();
  document.querySelectorAll("[data-total-for]").forEach((el) => {
    const summe = summen[el.dataset.totalFor] || 0;
    const zusatz = summenZusatz[el.dataset.totalFor] || 0;
    el.innerHTML = totalZelleInhalt(summe, zusatz);
    el.closest("tr").classList.toggle("leer", !summe && !zusatz);
  });
  document.querySelectorAll("[data-kosten-for]").forEach((el) => {
    const zeile = zeileSuchen(offen, el.dataset.kostenFor);
    if (zeile) el.innerHTML = zeilenKostenText(zeile);
  });
  const gesamtZelle = document.getElementById("gesamtTotalZelle");
  if (gesamtZelle) gesamtZelle.textContent = "CHF " + franken(gesamt);
  // Die Options-Zeilen im Tabellenfuss hängen ebenfalls an den Summen --
  // ohne das hier blieben sie nach einer reinen Wertänderung stehen
  // (die Kennzahl-Kachel oben stimmte dann, der Fuss nicht).
  const inklZelle = document.getElementById("gesamtInklusiveZelle");
  if (inklZelle) {
    const { summen: ms } = modulSummen();
    inklZelle.textContent = "CHF " + franken(gesamt + gesamtZusatz);
    document.querySelectorAll("[data-option-total]").forEach((el) => {
      el.innerHTML = `<span class="bk-zusatz">+ ${franken(ms[el.dataset.optionTotal] || 0)}</span>`;
    });
  }
  renderKpis(gesamt, gesamtZusatz);
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
    <label>Berechnung</label>
    <select data-panel-feld="basis">
      <option value=""${zeile.basis ? "" : " selected"}>Ausmass × Kennwert</option>
      ${Object.entries(BASIS_ARTEN)
        .map(([k, label]) => `<option value="${k}"${zeile.basis === k ? " selected" : ""}>${escapeHtml(label)}</option>`)
        .join("")}
    </select>
    ${
      zeile.basis
        ? `<div class="bk-panel-dreispalt">
             <div><label>Prozentsatz</label><input type="text" data-panel-feld="ausmass" value="${escapeHtml(zeile.ausmass || "")}"></div>
             <div style="flex:2;"><label>Bemessungsgrundlage</label><input type="text" value="${franken(basisBetrag(zeile.basis))}" readonly></div>
           </div>
           <div class="hint" style="margin:6px 0 0; font-size:11px;">
             Ohne Hauptgruppe 0 (Grundstück), ohne Optionen und ohne andere
             Prozent-Zeilen – sonst würde sich das Honorar selbst mitrechnen.
           </div>`
        : `<div class="bk-panel-dreispalt">
             <div><label>Ausmass</label><input type="text" data-panel-feld="ausmass" value="${escapeHtml(zeile.ausmass || "")}"></div>
             <div><label>Einheit</label><input type="text" data-panel-feld="einheit" list="einheitenListe" value="${escapeHtml(zeile.einheit || "")}"></div>
             <div><label>Kennwert</label><input type="text" data-panel-feld="kennwert" value="${escapeHtml(zeile.kennwert || "")}"></div>
           </div>`
    }
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
  if (!data.status) data.status = {};
  // basis (Prozent-Berechnung) kam später dazu -- fehlt sie, ist die Zeile
  // eine ganz normale "Ausmass × Kennwert"-Zeile.
  Object.values(data.positionen).forEach((zeilen) => {
    (zeilen || []).forEach((z) => {
      if (z.basis === undefined) z.basis = "";
    });
  });
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
    status: {},
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
function uniqueFilename(base, ausser) {
  const bekannt = new Set(schaetzungen.map((s) => s.filename).filter((f) => f !== ausser));
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
function dateinameFuer(data, ausser) {
  const teile = [data.projekt, data.projektName, data.titel].filter(Boolean);
  return uniqueFilename(sanitizeJsonFilename(teile.join(" ") || "Kostenschätzung"), ausser);
}

// Benennt die Datei auf Nextcloud um, sobald Projekt oder Titel geändert
// wurden -- sonst hiesse die Datei dort dauerhaft wie die erste Fassung.
// Der Worker-Proxy lässt nur GET/PUT/MKCOL/PROPFIND/DELETE durch, ein
// WebDAV-MOVE fällt also aus: erst die neue Datei schreiben, dann die alte
// löschen. In dieser Reihenfolge kann ein Abbruch mittendrin höchstens
// eine Kopie hinterlassen, niemals die Schätzung verlieren.
function planeUmbenennen(alterName, neuerName) {
  if (alterName === neuerName) return;
  if (!isConfigured() || !navigator.onLine) {
    setSyncLine("Offline · Datei wird erst beim nächsten Sync umbenannt");
    return;
  }
  // Die App zeigt ab sofort auf den neuen Namen; nachfolgende Änderungen
  // landen dort. Die Warteschlange erledigt den Rest der Reihe nach.
  offenFilename = neuerName;
  const eintrag = schaetzungen.find((x) => x.filename === alterName);
  if (eintrag) eintrag.filename = neuerName;
  saveJSON(LS_KEYS.cache, schaetzungen);

  // Die Daten werden JETZT festgehalten: schliesst man die Schätzung
  // gleich nach dem Umbenennen (z.B. beim Umbenennen aus der Liste
  // heraus), ist `offen` längst null, wenn die Warteschlange hier ankommt.
  const daten = offen;
  syncQueue = syncQueue.then(async () => {
    try {
      setSyncLine("Benennt um…");
      await ensureBkFolder();
      await putFile(neuerName, daten);
      await deleteFile(alterName);
      // Ein noch laufender Speichervorgang auf den ALTEN Namen kann den
      // Cache-Eintrag zwischenzeitlich wieder angelegt haben -- hier
      // endgültig aufräumen.
      schaetzungen = schaetzungen.filter((x) => x.filename !== alterName);
      if (!schaetzungen.some((x) => x.filename === neuerName)) schaetzungen.push({ filename: neuerName, data: daten });
      saveJSON(LS_KEYS.cache, schaetzungen);
      if (offenFilename === neuerName) setSyncLine("Gespeichert");
      renderList();
    } catch (err) {
      console.warn("Umbenennen fehlgeschlagen:", err);
      setSyncLine("Umbenennen fehlgeschlagen");
    }
  });
  return syncQueue;
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
  return { id: uid(), beschrieb: "", ausmass: "", einheit: "", kennwert: "", basis: "", modul: "", intern: "", extern: "" };
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
  // Die Bemerkungs-Punkte in der Beschrieb-Spalte hängen am Inhalt, und
  // ein Modulwechsel kann die Fusszeilen umbauen (sobald die erste Zeile
  // in ein Zusatz-Modul wandert, kommen "Option"- und "Total inklusive"-
  // Zeilen dazu) -- beides ist strukturell, refreshSummen() genügt nicht.
  if (feld === "basis") {
    // Die Einheit gehört zur Berechnungsart: Prozent-Zeilen rechnen in "%",
    // beim Zurückschalten bleibt das Feld frei zum Neusetzen.
    mutate((data) => {
      const z = (data.positionen[nr] || []).find((x) => x.id === rowId);
      if (z) z.einheit = wert ? "%" : "";
      return data;
    });
    render();
    return;
  }
  if (feld === "modul" || ((feld === "intern" || feld === "extern") && !ansicht.bemerkungen)) {
    renderTabelleErhalten();
  }
}

// Was gerade im fokussierten Feld steht, ist noch NICHT in den Daten:
// change feuert erst beim Verlassen des Feldes. Vor jedem Neuaufbau der
// Tabelle muss die offene Eingabe deshalb übernommen werden, sonst wird
// sie beim Neuzeichnen überschrieben -- z.B. Kennwert tippen und direkt
// daneben das Modul auswählen (das Modul baut die Fusszeilen um).
function uebernimmOffeneEingabe() {
  const el = document.activeElement;
  if (!el || !el.dataset) return;
  const feld = el.dataset.feld || el.dataset.panelFeld;
  if (!feld) return;
  const tr = el.closest ? el.closest("tr.bk-sub") : null;
  const ziel = tr ? { nr: tr.dataset.nr, id: tr.dataset.row } : el.dataset.panelFeld ? gewaehlteZeile : null;
  if (!ziel) return;
  const zeile = zeileSuchen(offen, ziel.id);
  if (!zeile || zeile[feld] === el.value) return;
  if (el.matches && el.matches("input.bk-num")) el.dataset.roh = el.value;
  const wert = el.value;
  mutate((data) => {
    const z = (data.positionen[ziel.nr] || []).find((x) => x.id === ziel.id);
    if (z) z[feld] = wert;
    return data;
  });
}

// Ein Neuaufbau der Tabelle, der die Scrollposition behält -- für
// Änderungen, die nur die Darstellung betreffen (Klappen, Filter, Status,
// Bemerkungs-Punkte). Gescrollt wird die SEITE (siehe Layout-Kommentar in
// index.html), nicht ein innerer Container.
function renderTabelleErhalten() {
  uebernimmOffeneEingabe();
  const scroll = window.scrollY;
  const { gesamt, gesamtZusatz } = renderTabelle();
  renderKpis(gesamt, gesamtZusatz);
  window.scrollTo(0, scroll);
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

function umklappen(nr) {
  if (zugeklappt.has(nr)) zugeklappt.delete(nr);
  else zugeklappt.add(nr);
  renderTabelleErhalten();
}

// Nächste freie Unterteilungsnummer einer Position: 211 -> "211.1", und
// wenn die schon vergeben ist -> "211.2".
function naechsteUnterteilung(nr) {
  const vergeben = ((offen && offen.eigenePositionen) || [])
    .map((p) => p.nr)
    .filter((n) => n.startsWith(nr + "."))
    .map((n) => Number(n.slice(nr.length + 1)))
    .filter((n) => !isNaN(n));
  return `${nr}.${vergeben.length ? Math.max(...vergeben) + 1 : 1}`;
}

function onBodyClick(e) {
  uebernimmOffeneEingabe(); // siehe Kommentar dort
  const btn = e.target.closest("[data-action]");
  if (!btn) {
    // Klick irgendwo auf eine Gruppen-/Positionszeile klappt sie auf und zu.
    // In der Zeile selbst gibt es sonst nichts anzuklicken -- dadurch
    // braucht es keine eigenen Klapp-Dreiecke mehr.
    const zeile = e.target.closest("tr.bk-group.klappbar");
    if (zeile) umklappen(zeile.dataset.nr);
    return;
  }
  const { action, nr, row } = btn.dataset;

  if (action === "status") {
    // Auf Gruppen ist das Kästchen reine Anzeige (der Stand kommt aus den
    // Kindern) -- dort soll der Klick wie überall sonst in der Zeile
    // auf-/zuklappen statt ins Leere zu gehen.
    if (!btn.dataset.blatt) {
      const zeile = btn.closest("tr.bk-group.klappbar");
      if (zeile) umklappen(zeile.dataset.nr);
      return;
    }
    const jetzt = (offen.status || {})[nr] || "";
    const naechster = STATUS_FOLGE[(STATUS_RANG[jetzt] + 1) % STATUS_FOLGE.length];
    mutate((data) => {
      if (!data.status) data.status = {};
  // basis (Prozent-Berechnung) kam später dazu -- fehlt sie, ist die Zeile
  // eine ganz normale "Ausmass × Kennwert"-Zeile.
  Object.values(data.positionen).forEach((zeilen) => {
    (zeilen || []).forEach((z) => {
      if (z.basis === undefined) z.basis = "";
    });
  });
      if (naechster) data.status[nr] = naechster;
      else delete data.status[nr];
      return data;
    });
    renderTabelleErhalten();
    return;
  }

  if (action === "add-zeile") {
    vorfahren(nr).forEach((v) => zugeklappt.delete(v));
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
    const vorschlag = naechsteUnterteilung(nr);
    // Komma wird als Punkt gelesen -- im Büro wird "211,1" genauso
    // geschrieben wie "211.1".
    const eingabe = (prompt(`Eigene Unterteilung von BKP ${nr} – Nummer:`, vorschlag) || "").trim().replace(/,/g, ".");
    if (!eingabe) return;
    if (!eingabe.startsWith(nr + ".") || !/^\d{3}(\.\d+)+$/.test(eingabe)) {
      alert(`Die Nummer muss mit "${nr}." beginnen und mit einer Ziffer enden, z.B. ${vorschlag}.`);
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
    vorfahren(eingabe).forEach((v) => zugeklappt.delete(v));
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
    if (!confirm(anzahl ? `Unterteilung ${nr} mit ${anzahl} Zeile(n) wirklich löschen?` : `Unterteilung ${nr} wirklich löschen?`)) return;
    if (gewaehlteZeile && gewaehlteZeile.nr === nr) gewaehlteZeile = null;
    mutate(
      (data) => {
        data.eigenePositionen = (data.eigenePositionen || []).filter((p) => p.nr !== nr);
        delete data.positionen[nr];
        if (data.status) delete data.status[nr];
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
  const ungueltig = isNaN(berechnet);
  input.value = berechnet === null ? "" : ungueltig ? input.dataset.roh : zahl(berechnet);
  input.classList.toggle("ungueltig", ungueltig);
  input.title = input.dataset.roh || "";
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
  if (action === "rename") {
    const eintrag = schaetzungen.find((x) => x.filename === file);
    if (!eintrag) return;
    const titel = (prompt("Neuer Titel:", eintrag.data.titel || "") || "").trim();
    if (!titel || titel === eintrag.data.titel) return;
    // Zum Umbenennen kurz öffnen -- so laufen Speichern und Umbenennen
    // durch dieselbe Warteschlange wie jede andere Änderung.
    oeffne(file);
    mutate((data) => {
      data.titel = titel;
      return data;
    });
    planeUmbenennen(offenFilename, dateinameFuer(offen, offenFilename));
    zurueckZurListe();
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
  kopfModule = module_().map((m) => ({ ...m }));
  renderKopfModule();
  document.getElementById("kopfGrundlagen").value = offen.grundlagen || "";
  overlay("kopfOverlay", true);
}

function uebernimmKopfDialog() {
  const { projekt, projektName } = projektAusSelect("kopfProjekt");
  const titel = document.getElementById("kopfTitel").value.trim();
  const genauigkeit = document.getElementById("kopfGenauigkeit").value.trim();
  const kostenstand = document.getElementById("kopfKostenstand").value.trim();
  const grundlagen = document.getElementById("kopfGrundlagen").value;
  lesKopfModulNamen();
  const neueModule = kopfModule
    .map((m) => ({ id: m.id, name: m.name.trim(), zusatz: !!m.zusatz }))
    .filter((m) => m.name);
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
  planeUmbenennen(offenFilename, dateinameFuer(offen, offenFilename));
}

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
  optUnterteilungen: "unterteilungen",
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
  const { summen, summenZusatz, gesamt, gesamtZusatz } = alleSummen();
  const verwendet = verwendeteKnoten();
  const mods = opt.modulSpalten ? module_() : [];
  const zIds = zusatzModulIds();
  // Grundkosten und Optionsbeträge in einer Zelle: "45'820  +12'000"
  const betragZelle = (basis, zusatz) =>
    `${basis ? franken(basis) : ""}${zusatz ? ` <span class="pr-formel">+${franken(zusatz)}</span>` : ""}`;

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

    // Eigene Unterteilungen (211.1) werden standardmässig nicht separat
    // ausgewiesen -- ihre Kosten stecken über alleSummen() ohnehin schon
    // in der dreistelligen Position.
    if (e === 4 && !opt.unterteilungen) return;
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
        <td class="r">${betragZelle(summe, summenZusatz[k.nr] || 0)}</td>
        ${mods.length ? modulZellen(modulAnteile(k.nr)) : ""}
        ${opt.bemerkungExtern ? "<td></td>" : ""}
      </tr>`;
      return;
    }

    // Position (dreistellig) bzw. eine separat ausgewiesene Unterteilung
    const posZeilen = opt.unterteilungen ? zeilenVon(k.nr) : zeilenUnter(k.nr);
    if (opt.unterpositionen && posZeilen.length) {
      zeilen += `<tr class="pr-pos">
        <td>${escapeHtml(k.nr)}</td>
        <td>${escapeHtml(k.titel)}</td>
        <td colspan="3"></td>
        <td class="r">${betragZelle(summe, summenZusatz[k.nr] || 0)}</td>
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
          <td class="r">${zahl(rechne(z.ausmass))}${!z.basis && istRechnung(z.ausmass) ? `<div class="pr-formel">${escapeHtml(z.ausmass)}</div>` : ""}</td>
          <td>${z.basis ? "%" : escapeHtml(z.einheit || "")}</td>
          <td class="r">${z.basis ? franken(basisBetrag(z.basis)) : zahl(rechne(z.kennwert))}</td>
          <td class="r">${zeilenKosten(z) ? (istZusatzZeile(z, zIds) ? "+" : "") + franken(zeilenKosten(z)) : ""}</td>
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
      <td>${einzeln ? (einzeln.basis ? "%" : escapeHtml(einzeln.einheit || "")) : ""}</td>
      <td class="r">${einzeln ? (einzeln.basis ? franken(basisBetrag(einzeln.basis)) : zahl(rechne(einzeln.kennwert))) : ""}</td>
      <td class="r">${betragZelle(summe, summenZusatz[k.nr] || 0)}</td>
      ${mods.length ? modulZellen(modulAnteile(k.nr)) : ""}
      ${opt.bemerkungExtern ? `<td>${escapeHtml(bemerkungen.join("; "))}</td>` : ""}
    </tr>`;
  });

  const gesamtModule = mods.length ? modulZellen(modulAnteile("")) : "";
  const leerZellen = `${mods.map(() => "<td></td>").join("")}${opt.bemerkungExtern ? "<td></td>" : ""}`;
  zeilen += `<tr class="pr-gesamt">
    <td></td>
    <td>Total${offen.genauigkeit ? " " + escapeHtml(offen.genauigkeit) : ""}${gesamtZusatz ? " (ohne Optionen)" : ""}</td>
    <td colspan="3"></td>
    <td class="r">CHF ${franken(gesamt)}</td>
    ${gesamtModule}
    ${opt.bemerkungExtern ? "<td></td>" : ""}
  </tr>`;
  if (gesamtZusatz) {
    const { summen: ms } = modulSummen();
    module_()
      .filter((m) => m.zusatz)
      .forEach((m) => {
        zeilen += `<tr><td></td><td>Option: ${escapeHtml(m.name)}</td><td colspan="3"></td><td class="r">+ ${franken(ms[m.id])}</td>${leerZellen}</tr>`;
      });
    zeilen += `<tr class="pr-gesamt"><td></td><td>Total inklusive Optionen</td><td colspan="3"></td><td class="r">CHF ${franken(
      gesamt + gesamtZusatz
    )}</td>${leerZellen}</tr>`;
  }

  let modulBlock = "";
  if (opt.modulSummen && module_().length) {
    const { summen: ms, ohne } = modulSummen();
    const zeilenHtml =
      module_()
        .filter((m) => !m.zusatz)
        .map((m) => `<tr><td>${escapeHtml(m.name)}</td><td class="r">${franken(ms[m.id])}</td></tr>`)
        .join("") +
      (ohne ? `<tr><td>Ohne Modul</td><td class="r">${franken(ohne)}</td></tr>` : "") +
      module_()
        .filter((m) => m.zusatz)
        .map((m) => `<tr><td>Option: ${escapeHtml(m.name)}</td><td class="r">+ ${franken(ms[m.id])}</td></tr>`)
        .join("") +
      `<tr><td>Total${gesamtZusatz ? " inkl. Optionen" : ""}</td><td class="r">${franken(gesamt + gesamtZusatz)}</td></tr>`;
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
  document.getElementById("kopfModulListe").addEventListener("click", onKopfModulClick);
  document.getElementById("kopfModulAddBtn").addEventListener("click", () => {
    lesKopfModulNamen();
    kopfModule.push({ id: uid(), name: "", zusatz: false });
    renderKopfModule();
    const felder = document.querySelectorAll("#kopfModulListe .bk-modul-name");
    if (felder.length) felder[felder.length - 1].focus();
  });
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

  const sticky = document.getElementById("bkSticky");
  if (window.ResizeObserver) new ResizeObserver(messeSticky).observe(sticky);
  window.addEventListener("resize", messeSticky);
  window.addEventListener("scroll", () => sticky.classList.toggle("geklebt", window.scrollY > 4), { passive: true });
  messeSticky();

  window.addEventListener("online", refreshAlle);

  render();
  refreshAppData();
  refreshAlle();

  registerServiceWorkerWithAutoUpdate();
}

document.addEventListener("DOMContentLoaded", init);
