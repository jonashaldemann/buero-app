/* ============================================================
   Baukosten — Kostenschätzung nach BKP (Baukostenplan).

   Ablöser der bisherigen Excel-Vorlage des Büros. Der BKP-Katalog selbst
   (Ausgabe 2017, bis zur vierstelligen Gattung) steht fix in bkp.js und
   ist für alle Schätzungen identisch; eine Schätzung speichert nur das,
   was tatsächlich erfasst wurde:

     positionen: { "224": [ {Unterposition}, ... ], "211.5.10": [ ... ] }
     eigenePositionen: [ { nr: "211.5.10", titel: "Wände" } ]
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
   teilt man sie in zwei Unterpositionen. Jede Position zählt dabei ganz
   normal ins Total -- ein Modul ist eine AUSWERTUNG der Schätzung, keine
   Ausnahme davon.

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
  ansicht: "baukosten_ansicht",
  sicht: "baukosten_letzte_sicht", // wo man in welcher Schätzung zuletzt war
  katalog: "baukosten_katalog_cache" // zuletzt geladener BKP-Katalog, siehe ladeKatalog()
};

const BAUKOSTEN_TARGET_FOLDER_PATH = appModuleFolderPath("Baukosten");

// ---------- BKP-Katalog: Norm von Nextcloud, Grundkatalog aus dem Repo ----------
//
// Die vollständige Norm SN 506 500:2017 ist urheberrechtlich geschützt und
// darf nicht ins öffentliche Repo. Sie liegt deshalb als "_bkp_katalog.json"
// neben den Kostenschätzungen auf Nextcloud und wird nach dem Anmelden
// geladen. Ohne sie (Demomodus, erster Start ohne Netz) gilt der
// mitgelieferte Grundkatalog aus bkp.js -- gröber und an ein paar Stellen
// abweichend, aber brauchbar.
//
// Woher der gerade gültige Katalog stammt, entscheidet zweierlei: ob die
// Sync-Zeile warnt, und ob migriereAuf2017() laufen darf. Gegen einen
// unvollständigen Katalog zu migrieren würde Zeilen in eigene Unterkapitel
// umhängen, nur weil die Norm gerade nicht da ist.
const KATALOG_FILENAME = "_bkp_katalog.json";
let katalogListe = BKP_KATALOG;
let katalogTitel = BKP_TITEL;
let katalogQuelle = "repo"; // "repo" | "cache" | "nextcloud"

function setzeKatalog(liste, quelle) {
  if (!Array.isArray(liste) || !liste.length) return false;
  katalogListe = liste;
  katalogTitel = Object.fromEntries(liste);
  katalogQuelle = quelle;
  return true;
}

// Nur mit der echten Norm (frisch oder aus dem Cache) darf eine Schätzung
// umgeschrieben werden.
function katalogIstVollstaendig() {
  return katalogQuelle !== "repo" || istDemo();
}

// Erst den Cache (sofort da, auch offline), dann die Datei auf Nextcloud.
// Schlägt beides fehl, bleibt der Grundkatalog aus bkp.js stehen.
async function ladeKatalog() {
  // Der Demomodus zeigt bewusst den öffentlichen Grundkatalog -- sonst
  // sähe er nach einem früheren Login plötzlich anders aus als bei allen
  // anderen, und die Demodaten passen zu bkp.js.
  if (istDemo()) return;
  const zwischenstand = loadJSON(LS_KEYS.katalog, null);
  if (zwischenstand) setzeKatalog(zwischenstand.katalog, "cache");
  if (!isConfigured()) return;
  try {
    const daten = await fetchFile(KATALOG_FILENAME); // 404 -> null, kein Fehlerfall
    if (daten && setzeKatalog(daten.katalog, "nextcloud")) saveJSON(LS_KEYS.katalog, daten);
  } catch (e) {
    /* offline o.ä. -- Cache bzw. Grundkatalog bleibt stehen */
  }
}

// ---------- Vorlagen aus der Preisliste (freiwillig, von Nextcloud) ----------
//
// Das Büro pflegt seine Einheitspreise in einem eigenen Programm. Ein
// Export davon darf
// als "_preisliste.json" neben den Kostenschätzungen
// liegen; dann lässt sich im Bearbeitungsfenster eine Position als VORLAGE
// übernehmen, statt den Kennwert von Hand zusammenzusuchen. Die Datei ist
// die Preisdatenbank des Büros und gehört so wenig ins öffentliche Repo wie
// die Norm -- .gitignore fängt eine Arbeitskopie ab.
//
// Alles daran ist freiwillig: fehlt die Datei, verschwindet nur der
// Vorlage-Block, sonst bleibt das Modul, wie es war. Schon übernommene
// Optionen stehen in der Schätzung SELBST und rechnen ohne die Datei
// weiter -- eine Schätzung hängt nach dem Übernehmen nicht mehr an
// die Preisliste.
//
// Aufbau: baum = verschachtelte Knoten
//   { bkp: "201.0" | null, bezeichnung, typ: "ordner" | "position",
//     unterpositionen: [ ... ] }
// Knoten mit typ "position" zusätzlich:
//   { einheit, projekt: { menge, einheitspreis, netto },
//     optionen: [ { aktiv, text, preis, preisEinheit, menge, mengeEinheit,
//                   vorlagePreis } ] }
// Einheitspreis = Summe (preis × menge) aller Optionen mit aktiv = true.
const PREISLISTE_FILENAME = "_preisliste.json";
const PFAD_TRENNER = " › ";

let preislisteBaum = null; // Liste von Wurzelknoten, null = keine Datei
let preislisteFlach = null; // Zwischenspeicher: alle Knoten samt Pfad
let preislistePromise = null; // läuft der Ladevorgang gerade?
let preislisteFehlt = false; // 404: das Büro führt keine Vorlagen-Datei
let preislisteFehler = ""; // Netz-/Formatfehler, damit man nicht ins Leere schaut
// Nur ein NETZfehler lohnt einen neuen Versuch -- eine Datei ohne Baum
// wird durchs Wiederholen nicht besser, und der Export ist 6 MB.
let preislisteWiederholbar = false;

function setzePreisliste(baum) {
  // Die Datei darf eine Liste oder einen einzelnen Wurzelknoten enthalten.
  const liste = Array.isArray(baum) ? baum : baum && typeof baum === "object" ? [baum] : null;
  if (!liste || !liste.length) return false;
  preislisteBaum = liste;
  preislisteFlach = null;
  preislisteKnotenCache = null;
  preislisteNrMapCache = null;
  return true;
}

// Geholt wird die Datei ERST beim ersten Öffnen des Bearbeitungsfensters,
// nicht beim Start: der Export des Büros ist rund 6 MB (4200 Positionen mit
// 12600 Optionen), und die allermeisten Sitzungen brauchen ihn nie. Aus
// demselben Grund liegt er NICHT im localStorage -- 6 MB dort würden den
// Platz sprengen, den die Schätzungen selbst für den Offline-Betrieb
// brauchen. Offline gibt es deshalb keine Vorlagen; die bereits
// übernommenen Optionen stehen in der Schätzung und rechnen weiter.
function ladePreislisteBeiBedarf() {
  // Wie beim Katalog: im Demomodus bewusst nichts -- die Preise des Büros
  // haben in einer Demositzung nichts verloren.
  if (istDemo() || !isConfigured() || !navigator.onLine) return;
  if (preislistePromise) return;
  preislisteFehler = "";
  preislistePromise = (async () => {
    renderGliederungHinweis(); // "wird geladen …", sobald es losgeht
    try {
      const daten = await fetchFile(PREISLISTE_FILENAME); // 404 -> null, kein Fehlerfall
      if (daten && setzePreisliste(daten.baum)) {
        /* da */
      } else if (daten) {
        // Datei da, aber ohne brauchbaren Baum -- das ist ein Fehler und
        // kein "gibt es nicht".
        preislisteFehler = "Datei enthält keinen Baum";
        preislisteWiederholbar = false;
        preislistePromise = null;
      } else {
        preislisteFehlt = true; // gibt es nicht -- nicht bei jedem Öffnen neu fragen
        console.info(
          `Keine Vorlagen: "${PREISLISTE_FILENAME}" liegt nicht in ${BAUKOSTEN_TARGET_FOLDER_PATH}.`
        );
      }
    } catch (e) {
      // Netzfehler: beim nächsten Öffnen noch einmal versuchen. Ohne das
      // bliebe der Hinweis "Vorlagen werden geladen …" für immer stehen.
      preislisteFehler = (e && e.message) || "unbekannter Fehler";
      preislisteWiederholbar = true;
      preislistePromise = null;
    }
    // Egal wie es ausgegangen ist: der Zustand gehört an den Baum, nicht
    // nur ins Bearbeitungsfenster (siehe renderGliederungHinweis()).
    renderGliederungHinweis();
    // Der Baum kennt die Gliederung jetzt -- neu zeichnen. Die Ebene wird
    // dabei neu gesetzt, damit die leeren Kapitel der Preisliste zugeklappt
    // starten (siehe setzeEbene()).
    if (offen && preislisteBaum) {
      setzeEbene(ansicht.ebene);
    }
    // Jetzt steht der Baum -- erst jetzt lässt sich das gemerkte Kapitel
    // öffnen und die Stelle in der Tabelle wiederfinden.
    stelleSichtHer();
    // Gibt es gar keine Vorlagen-Datei, hat der Auswahl-Dialog nichts zu
    // zeigen: dann weiter wie früher, Zeile anlegen und lostippen. Beim
    // Wechseln einer bestehenden Zeile bleibt der Hinweis stehen -- dort
    // ist das Anlegen keine sinnvolle Antwort.
    if (vorlagenZiel && preislisteFehlt && !vorlagenZiel.rowId) {
      const { nr } = vorlagenZiel;
      schliesseVorlagenWahl();
      legeZeileAn(nr, { mitFenster: ansichtModus === "kapitel" });
      return;
    }
    // Steht der Auswahl-Dialog offen, füllt sich die Liste jetzt. Das
    // Suchfeld wird dabei neu gebaut -- deshalb den Fokus zurückgeben.
    if (vorlagenZiel) {
      const stand = vorlageSuche;
      zeichneVorlagenWahl();
      const feld = document.getElementById("vorlageSuche");
      if (feld) {
        feld.value = stand;
        feld.focus();
      }
    }
  })();
}

// ---------- Zustand der Gliederung, SICHTBAR am Baum ----------
//
// Der Baum unterhalb der BKP-Nummer kommt aus der Preisliste, und die wird
// JE GERÄT geladen. Scheitert das, fehlen genau diese Kapitel -- man sieht
// einen anderen Baum als die andere Person, ohne es zu merken: gemeldet
// wurde ein Fehler bis November 2026 nur im Vorlagen-Block INNERHALB des
// Bearbeitungsfensters, und "lädt noch" / "geladen" / "gescheitert" sahen
// im Baum identisch aus. Genau so ist es passiert ("bei mir sind
// Positionen aufgetaucht, die mein Kollege nicht hat").
//
// Der 404 bleibt still: dass das Büro gar keine Vorlagen-Datei führt, ist
// ein gültiger Zustand -- dann sehen auch alle dasselbe.
let gliederungStand = null;

function renderGliederungHinweis() {
  const el = document.getElementById("preislisteHinweis");
  if (!el) return;
  const html = preislisteLaedt()
    ? "Gliederung der Preisliste wird geladen …"
    : preislisteFehler
    ? `Gliederung der Preisliste nicht geladen (${escapeHtml(preislisteFehler)}) – die ` +
      "Kapitel unterhalb der BKP-Nummern fehlen hier, andere sehen an dieser Schätzung mehr. " +
      '<button type="button" class="bk-toggle" data-gliederung="neu">Nochmals versuchen</button>'
    : "";
  // Der Live-Takt ruft das oft -- nur anfassen, wenn sich wirklich etwas
  // ändert, sonst flackert der Knopf und messeSticht() läuft umsonst.
  if (html === gliederungStand) return;
  gliederungStand = html;
  el.innerHTML = html;
  el.classList.toggle("fehler", !!preislisteFehler);
  el.hidden = !html;
  messeSticky();
}

// Von Hand nochmals versuchen (Knopf im Hinweis).
function wiederholeGliederung() {
  preislistePromise = null;
  preislisteFehler = "";
  gliederungNaechsterVersuch = 0;
  renderGliederungHinweis();
  ladePreislisteBeiBedarf();
}

// Bisher wurde ein gescheitertes Laden erst beim nächsten ÖFFNEN der
// Schätzung wiederholt -- die liegt aber stundenlang offen. Der Live-Takt
// nimmt es mit, höchstens einmal pro Minute: ein Fehlversuch im
// Sekundentakt zöge 6 MB und brächte nichts.
const GLIEDERUNG_WIEDER_MS = 60000;
let gliederungNaechsterVersuch = 0;

function versucheGliederungNochmals() {
  if (!offenFilename || !preislisteFehler || !preislisteWiederholbar) return;
  if (preislistePromise || Date.now() < gliederungNaechsterVersuch) return;
  gliederungNaechsterVersuch = Date.now() + GLIEDERUNG_WIEDER_MS;
  ladePreislisteBeiBedarf();
}

// Läuft der Ladevorgang noch? Dann steht im Fenster ein Hinweis statt
// nichts -- 6 MB dauern auf dem Telefon einen Moment. Gescheitert oder gar
// nicht vorhanden heisst dagegen: gar kein Block, wie ohne die Datei.
function preislisteLaedt() {
  return !!preislistePromise && !preislisteBaum && !preislisteFehlt;
}

// ---------- Die Preisliste als Knoten im Baum ----------
//
// Unterhalb der BKP-Nummer hört die Norm auf -- dort gliedert die Preisliste
// weiter ("211.5 Beton- und Stahlbetonarbeiten" > "Wände" > "Innenwände" >
// "Wandstärke 18 cm"), und genau diese Gliederung zeigt der Baum, gleich
// organisiert wie der nummerierte Teil darüber, nur ohne Nummern.
//
// Die Knoten sind VIRTUELL: sie stehen in keiner Schätzungsdatei. Erst wer
// etwas erfasst, schreibt sein Kapitel hinein (materialisiereKnoten()) --
// sonst stünden in jeder Schätzung über fünftausend leere Kapitel.
//
// Die Kennung ist <eltern>.<lfd> ab 1000, damit sie nie mit einer von Hand
// angelegten Unterteilung kollidiert (die zählt ab 10) und nie mit einer
// Gattung (.0-.9). Angezeigt wird sie nirgends (istEigen/knotenLabel).
const PREISLISTE_NR_START = 1000;
let preislisteKnotenCache = null;
let preislisteNrMapCache = null;

function preislisteKnoten() {
  if (preislisteKnotenCache) return preislisteKnotenCache;
  const liste = [];
  if (!preislisteBaum) return (preislisteKnotenCache = liste);
  const unter = (knoten, elternNr, pfad) => {
    let i = PREISLISTE_NR_START;
    preislisteKinder(knoten).forEach((k) => {
      // Trägt das Kind selbst eine BKP-Nummer, gehört es dorthin und nicht
      // unter diesen Knoten -- sonst stünde 211.5 nochmals unter 211.
      if (k.bkp) return;
      const nr = `${elternNr}.${i++}`;
      const eigenerPfad = [...pfad, String(k.bezeichnung || "")];
      liste.push({
        nr,
        titel: String(k.bezeichnung || ""),
        knoten: k,
        pfadText: eigenerPfad.join(PFAD_TRENNER)
      });
      unter(k, nr, eigenerPfad);
    });
  };
  preislisteAlle().forEach((e) => {
    if (e.knoten.bkp) unter(e.knoten, String(e.knoten.bkp), e.pfad);
  });
  preislisteKnotenCache = liste;
  return liste;
}

function preislisteNrMap() {
  if (!preislisteNrMapCache) {
    preislisteNrMapCache = new Map();
    preislisteKnoten().forEach((k) => preislisteNrMapCache.set(k.nr, k));
  }
  return preislisteNrMapCache;
}

// Der Preislisten-Knoten hinter einer Nummer -- für Titel, Optionen und die
// Frage, ob es eine erfassbare Position ist.
function preislisteZuNr(nr) {
  return preislisteNrMap().get(nr) || null;
}

// Eine erfassbare Position (das unterste Glied, wo Einheit und Optionen
// hängen) gegenüber einem blossen Gliederungsordner.
function istPreislistePosition(nr) {
  const k = preislisteZuNr(nr);
  return !!k && k.knoten.typ === "position";
}

// Ein EIGENES Unterkapitel ohne weitere Gliederung und mit GENAU EINER
// Zeile ist eine eigene Endposition ("Dach anheben"): Es steht auf derselben
// Ebene wie die Preislisten-Positionen daneben, trägt wie diese Häkchen und
// Frage (die hängen an der Nummer, eine lose Zeile hätte keine), und ein
// Klick öffnet direkt das Fenster. Erst ab der zweiten Zeile ist es wieder
// ein Kapitel zum Hineingehen -- gleich wie bei der Preisliste.
// kids: die Kinder, falls schon bekannt (im Tabellen-Rendering), sonst
// werden sie hier geholt.
function istEigeneEndposition(nr, kids) {
  if (!nr || !istEigen(nr) || preislisteZuNr(nr)) return false;
  const kinder = kids || kinderVon(nr);
  return !kinder.length && zeilenVon(nr).length === 1;
}

// Ist der Knoten selbst eine POSITION (das unterste Glied, an dem Zeilen
// hängen) statt eines Kapitels mit Positionen darin? Dann heisst "dazu"
// eine weitere ZEILE ("Innenwände EG" / "OG"), sonst eine neue Position.
// Das gilt für Preislisten-Positionen und für eigene Endpositionen, auch
// wenn diese schon zwei Zeilen haben.
function istPositionsKnoten(nr) {
  if (!nr) return false;
  if (istPreislistePosition(nr)) return true;
  return istEigen(nr) && !preislisteZuNr(nr) && !kinderVon(nr).length && zeilenVon(nr).length > 0;
}

// Die Knöpfe zum Ergänzen unter einem Knoten -- gleich in der Tabelle und
// in der Kapitelansicht. "+ Position" legt in EINEM Schritt eine eigene
// Endposition an (Unterkapitel samt einer Zeile, mit Häkchen und Frage);
// "+ Unterkapitel" ist nur noch für die Gliederung ("Wände" › "Innenwände").
// In einer Position selbst gibt es stattdessen "+ Zeile".
function ergaenzenKnoepfe(nr) {
  const n = escapeHtml(nr);
  if (istPositionsKnoten(nr)) {
    return `<button type="button" class="bk-add-btn" data-action="add-zeile" data-nr="${n}" title="Weitere Zeile in dieser Position, z.B. &quot;EG&quot; und &quot;OG&quot;">+ Zeile</button>`;
  }
  return (
    `<button type="button" class="bk-add-btn" data-action="add-endposition" data-nr="${n}" title="Eigene Position wie &quot;Dach anheben&quot; ergänzen">+ Position</button>` +
    `<button type="button" class="bk-add-btn" data-action="add-position" data-nr="${n}" title="Eigenes Unterkapitel wie &quot;Wände&quot; ergänzen">+ Unterkapitel</button>`
  );
}

function preislisteKinder(knoten) {
  return Array.isArray(knoten && knoten.unterpositionen) ? knoten.unterpositionen : [];
}

// Alle Knoten des Baums, jeder mit seinem Pfad von ganz oben. Der PFADTEXT
// ist zugleich die Kennung einer Vorlage (sie landet in zeile.vorlage.pfad)
// -- der Baum hat keine IDs, und ein Pfad ist beim Nachschauen in der Preisliste
// deutlich brauchbarer als eine Nummer.
function preislisteAlle() {
  if (!preislisteFlach) {
    preislisteFlach = [];
    if (preislisteBaum) {
      const gehe = (knoten, pfad) => {
        const eigener = [...pfad, String(knoten.bezeichnung || "")];
        preislisteFlach.push({ knoten, pfad: eigener, pfadText: eigener.join(PFAD_TRENNER) });
        preislisteKinder(knoten).forEach((k) => gehe(k, eigener));
      };
      preislisteBaum.forEach((k) => gehe(k, []));
    }
  }
  return preislisteFlach;
}

function preislistePositionen() {
  return preislisteAlle().filter((e) => e.knoten.typ === "position");
}

function preislisteNachPfad(pfadText) {
  return preislistePositionen().find((e) => e.pfadText === pfadText) || null;
}

function gleicheBezeichnung(a, b) {
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  return !!norm(a) && norm(a) === norm(b);
}

// Der Knoten, unter dem die Vorlagen für eine BKP-Nummer stehen: die
// tiefste Nummer, die der Baum selbst führt. Liegt die Katalognummer tiefer
// (201.0.1, während der Baum nur 201.0 kennt), wird von dort über die
// BEZEICHNUNG weitergesucht -- unterhalb der Gattung gliedert die Preisliste in
// Ordnern, die gleich heissen wie die Positionen im Katalog.
function preislisteKnotenFuer(nr) {
  if (!preislisteBaum || !nr) return null;
  const kette = [nr, ...vorfahren(nr)]; // von innen nach aussen
  for (let i = 0; i < kette.length; i++) {
    const treffer = preislisteAlle().find((e) => String(e.knoten.bkp || "") === kette[i]);
    if (!treffer) continue;
    let eintrag = treffer;
    for (let j = i - 1; j >= 0; j--) {
      const titel = knotenTitel(kette[j]);
      const kind = preislisteKinder(eintrag.knoten).find(
        (k) => k.typ !== "position" && gleicheBezeichnung(k.bezeichnung, titel)
      );
      if (!kind) break; // nicht gefunden -> beim gröberen Knoten bleiben
      eintrag = preislisteAlle().find((e) => e.knoten === kind) || eintrag;
    }
    return eintrag;
  }
  return null;
}

let schaetzungen = loadJSON(LS_KEYS.cache, []); // [{ filename, data }]
let projectList = appConfig.projekte;

let offen = null; // die gerade geöffnete Schätzung (data), null = Listenansicht
let offenFilename = null;

// Ansichtszustand: bewusst NICHT Teil der Datei, sondern pro Gerät in
// localStorage -- zwei Leute dürfen dieselbe Schätzung gleichzeitig
// unterschiedlich tief aufgeklappt anschauen.
//
// "Nur verwendete", Bemerkungsspalten und Dichte gelten für ALLE
// Schätzungen gleich. Wo man WAR -- Modus, offenes Kapitel, Ebene und die
// Stelle in der Tabelle -- hängt dagegen an der einzelnen Schätzung und
// steht in LS_KEYS.sicht (siehe merkeSicht()). Ebene 1 ist nur noch der
// Startwert für eine Schätzung, die man das erste Mal öffnet.
const ansichtDefaults = { ebene: 1, nurVerwendet: false, bemerkungen: false };
let ansicht = { ...ansichtDefaults, ...loadJSON(LS_KEYS.ansicht, {}) };
let suche = "";
// Ansicht: "tabelle" (die lange Liste) oder "kapitel" (eine Ebene auf
// einmal, wie ein Steuerformular).
let ansichtModus = "tabelle";
let kapitelKnoten = ""; // "" = Übersicht (alle Hauptgruppen)
let zugeklappt = new Set(); // Knoten-Nummern, die zugeklappt sind
let gewaehlteZeile = null; // { nr, id } der im Bearbeitungsfenster gezeigten Unterposition
// Suchtext im Vorlagen-Block. Gilt nur für das offene Fenster und wird beim
// Wechsel der Zeile zurückgesetzt -- gesucht wird nach einer Vorlage für
// DIESE Position, nicht dauerhaft gefiltert.
let vorlageSuche = "";
// Zuletzt gerechneter Stand je Knoten ({ anzahl, kuerzel, gelb, fragen }).
// Gebraucht beim Klick auf das Kästchen einer Gruppe: dort wird vom
// ANGEZEIGTEN (abgeleiteten) Stand aus entschieden, und der steht nur hier.
let letzterStatus = {};

// Gedämpfte Farbtöne für die Modul-Markierungen (Strich in der Tabelle,
// Rand an der Kennzahl-Kachel) -- aus derselben Palette wie die
// Startseiten-Kacheln, bewusst zurückhaltend.
const MODUL_FARBEN = ["#4F7089", "#8F9A85", "#C97960", "#8C6E86", "#BF9B4F", "#4A7856", "#7A95A6", "#8A7458"];

// ---------- Durchgehen zu zweit: Häkchen und Fragen ----------
//
// Jede Person setzt NUR IHR EIGENES Häkchen, und niemand kann das des
// Partners entfernen -- damit ist das Vieraugenprinzip nicht mehr eine
// Regel, die man prüfen muss, sondern folgt aus der Datenstruktur:
//
//   haken:  { "<bkp-nr>": ["JH"] }        ein Kürzel je Person, höchstens
//                                          ZWEI (die dritte Person kommt
//                                          nicht mehr dazu, siehe
//                                          setzeHaken()).
//   fragen: { "<bkp-nr>": "MV" }          wer eine Frage offen hat.
//
// Beides hängt an der BKP-NUMMER, nicht an der einzelnen Zeile: gefragt
// wird zu einer Position ("Spenglerarbeiten"), nicht zu jeder Zeile im
// Bearbeitungsfenster. Eine Gruppe darf eine EIGENE Frage tragen, die sich
// nicht nach unten vererbt -- angezeigt wird zusätzlich, wie viele Fragen
// in ihrem Ast offen sind.
//
// GELB gibt es nicht als gespeicherten Stand: es ist schlicht "hat einen
// Betrag, aber noch kein Häkchen" und wird immer gerechnet. Bis November
// 2026 gab es dafür einen gemeinsamen `status` je Nummer
// (offen/pendent/erledigt/verifiziert) plus `geprueft`; migriere() wandelt
// das um und räumt die alten Felder weg.
const HAKEN_MAX = 2;

function hakenVon(nr) {
  const liste = (offen && offen.haken && offen.haken[nr]) || [];
  return Array.isArray(liste) ? liste.filter(Boolean) : [];
}
function frageVon(nr) {
  const wer = offen && offen.fragen && offen.fragen[nr];
  return typeof wer === "string" && wer ? wer : "";
}

// Die Initialen eines Namens: erster Buchstabe des ersten und des LETZTEN
// Wortes ("Jonas Haldemann" -> JH, "Anna von Gunten" -> AG). Ein einzelnes
// Wort gibt seine ersten zwei Buchstaben her.
function initialen(name) {
  const teile = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!teile.length) return "";
  const roh = teile.length > 1 ? teile[0][0] + teile[teile.length - 1][0] : teile[0].slice(0, 2);
  return roh.toUpperCase();
}

// Das Kürzel der angemeldeten Person -- IMMER aus dem Namen gebildet, nie
// aus `mitarbeitende[].key`: der Schlüssel in config.json ist eine interne
// Kennung und darf beliebig lang sein ("jonas"), im Kästchen stünde dann
// "JONAS" statt "JH". config.json liefert nur die volle Schreibweise des
// Namens, falls man mit einem Benutzernamen angemeldet ist.
function meinKuerzel() {
  const angemeldet = (personName() || "").trim();
  if (!angemeldet) return "";
  const gleich = (a) => (a || "").trim().toLowerCase() === angemeldet.toLowerCase();
  const liste = (typeof appConfig !== "undefined" && appConfig.mitarbeitende) || [];
  const treffer = liste.find((m) => gleich(m.name) || gleich(m.key));
  return initialen((treffer && treffer.name) || angemeldet);
}

function kuerzelText(liste) {
  return liste.map((k) => String(k).toUpperCase()).join("/");
}

// Mein Häkchen auf einer Liste setzen oder wegnehmen. `an` erzwingt die
// Richtung (für den Gruppenklick, der alles darunter gleich setzt); ohne
// Angabe wird umgeschaltet. Stehen schon zwei ANDERE drin, passiert nichts
// -- die dritte Person prüft nicht mit (besprochen im November 2026: tritt
// der Fall ein, redet man miteinander, statt es zu konfigurieren).
function mitHaken(bisher, ich, an) {
  if (!ich) return bisher;
  const drin = bisher.includes(ich);
  const soll = an === undefined ? !drin : !!an;
  if (soll === drin) return bisher;
  if (soll) return bisher.length >= HAKEN_MAX ? bisher : [...bisher, ich];
  return bisher.filter((k) => k !== ich);
}

// MwSt: Kennwerte werden exklusive erfasst (so kommen sie aus Richtofferten
// und Kennwert-Sammlungen), die Kostenspalte und alle Summen zeigen den
// Betrag inklusive -- der Bauherr will wissen, was er am Schluss zahlt.
// Der Satz gehört zur Schätzung (Kostenstand!), nicht ins Programm, und
// steht deshalb in den Kopfdaten; 8.1% ist nur der Startwert.
const MWST_DEFAULT = 8.1;

const DRUCK_DEFAULTS = {
  nurVerwendete: true,
  alleHauptgruppen: true,
  unterpositionen: false,
  unterteilungen: false,
  bemerkungExtern: true,
  modulSpalten: false,
  modulSummen: true,
  modulSeiten: false
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

// Eine Zeile mit PREISPOSITIONEN trägt einen Einheitspreis (CHF pro m2, m3,
// Stk): ohne Ausmass ist noch gar nicht gesagt, wie viel davon gebaut wird.
// Sie zählt deshalb nichts, bis dort eine Zahl steht -- sonst legt schon das
// Anklicken einer Position in der Preisliste Geld in die Schätzung, bloss
// weil dort Häkchen gesetzt sind. VON HAND erfasste Zeilen bleiben wie
// bisher: dort heisst ein leeres Ausmass weiterhin "einmal", damit eine
// Pauschal-/Budgetzeile ohne das Pseudo-Ausmass "1 Pausch" auskommt (siehe
// Dateikopf) -- bestehende Schätzungen rechnen also unverändert weiter.
function ausmassFehlt(zeile) {
  if (!zeile || zeile.basis) return false;
  if (!optionenVon(zeile).length) return false;
  return rechne(zeile.ausmass) === null;
}
function ausmassWert(zeile) {
  if (ausmassFehlt(zeile)) return 0;
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

function mwstSatz(data) {
  const quelle = data || offen;
  const v = quelle && quelle.mwst;
  return typeof v === "number" && isFinite(v) && v >= 0 ? v : 0;
}
function mwstFaktor(data) {
  return 1 + mwstSatz(data) / 100;
}
// "Total ±25% inkl. 8.1% MwSt" -- die Beschriftung steht unter der Tabelle
// und im Ausdruck, damit nie offen bleibt, ob die Zahl inklusive ist.
function totalBeschriftung() {
  const satz = mwstSatz();
  return (
    "Total" +
    (offen.genauigkeit ? " " + offen.genauigkeit : "") +
    (satz ? ` inkl. ${zahl(satz)}% MwSt` : " exkl. MwSt")
  );
}
// Die Zeile über der Modul-Aufstellung: das Grundtotal ohne alles, was
// einem Modul zugeordnet ist.
function grundTotalBeschriftung() {
  return "Total" + (offen.genauigkeit ? " " + offen.genauigkeit : "") + " ohne Module";
}
// Lohnt sich die Aufstellung überhaupt? Nur wenn wenigstens ein Modul
// einen Betrag hat -- sonst stünde dreimal dieselbe Zahl untereinander.
function modulAufstellung() {
  if (!module_().length) return null;
  const { summen, ohne } = modulSummen();
  if (!module_().some((m) => summen[m.id])) return null;
  return { summen, ohne };
}

// ---------- Prozent-Zeilen (Honorar auf die Baukosten) ----------
//
// Eine Unterposition kann statt "Ausmass × Kennwert" auch als PROZENTSATZ
// der Baukosten gerechnet werden -- gedacht fürs Architektenhonorar (BKP
// 291), das sich damit automatisch mitbewegt, wenn sich die Schätzung
// ändert. Die übrigen Honorare werden weiterhin pauschal erfasst.
//
// zeile.basis = "bkp19ohneHonorar" macht die Zeile zur Prozent-Zeile;
// zeile.ausmass hält dann den Prozentsatz (Einheit "%"), der Kennwert
// entfällt.
//
// Es gibt bewusst nur EINE Bemessungsgrundlage: die Baukosten BKP 1-9 ohne
// die Honorar-Elementgruppen. Eine zweite Variante "mit Honoraren" gab es
// kurz, sie ist aber nicht gebräuchlich -- ein Honorar auf Honorare zu
// rechnen will niemand, und die Wahl war nur eine Stolperstelle.
//
// ZIRKELSCHLUSS: BKP 291 liegt selbst in Hauptgruppe 2 und wäre damit Teil
// seiner eigenen Bemessungsgrundlage. Deshalb zählen Prozent-Zeilen NIE in
// die Basis. Ebenfalls draussen: die Hauptgruppe 0 (Grundstück ist keine
// Baukost) und die Honorargruppen x9x.
const BASIS_ART = "bkp19ohneHonorar";
const BASIS_LABEL = "% der Baukosten (BKP 1–9 ohne Honorare)";

function basisBetrag(data) {
  const quelle = data || offen;
  if (!quelle) return 0;
  let summe = 0;
  Object.keys(quelle.positionen || {}).forEach((nr) => {
    if (nr[0] === "0") return; // Grundstück
    // Die Honorar-Elementgruppen enden auf 9 (09, 19, 29, ... 99).
    if (nr[1] === "9") return;
    (quelle.positionen[nr] || []).forEach((z) => {
      if (z.basis) return; // siehe Zirkelschluss oben
      summe += einfacheKosten(z);
    });
  });
  return summe;
}

// Der MwSt-Zuschlag UND die Rundung sitzen bewusst an GENAU EINER Stelle
// (zeilenKosten()): alles darunter (einfacheKosten, zeilenNetto,
// basisBetrag) rechnet exklusive und ungerundet, alles darüber (Summen,
// Kennzahlen, Ausdruck) geht über zeilenKosten() und ist damit inklusive
// und auf 100 gerundet. Insbesondere bleibt die Bemessungsgrundlage der
// Prozent-Zeilen exklusive -- das Honorar wird auf die Netto-Baukosten
// gerechnet und dann selbst versteuert, nicht auf einen Betrag, in dem die
// MwSt schon steckt.
// Was die Zeile OHNE MwSt kostet -- die Grundlage für zeilenKosten() und
// die hellere Zahl neben dem Total im Bearbeitungsfenster.
function zeilenNetto(zeile, data) {
  const netto = zeile.basis
    ? ((rechne(zeile.ausmass) || 0) / 100) * basisBetrag(data)
    : einfacheKosten(zeile);
  return isNaN(netto) ? 0 : netto;
}

// JEDE POSITION wird auf die nächsten 100 Franken gerundet (auf oder ab, je
// nachdem was näher liegt). Eine Kostenschätzung ist nie frankengenau --
// "CHF 616" täuscht eine Genauigkeit vor, die es nicht gibt. Gerundet wird
// der Betrag INKLUSIVE MwSt, also genau die Zahl, die in der Kostenspalte
// steht; damit sind auch jede Gruppensumme und das Gesamttotal Vielfache
// von 100. Netto bleibt alles darunter (einfacheKosten, basisBetrag, die
// Bemessungsgrundlage der Prozent-Zeilen) ungerundet.
// Eine Zeile unter 50 Fr. wird damit zu 0 und zeigt eine leere Kostenzelle
// -- bewusst so gewünscht, in einer Baukostenschätzung gibt es keine
// Positionen dieser Grössenordnung.
const RUNDUNG = 100;

function aufHundert(betrag) {
  return isFinite(betrag) ? Math.round(betrag / RUNDUNG) * RUNDUNG : 0;
}

function zeilenKosten(zeile, data) {
  return aufHundert(zeilenNetto(zeile, data) * mwstFaktor(data));
}

// ---------- Preispositionen einer Unterposition ----------
//
// Eine übernommene Vorlage bringt ihre Optionen mit; der Kennwert ist dann
// deren Summe (Preis × Menge über alles, was ANGEHAKT ist). Mehr als ein
// Häkchen je Zeile gibt es nicht -- genau wie in der Preisliste selbst.
// In der Oberfläche heissen sie PREISPOSITIONEN: um eine 18-cm-Betonwand
// zu erstellen, braucht es Beton, Betonstahl, Schalung, Abschalung -- das
// sind keine "Optionen", sondern die Posten, aus denen sich der Preis
// zusammensetzt. Der Schlüssel in den Dateien bleibt `optionen`, sonst
// müsste jede bestehende Schätzung umgeschrieben werden (wie bei
// verifiziert/"Vieraugenprinzip").
// Bis November 2026 trug jede Preisposition zusätzlich eine ART
// (Variante/Bestandteil/Zuschlag) und die Liste war danach in aufklappbare
// Gruppen geteilt. Das war unübersichtlich: man sah nie alle Posten auf
// einmal, obwohl genau das die Frage ist ("woraus setzt sich der Preis
// zusammen?"). Das Feld `typ` steht in älteren Dateien noch, wird aber
// nicht mehr gelesen -- migriere() sorgt dafür, dass ein früherer
// "Bestandteil" angehakt ist, denn der zählte auch ohne Häkchen.

function optionenVon(zeile) {
  return Array.isArray(zeile && zeile.optionen) ? zeile.optionen : [];
}

// Preis und Menge dürfen wie Ausmass und Kennwert eine Rechnung sein; aus
// der Datei kommen sie als Zahl.
function optionZahl(wert) {
  const v = rechne(wert);
  return v === null || isNaN(v) ? 0 : v;
}

function optionBetrag(opt) {
  return optionZahl(opt.preis) * optionZahl(opt.menge);
}

// Zählt die Preisposition in den Kennwert? Allein das Häkchen entscheidet
// -- die früheren Arten (Variante/Bestandteil/Zuschlag) waren nur eine
// Darstellung, und drei Gruppen über ein Dutzend Zeilen gaben weniger her
// als eine Liste mit einer Spalte zum An- und Abwählen.
function optionZaehlt(opt) {
  return !!opt.aktiv;
}

function optionenSumme(zeile) {
  return optionenVon(zeile).reduce((s, o) => s + (optionZaehlt(o) ? optionBetrag(o) : 0), 0);
}

// Der gerechnete Kennwert als TEXT -- im selben Format wie ein von Hand
// getippter (siehe Dateikopf: Ausmass und Kennwert sind Eingabetext).
function kennwertAusOptionen(zeile) {
  return String(Math.round(optionenSumme(zeile) * 100) / 100);
}

// Rechnet der Kennwert automatisch mit? Nur mit Optionen, und solange
// niemand ihn von Hand überschrieben hat.
function kennwertAutomatisch(zeile) {
  return optionenVon(zeile).length > 0 && !zeile.kennwertManuell;
}

// Die Preispositionen einer Vorlage als Kopie. Übernommen wird auch, was
// NICHT angehakt ist: in der Preisliste stehen dort die zuschaltbaren
// Posten ("Zuschlag Schalung Typ 3"), und die will man vor sich haben.
function optionenKopie(optionen) {
  return optionen.map((o) => ({
    aktiv: !!o.aktiv,
    text: String(o.text || ""),
    preis: o.preis === undefined || o.preis === null ? "" : o.preis,
    preisEinheit: String(o.preisEinheit || ""),
    menge: o.menge === undefined || o.menge === null ? "" : o.menge,
    mengeEinheit: String(o.mengeEinheit || ""),
    // Woher der Preis ursprünglich kam -- bleibt stehen, auch wenn jemand
    // den Preis in dieser Schätzung anpasst (dann steht er klein daneben).
    vorlagePreis: o.vorlagePreis === undefined || o.vorlagePreis === null ? o.preis ?? "" : o.vorlagePreis
  }));
}

// Der Einheitspreis einer Preislisten-Position nach deren eigener Regel --
// gebraucht für die Vorschau in der Vorlagenliste, vor dem Übernehmen.
function vorlageEinheitspreis(knoten) {
  const optionen = Array.isArray(knoten && knoten.optionen) ? knoten.optionen : [];
  return optionen.reduce((s, o) => s + (o.aktiv ? optionZahl(o.preis) * optionZahl(o.menge) : 0), 0);
}

// Stammt die Zeile aus der Preisliste? Solche Zeilen werden NICHT
// gelöscht: was einmal aus der Preisliste übernommen wurde, gehört zur
// Kostenberechnung und soll nicht mit einem Klick verschwinden. Wer eine
// doch loswerden will (Fehlklick auf eine Position), löst zuerst die
// Vorlage -- siehe loeseVorlage().
function ausVorlage(zeile) {
  return !!(zeile && zeile.vorlage && zeile.vorlage.pfad);
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

// Summe pro Modul plus der nicht zugeordnete Rest. Ein Modul ist eine
// AUFTEILUNG der Schätzung ("nur Dach", "UG & Fenster"): alle Module plus
// der Rest ergeben zusammen das Total -- ein Modul ist nie ein Zuschlag
// darauf.
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
// (nur der Name). Solange der Dialog offen ist, liegt
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
  }
}

// ---------- Baum aus Katalog + eigenen Positionen ----------

// Eine Nummer mit Punkt ("211.5 Beton- und Stahlbetonarbeiten") ist im BKP
// ein TEIL der dreistelligen Position, nicht deren Nachbar -- sie bekommt
// deshalb eine eigene Ebene 4 und hängt unter "211". Seit der Ausgabe 2017
// steht diese vierte Stelle (die "Gattung") im Katalog selbst.
// Die Tiefe ist bewusst NICHT auf vier Ebenen festgenagelt: "211.5" ist
// Ebene 4, "211.5.10" Ebene 5 und so weiter. Darunter liegen die eigenen
// Unterkapitel dieser Schätzung, beliebig tief und ohne sichtbare Nummer
// (siehe knotenLabel()) -- dort hört die Norm auf und die Gliederung des
// Büros fängt an.
function knotenEbene(nr) {
  const punkte = (String(nr).match(/\./g) || []).length;
  return punkte ? 3 + punkte : String(nr).length;
}
function elterNummer(nr) {
  if (nr.includes(".")) return nr.slice(0, nr.lastIndexOf("."));
  if (nr.length <= 1) return null;
  return nr.slice(0, nr.length - 1);
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

// Hierarchische Reihenfolge zweier Nummern: "2" < "21" < "211" < "211.0" <
// "211.9" < "211.10" < "212". Der Stamm vergleicht sich als TEXT -- daraus
// ergibt sich die Verschachtelung von selbst --, die Abschnitte hinter den
// Punkten dagegen als ZAHL, sonst käme "211.10" vor "211.2". Eigene
// Unterkapitel zählen ab 10 aufwärts (siehe naechsteUnterteilung()), das
// trifft also ständig zu.
function nummerVergleich(a, b) {
  const ta = String(a).split(".");
  const tb = String(b).split(".");
  if (ta[0] !== tb[0]) return ta[0] < tb[0] ? -1 : 1;
  for (let i = 1; i < Math.max(ta.length, tb.length); i++) {
    // Fehlender Abschnitt heisst "weiter oben im Baum" und kommt zuerst.
    const x = ta[i] === undefined ? -1 : Number(ta[i]);
    const y = tb[i] === undefined ? -1 : Number(tb[i]);
    if (x !== y) return x - y;
  }
  return 0;
}

// Ein Knoten gehört entweder dem Katalog oder dieser Schätzung allein.
function istEigen(nr) {
  return !!nr && !katalogTitel[nr];
}

// Wie ein Knoten angeschrieben wird. Katalogknoten tragen ihre Nummer vor
// dem Titel ("211.5 Beton- und Stahlbetonarbeiten"), eigene Unterkapitel
// nicht: sie sind frei benannte Gliederung unterhalb der Norm ("Wände" ›
// "Innenwände") und hätten an einer Nummer nichts gewonnen -- sie tragen
// intern zwar eine, aber nur als Kennung.
function knotenLabel(nr) {
  if (!nr) return "Übersicht";
  const titel = knotenTitel(nr);
  return istEigen(nr) ? titel : [nr, titel].filter(Boolean).join(" ");
}

// Katalog + die eigenen Unterkapitel dieser Schätzung, hierarchisch
// sortiert (siehe nummerVergleich()).
function alleKnoten() {
  const eigene = (offen && offen.eigenePositionen) || [];
  const knoten = katalogListe.map(([nr, titel]) => ({ nr, titel, eigen: false }));
  const belegt = new Set(knoten.map((k) => k.nr));
  const ergaenze = (nr, titel, extra) => {
    if (belegt.has(nr)) return;
    belegt.add(nr);
    knoten.push({ nr, titel, eigen: true, ...extra });
  };
  eigene.forEach((p) => ergaenze(p.nr, p.titel));
  // Die Gliederung aus der Preisliste. Ein Kapitel, das unter demselben
  // Elter schon denselben TITEL trägt, wird nicht doppelt angehängt: es ist
  // dasselbe, nur bereits in der Schätzung festgehalten (und behält dann
  // seine Kennung, auch wenn der Export später umsortiert wird).
  const belegteTitel = new Set(
    knoten.map((k) => `${elterNummer(k.nr) || ""}\u0000${String(k.titel).trim().toLowerCase()}`)
  );
  preislisteKnoten().forEach((k) => {
    const schluessel = `${elterNummer(k.nr) || ""}\u0000${k.titel.trim().toLowerCase()}`;
    if (belegteTitel.has(schluessel)) return;
    belegteTitel.add(schluessel);
    ergaenze(k.nr, k.titel, { ausPreisliste: true });
  });
  Object.entries(unbekannteKnoten()).forEach(([nr, titel]) => ergaenze(nr, titel));
  knoten.sort((a, b) => nummerVergleich(a.nr, b.nr));
  return knoten;
}

// Sicherheitsnetz: Nummern, unter denen Zeilen hängen, die aber weder der
// Katalog noch die eigenen Unterkapitel kennen -- samt ihren fehlenden
// Vorfahren. Das passiert, wenn die Norm von Nextcloud gerade nicht da ist
// und der gröbere Grundkatalog aus bkp.js gilt, oder bei einer Datei aus
// der Ausgabe 1991. Ohne Knoten wären solche Zeilen unsichtbar, würden
// aber weiter ins Total zählen. Gespeichert wird hier NICHTS -- das macht
// migriereAuf2017(), und nur mit vollständigem Katalog.
function unbekannteKnoten() {
  const map = {};
  if (!offen) return map;
  const eigene = offen.eigenePositionen || [];
  Object.keys(offen.positionen || {}).forEach((nr) => {
    if (!zeilenVon(nr).length) return;
    [...vorfahren(nr), nr].forEach((n) => {
      if (katalogTitel[n] || eigene.some((p) => p.nr === n) || preislisteZuNr(n)) return;
      map[n] = BKP_ENTFALLEN_1991[n] ? `${BKP_ENTFALLEN_1991[n]} (BKP ${n})` : `BKP ${n}`;
    });
  });
  return map;
}

function zeilenVon(nr) {
  return (offen.positionen && offen.positionen[nr]) || [];
}

// Zeilen eines Knotens samt denen von allem darunter ("211" liefert auch
// die Zeilen von "211.5" und dessen eigenen Unterkapiteln).
function zeilenUnter(nr) {
  const alle = [];
  Object.keys(offen.positionen || {}).forEach((k) => {
    if (k === nr || k.startsWith(nr + ".")) alle.push(...zeilenVon(k));
  });
  return alle;
}

// Summen für alle Knoten auf einmal: erst pro Position, dann auf die
// zwei- und einstelligen Eltern hochgezählt. Der Filter zählt nur einen
// Teil der Zeilen mit -- gebraucht für die Modulseiten im Ausdruck, wo
// dieselbe Tabelle nur mit den Zeilen EINES Moduls steht.
function summenMit(filter) {
  const summen = {};
  let gesamt = 0;
  Object.keys(offen.positionen || {}).forEach((nr) => {
    let betrag = 0;
    zeilenVon(nr).forEach((z) => {
      if (filter(z)) betrag += zeilenKosten(z);
    });
    [nr, ...vorfahren(nr)].forEach((ziel) => {
      summen[ziel] = (summen[ziel] || 0) + betrag;
    });
    gesamt += betrag;
  });
  return { summen, gesamt };
}
function alleSummen() {
  return summenMit(() => true);
}

// "Verwendet" heisst: irgendwo darunter ist mindestens eine Unterposition
// erfasst -- bewusst unabhängig vom Betrag, eine Zeile mit noch offenem
// Preis (Kosten 0) soll nicht wieder verschwinden.
function verwendeteKnoten(filter) {
  const set = new Set();
  Object.keys(offen.positionen || {}).forEach((nr) => {
    if (!zeilenVon(nr).filter(filter || (() => true)).length) return;
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

// Ein Knoten ZÄHLT MIT, sobald an ihm oder unter ihm etwas steht: eine
// Zeile oder ein gesetztes Häkchen. Alles andere bleibt beim Hochrechnen
// aussen vor -- und das ist der Kern der Sache: unter einer Position
// hängen acht Gattungen des Katalogs, unter einer Gattung hunderte Knoten
// der Preisliste, erfasst ist davon immer nur ein Bruchteil. Zählte der
// leere Rest mit, stünde das Minimum einer Gruppe auf ewig bei null, und
// eine Position würde nie grün, obwohl alles Erfasste darunter abgehakt
// ist (genau so gemeldet). "Noch nicht angeschaut" heisst hier also: es
// ist etwas erfasst, aber niemand war dran -- nicht: diese Katalognummer
// existiert und ist leer.
//
// Der Stand einer Gruppe wird NICHT gespeichert, sondern aus ihren Kindern
// gerechnet: sie hat so viele Häkchen, wie alle MITZÄHLENDEN Kinder
// mindestens haben (das Minimum). Eine Elementgruppe wird also grün,
// sobald jede erfasste Position darunter grün ist -- das soll beim
// gemeinsamen Durchgehen sichtbar machen, wo noch niemand war.
// Gespeichert wird an den Blättern (Positionen, Gattungen bzw. eigene
// Unterkapitel) und zusätzlich an jedem Knoten, der EIGENE Zeilen trägt:
// ein Knoten darf Zeilen und Unterkapitel gleichzeitig haben, und seine
// eigenen Zeilen hängen an seiner Nummer -- ohne sie im Minimum liesse
// sich für sie nirgends ein Häkchen setzen.
//
// Je Knoten entsteht: wie viele Häkchen (0-2), welche Kürzel (nur wenn
// darunter alle dasselbe sagen -- sonst wäre die Angabe falsch), ob er
// GELB ist (hat einen Betrag, aber noch kein Häkchen), die eigene Frage,
// wie viele Fragen in seinem Ast offen sind, und ob er mitzählt.
function statusBerechnen(knoten, kinder, summen) {
  const ergebnis = {};
  const betragVon = (nr) => !!(summen && summen[nr]);
  [...knoten]
    .sort((a, b) => knotenEbene(b.nr) - knotenEbene(a.nr))
    .forEach((k) => {
      const kids = kinder[k.nr] || [];
      const eigeneFrage = frageVon(k.nr);
      // Fragen zählen über ALLE Kinder, auch über leere: eine Frage steht
      // nur dort, wo jemand sie gestellt hat.
      let fragen = eigeneFrage ? 1 : 0;
      kids.forEach((c) => {
        fragen += ergebnis[c].fragen;
      });

      const eigeneZeilen = zeilenVon(k.nr).length;
      const eigenerHaken = hakenVon(k.nr);
      const zaehlendeKids = kids.filter((c) => ergebnis[c].zaehlt);
      // Ein Knoten, unter dem (noch) NICHTS erfasst ist, verhält sich wie
      // ein Blatt: sein eigenes Häkchen gilt. Sonst liesse sich eine leere
      // Gruppe gar nicht abhaken -- und genau das ist beim Durchgehen des
      // Katalogs der häufigste Fall ("durchgegangen, hier kommt nichts").
      // Als Bug gemeldet (November 2026): bei den Preislisten-Ordnern einer
      // Gattung passierte beim Klick aufs Kästchen gar nichts.
      // Sobald darunter etwas erfasst ist, zählt wieder das Minimum der
      // Kinder, und das eigene Häkchen bleibt als totes Feld liegen --
      // bewusst: dann ist die Gruppe nicht mehr leer und gehört neu
      // angeschaut.
      const wieBlatt = !zaehlendeKids.length && !eigeneZeilen;
      const zaehlt = wieBlatt ? !!eigenerHaken.length : true;
      if (!zaehlt) {
        ergebnis[k.nr] = {
          anzahl: 0, kuerzel: [], gelb: false, eigeneFrage, fragen, zaehlt: false, eigen: false
        };
        return;
      }

      // Was ins Minimum eingeht: die mitzählenden Kinder -- und der eigene
      // Stand, wenn der Knoten wie ein Blatt zählt oder eigene Zeilen trägt.
      const teile = zaehlendeKids.map((c) => ergebnis[c]);
      if (wieBlatt || eigeneZeilen) teile.push({ anzahl: eigenerHaken.length, kuerzel: eigenerHaken });

      // WER ist durch alles darunter durch? Das ist der DURCHSCHNITT der
      // Kürzel über alle mitzählenden Teile -- nicht das Minimum der
      // ANZAHLEN. Die beiden fallen genau dann auseinander, wenn
      // verschiedene Leute verschiedene Äste abgehakt haben, und dort war
      // die alte Rechnung irreführend (November 2026 gemeldet):
      //   - Das Kürzel erschien nur, wenn ALLE Kinder genau dasselbe
      //     meldeten -- sonst stand da ein grünes Kästchen OHNE Kürzel
      //     ("manchmal schreibt es keine Initialen rein").
      //   - Und es konnte grün sein, obwohl NIEMAND alles angeschaut
      //     hatte: ein Kind nur von MV, das andere nur von JH, Minimum 1.
      // Mit dem Durchschnitt gilt beides zusammen: grün heisst "diese
      // Person war überall darunter durch", und ein grünes Kästchen trägt
      // IMMER ein Kürzel (anzahl ist genau dessen Länge).
      const gemeinsam = teile.reduce(
        (bisher, t) => bisher.filter((kuerzel) => t.kuerzel.includes(kuerzel)),
        [...teile[0].kuerzel]
      );
      ergebnis[k.nr] = {
        anzahl: gemeinsam.length,
        kuerzel: gemeinsam,
        gelb: !gemeinsam.length && betragVon(k.nr),
        eigeneFrage,
        fragen,
        zaehlt: true,
        // `eigen` heisst: an diesem Knoten liegt ein Stand in `haken` --
        // entweder weil er dort gelesen wird (`wieBlatt`, eigene Zeilen)
        // oder weil schlicht einer darin steht. Genau diese Knoten sind
        // die Ziele eines Gruppenklicks (siehe hakenZiele()). Das letzte
        // Glied ist nötig, damit ein einmal abgehaktes leeres Kapitel auch
        // dann noch über die Gruppe zurückgesetzt werden kann, wenn
        // darunter inzwischen etwas erfasst wurde und sein eigenes Häkchen
        // für die Anzeige keine Rolle mehr spielt -- sonst bliebe es
        // liegen und tauchte wieder auf, sobald der Inhalt verschwindet.
        eigen: wieBlatt || !!eigeneZeilen || !!eigenerHaken.length
      };
    });
  return ergebnis;
}

// Damit eine fehlende Angabe nirgends einen Absturz auslöst (z.B. ein
// Knoten, den die Suche gerade nicht gerechnet hat).
const LEERER_STAND = {
  anzahl: 0, kuerzel: [], gelb: false, eigeneFrage: "", fragen: 0, zaehlt: false, eigen: false
};

// Nur noch für den Einstiegshinweis unter der Werkzeugleiste: solange gar
// nichts erfasst ist, erklärt er, wie man anfängt.
function anzahlErfassterPositionen() {
  return Object.keys(offen.positionen || {}).filter((nr) => zeilenVon(nr).length).length;
}

// ---------- Kapitelansicht: Navigation über den Baum ----------
//
// Wie beim Ausfüllen der Steuererklärung: man sieht immer nur EINE Ebene
// und klickt sich hinein. Alles hier rechnet über den Baum
// (alleKnoten()/kinderMap()), nicht über feste Ebenen 1-4 -- eigene
// eigene Unterkapitel dürfen beliebig tief werden (siehe knotenEbene()).

function kinderVon(nr) {
  const knoten = alleKnoten();
  const kinder = kinderMap(knoten);
  const liste = nr ? kinder[nr] || [] : knoten.filter((k) => knotenEbene(k.nr) === 1).map((k) => k.nr);
  return liste;
}

// Auf jedem Knoten ab der dreistelligen Position lassen sich BEIDES anlegen:
// eigene Zeilen und eigene Unterkapitel ("Wände", darunter "Innenwände" …).
// Auf Haupt- und Elementgruppen nicht -- deren Gliederung gibt die Norm vor.
function kapitelAktionen() {
  if (!kapitelKnoten || knotenEbene(kapitelKnoten) < 3) return "";
  // Ein eigenes Unterkapitel lässt sich auch hier löschen -- sonst bliebe
  // ein leeres (z.B. nach einem abgebrochenen Anlegen) in der
  // Kapitelansicht für immer stehen.
  const loeschen =
    istEigen(kapitelKnoten) && !preislisteZuNr(kapitelKnoten)
      ? `<button type="button" class="bk-add-btn" data-action="del-position" data-nr="${escapeHtml(kapitelKnoten)}" title="Dieses eigene Unterkapitel samt Inhalt löschen">Unterkapitel löschen</button>`
      : "";
  return ergaenzenKnoepfe(kapitelKnoten) + loeschen;
}

function istBlattKnoten(nr) {
  return !!nr && kinderVon(nr).length === 0;
}

function knotenTitel(nr) {
  if (!nr) return "Übersicht";
  const arch = preislisteZuNr(nr);
  return (
    katalogTitel[nr] ||
    ((offen.eigenePositionen || []).find((p) => p.nr === nr) || {}).titel ||
    (arch && arch.titel) ||
    unbekannteKnoten()[nr] ||
    ""
  );
}

// Weiter/Zurück laufen der Reihe nach durch die BLÄTTER des Baums. Die
// Reihenfolge aus alleKnoten() (siehe nummerVergleich()) ist genau die
// Tiefensuche-Reihenfolge. Mit "Nur verwendete" bleiben die leeren Blätter
// aussen vor -- sonst klickt man sich durch über 800 leere Positionen.
function kapitelSchritte() {
  const knoten = alleKnoten();
  const kinder = kinderMap(knoten);
  const verwendet = ansicht.nurVerwendet ? verwendeteKnoten() : null;
  return knoten
    .filter((k) => !(kinder[k.nr] || []).length)
    .filter((k) => !verwendet || verwendet.has(k.nr))
    .map((k) => k.nr);
}

function setzeKapitel(nr) {
  kapitelKnoten = nr || "";
  gewaehlteZeile = null;
  render();
  window.scrollTo(0, 0);
  merkeSicht();
}

function kapitelSchritt(richtung) {
  const schritte = kapitelSchritte();
  // Steht man auf einer Gruppe, ist der nächste Schritt ihr erstes Blatt.
  const i = schritte.indexOf(kapitelKnoten);
  if (i === -1) {
    const treffer = richtung > 0
      ? schritte.find((nr) => nummerVergleich(nr, kapitelKnoten) > 0)
      : [...schritte].reverse().find((nr) => nummerVergleich(nr, kapitelKnoten) < 0);
    if (treffer) setzeKapitel(treffer);
    return;
  }
  const ziel = schritte[i + richtung];
  if (ziel) setzeKapitel(ziel);
}

function setzeModus(modus) {
  ansichtModus = modus;
  if (modus === "kapitel") {
    suche = "";
    document.getElementById("sucheInput").value = "";
    document.getElementById("sucheHinweis").textContent = "";
  }
  renderToolbar();
  render();
  merkeSicht();
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
// Die Tabelle hat am Bildschirm KEINE Spaltentitel mehr: bei einer Liste,
// die man den ganzen Tag vor sich hat, sind sie nach dem zweiten Blick
// Dekoration. Was in ein Feld gehört, steht stattdessen als Platzhalter
// darin -- also genau dort, wo man hinschaut, und nur solange das Feld
// leer ist. "label" ist deshalb der Platzhaltertext; im AUSDRUCK gibt es
// weiterhin Spaltentitel (dort liest jemand die Tabelle zum ersten Mal).
function spalten() {
  const cols = [
    { key: "nr", label: "BKP", cls: "bk-col-nr" },
    { key: "beschrieb", label: "Beschrieb der Arbeiten", cls: "" },
    { key: "ausmass", label: "Ausmass", cls: "bk-col-ausmass bk-right" },
    { key: "einheit", label: "Einheit", cls: "bk-col-einheit" },
    { key: "kennwert", label: mwstSatz() ? "Kennwert exkl." : "Kennwert", cls: "bk-col-kennwert bk-right" },
    { key: "kosten", label: mwstSatz() ? "Kosten inkl." : "Kosten", cls: "bk-col-kosten bk-right" }
  ];
  if (module_().length) cols.push({ key: "modul", label: "Modul", cls: "bk-col-modul" });
  if (ansicht.bemerkungen) {
    cols.push({ key: "intern", label: "Notizen", cls: "bk-col-bem" });
    cols.push({ key: "extern", label: "Bemerkungen", cls: "bk-col-bem" });
  }
  cols.push({ key: "aktion", label: "", cls: "bk-col-aktion" });
  return cols;
}
function spaltenPlatzhalter(cols, key) {
  const c = cols.find((x) => x.key === key);
  return c ? c.label : "";
}

// ---------- Rendering: Liste ----------

// Für die Listenansicht: das Total der ganzen Schätzung.
function schaetzungTotal(data) {
  let gesamt = 0;
  Object.values(data.positionen || {}).forEach((zeilen) => {
    (zeilen || []).forEach((z) => {
      gesamt += zeilenKosten(z, data);
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

function renderKpis(gesamt) {
  const kacheln = [];
  kacheln.push(`<div class="bk-kpi gross">
    <div class="bk-kpi-label">Total</div>
    <div class="bk-kpi-wert">CHF ${franken(gesamt)}</div>
    <div class="bk-kpi-sub">${mwstSatz() ? `inkl. ${zahl(mwstSatz())}% MwSt` : "exkl. MwSt"}${
      offen.kostenstand ? ` · Stand ${escapeHtml(offen.kostenstand)}` : ""
    }</div>
  </div>`);

  // Unter- und Obergrenze stehen gleichwertig nebeneinander: es ist EINE
  // Spanne, keine Zahl mit Zusatz.
  const prozent = genauigkeitProzent();
  if (prozent !== null && gesamt) {
    kacheln.push(`<div class="bk-kpi">
      <div class="bk-kpi-label">Bandbreite ${escapeHtml(offen.genauigkeit)}</div>
      <div class="bk-kpi-wert">${franken(aufHundert(gesamt * (1 - prozent / 100)))} – ${franken(
        aufHundert(gesamt * (1 + prozent / 100))
      )}</div>
    </div>`);
  }

  // Erst die Baukosten ohne Module, dann die Module: ein Modul ist ein
  // separat zu entscheidender Teilbereich ("Küche ersetzen"), der Rest ist
  // das, was so oder so gebaut wird -- in dieser Reihenfolge liest man es.
  if (module_().length) {
    const { summen, ohne } = modulSummen();
    kacheln.push(`<div class="bk-kpi bk-kpi-modul">
      <div class="bk-kpi-label">Baukosten ohne Module</div>
      <div class="bk-kpi-wert">${franken(ohne)}</div>
      <div class="bk-kpi-sub">${gesamt ? Math.round((ohne / gesamt) * 100) : 0}% vom Total</div>
    </div>`);
    module_().forEach((m) => {
      kacheln.push(`<div class="bk-kpi bk-kpi-modul" style="--modul-farbe:${modulFarbe(m.id)}">
        <div class="bk-kpi-label">${escapeHtml(m.name)}</div>
        <div class="bk-kpi-wert">${franken(summen[m.id])}</div>
        <div class="bk-kpi-sub">${gesamt ? Math.round((summen[m.id] / gesamt) * 100) : 0}% vom Total</div>
      </div>`);
    });
  }

  document.getElementById("kpis").innerHTML = kacheln.join("");
}

// ---------- Rendering: Tabelle ----------

// Das Statuskästchen vor der Nummer, daneben das Fragezeichen. Auf
// Blättern setzt das Kästchen MEIN Häkchen; auf Gruppen (deren Stand sich
// aus den Kindern ergibt, siehe statusBerechnen()) setzt es meines auf
// alles darunter -- sonst müsste man eine fertige Elementgruppe Zeile für
// Zeile abhaken. Der Rest der Zeile bleibt fürs Auf- und Zuklappen.

// Weiss (nichts erfasst) / gelb (Betrag, aber kein Häkchen) / hellgrün
// (ein Häkchen) / dunkelgrün (beide). Gelb wird nie gespeichert.
function statusKlasse(stand) {
  if (stand.anzahl >= HAKEN_MAX) return "s-zwei";
  if (stand.anzahl === 1) return "s-eins";
  return stand.gelb ? "s-gelb" : "s-leer";
}

function statusTitel(stand, istBlatt) {
  const wer = stand.kuerzel.length ? kuerzelText(stand.kuerzel) : "";
  const was =
    stand.anzahl >= HAKEN_MAX
      ? `Vieraugenprinzip${wer ? ` – ${wer}` : ""}`
      : stand.anzahl === 1
      ? `Durchgegangen${wer ? ` von ${wer}` : ""} – die zweite Person fehlt noch`
      : stand.gelb
      ? "Erfasst, aber noch von niemandem durchgegangen"
      : "Noch nichts erfasst";
  return `${was} · ${istBlatt ? "klicken setzt mein Häkchen" : "klicken setzt mein Häkchen auf alles darunter"}`;
}

function statusHtml(nr, stand, istBlatt) {
  const s = stand || LEERER_STAND;
  return (
    `<button type="button" class="bk-status ${statusKlasse(s)}" data-action="status" data-nr="${nr}"${
      istBlatt ? ' data-blatt="1"' : ""
    } title="${escapeHtml(statusTitel(s, istBlatt))}">${escapeHtml(kuerzelText(s.kuerzel))}</button>` +
    frageHtml(nr, s)
  );
}

// Das runde Fragezeichen: ein Hinweis an die andere Person, hier genauer
// hinzuschauen. Es hängt an der NUMMER, nicht an der Zeile, und eine
// Gruppe darf eine eigene Frage tragen -- die vererbt sich nicht nach
// unten. Je mehr Fragen im Ast offen sind, desto kräftiger das Rot
// (ab FRAGEN_VOLL ist Schluss); wegnehmen darf es jede und jeder, sonst
// stapeln sich längst beantwortete Fragen.
const FRAGEN_VOLL = 5;

function frageHtml(nr, stand) {
  const s = stand || LEERER_STAND;
  const staerke = s.fragen ? Math.min(s.fragen, FRAGEN_VOLL) / FRAGEN_VOLL : 0;
  const titel = s.eigeneFrage
    ? `Frage von ${s.eigeneFrage}${s.fragen > 1 ? ` · ${s.fragen - 1} weiter unten` : ""} · klicken nimmt sie weg`
    : s.fragen
    ? `${s.fragen} ${s.fragen === 1 ? "Frage" : "Fragen"} weiter unten · klicken stellt hier eine eigene`
    : "Frage stellen – die andere Person soll hier genauer hinschauen";
  return `<button type="button" class="bk-frage${s.eigeneFrage ? " eigen" : ""}${
    s.fragen ? " offen" : ""
  }" data-action="frage" data-nr="${nr}" style="--frage-staerke:${staerke.toFixed(2)}" title="${escapeHtml(
    titel
  )}">?</button>`;
}

// Die Bemerkungen der Unterpositionen, zu EINEM Text zusammengezogen --
// auf der dreistelligen Positionszeile steht damit, was in der Position
// insgesamt steckt ("Zumauern Türöffnungen, Neue Trennwände"), ohne sie
// aufklappen zu müssen. Genau denselben Text druckt die zusammengefasste
// Positionszeile im Ausdruck. Nur die EXTERNEN Bemerkungen: Notizen sind
// Arbeitsmaterial und gehören niemandem sonst vor die Augen.
function bemerkungenZusammen(nr) {
  if (knotenEbene(nr) < 3) return "";
  return zeilenUnter(nr)
    .map((z) => (z.extern || "").trim())
    .filter(Boolean)
    .join(", ");
}

function totalZelleInhalt(summe) {
  return summe ? franken(summe) : "";
}

// Gleich grosse Stufen -- als Stil statt als Klasse, weil der Baum keine
// feste maximale Tiefe hat. Ab Ebene 6 wird nicht weiter eingerückt, sonst
// liefe die 112px schmale Nummernspalte über.
function einzugStil(nr) {
  const e = knotenEbene(nr);
  return e === 1 ? "" : ` style="padding-left:${10 + Math.min(e - 1, 5) * 14}px"`;
}

function gruppenZeileHtml(knoten, summe, klappbar, offenJetzt, cols, status, istBlatt) {
  const e = knotenEbene(knoten.nr);
  const indent = einzugStil(knoten.nr);
  let aktionen = "";
  if (e >= 3) {
    // Auch unter einem eigenen Unterkapitel darf ein weiteres entstehen
    // ("Wände" -> "Innenwände"), siehe knotenEbene().
    aktionen = ergaenzenKnoepfe(knoten.nr);
    if (knoten.eigen) {
      aktionen += `<button type="button" class="bk-row-action" data-action="del-position" data-nr="${knoten.nr}" title="Eigenes Unterkapitel löschen">×</button>`;
    }
  }
  // Titel spannt von "Beschrieb" bis vor "Kosten", danach folgen die
  // optionalen Spalten und die Aktionsspalte -- die Bemerkungsspalte
  // bekommt dabei die zusammengezogenen Bemerkungen der Unterpositionen.
  const titelSpan = cols.findIndex((c) => c.key === "kosten") - 1;
  const restZellen = cols
    .slice(cols.findIndex((c) => c.key === "kosten") + 1)
    .map((c) => {
      if (c.key === "aktion") return `<td class="bk-col-aktion">${aktionen}</td>`;
      if (c.key === "extern") return `<td class="bk-bem-zusammen">${escapeHtml(bemerkungenZusammen(knoten.nr))}</td>`;
      return "<td></td>";
    })
    .join("");
  // Der Status färbt bewusst nur das Kästchen (siehe index.html) -- die
  // Zeile trägt ihn nicht mehr als Klasse.
  const klassen = ["bk-group", `bk-l${e}`, summe ? "" : "leer", klappbar ? "klappbar" : ""]
    .filter(Boolean)
    .join(" ");
  return `<tr class="${klassen}" data-nr="${knoten.nr}"${klappbar ? "" : ' data-fest="1"'}>
    <td class="bk-col-nr"${indent}>${statusHtml(knoten.nr, status, istBlatt)}<span class="bk-nr-text">${
      knoten.eigen ? "" : escapeHtml(knoten.nr)
    }</span></td>
    <td class="bk-titel" colspan="${titelSpan}">${escapeHtml(knoten.titel)}</td>
    <td class="bk-total bk-right" data-total-for="${knoten.nr}">${totalZelleInhalt(summe)}</td>
    ${restZellen}
  </tr>`;
}

// Ausmass- und Kennwert-Zelle: im Feld steht das gerechnete Resultat. Die
// eingetippte Rechnung steht NICHT mehr klein darunter (das war bei
// hunderten Zeilen zu unruhig) -- sie erscheint beim Hineinklicken wieder
// im Feld und hängt zusätzlich als Tooltip daran. Lässt sich eine Eingabe
// nicht rechnen, bleibt sie stehen und wird rot markiert.
function rechenZelle(zeile, feld, cssExtra, platzhalter) {
  const roh = zeile[feld] || "";
  const wert = rechne(roh);
  const ungueltig = isNaN(wert);
  const anzeige = wert === null ? "" : ungueltig ? roh : zahl(wert);
  return `<td><input type="text" class="bk-num ${cssExtra}${ungueltig ? " ungueltig" : ""}" data-feld="${feld}" data-roh="${escapeHtml(roh)}" value="${escapeHtml(anzeige)}" placeholder="${escapeHtml(platzhalter || "")}" title="${escapeHtml(roh)}"></td>`;
}

// Dasselbe Dropdown steht an zwei Orten -- und die beiden lesen ihre
// Felder verschieden: in der Tabelle über `data-feld` samt umgebender
// `tr.bk-sub` (onBodyChange()), im Bearbeitungsfenster über
// `data-panel-feld` (onPanelChange()), denn dort gibt es keine Zeile
// darum herum. Mit dem falschen Attribut fällt die Auswahl im Fenster
// durch BEIDE Wege -- auch durch uebernimmOffeneEingabe(), das ohne
// `tr.bk-sub` kein Ziel findet -- und ist beim nächsten Zeichnen wieder
// weg. Genau so gemeldet (November 2026).
function modulSelectHtml(zeile, cssKlasse, imPanel) {
  const feldAttr = imPanel ? 'data-panel-feld="modul"' : 'data-feld="modul"';
  const optionen = module_()
    .map((m) => `<option value="${m.id}"${zeile.modul === m.id ? " selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");
  return `<select class="${cssKlasse}" ${feldAttr}><option value="">–</option>${optionen}</select>`;
}

// "–" statt einer leeren Zelle, wenn das Ausmass fehlt: leer liesse offen,
// ob hier noch nichts erfasst ist oder gerade nichts kostet.
function zeilenKostenText(zeile) {
  if (ausmassFehlt(zeile)) return "–";
  const kosten = zeilenKosten(zeile);
  return kosten ? franken(kosten) : "";
}

// stattKnoten: die Zeile TRITT AN DIE STELLE ihres Knotens. Bei einer
// Preislisten-Position wäre "Wandstärke 18 cm" sonst zweimal untereinander
// zu lesen -- einmal als Kapitel, einmal als Zeile darin. Sie übernimmt
// dafür Einzug und Status-Kästchen des Knotens.
function unterpositionHtml(nr, zeile, cols, stattKnoten) {
  const gewaehlt = gewaehlteZeile && gewaehlteZeile.id === zeile.id ? " gewaehlt" : "";
  let zellen = "";
  cols.forEach((c) => {
    if (c.key === "nr") {
      zellen += stattKnoten
        ? `<td class="bk-col-nr"${stattKnoten.indent}>${stattKnoten.status}</td>`
        : '<td class="bk-col-nr"></td>';
    } else if (c.key === "beschrieb") {
      // Die Punkte zeigen auch bei ausgeblendeten Bemerkungsspalten, dass
      // zu dieser Zeile etwas hinterlegt ist.
      const punkte =
        (!ansicht.bemerkungen && zeile.intern ? '<span class="bk-bem-punkt" title="Notiz (nicht im Ausdruck)"></span>' : "") +
        (!ansicht.bemerkungen && zeile.extern ? '<span class="bk-bem-punkt extern" title="Bemerkung"></span>' : "");
      zellen += `<td>${punkte}<textarea rows="1" data-feld="beschrieb" placeholder="${escapeHtml(c.label)}">${escapeHtml(zeile.beschrieb || "")}</textarea></td>`;
    } else if (c.key === "ausmass") {
      // Bei einer Prozent-Zeile steht hier der Prozentsatz.
      zellen += rechenZelle(zeile, "ausmass", "bk-ausmass", zeile.basis ? "%" : c.label);
    } else if (c.key === "einheit") {
      zellen += zeile.basis
        ? '<td class="bk-fest">%</td>'
        : `<td><input type="text" data-feld="einheit" list="einheitenListe" placeholder="${escapeHtml(c.label)}" value="${escapeHtml(zeile.einheit || "")}"></td>`;
    } else if (c.key === "kennwert") {
      // Statt eines Kennwerts zeigt die Prozent-Zeile ihre Bemessungs-
      // grundlage -- sonst wäre nicht nachvollziehbar, worauf sich der
      // Prozentsatz bezieht.
      zellen += zeile.basis
        ? `<td class="bk-fest" title="${escapeHtml(BASIS_LABEL)}">${franken(basisBetrag())}</td>`
        : rechenZelle(zeile, "kennwert", "bk-kennwert", c.label);
    } else if (c.key === "kosten") {
      zellen += `<td class="bk-kosten" data-kosten-for="${zeile.id}">${zeilenKostenText(zeile)}</td>`;
    } else if (c.key === "modul") {
      zellen += `<td><span class="bk-modul-zelle"><span class="bk-modul-strich" style="--modul-farbe:${modulFarbe(zeile.modul)}"></span>${modulSelectHtml(zeile, "bk-modul-select")}</span></td>`;
    } else if (c.key === "intern") {
      zellen += `<td><textarea class="bk-bem" rows="1" data-feld="intern" placeholder="${escapeHtml(c.label)}">${escapeHtml(zeile.intern || "")}</textarea></td>`;
    } else if (c.key === "extern") {
      zellen += `<td><textarea class="bk-bem" rows="1" data-feld="extern" placeholder="${escapeHtml(c.label)}">${escapeHtml(zeile.extern || "")}</textarea></td>`;
    } else if (c.key === "aktion") {
      // Kein × bei einer Zeile aus der Preisliste: die wird nicht gelöscht
      // (siehe ausVorlage()). Der Weg dazu steht im Bearbeitungsfenster.
      zellen += `<td class="bk-col-aktion"><button type="button" class="bk-row-action" data-action="bearbeiten" data-nr="${nr}" data-row="${zeile.id}" title="Zeile im Fenster bearbeiten">⋯</button>${
        ausVorlage(zeile)
          ? ""
          : `<button type="button" class="bk-row-action" data-action="del-zeile" data-nr="${nr}" data-row="${zeile.id}" title="Zeile löschen">×</button>`
      }</td>`;
    }
  });
  return `<tr class="bk-sub${stattKnoten ? " bk-sub-knoten" : ""}${
    ausmassFehlt(zeile) ? " bk-ohne-mass" : ""
  }${gewaehlt}" data-nr="${nr}" data-row="${zeile.id}">${zellen}</tr>`;
}

function renderTabelle() {
  const cols = spalten();
  const knoten = alleKnoten();
  const kinder = kinderMap(knoten);
  const { summen, gesamt } = alleSummen();
  const status = statusBerechnen(knoten, kinder, summen);
  const q = suche.trim().toLowerCase();
  const sucheAktiv = q.length > 0;
  const trefferSet = sucheAktiv ? sichtbarDurchSuche(knoten, q) : null;
  const verwendet = verwendeteKnoten();

  // Ohne Kopfzeile tragen die <col>-Elemente die Spaltenbreiten.
  document.getElementById("bkCols").innerHTML = cols.map((c) => `<col class="${c.cls}">`).join("");

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

    // Eine Preislisten-Position mit GENAU EINER Erfassung braucht keine
    // eigene Kopfzeile: der Knoten ist die Zeile. Erst ab der zweiten
    // Erfassung ("Innenwände EG" / "OG") lohnt sich die Gliederung wieder.
    if (
      (istPreislistePosition(k.nr) && eigeneZeilen === 1 && !kids.length) ||
      (eigeneZeilen === 1 && istEigeneEndposition(k.nr, kids))
    ) {
      html += unterpositionHtml(k.nr, zeilenVon(k.nr)[0], cols, {
        indent: einzugStil(k.nr),
        status: statusHtml(k.nr, status[k.nr], true)
      });
      sichtbareZeilen++;
      return;
    }

    html += gruppenZeileHtml(k, summen[k.nr] || 0, klappbar, kinderOffen, cols, status[k.nr], !kids.length);
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

  // Module werden separat gerechnet: zuerst das Grundtotal (nur Positionen
  // ohne Modul), dann je Modul eine Zeile, zuletzt das Gesamttotal.
  const aufstellung = modulAufstellung();
  if (aufstellung) {
    html += fuss(" bk-gesamt-teil", grundTotalBeschriftung(), "CHF " + franken(aufstellung.ohne), ' id="gesamtOhneModuleZelle"');
    module_().forEach((m) => {
      html += fuss(
        " bk-gesamt-teil",
        `Modul: ${escapeHtml(m.name)}`,
        `<span class="bk-modul-betrag">+ ${franken(aufstellung.summen[m.id])}</span>`,
        ` data-modul-total="${m.id}"`
      );
    });
  }
  html += fuss("", totalBeschriftung(), "CHF " + franken(gesamt), ' id="gesamtTotalZelle"');

  document.getElementById("bkBody").innerHTML = html;
  autoGrowAlle();
  letzterStatus = status;
  return { gesamt };
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
  const kapitel = ansichtModus === "kapitel";
  document.getElementById("kapitelView").hidden = !kapitel;
  document.getElementById("tabelleView").hidden = kapitel;
  const { gesamt } = kapitel ? (renderKapitel(), alleSummen()) : renderTabelle();
  renderKpis(gesamt);

  const meta = [projektLabel(offen), offen.genauigkeit, offen.kostenstand ? `Stand ${offen.kostenstand}` : ""]
    .filter(Boolean)
    .join(" · ");
  document.getElementById("headTitel").textContent = offen.titel || "(ohne Titel)";
  document.getElementById("headMeta").textContent = meta;
  document.getElementById("sucheHinweis").textContent = suche.trim()
    ? "Suche aktiv – Filter und Ein-/Ausklappen ausgesetzt"
    : "";
  renderGliederungHinweis();
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

// Die Kapitelansicht rechnet ihre Summen und Stände selbst -- sie rendert
// die Tabelle nicht, die sonst letzterStatus füllt.
// Der Fortschrittsbalken zeigt ALLE Stände, nicht nur den fertigen Teil:
// dunkelgrün (Vieraugenprinzip), hellgrün (erledigt), gelb (pendent) -- und
// was übrig bleibt, ist noch gar nicht angeschaut. Vorher füllte ein
// einziger grüner Balken alles ab "erledigt", und ob der Rest pendent oder
// unberührt war, sah man nicht.
function balkenHtml(blaetter, status) {
  const n = blaetter.length;
  if (!n) return '<span class="bk-kap-balken"></span>';
  const zahl = { zwei: 0, eins: 0, gelb: 0 };
  blaetter.forEach((b) => {
    const st = status[b] || LEERER_STAND;
    if (st.anzahl >= HAKEN_MAX) zahl.zwei++;
    else if (st.anzahl === 1) zahl.eins++;
    else if (st.gelb) zahl.gelb++;
  });
  const leer = n - zahl.zwei - zahl.eins - zahl.gelb;
  const breite = (k) => (zahl[k] / n) * 100;
  // Die Fragen stehen NICHT im Balken: eine Position kann durchgegangen
  // sein UND eine Frage tragen, ein eigener Abschnitt zählte sie doppelt.
  // Dafür steht das Fragezeichen neben der Zeile.
  const titel =
    [
      zahl.zwei ? `${zahl.zwei}× Vieraugenprinzip` : "",
      zahl.eins ? `${zahl.eins}× einmal durchgegangen` : "",
      zahl.gelb ? `${zahl.gelb}× erfasst, noch nicht durchgegangen` : "",
      leer ? `${leer}× nichts erfasst` : ""
    ]
      .filter(Boolean)
      .join(" · ") + ` (${n} ${n === 1 ? "Position" : "Positionen"})`;
  return `<span class="bk-kap-balken" title="${escapeHtml(titel)}">
    <i class="s-zwei" style="width:${breite("zwei")}%"></i>
    <i class="s-eins" style="width:${breite("eins")}%"></i>
    <i class="s-gelb" style="width:${breite("gelb")}%"></i>
  </span>`;
}

function renderKapitel() {
  const knoten = alleKnoten();
  const kinder = kinderMap(knoten);
  const { summen, gesamt } = alleSummen();
  const status = statusBerechnen(knoten, kinder, summen);
  letzterStatus = status;
  const verwendet = verwendeteKnoten();
  const summeVon = (nr) => (nr ? summen[nr] || 0 : gesamt);

  // Pfad: nur die Stufen bis hierher, Übersicht zuoberst.
  const pfad = ["", ...[...vorfahren(kapitelKnoten)].reverse(), ...(kapitelKnoten ? [kapitelKnoten] : [])];
  document.getElementById("kapPfad").innerHTML = pfad
    .map((nr, i) => {
      const aktuell = i === pfad.length - 1;
      return `<button type="button" class="bk-kap-knopf${aktuell ? " aktuell" : ""}" data-kap-ziel="${escapeHtml(nr)}"${
        aktuell ? " disabled" : ""
      }>
        <span class="nr">${escapeHtml(knotenLabel(nr))}</span>
        <span class="summe">${franken(summeVon(nr))}</span>
      </button>`;
    })
    .join("");

  // Kopf: Titel, Summe und eine Zeile darüber, was hier drinsteckt.
  const kinderListe = kinderVon(kapitelKnoten).filter((nr) => !ansicht.nurVerwendet || verwendet.has(nr));
  const blatt = istBlattKnoten(kapitelKnoten);
  const zeilen = blatt ? zeilenVon(kapitelKnoten) : [];
  const meta = blatt
    ? `${zeilen.length} ${zeilen.length === 1 ? "Position" : "Positionen"}`
    : [
        `${kinderListe.length} Unterkapitel · ${kinderListe.filter((nr) => verwendet.has(nr)).length} verwendet`,
        zeilenVon(kapitelKnoten).length
          ? `${zeilenVon(kapitelKnoten).length} eigene ${zeilenVon(kapitelKnoten).length === 1 ? "Position" : "Positionen"}`
          : ""
      ]
        .filter(Boolean)
        .join(" · ");
  // Das Statuskästchen des OFFENEN Kapitels gehört in den Kopf. Ohne das
  // liess sich ein Kapitel nur aus der Liste des ELTERNS abhaken -- war man
  // hineingegangen, gab es nichts mehr zum Anklicken, und bei einem
  // Blatt-Kapitel (Positionszeilen) überhaupt nirgends: die Zeilen tragen
  // bewusst kein eigenes Kästchen, das Häkchen hängt an der NUMMER.
  // Genau so gemeldet (November 2026): "bei einigen Positionen und
  // Unterpositionen geht das Abkreuzen nicht" -- es gab dort schlicht kein
  // Kästchen. In der Übersicht (kein Kapitel offen) bleibt es weg, die
  // ganze Schätzung hakt niemand ab.
  const kopfStand = kapitelKnoten
    ? `<div class="bk-kap-stand">${statusHtml(kapitelKnoten, status[kapitelKnoten], blatt)}</div>`
    : "";
  document.getElementById("kapKopf").innerHTML = `
    ${kopfStand}
    <div class="titel">
      <div class="bk-kap-meta">${escapeHtml(
        [kapitelKnoten ? (istEigen(kapitelKnoten) ? "Eigenes Unterkapitel" : `Kapitel ${kapitelKnoten}`) : "Ganze Schätzung", meta]
          .filter(Boolean)
          .join(" · ")
      )}</div>
      <div class="bk-kap-titel">${escapeHtml(knotenTitel(kapitelKnoten))}</div>
    </div>
    <div class="bk-kap-summe">
      <div class="bk-kap-meta">${kapitelKnoten ? "Summe Kapitel" : "Total"}</div>
      <div class="wert">CHF ${franken(summeVon(kapitelKnoten))}</div>
    </div>`;

  // Mitte: die direkten Kinder und/oder die eigenen Positionen. Ein Knoten
  // darf beides haben ("211.5" mit eigenen Zeilen UND dem Unterkapitel
  // "Wände") -- dann steht beides untereinander, sonst wären die eigenen
  // Zeilen hier unsichtbar.
  const eigeneZeilen = zeilenVon(kapitelKnoten);
  const positionenHtml = (liste) =>
    liste
        .map(
          (z) => `<div class="bk-kap-pos${ausmassFehlt(z) ? " leer" : ""}" data-kap-zeile="${z.id}">
          <span class="bk-kap-zeile-haupt">
            <span class="bk-kap-zeile-titel">${escapeHtml(z.beschrieb || "(ohne Beschrieb)")}</span>
            ${z.extern ? `<span class="bk-kap-zeile-sub">${escapeHtml(z.extern)}</span>` : ""}
          </span>
          <span class="mass">${escapeHtml(
            z.basis ? `${zahl(rechne(z.ausmass))} %` : [zahl(rechne(z.ausmass)), z.einheit].filter(Boolean).join(" ")
          )}</span>
          <span class="bk-kap-betrag">${zeilenKostenText(z)}</span>
          <span class="bk-kap-pfeil">›</span>
        </div>`
        )
        .join("") +
    `<div class="bk-kap-neu">${kapitelAktionen()}</div>`;

  const ziel = document.getElementById("kapListe");
  if (blatt) {
    ziel.innerHTML = positionenHtml(eigeneZeilen);
  } else if (!kinderListe.length && !eigeneZeilen.length) {
    ziel.innerHTML =
      `<div class="bk-kap-leer-hinweis">${
        ansicht.nurVerwendet ? 'Nichts erfasst — "Nur verwendete" ausschalten.' : "Noch nichts erfasst."
      }</div>` + (kapitelAktionen() ? `<div class="bk-kap-neu">${kapitelAktionen()}</div>` : "");
  } else {
    ziel.innerHTML = kinderListe
      .map((nr) => {
        const blaetter = (kinderVon(nr).length ? blattNummernUnter(nr) : [nr]).filter(Boolean);
        // Hier stand früher eine zweite Zeile mit den ersten drei
        // Unterkapiteln ("Vorstudien · Grundstückserwerb · Nebenkosten …").
        // Sie machte die Liste doppelt so hoch, ohne eine Frage zu
        // beantworten -- wer wissen will, was drinsteckt, geht hinein.
        // Grau heisst "hier zählt noch nichts" -- nicht bloss "hier steht
        // noch keine Zeile". Eine angeklickte Preislisten-Position ohne
        // Ausmass soll nicht schon schwarz werden.
        return `<div class="bk-kap-zeile${verwendet.has(nr) && summen[nr] ? "" : " leer"}" data-kap-ziel="${escapeHtml(nr)}">
          ${statusHtml(nr, status[nr], !kinderVon(nr).length)}
          <span class="bk-kap-zeile-haupt">
            <span class="bk-kap-zeile-titel">${escapeHtml(knotenLabel(nr))}</span>
          </span>
          ${balkenHtml(blaetter, status)}
          <span class="bk-kap-betrag">${summen[nr] ? franken(summen[nr]) : "–"}</span>
          <span class="bk-kap-pfeil">›</span>
        </div>`;
      })
      .join("") +
      (eigeneZeilen.length ? positionenHtml(eigeneZeilen) : kapitelAktionen() ? `<div class="bk-kap-neu">${kapitelAktionen()}</div>` : "");
  }

  // Fuss: der Reihe nach durch die Blätter des Baums.
  const schritte = kapitelSchritte();
  const i = schritte.indexOf(kapitelKnoten);
  const vorheriges = i > 0 ? schritte[i - 1] : [...schritte].reverse().find((nr) => nummerVergleich(nr, kapitelKnoten) < 0);
  const naechstes = i >= 0 ? schritte[i + 1] : schritte.find((nr) => nummerVergleich(nr, kapitelKnoten) > 0);
  const navKnopf = (nr, klasse, label) =>
    `<button type="button" class="bk-kap-nav${klasse}" data-kap-ziel="${escapeHtml(nr || "")}"${nr ? "" : " disabled"}>
      <span class="label">${label}</span>
      <span class="ziel">${escapeHtml(nr ? knotenLabel(nr) : "–")}</span>
    </button>`;
  document.getElementById("kapFuss").innerHTML =
    navKnopf(vorheriges, "", "‹ Zurück") +
    `<span class="bk-kap-stand">${
      i >= 0 ? `Schritt ${i + 1} von ${schritte.length}` : `${schritte.length} Positionen`
    }</span>` +
    navKnopf(naechstes, " weiter", "Weiter ›");
}

// Nach einer reinen Wertänderung müssen nur die gerechneten Zellen
// nachgeführt werden -- kein kompletter Neuaufbau, der den Cursor aus der
// Tabelle werfen würde.
function refreshSummen() {
  const { summen, gesamt } = alleSummen();
  document.querySelectorAll("[data-total-for]").forEach((el) => {
    const summe = summen[el.dataset.totalFor] || 0;
    el.innerHTML = totalZelleInhalt(summe);
    el.closest("tr").classList.toggle("leer", !summe);
  });
  document.querySelectorAll("[data-kosten-for]").forEach((el) => {
    const zeile = zeileSuchen(offen, el.dataset.kostenFor);
    if (!zeile) return;
    el.innerHTML = zeilenKostenText(zeile);
    // Tippt jemand das Ausmass, wird aus der ausgegrauten Zeile eine
    // zählende (und umgekehrt) -- ohne das bliebe sie grau.
    const tr = el.closest("tr");
    if (tr) tr.classList.toggle("bk-ohne-mass", ausmassFehlt(zeile));
  });
  const gesamtZelle = document.getElementById("gesamtTotalZelle");
  if (gesamtZelle) gesamtZelle.textContent = "CHF " + franken(gesamt);
  // Die Modul-Aufstellung im Fuss hängt ebenfalls an den Summen -- ohne das
  // hier bliebe sie nach einer reinen Wertänderung auf dem alten Stand.
  const { summen: ms, ohne } = modulSummen();
  const ohneZelle = document.getElementById("gesamtOhneModuleZelle");
  if (ohneZelle) ohneZelle.textContent = "CHF " + franken(ohne);
  document.querySelectorAll("[data-modul-total]").forEach((el) => {
    el.innerHTML = `<span class="bk-modul-betrag">+ ${franken(ms[el.dataset.modulTotal] || 0)}</span>`;
  });
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

// ---------- Bearbeitungsfenster ----------
//
// Die Zeile wird in einem zentrierten Overlay bearbeitet statt in einem
// Fenster rechts: in der Kapitelansicht gäbe es dafür keinen Platz, und in
// der Tabelle schob sich das Fenster bisher beim blossen Hineinklicken ins
// Bild. Geöffnet wird es jetzt absichtlich -- über das "⋯" in der Zeile
// (Tabelle) oder einen Klick auf die Position (Kapitelansicht).
//
// Gespeichert wird beim Schliessen: jede Änderung läuft ohnehin schon über
// setzeFeld()/mutate(), uebernimmOffeneEingabe() holt zusätzlich das gerade
// offene Feld ab. Deshalb kein Speichern-Knopf und keine Rückfrage.
function renderPanel() {
  const panel = document.getElementById("detailPanel");
  const zeile = gewaehlteZeile && zeileSuchen(offen, gewaehlteZeile.id);
  if (!zeile) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const nr = gewaehlteZeile.nr;
  const posTitel = knotenTitel(nr);
  const modulFeld = module_().length
    ? `<label>Modul</label>${modulSelectHtml(zeile, "bk-panel-modul", true)}`
    : `<label>Modul</label><div class="hint" style="margin:0; font-size:11.5px;">Noch keine Module definiert — in den Kopfdaten anlegen.</div>`;
  // Pfad klein oben: "2 Gebäude › 22 Rohbau 2 › 224 Bedachungsarbeiten"
  const pfadText = [...vorfahren(nr)].reverse().concat(nr).map(knotenLabel).join(" › ");
  const geschwister = zeilenVon(nr);
  const idx = geschwister.findIndex((z) => z.id === zeile.id);

  panel.hidden = false;
  panel.innerHTML = `
    <div class="bk-panel-box">
    <div class="bk-panel-head">
      <div style="flex:1; min-width:0;">
        <div class="bk-panel-pos">${escapeHtml(pfadText)}</div>
        <div class="bk-panel-nr">${escapeHtml(zeile.beschrieb || posTitel || knotenLabel(nr))}</div>
      </div>
      <button type="button" class="bk-row-action" data-panel-action="close" title="Schliessen (Esc)">×</button>
    </div>
    <label>Beschrieb</label>
    <textarea rows="4" data-panel-feld="beschrieb">${escapeHtml(zeile.beschrieb || "")}</textarea>
    <label>Berechnung</label>
    <select data-panel-feld="basis">
      <option value=""${zeile.basis ? "" : " selected"}>Ausmass × Kennwert</option>
      <option value="${BASIS_ART}"${zeile.basis ? " selected" : ""}>${escapeHtml(BASIS_LABEL)}</option>
    </select>
    ${
      zeile.basis
        ? `<div class="bk-panel-dreispalt">
             <div><label>Prozentsatz</label><input type="text" data-panel-feld="ausmass" value="${escapeHtml(zeile.ausmass || "")}"></div>
             <div style="flex:2;"><label>Bemessungsgrundlage</label><input type="text" value="${franken(basisBetrag())}" readonly></div>
           </div>
           <div class="hint" style="margin:6px 0 0; font-size:11px;">
             Baukosten BKP 1–9 ohne die Honorargruppen (x9x), ohne Hauptgruppe
             0 (Grundstück) und ohne andere Prozent-Zeilen – sonst würde sich
             das Honorar selbst mitrechnen. Die Grundlage ist exklusive MwSt;
             der Prozentbetrag wird wie jede Zeile versteuert.
           </div>`
        : `<div class="bk-panel-dreispalt">
             <div><label>Ausmass</label><input type="text" data-panel-feld="ausmass" value="${escapeHtml(zeile.ausmass || "")}"></div>
             <div><label>Einheit</label><input type="text" data-panel-feld="einheit" list="einheitenListe" value="${escapeHtml(zeile.einheit || "")}"></div>
             <div><label>Kennwert</label><input type="text" data-panel-feld="kennwert" class="${
               kennwertAutomatisch(zeile) ? "bk-kw-auto" : optionenVon(zeile).length ? "bk-kw-manuell" : ""
             }"${kennwertAutomatisch(zeile) ? " readonly" : ""} value="${escapeHtml(zeile.kennwert || "")}"></div>
             ${kennwertKnopfHtml(zeile)}
           </div>`
    }
    <div class="bk-panel-kosten">
      <span style="font-size:11px; letter-spacing:0.4px; color:var(--text-muted); text-transform:uppercase;">Kosten</span>
      <span class="wert" id="panelKosten">${panelKostenText(zeile)}</span>
    </div>
    <div id="panelVorlage">${vorlageBlockHtml(zeile)}</div>
    <div id="panelOptionen">${optionenBlockHtml(zeile)}</div>
    ${modulFeld}
    <label>Notizen <span style="text-transform:none; letter-spacing:0;">(nicht im Ausdruck)</span></label>
    <textarea rows="3" data-panel-feld="intern">${escapeHtml(zeile.intern || "")}</textarea>
    <label>Bemerkungen</label>
    <textarea rows="3" data-panel-feld="extern">${escapeHtml(zeile.extern || "")}</textarea>
    <label>Durchgehen</label>
    ${panelStandHtml(nr)}
    <div class="bk-panel-fuss">
      ${
        ausVorlage(zeile)
          ? `<button type="button" class="bk-toggle" data-panel-action="vorlage-loesen"
                     title="Nimmt die Herkunft aus der Preisliste weg. Beschrieb, Einheit und Preispositionen bleiben stehen, die Zeile lässt sich danach löschen.">Vorlage lösen</button>`
          : `<button type="button" class="bk-toggle" data-panel-action="delete">${
              istEigeneEndposition(nr) ? "Position löschen" : "Zeile löschen"
            }</button>`
      }
      <span class="bk-panel-hinweis">Änderungen werden beim Schliessen gespeichert · Esc</span>
      <span class="bk-panel-bl">
        <button type="button" class="bk-toggle" data-panel-action="prev"${idx <= 0 ? " disabled" : ""}>‹ vorherige</button>
        <button type="button" class="bk-toggle" data-panel-action="next"${
          idx < 0 || idx >= geschwister.length - 1 ? " disabled" : ""
        }>nächste ›</button>
      </span>
    </div>
    </div>`;
}

// Der Knopf zum Umschalten steht in DERSELBEN Zeile wie Ausmass, Einheit
// und Kennwert -- er hat keine eigene mehr. Die früheren Marken darüber
// ("rechnet aus den Preispositionen" / "von Hand gesetzt") sind weg: sie
// kosteten eine ganze Zeile und sagten nichts, was das Kennwertfeld nicht
// schon zeigt (grau und schreibgeschützt = gerechnet, gelb umrandet = von
// Hand). Nur bei Zeilen mit Preispositionen -- sonst gibt es nichts
// umzuschalten.
function kennwertKnopfHtml(zeile) {
  if (!optionenVon(zeile).length) return "";
  return kennwertAutomatisch(zeile)
    ? `<div class="bk-kw-knopf">
         <button type="button" class="bk-toggle" data-panel-action="kennwert-manuell"
                 title="Der Kennwert rechnet aus den Preispositionen. Hier lässt er sich von Hand setzen.">Von Hand überschreiben</button>
       </div>`
    : `<div class="bk-kw-knopf">
         <button type="button" class="bk-toggle" data-panel-action="kennwert-auto"
                 title="Der Kennwert ist von Hand gesetzt. Hier rechnet er wieder aus den Preispositionen.">Aus Preispositionen (${zahl(
                   optionenSumme(zeile)
                 )})</button>
       </div>`;
}

// ---------- Bearbeitungsfenster: Vorlage ----------

// Deckel für die Liste. 150 deckt jede BKP-Nummer des echten Katalogs ab
// (die längste, 211.5 Beton- und Stahlbetonarbeiten, hat 145 Vorlagen) --
// er greift also praktisch nur beim Suchen über alles.
const VORLAGEN_MAX = 150;

function vorlageBlockHtml(zeile) {
  // Prozent-Zeilen haben keinen Kennwert, für sie gibt es nichts zu holen.
  if (zeile.basis) return "";
  // Ohne Vorlagen (Demomodus, keine Datei) gibt es den Block gar nicht --
  // dann ist das Fenster genau das, was es vorher war. Eine Zeile MIT
  // Herkunft zeigt sie trotzdem: sie steht in der Schätzung, nicht in der
  // Datei.
  if (!vorlagenMoeglich() && !(zeile.vorlage && zeile.vorlage.pfad)) return "";
  // Gewählt wird die Vorlage beim ANLEGEN der Zeile (siehe
  // oeffneVorlagenWahl()). Hier steht nur noch, woher sie stammt, und ein
  // Knopf zum Wechseln -- im Fenster geht es sonst nur um die Zahlen.
  const pfad = zeile.vorlage && zeile.vorlage.pfad;
  return `
    <label>Vorlage</label>
    <div class="bk-vorlage-aktuell">
      <span>${pfad ? "Aus der Preisliste: " + escapeHtml(pfad) : "Keine Vorlage — von Hand erfasst."}</span>
      <button type="button" class="bk-toggle" data-panel-action="vorlage-wechseln">${
        pfad ? "Andere Vorlage" : "Vorlage wählen"
      }</button>
    </div>`;
}

function vorlageListeHtml(zielNr) {
  if (!zielNr || !preislisteBaum) return "";
  const such = vorlageSuche.trim().toLowerCase();
  const alle = preislistePositionen();
  let liste;
  let hinweis;
  // Was von jedem Pfad abgeschnitten wird: steht der Knoten schon in der
  // Quellenzeile darüber, wäre er unter jedem Eintrag noch einmal nur
  // Lärm. Beim Suchen bleibt der ganze Pfad stehen -- dort ist gerade er
  // die Antwort auf "wo kommt das her?".
  let schnitt = 0;
  if (such) {
    // Beim Suchen bewusst im GANZEN Baum: wer tippt, sucht etwas
    // Bestimmtes, und das steht oft unter einer anderen Nummer.
    liste = alle.filter((e) => e.pfadText.toLowerCase().includes(such));
    hinweis = `Gesucht in der ganzen Preisliste`;
  } else {
    const knoten = preislisteKnotenFuer(zielNr);
    if (!knoten) {
      return `<div class="bk-vorlage-leer">Zu ${escapeHtml(
        knotenLabel(zielNr)
      )} führt die Preisliste nichts. Über das Suchfeld lässt sich trotzdem eine Vorlage holen.</div>`;
    }
    const praefix = knoten.pfadText + PFAD_TRENNER;
    liste = alle.filter((e) => e.pfadText === knoten.pfadText || e.pfadText.startsWith(praefix));
    hinweis = `Aus ${escapeHtml(knoten.pfadText)}`;
    schnitt = knoten.pfad.length;
  }
  if (!liste.length) return `<div class="bk-vorlage-leer">Keine Vorlage gefunden.</div>`;
  const gezeigt = liste.slice(0, VORLAGEN_MAX);

  // Nach Ordner gruppieren statt eine flache Liste: unter einer Gattung
  // hängen gern achtzig Positionen in einem Dutzend Ordnern ("Büro, WC,
  // Aufenthalts-, Wohn- und Lagerraum", "Materialcontainer", "Baukran").
  // Flach untereinander stünde unter jedem Eintrag derselbe lange Pfad, und
  // man fände nichts wieder. Eine Map behält die Reihenfolge des Baums.
  const gruppen = new Map();
  gezeigt.forEach((e) => {
    const rel = e.pfad.slice(schnitt, -1).join(PFAD_TRENNER);
    if (!gruppen.has(rel)) gruppen.set(rel, []);
    gruppen.get(rel).push(e);
  });

  // Die Suche läuft über den ganzen Baum. Ein Treffer von anderswo ist oft
  // genau der richtige, aber man muss es SEHEN -- sonst steht plötzlich
  // eine Position aus BKP 1 unter 211.0.
  const eigenerAst = preislisteKnotenFuer(zielNr);
  const istFremd = (e) =>
    !!eigenerAst &&
    e.pfadText !== eigenerAst.pfadText &&
    !e.pfadText.startsWith(eigenerAst.pfadText + PFAD_TRENNER);
  const eintragHtml = (e) => `<li><button type="button" data-panel-action="vorlage" data-pfad="${escapeHtml(
    e.pfadText
  )}">
      <span class="bk-vorlage-titel">${escapeHtml(e.knoten.bezeichnung || "(ohne Bezeichnung)")}</span>
      ${istFremd(e) ? `<span class="bk-vorlage-fremd" title="${escapeHtml(e.pfad.slice(0, 2).join(PFAD_TRENNER))}">anderer Bereich</span>` : ""}
      <span class="bk-vorlage-preis">${
        (e.knoten.optionen || []).length
          ? zahl(vorlageEinheitspreis(e.knoten)) + (e.knoten.einheit ? " / " + escapeHtml(e.knoten.einheit) : "")
          : "<span title=\"Diese Position führt in der Preisliste keine Preispositionen\">ohne Preis</span>"
      }</span>
    </button></li>`;

  return `
    <div class="bk-vorlage-quelle">${hinweis} · ${liste.length} ${liste.length === 1 ? "Vorlage" : "Vorlagen"}</div>
    <ul class="bk-vorlage-liste">
      ${[...gruppen]
        .map(
          ([rel, eintraege]) =>
            (rel ? `<li class="bk-vorlage-gruppe">${escapeHtml(rel)}</li>` : "") +
            eintraege.map(eintragHtml).join("")
        )
        .join("")}
    </ul>
    ${
      liste.length > gezeigt.length
        ? `<div class="bk-vorlage-leer">… ${liste.length - gezeigt.length} weitere — Suche verfeinern.</div>`
        : ""
    }`;
}

// ---------- Bearbeitungsfenster: Optionen ----------

function optionenBlockHtml(zeile) {
  const optionen = optionenVon(zeile);
  if (!optionen.length || zeile.basis) return "";
  const summe = optionenSumme(zeile);
  // Ohne Überschrift: "Position · Preis · Menge · Betrag" in der Kopfzeile
  // sagt schon, was hier steht -- ein Titel "Preispositionen" darüber wäre
  // bloss eine Zeile mehr im Fenster.
  return `<ul class="bk-opt-liste">
      <li class="bk-opt-kopfzeile">
        <span></span><span>Position</span><span class="bk-opt-rechts">Preis</span>
        <span></span><span class="bk-opt-rechts">Menge</span><span class="bk-opt-rechts">Betrag</span>
      </li>
      ${optionen.map((o, i) => optionZeileHtml(o, i)).join("")}
      <li class="bk-opt-summe">
        <span></span><span>Kennwert${zeile.einheit ? " pro " + escapeHtml(zeile.einheit) : ""}</span>
        <span></span><span></span><span></span>
        <span class="bk-opt-rechts" data-opt-gesamt>${zahl(summe)}</span>
      </li>
    </ul>`;
}

function optionZeileHtml(opt, index) {
  return `<li class="bk-opt-zeile${opt.aktiv ? "" : " aus"}" data-opt="${index}">
    <input type="checkbox" data-opt-wahl${
      opt.aktiv ? " checked" : ""
    } aria-label="Diese Preisposition mitrechnen">
    <span class="bk-opt-text">${escapeHtml(opt.text || "(ohne Text)")}${
      vorlagePreisAbweichung(opt) === null
        ? '<span class="bk-opt-vorlage" data-opt-vorlage hidden></span>'
        : `<span class="bk-opt-vorlage" data-opt-vorlage>Vorlagepreis: ${zahl(vorlagePreisAbweichung(opt))}</span>`
    }</span>
    <span class="bk-opt-feld">
      <input type="text" class="bk-opt-num" data-opt-feld="preis" value="${escapeHtml(
        String(opt.preis ?? "")
      )}" aria-label="Preis"><span class="bk-opt-einheit">${escapeHtml(opt.preisEinheit || "")}</span>
    </span>
    <span class="bk-opt-mal">×</span>
    <span class="bk-opt-feld">
      <input type="text" class="bk-opt-num" data-opt-feld="menge" value="${escapeHtml(
        String(opt.menge ?? "")
      )}" aria-label="Menge"><span class="bk-opt-einheit">${escapeHtml(opt.mengeEinheit || "")}</span>
    </span>
    <span class="bk-opt-betrag bk-opt-rechts" data-opt-betrag>${zahl(optionBetrag(opt))}</span>
  </li>`;
}

// Der Preis der Vorlage, falls er vom jetzigen abweicht -- sonst null. Er
// steht klein unter der Zeile, damit sichtbar bleibt, dass hier für DIESE
// Schätzung ein anderer Preis gilt.
function vorlagePreisAbweichung(opt) {
  const vorlage = opt.vorlagePreis;
  if (vorlage === "" || vorlage === undefined || vorlage === null) return null;
  return optionZahl(vorlage) === optionZahl(opt.preis) ? null : optionZahl(vorlage);
}

// Das Overlay schliessen -- offene Eingabe übernehmen, dann neu zeichnen.
function schliessePanel() {
  uebernimmOffeneEingabe();
  gewaehlteZeile = null;
  document.querySelectorAll("#bkBody tr.bk-sub.gewaehlt").forEach((tr) => tr.classList.remove("gewaehlt"));
  renderTabelleErhalten();
}

// Das Durchgeh-Feld im Bearbeitungsfenster: dieselben zwei Knöpfe wie im
// Baum, damit es nur EINE Bedienung gibt. `letzterStatus` steht hier schon,
// weil renderPanel() immer nach dem Zeichnen der Tabelle läuft.
// Eigene Funktion, weil der Live-Takt diesen Text nachführt, ohne das
// Fenster neu zu bauen (siehe aktualisiereStandAnzeige()).
function panelStandText(stand) {
  const text =
    stand.anzahl >= HAKEN_MAX
      ? `Vieraugenprinzip${stand.kuerzel.length ? ` – ${kuerzelText(stand.kuerzel)}` : ""}`
      : stand.anzahl === 1
      ? `Durchgegangen${stand.kuerzel.length ? ` von ${kuerzelText(stand.kuerzel)}` : ""} – die zweite Person fehlt noch`
      : stand.gelb
      ? "Erfasst, aber noch von niemandem durchgegangen"
      : "Noch nichts erfasst";
  return text + (stand.eigeneFrage ? ` · Frage von ${stand.eigeneFrage} offen` : "");
}

function panelStandHtml(nr) {
  const stand = letzterStatus[nr] || LEERER_STAND;
  return `<div class="bk-panel-stand">
    ${statusHtml(nr, stand, !kinderVon(nr).length)}
    <span class="bk-panel-stand-text">${escapeHtml(panelStandText(stand))}</span>
  </div>`;
}

// Zur vorherigen/nächsten Position derselben BKP-Nummer, ohne zu schliessen.
function panelNachbar(richtung) {
  if (!gewaehlteZeile) return;
  uebernimmOffeneEingabe();
  const geschwister = zeilenVon(gewaehlteZeile.nr);
  const i = geschwister.findIndex((z) => z.id === gewaehlteZeile.id);
  const ziel = geschwister[i + richtung];
  if (!ziel) return;
  gewaehlteZeile = { nr: gewaehlteZeile.nr, id: ziel.id };
  vorlageSuche = "";
  renderTabelleErhalten();
  fokussierePanel();
}

// Beim Öffnen in das erste Feld springen -- nur von hier und aus
// waehleZeile(), NICHT aus renderPanel(): das läuft bei jedem Neuaufbau der
// Tabelle und würde den Fokus ständig an sich reissen.
function fokussierePanel() {
  const feld = document.querySelector('#detailPanel [data-panel-feld="beschrieb"]');
  if (feld) feld.focus();
}

// Tabulator bleibt im Fenster: es ist modal, dahinter ist nichts bedienbar.
function onPanelKeydown(e) {
  if (e.key !== "Tab") return;
  const panel = document.getElementById("detailPanel");
  const ziele = [...panel.querySelectorAll("button, input, select, textarea, summary, [tabindex]")].filter(
    (el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null
  );
  if (!ziele.length) return;
  const erste = ziele[0];
  const letzte = ziele[ziele.length - 1];
  if (e.shiftKey && document.activeElement === erste) {
    letzte.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === letzte) {
    erste.focus();
    e.preventDefault();
  }
}

// Ohne Ausmass steht hier "– Ausmass fehlt" statt eines Betrags: sonst
// zeigt das Fenster eine Zahl, die die Zeile gar nicht in die Schätzung
// einbringt.
// Links neben der grossen Zahl (inkl. MwSt, gerundet) steht heller und
// nicht fett der Betrag OHNE MwSt -- den braucht man beim Vergleich mit
// einer Offerte. Ohne MwSt-Satz entfällt er: dort stünde zweimal dasselbe,
// und die gerundete Zahl wäre erst noch die ehrlichere.
function panelKostenText(zeile) {
  if (ausmassFehlt(zeile)) return '<span class="bk-kosten-offen">– <small>Ausmass fehlt</small></span>';
  const netto = mwstSatz()
    ? `<span class="bk-kosten-netto" title="ohne MwSt">${franken(zeilenNetto(zeile))}</span>`
    : "";
  return netto + "CHF " + franken(zeilenKosten(zeile));
}

function renderPanelKosten() {
  const el = document.getElementById("panelKosten");
  if (!el || !gewaehlteZeile) return;
  const zeile = zeileSuchen(offen, gewaehlteZeile.id);
  if (zeile) el.innerHTML = panelKostenText(zeile);
}

function waehleZeile(nr, rowId) {
  gewaehlteZeile = { nr, id: rowId };
  vorlageSuche = "";
  document.querySelectorAll("#bkBody tr.bk-sub.gewaehlt").forEach((tr) => tr.classList.remove("gewaehlt"));
  const tr = document.querySelector(`#bkBody tr.bk-sub[data-row="${rowId}"]`);
  if (tr) tr.classList.add("gewaehlt");
  renderPanel();
  fokussierePanel();
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

// Der ETag kommt mit, damit der Live-Takt sehen kann, OB sich eine Datei
// geändert hat, ohne sie zu laden: eine Kostenschätzung sind hunderte
// Kilobyte, diese Antwort ein paar hundert Bytes. `getlastmodified` steht
// als Ersatz daneben, falls ein Server keinen ETag liefert.
const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>';

// Ordnerinhalt als [{ name, kennung }] -- eine Anfrage, zwei Verwendungen:
// die Liste der Schätzungen (listFilenames()) und der Live-Takt, der daraus
// die Kennung der offenen Datei UND die von "_praesenz.json" liest.
async function ordnerEintraege() {
  const relPath = davPath(bkSegments().join("/") + "/");
  const res = await proxyFetch(relPath, {
    method: "PROPFIND",
    headers: { ...authHeader(), Depth: "1", "Content-Type": "application/xml" },
    body: PROPFIND_LIST_BODY
  });
  if (!res.ok) throw new Error(`Ordnerinhalt lesen fehlgeschlagen (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  const text = (el) => (el ? el.textContent.trim() : "");
  return Array.from(doc.getElementsByTagNameNS("DAV:", "response")).map((resp) => {
    const href = text(resp.getElementsByTagNameNS("DAV:", "href")[0]);
    return {
      name: decodeURIComponent(href.replace(/\/$/, "").split("/").pop() || ""),
      kennung:
        text(resp.getElementsByTagNameNS("DAV:", "getetag")[0]) ||
        text(resp.getElementsByTagNameNS("DAV:", "getlastmodified")[0])
    };
  });
}

async function listFilenames() {
  return (await ordnerEintraege())
    .map((e) => e.name)
    // Dateien mit "_" am Anfang sind Stammdaten, keine Kostenschätzung
    // (hier "_bkp_katalog.json", "_praesenz.json") -- gleiche Konvention wie
    // "_optionen.json" in der Adressliste und "_absender.json" bei den Offerten.
    .filter((name) => name.toLowerCase().endsWith(".json") && !name.startsWith("_"));
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
    // Der Katalog MUSS vor den Schätzungen stehen: migriere() entscheidet
    // anhand von ihm, was eine unbekannte Nummer ist.
    await ladeKatalog();
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
    setSyncLine(
      katalogQuelle === "repo"
        ? `Synchronisiert · BKP-Katalog fehlt (${KATALOG_FILENAME}) — es gilt der gröbere Grundkatalog`
        : "Synchronisiert"
    );
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
  // "Zusätzlich"-Module (Positionen ausserhalb des Totals) gibt es nicht
  // mehr -- ihre Positionen zählen jetzt wie alle anderen ins Total.
  data.module.forEach((m) => delete m.zusatz);
  if (!data.haken) data.haken = {};
  if (!data.fragen) data.fragen = {};
  // Bis November 2026 stand der Durchgeh-Stand als GEMEINSAMER `status` je
  // Nummer in der Datei (offen/pendent/erledigt/verifiziert), daneben
  // `geprueft` mit den Kürzeln. Jetzt setzt jede Person ihr eigenes
  // Häkchen: `geprueft` IST die neue Liste, "pendent" entfällt ersatzlos
  // (gelb wird gerechnet, siehe statusBerechnen()). Die alten Felder
  // werden entfernt, damit die Datei beim nächsten Speichern dauerhaft im
  // neuen Format landet -- wie bei den Jahres-Dateien der Finanzplanung.
  if (data.geprueft) {
    Object.entries(data.geprueft).forEach(([nr, liste]) => {
      const kuerzel = (Array.isArray(liste) ? liste : []).filter(Boolean).slice(0, HAKEN_MAX);
      if (kuerzel.length && !data.haken[nr]) data.haken[nr] = kuerzel;
    });
  }
  delete data.geprueft;
  delete data.status;
  // Vor dem MwSt-Satz waren die Kennwerte inklusive erfasst; für solche
  // Dateien ist 0 der richtige Startwert, sonst käme die MwSt doppelt drauf.
  if (typeof data.mwst !== "number") data.mwst = 0;
  // basis (Prozent-Berechnung) kam später dazu -- fehlt sie, ist die Zeile
  // eine ganz normale "Ausmass × Kennwert"-Zeile. Die kurzzeitig zweite
  // Variante "bkp19" (mit Honoraren) gibt es nicht mehr: solche Zeilen
  // rechnen neu auf dieselbe Grundlage wie alle anderen.
  Object.values(data.positionen).forEach((zeilen) => {
    (zeilen || []).forEach((z) => {
      if (z.basis === undefined) z.basis = "";
      else if (z.basis && z.basis !== BASIS_ART) z.basis = BASIS_ART;
      // Optionen gibt es erst seit den Vorlagen der Preisliste, und sie werden
      // bewusst NICHT überall ergänzt -- eine Zeile ohne Optionen hat das
      // Feld schlicht nicht. Nur was da ist, wird in Form gebracht: eine
      // unbekannte Art würde sonst in keiner Gruppe auftauchen.
      if (Array.isArray(z.optionen)) {
        z.optionen.forEach((o) => {
          // Ein "Bestandteil" zählte früher immer mit, auch ohne Häkchen --
          // jetzt entscheidet allein das Häkchen, also muss es gesetzt sein.
          if (o.typ === "bestandteil") o.aktiv = true;
        });
      }
    });
  });
  data.druck = { ...DRUCK_DEFAULTS, ...(data.druck || {}) };
  migriereAuf2017(data);
  return data;
}

// Bis November 2026 lief die App auf dem BKP der Ausgabe 1991, seither auf
// 2017 (siehe bkp.js). Erfasste Zeilen hängen an der NUMMER, deshalb muss
// beim Öffnen einer älteren Datei zweierlei aufgefangen werden. Beides ist
// idempotent -- beim zweiten Mal findet die Funktion nichts mehr.
function migriereAuf2017(data) {
  // Ohne die Norm von Nextcloud würde hier gegen den gröberen Grundkatalog
  // migriert -- Zeilen landeten in eigenen Unterkapiteln, bloss weil die
  // Datei gerade fehlt. Sichtbar bleiben sie auch so (unbekannteKnoten()).
  if (!katalogIstVollstaendig()) return;
  const eigene = data.eigenePositionen;
  const belegt = (nr) => !!katalogTitel[nr] || eigene.some((p) => p.nr === nr);

  // Eine Nummer samt allem darunter umhängen.
  const umbenennen = (alt, neu) => {
    const passt = (n) => n === alt || n.startsWith(alt + ".");
    const ersetzt = (n) => neu + n.slice(alt.length);
    eigene.forEach((p) => {
      if (passt(p.nr)) p.nr = ersetzt(p.nr);
    });
    [data.positionen, data.haken, data.fragen].filter(Boolean).forEach((topf) => {
      Object.keys(topf).forEach((n) => {
        if (!passt(n)) return;
        topf[ersetzt(n)] = topf[n];
        delete topf[n];
      });
    });
  };

  // (1) Eigene Unterteilungen, deren Nummer der Katalog inzwischen selber
  // führt: "211.1" war eine selbstgemachte Unterteilung, heute ist es die
  // Gattung "Gerüste". Sie bekommen eine freie Kennung (ab .10) und stehen
  // mit Titel und Zeilen neben der Gattung. Zusammenlegen ist Handarbeit --
  // ob dasselbe gemeint war, darf die App nicht raten.
  for (let schutz = 0; schutz < 500; schutz++) {
    const treffer = eigene.find((p) => katalogTitel[p.nr]);
    if (!treffer) break;
    const eltern = elterNummer(treffer.nr);
    let i = 10;
    while (belegt(`${eltern}.${i}`)) i++;
    umbenennen(treffer.nr, `${eltern}.${i}`);
  }

  // (2) Nummern, die 2017 ersatzlos gestrichen sind (18, 241, 243, 267,
  // 57x, 59x ...). Ohne Knoten im Baum zählten ihre Zeilen zwar weiter ins
  // Total, wären aber nirgends mehr zu sehen. Sie kommen als eigenes
  // Unterkapitel zurück, angeschrieben mit ihrer alten Nummer -- sonst
  // wüsste niemand, woher sie stammen.
  Object.keys(data.positionen)
    .filter((nr) => (data.positionen[nr] || []).length)
    .forEach((nr) => {
      [...vorfahren(nr), nr].forEach((n) => {
        if (belegt(n)) return;
        const titel = BKP_ENTFALLEN_1991[n];
        eigene.push({ nr: n, titel: titel ? `${titel} (BKP ${n}, Ausgabe 1991)` : `Ohne Zuordnung (${n})` });
      });
    });
}

function leereSchaetzung({ titel, projekt, projektName, genauigkeit, kostenstand }) {
  return {
    id: uid(),
    titel: titel || "Kostenschätzung",
    projekt: projekt || "",
    projektName: projektName || "",
    genauigkeit: genauigkeit || "",
    kostenstand: kostenstand || "",
    mwst: MWST_DEFAULT,
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
// Zählt JEDE eigene Änderung. Der Live-Takt darf einen Serverstand nur
// übernehmen, wenn seither nichts Eigenes dazugekommen ist -- sonst wirft
// er es weg (siehe holeFremdenStand()).
let lokaleAenderungen = 0;
// Nur wenn die letzte Speicherung durchkam, steht auf dem Server alles, was
// hier getippt wurde -- erst dann darf holeFremdenStand() den lokalen Stand
// durch den vom Server ersetzen.
let letzteSpeicherungOk = true;

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
  lokaleAenderungen++;
  cacheAktualisieren(filename, offen);
  beschleunigeLive();
  if (neuRendern) render();
  else refreshSummen();
  syncQueue = syncQueue.then(() => persist(filename, mutateFn));
  return syncQueue;
}

async function persist(filename, mutateFn) {
  const istAktuell = () => filename === offenFilename;
  if (!isConfigured()) {
    letzteSpeicherungOk = false;
    if (istAktuell()) setSyncLine("Nextcloud noch nicht eingerichtet · Einstellungen ⚙");
    return;
  }
  if (!navigator.onLine) {
    letzteSpeicherungOk = false;
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
    letzteSpeicherungOk = true;
  } catch (err) {
    letzteSpeicherungOk = false;
    console.warn("Kostenschätzung konnte nicht gespeichert werden:", err);
    if (istAktuell()) setSyncLine("Fehler beim Speichern");
  }
}

// ---------- Stand der anderen nachladen ----------
//
// Zwei Personen können gleichzeitig an derselben Schätzung arbeiten:
// persist() legt jede Änderung auf einen frisch geholten Serverstand, zwei
// verschiedene Zeilen überschreiben sich also nicht. Was fehlte, war das
// SEHEN -- die Zeilen der anderen tauchten erst nach einem Neuladen auf.
// Deshalb dasselbe wie in offerten/: beim Zurückkehren in den Tab nachladen.
//
// Geholt wird nur DIESE Datei, nicht die ganze Liste wie refreshAlle(): der
// Katalog und die übrigen Schätzungen ändern sich nicht, während man in
// einer tippt, und ein Neuaufbau der Liste würde die Tabelle zurücksetzen.
// `sanft` ist der LIVE-Takt (siehe unten), `false` der bisherige Weg beim
// Zurückkehren in den Tab. Rückgabe: ob der Serverstand wirklich verarbeitet
// wurde -- nur dann darf der Takt dessen Kennung als "gesehen" merken.
async function holeFremdenStand({ sanft = false } = {}) {
  if (!offenFilename || !isConfigured() || !navigator.onLine) return false;
  // Zuerst das gerade offene Feld und die Warteschlange rausschreiben --
  // sonst holt man den Stand von VOR dem eigenen letzten Tastendruck.
  // Im Live-Takt NICHT: der läuft alle paar Sekunden, auch mitten im Tippen,
  // und würde einen halb getippten Wert wegschreiben. Verloren geht dabei
  // nichts -- was im Feld steht, ist ohnehin noch nicht in `offen`, und
  // change/blur tragen es nach.
  if (!sanft) uebernimmOffeneEingabe();
  // Wirklich ALLES Eigene muss draussen sein, bevor geholt wird. Ein
  // einzelnes `await syncQueue` genügt dafür nicht: `mutate()` hängt
  // während des Wartens weiter an, und awaitet wird nur der Stand von
  // vorhin. Genau daran verschwanden Häkchen wieder (November 2026
  // gemeldet). Die Schleife ist gedeckelt -- wer ununterbrochen klickt,
  // soll den Takt nicht festhalten; der Zähler unten fängt den Rest.
  for (let i = 0; i < 5; i++) {
    const warteAuf = syncQueue;
    await warteAuf.catch(() => {});
    if (warteAuf === syncQueue) break;
  }
  // Ist das Schreiben gescheitert, steht die eigene Änderung nur hier. Dann
  // nicht überschreiben; die Sync-Zeile meldet den Fehler ohnehin.
  if (!letzteSpeicherungOk || !offenFilename) return false;
  const filename = offenFilename;
  const standVorher = lokaleAenderungen;
  let daten;
  try {
    daten = await fetchFile(filename);
  } catch (err) {
    console.warn("Stand konnte nicht nachgeladen werden:", err);
    return false;
  }
  // Zwischenzeitlich geschlossen oder gewechselt? Dann gehört der Stand
  // nicht mehr hierher.
  if (!daten || typeof daten !== "object" || filename !== offenFilename) return false;
  // Während des Holens wurde hier geklickt oder getippt -- der geholte
  // Stand kennt das noch nicht und würde es wegwerfen. Nicht übernehmen;
  // der nächste Takt holt frisch (die Kennung wird nicht gemerkt).
  if (lokaleAenderungen !== standVorher) return false;
  // Verglichen wird der INHALT, nicht updatedAt: persist() ersetzt den
  // lokalen Stand bewusst nicht durch den gerade geschriebenen (siehe dort).
  // Speichert nach der anderen Person auch diese hier, trägt die Datei
  // deren Zeitstempel -- die fremden Zeilen stünden trotzdem nur auf dem
  // Server. Über den Inhalt fällt dieser Fall nicht durchs Raster.
  const neu = migriere(daten);
  if (inhaltsKennung(neu) === inhaltsKennung(offen)) return true;
  const fremd = (neu.updatedBy || "") !== personName();
  const wer = fremd ? neu.updatedBy || "jemand" : "";

  // Haben sich NUR Häkchen und Fragen geändert, werden die Kästchen einzeln
  // ausgetauscht statt Tabelle und Fenster neu gebaut -- der Fokus bleibt,
  // wo er ist. Genau dafür ist der Live-Takt da.
  if (sanft && nurStandGeaendert(offen, neu)) {
    const was = standUnterschied(offen, neu);
    letzteAktivitaet = Date.now();
    offen = neu;
    cacheAktualisieren(filename, offen);
    aktualisiereStandAnzeige(was.nummern);
    setSyncLine(standMeldung(was, wer) || "Aktualisiert");
    return true;
  }
  // Mehr als die Kästchen: das geht nur über einen Neuaufbau, und der
  // nimmt den Fokus mit. Tippt gerade jemand, wird es aufgeschoben --
  // der nächste Takt (oder das Verlassen des Feldes) holt es nach. Der
  // Stand von JETZT wird bewusst nicht aufbewahrt: bis zum Anwenden wäre
  // er veraltet und würde das eben Getippte überschreiben.
  if (sanft && eingabeImFokus()) {
    standAusstehend = true;
    return false;
  }
  standAusstehend = false;
  letzteAktivitaet = Date.now();
  offen = neu;
  cacheAktualisieren(filename, offen);
  renderTabelleErhalten();
  setSyncLine(
    fremd ? `Stand von ${wer} übernommen · ${zeitpunktText(neu.updatedAt)}` : "Aktualisiert"
  );
  return true;
}

// Tippt gerade jemand in ein Feld? Dann darf nichts neu gezeichnet werden.
// Die Felder tragen alle eines dieser data-Attribute (siehe
// uebernimmOffeneEingabe()); Suchfeld und Dialoge sind bewusst nicht dabei,
// die baut renderTabelleErhalten() nicht neu.
function eingabeImFokus() {
  const el = document.activeElement;
  if (!el || !el.dataset) return false;
  return !!(el.dataset.feld || el.dataset.panelFeld || el.dataset.optFeld);
}

// Inhalt ohne die Spuren des Speicherns -- wer zuletzt gespeichert hat,
// sagt nichts darüber, ob sich etwas geändert hat.
function inhaltsKennung(data) {
  return JSON.stringify({ ...data, updatedAt: null, updatedBy: null });
}

function zeitpunktText(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "gerade eben";
  const heute = new Date().toDateString() === d.toDateString();
  return heute
    ? d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("de-CH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---------- Live: sehen, was die andere Person gerade tut ----------
//
// Nextcloud kann den Browser nicht anstupsen, und der Worker-Proxy reicht
// nur durch -- "live" heisst hier also: in kurzen Abständen nachfragen.
// Geladen wird dabei NICHT die Schätzung (hunderte Kilobyte), sondern ein
// PROPFIND auf den Ordner (ein paar hundert Bytes). Erst wenn sich die
// Kennung der Datei geändert hat, folgt der eigentliche GET.
//
// Nach dem EIGENEN Speichern ändert sich die Kennung ebenfalls, der
// nächste Takt holt also einmal unnötig die Datei und stellt fest, dass
// der Inhalt derselbe ist. Das ist Absicht: die neue Kennung schon beim
// Speichern zu merken ginge nur mit einer zweiten Anfrage danach -- und
// hätte die andere Person dazwischen geschrieben, wäre genau deren
// Änderung für immer als "gesehen" abgehakt.
// Der Takt PASST SICH AN, statt immer gleich schnell zu laufen: eine
// Schätzung liegt oft stundenlang offen, ohne dass jemand anders drin
// ist -- dort ist jede Anfrage verschenkt. Solange aber gerade etwas
// passiert (eigene oder fremde Änderung in den letzten zwei Minuten),
// sitzt man typischerweise zu zweit daran und geht sie durch. Dann sind
// drei Sekunden praktisch sofort. Unter ein bis zwei Sekunden lohnt es
// sich nicht: dort liegt schon der Roundtrip Browser -> Worker ->
// Nextcloud, und sehen würde man den Unterschied nicht.
const LIVE_TAKT_SCHNELL = 3000;
const LIVE_TAKT_RUHIG = 15000;
const LIVE_AKTIV_MS = 2 * 60 * 1000;

let liveAn = false;
let liveTimer = null;
// Zählt bei jedem Start/Stopp hoch: eine noch laufende Schleife aus einem
// früheren Durchgang (z.B. eine andere Schätzung) darf sich nicht selbst
// wieder einplanen.
let liveLauf = 0;
let liveLaeuft = false;
let letzteAktivitaet = 0;
let letzteDateiKennung = "";
// Ein fremder Stand, der mehr als Häkchen/Fragen ändert, während hier
// jemand in einem Feld tippt: aufgeschoben, nicht aufbewahrt (siehe
// holeFremdenStand()).
let standAusstehend = false;
let nachholTimer = null;

function liveMoeglich() {
  // Im Demomodus gibt es keine zweite Person -- und die Attrappe liefert
  // bei einem PROPFIND ohnehin keine ETags.
  return !!offenFilename && isConfigured() && navigator.onLine && !istDemo();
}

function liveTaktZeit() {
  return Date.now() - letzteAktivitaet < LIVE_AKTIV_MS ? LIVE_TAKT_SCHNELL : LIVE_TAKT_RUHIG;
}

// Kein setInterval: der Abstand ändert sich, und ein zäher Takt soll sich
// nicht stapeln. Die Schleife plant sich nach jedem Durchgang neu ein.
function planeLive(lauf, verzoegerung) {
  if (lauf !== liveLauf) return;
  if (!liveMoeglich() || document.visibilityState !== "visible") return stoppeLive();
  liveTimer = setTimeout(() => liveSchleife(lauf), verzoegerung === undefined ? liveTaktZeit() : verzoegerung);
}

async function liveSchleife(lauf) {
  if (lauf !== liveLauf) return;
  liveTimer = null;
  await liveTakt();
  versucheGliederungNochmals();
  planeLive(lauf);
}

function starteLive() {
  stoppeLive();
  if (!liveMoeglich()) return;
  liveAn = true;
  // Gerade geöffnet -- die ersten Minuten im schnellen Takt.
  letzteAktivitaet = Date.now();
  liveSchleife(++liveLauf);
}

function stoppeLive() {
  liveLauf++;
  liveAn = false;
  clearTimeout(liveTimer);
  liveTimer = null;
  clearTimeout(nachholTimer);
  letzteDateiKennung = "";
  letztePraesenzKennung = "";
  letztePraesenzSchrift = 0;
  standAusstehend = false;
  praesenzStand = {};
  zeigePraesenz();
}

// Nach einer eigenen Änderung kommt die Antwort der anderen Person oft
// gleich darauf -- dann nicht erst den ruhigen Takt zu Ende warten.
// Läuft gerade ein Durchgang (liveTimer === null), erledigt der das schon.
function beschleunigeLive() {
  const warRuhig = Date.now() - letzteAktivitaet >= LIVE_AKTIV_MS;
  letzteAktivitaet = Date.now();
  if (!liveAn || !liveTimer || !warRuhig) return;
  clearTimeout(liveTimer);
  liveTimer = null;
  planeLive(liveLauf, LIVE_TAKT_SCHNELL);
}

async function liveTakt() {
  // Ein langsamer Takt (grosse Datei, zähes Netz) soll sich nicht stapeln.
  if (liveLaeuft || document.visibilityState !== "visible") return;
  if (!liveMoeglich()) return stoppeLive();
  liveLaeuft = true;
  const filename = offenFilename;
  try {
    const eintraege = await ordnerEintraege();
    if (filename !== offenFilename) return;
    const eintrag = eintraege.find((e) => e.name === filename);
    // Noch nie gespeichert (frisch angelegt, Speichern noch unterwegs):
    // dann gibt es auch nichts zu vergleichen.
    if (!eintrag) return;
    if (!eintrag.kennung) {
      // Ohne ETag und ohne Änderungsdatum bliebe nur, alle acht Sekunden
      // die ganze Datei zu laden. Dann lieber kein Live-Takt; der Stand
      // kommt weiterhin beim Wechsel in den Tab (visibilitychange).
      console.info("Server liefert weder ETag noch Änderungsdatum – Live-Abgleich aus.");
      stoppeLive();
      return;
    }
    if (eintrag.kennung !== letzteDateiKennung || standAusstehend) {
      const uebernommen = await holeFremdenStand({ sanft: true });
      if (filename !== offenFilename) return;
      // Nur als gesehen merken, wenn der Stand wirklich verarbeitet wurde --
      // sonst bliebe eine aufgeschobene Änderung für immer liegen.
      if (uebernommen) letzteDateiKennung = eintrag.kennung;
    }

    const praesenz = (eintraege.find((e) => e.name === PRAESENZ_DATEI) || {}).kennung || "";
    if (praesenz && praesenz !== letztePraesenzKennung) {
      await lesePraesenz();
      letztePraesenzKennung = praesenz;
    }
    // Veraltete Einträge verschwinden auch dann, wenn niemand mehr schreibt
    // (und die Kennung sich darum nicht mehr ändert).
    zeigePraesenz();
    await schreibePraesenz();
  } catch (err) {
    // Netz kurz weg, Nextcloud antwortet nicht: beim nächsten Takt nochmals.
    console.debug("Live-Abgleich übersprungen:", err);
  } finally {
    liveLaeuft = false;
  }
}

// ---------- Wer ist sonst noch an dieser Schätzung? ----------
//
// "_praesenz.json" liegt neben den Schätzungen; der Unterstrich hält sie
// aus deren Liste heraus (wie "_bkp_katalog.json"). Darin steht je Person
// das Kürzel, die offene Datei und wann sie sich zuletzt gemeldet hat.
//
// Das ist die einzige Stelle im Repo, die im Hintergrund regelmässig
// SCHREIBT. Deshalb so sparsam wie möglich: nur solange eine Schätzung
// offen und der Tab sichtbar ist, höchstens alle 30 Sekunden, und eine
// Datei von wenigen hundert Bytes. Geschrieben wird wie überall sonst auf
// einen frisch geholten Stand, damit sich zwei Leute nicht gegenseitig
// austragen; geht dabei etwas schief, ist es nicht schlimm -- der Eintrag
// veraltet von selbst und wird 30 Sekunden später neu gesetzt.
const PRAESENZ_DATEI = "_praesenz.json";
const PRAESENZ_SCHREIB_MS = 30000;
const PRAESENZ_FRISCH_MS = 75000; // gut zwei Schreibtakte -- einer darf ausfallen
const PRAESENZ_ALT_MS = 10 * 60 * 1000; // so alte Einträge fliegen beim Schreiben raus

let praesenzStand = {};
let letztePraesenzKennung = "";
let letztePraesenzSchrift = 0;
let letztePraesenzAnzeige = "";

async function lesePraesenz() {
  let stand;
  try {
    stand = await fetchFile(PRAESENZ_DATEI);
  } catch (err) {
    return; // beim nächsten Takt nochmals
  }
  praesenzStand = stand && typeof stand === "object" ? stand : {};
}

async function schreibePraesenz() {
  const ich = meinKuerzel();
  if (!ich || !offenFilename) return;
  const jetzt = Date.now();
  if (jetzt - letztePraesenzSchrift < PRAESENZ_SCHREIB_MS) return;
  letztePraesenzSchrift = jetzt;
  const datei = offenFilename;
  let stand;
  try {
    stand = await fetchFile(PRAESENZ_DATEI);
  } catch (err) {
    // Nicht blind schreiben: ein leerer Stand würde die anderen austragen.
    letztePraesenzSchrift = 0;
    return;
  }
  const frisch = {};
  Object.entries(stand && typeof stand === "object" ? stand : {}).forEach(([k, v]) => {
    if (v && v.at && jetzt - Date.parse(v.at) < PRAESENZ_ALT_MS) frisch[k] = v;
  });
  frisch[ich] = { name: personName(), datei, at: new Date().toISOString() };
  try {
    await putFile(PRAESENZ_DATEI, frisch);
    praesenzStand = frisch;
    zeigePraesenz();
  } catch (err) {
    letztePraesenzSchrift = 0;
  }
}

// Beim Zurück zur Liste den eigenen Eintrag wegnehmen -- sonst stünde das
// eigene Kürzel bei der anderen Person noch über eine Minute da, obwohl man
// längst weg ist. Fehler sind hier belanglos: der Eintrag veraltet ohnehin.
function meldeAbwesend() {
  const ich = meinKuerzel();
  if (!liveAn || !ich) return;
  (async () => {
    try {
      const stand = await fetchFile(PRAESENZ_DATEI);
      if (!stand || typeof stand !== "object" || !stand[ich]) return;
      delete stand[ich];
      await putFile(PRAESENZ_DATEI, stand);
    } catch (err) {
      /* egal */
    }
  })();
}

function zeigePraesenz() {
  const el = document.getElementById("praesenz");
  if (!el) return;
  const jetzt = Date.now();
  const ich = meinKuerzel();
  const leute = Object.entries(praesenzStand)
    .filter(([k, v]) => v && k !== ich && v.datei === offenFilename)
    .filter(([, v]) => v.at && jetzt - Date.parse(v.at) < PRAESENZ_FRISCH_MS)
    .map(([k, v]) => ({ kuerzel: k, name: v.name || k }));
  const kennung = leute.map((p) => p.kuerzel).join("/");
  if (kennung === letztePraesenzAnzeige) return;
  letztePraesenzAnzeige = kennung;
  el.innerHTML = leute
    .map(
      (p) =>
        `<span class="bk-praesenz-wer" title="${escapeHtml(
          p.name
        )} ist gerade auch an dieser Schätzung">${escapeHtml(p.kuerzel)}</span>`
    )
    .join("");
  el.hidden = !leute.length;
  // Die Zeile kann dadurch höher oder niedriger werden -- die Spaltentitel
  // rasten an der gemessenen Höhe ein.
  messeSticky();
}

// ---------- Nur die Statuskästchen nachführen ----------

// Haben sich NUR Häkchen und Fragen geändert? Dann sind Zeilen, Beträge und
// Gliederung gleich geblieben, und es reicht, die Kästchen auszutauschen.
function ohneStand(data) {
  return JSON.stringify({ ...data, updatedAt: null, updatedBy: null, haken: null, fragen: null });
}
function nurStandGeaendert(alt, neu) {
  return ohneStand(alt) === ohneStand(neu);
}

// Was genau ist passiert? Für die Meldung in der Sync-Zeile und fürs
// Aufblitzen am richtigen Kästchen.
function standUnterschied(alt, neu) {
  const nummern = new Set();
  const hakenAuf = [];
  const hakenAb = [];
  const fragenAuf = [];
  const fragenAb = [];
  const schluessel = (d, feld) => Object.keys((d && d[feld]) || {});
  new Set([
    ...schluessel(alt, "haken"),
    ...schluessel(neu, "haken"),
    ...schluessel(alt, "fragen"),
    ...schluessel(neu, "fragen")
  ]).forEach((nr) => {
    const a = ((alt.haken || {})[nr] || []).filter(Boolean);
    const b = ((neu.haken || {})[nr] || []).filter(Boolean);
    const fa = (alt.fragen || {})[nr] || "";
    const fb = (neu.fragen || {})[nr] || "";
    if (a.join("/") === b.join("/") && fa === fb) return;
    nummern.add(nr);
    if (b.length > a.length) hakenAuf.push(nr);
    else if (b.length < a.length) hakenAb.push(nr);
    if (fb && !fa) fragenAuf.push(nr);
    else if (fa && !fb) fragenAb.push(nr);
  });
  return { nummern, hakenAuf, hakenAb, fragenAuf, fragenAb };
}

// "MV hat eine Frage gestellt bei 211.5" -- bei einer einzelnen Änderung
// steht die Nummer dabei, sonst wäre sie in 2450 Zeilen nicht zu finden.
function standMeldung(was, wer) {
  const teile = [];
  const satz = (liste, eins, viele) => {
    if (!liste.length) return;
    teile.push(liste.length === 1 ? `${eins} bei ${liste[0]}` : `${liste.length} ${viele}`);
  };
  satz(was.hakenAuf, "ein Häkchen gesetzt", "Häkchen gesetzt");
  satz(was.hakenAb, "ein Häkchen weggenommen", "Häkchen weggenommen");
  satz(was.fragenAuf, "eine Frage gestellt", "Fragen gestellt");
  satz(was.fragenAb, "eine Frage erledigt", "Fragen erledigt");
  if (!teile.length) return "";
  const text = teile.join(" · ");
  return wer ? `${wer} hat ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

// Die Statuskästchen einzeln austauschen, ohne Tabelle und
// Bearbeitungsfenster anzufassen: renderTabelleErhalten() würde den Fokus
// aus dem Feld reissen, in dem gerade jemand tippt -- bei einem Takt alle
// acht Sekunden wäre das unbenutzbar. Dasselbe Vorgehen wie bei
// aktualisierePanelZahlen().
function aktualisiereStandAnzeige(frisch) {
  const knoten = alleKnoten();
  const kinder = kinderMap(knoten);
  const { summen } = alleSummen();
  const status = statusBerechnen(knoten, kinder, summen);
  letzterStatus = status;

  document.querySelectorAll('[data-action="status"]').forEach((btn) => {
    const nr = btn.dataset.nr;
    const istBlatt = btn.dataset.blatt === "1";
    // statusHtml() liefert Kästchen UND Fragezeichen -- das alte
    // Fragezeichen daneben muss darum zuerst weg.
    const frage = btn.nextElementSibling;
    if (frage && frage.dataset && frage.dataset.action === "frage") frage.remove();
    btn.outerHTML = statusHtml(nr, status[nr], istBlatt);
  });

  // Der Fortschrittsbalken der Kapitelansicht zählt dieselben Stände.
  document.querySelectorAll(".bk-kap-zeile[data-kap-ziel]").forEach((zeile) => {
    const balken = zeile.querySelector(".bk-kap-balken");
    if (!balken) return;
    const nr = zeile.dataset.kapZiel;
    const blaetter = (kinderVon(nr).length ? blattNummernUnter(nr) : [nr]).filter(Boolean);
    balken.outerHTML = balkenHtml(blaetter, status);
  });

  // Im Bearbeitungsfenster steht der Stand zusätzlich im Klartext.
  const standText = document.querySelector(".bk-panel-stand-text");
  if (standText && gewaehlteZeile) {
    standText.textContent = panelStandText(status[gewaehlteZeile.nr] || LEERER_STAND);
  }

  // Kurz aufblitzen lassen: sonst ändert sich irgendwo in 2450 Zeilen
  // lautlos ein Kästchen und niemand merkt es.
  if (frisch && frisch.size) {
    document.querySelectorAll('[data-action="status"], [data-action="frage"]').forEach((el) => {
      if (!frisch.has(el.dataset.nr)) return;
      el.classList.add("bk-frisch");
      setTimeout(() => el.classList.remove("bk-frisch"), 2200);
    });
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

// Klick auf eine Preislisten-Position im Baum ("Wandstärke 18 cm"): dort
// wird erfasst. Gibt es noch keine Zeile, entsteht eine mit den Optionen
// der Position; sonst geht die vorhandene auf.
function erfassePreislistePosition(nr) {
  const arch = preislisteZuNr(nr);
  if (!arch) return;
  const vorhandene = zeilenVon(nr);
  if (vorhandene.length) {
    waehleZeile(nr, vorhandene[0].id);
    return;
  }
  legeZeileAn(nr, { mitFenster: true });
  // Die Zeile steht schon am richtigen Platz -- nur die Werte übernehmen.
  uebernimmVorlage(arch.pfadText, { verschieben: false });
}

// Ein virtueller Preislisten-Knoten steht in keiner Datei. Sobald darunter
// etwas erfasst wird, muss er samt seinen Vorfahren als eigenes Kapitel in
// die Schätzung -- sonst hinge die Zeile beim nächsten Öffnen ohne die
// Preisliste im Leeren.
function materialisiereKnoten(data, nr) {
  const kette = [];
  let n = nr;
  while (n && !katalogTitel[n]) {
    const schonDa = (data.eigenePositionen || []).some((p) => p.nr === n);
    const arch = preislisteZuNr(n);
    if (!schonDa && arch) kette.unshift({ nr: n, titel: arch.titel });
    n = elterNummer(n);
  }
  kette.forEach((k) => data.eigenePositionen.push(k));
}

// Eine leere Zeile unter nr anlegen. mitFenster: das Bearbeitungsfenster
// geht gleich auf (Kapitelansicht und nach der Vorlagenwahl) -- in der
// Tabelle wird dagegen direkt in der Zeile getippt, ein Fenster würde sie
// zudecken.
// Eine eigene Endposition in EINEM Schritt: Unterkapitel mit dem Namen und
// darin genau eine Zeile mit demselben Beschrieb -- damit trägt sie Häkchen
// und Frage (die hängen an der Nummer) und öffnet direkt das Fenster
// (istEigeneEndposition()). Gibt die neue Stelle zurück.
function legeEndpositionAn(nr, titel) {
  const neuNr = naechsteUnterteilung(nr);
  // Wie bei legeZeileAn(): Zeile und Nummer EINMAL vor dem mutate(), damit
  // beide Durchläufe (lokal und Serverstand) dasselbe anlegen.
  const zeile = { ...neueZeile(), beschrieb: titel };
  vorfahren(neuNr).forEach((v) => zugeklappt.delete(v));
  gewaehlteZeile = { nr: neuNr, id: zeile.id };
  vorlageSuche = "";
  mutate(
    (data) => {
      // Liegt das Kapitel darüber nur in der Preisliste, muss es zuerst in
      // die Datei -- sonst hinge die Position beim nächsten Öffnen im Leeren.
      materialisiereKnoten(data, nr);
      if (!data.eigenePositionen) data.eigenePositionen = [];
      if (!data.eigenePositionen.some((p) => p.nr === neuNr)) data.eigenePositionen.push({ nr: neuNr, titel });
      if (!data.positionen[neuNr]) data.positionen[neuNr] = [];
      if (!data.positionen[neuNr].some((z) => z.id === zeile.id)) data.positionen[neuNr].push({ ...zeile });
      return data;
    },
    { neuRendern: true }
  );
  fokussierePanel();
  return { nr: neuNr, id: zeile.id };
}

function legeZeileAn(nr, { mitFenster } = {}) {
  vorfahren(nr).forEach((v) => zugeklappt.delete(v));
  zugeklappt.delete(nr);
  // Die Zeile wird EINMAL vor dem mutate() erzeugt, nicht darin: mutateFn
  // läuft zweimal (lokal und auf dem frisch geholten Serverstand), und mit
  // einem uid() im Innern bekäme die Zeile dort eine andere ID -- alle
  // späteren Feldänderungen würden sie auf dem Server nicht mehr finden.
  const zeile = neueZeile();
  if (mitFenster) {
    gewaehlteZeile = { nr, id: zeile.id };
    vorlageSuche = "";
  }
  mutate(
    (data) => {
      materialisiereKnoten(data, nr);
      if (!data.positionen[nr]) data.positionen[nr] = [];
      if (!data.positionen[nr].some((z) => z.id === zeile.id)) data.positionen[nr].push({ ...zeile });
      return data;
    },
    { neuRendern: true }
  );
  const neuesFeld = document.querySelector(`#bkBody tr.bk-sub[data-row="${zeile.id}"] textarea[data-feld="beschrieb"]`);
  if (neuesFeld) neuesFeld.focus();
  else if (mitFenster) fokussierePanel();
  return zeile;
}

// Einziger Weg, ein Feld einer Unterposition zu ändern -- egal ob die
// Eingabe aus der Tabelle oder aus dem Bearbeitungsfenster kam. Danach wird die
// jeweils ANDERE Darstellung derselben Zeile nachgeführt, damit beide
// nicht auseinanderlaufen.
// Mein Häkchen setzen oder wegnehmen. Auf einer GRUPPE gilt es für alles
// darunter, und zwar in EINE Richtung: habe ich schon überall mein Häkchen,
// nimmt der Klick es überall weg, sonst setzt er es überall. Positionen,
// auf denen bereits zwei andere stehen, bleiben dabei unberührt -- das
// Häkchen des Partners kann niemand entfernen.
// Wo das Häkchen landet: auf dem Knoten SELBST und auf ALLEM darunter --
// Unterkapitel wie Blätter, leer oder nicht. Ein Klick auf ein Überkapitel
// hakt damit alles darunter mit ab und überschreibt dort einen abweichenden
// Stand; derselbe Klick nochmals nimmt es überall wieder weg. Auf jeder
// Ebene abhaken zu können und die Unterkapitel immer mitzunehmen ist
// ausdrücklich so gewünscht (November 2026).
//
// Kurzzeitig war das enger gefasst (nur Knoten mit Inhalt), um die Datei
// klein zu halten -- dabei blieben die Unterkapitel beim Klick aufs
// Überkapitel weiss, und genau das wurde als Fehler gemeldet. Der Preis
// ist bekannt und in Kauf genommen: ein Klick weit oben schreibt für jede
// Nummer darunter einen Eintrag in `haken`, mit der Gliederung der
// Preisliste also tausende (rund 30 Bytes je Eintrag).
//
// Die ANZEIGE bleibt davon unberührt: `statusBerechnen()` rechnet das
// Minimum weiterhin nur über die MITZÄHLENDEN Knoten (`zaehlt`), eine
// leere Katalognummer ohne Häkchen zieht eine Gruppe also nach wie vor
// nicht auf null.
function hakenZiele(nr, istBlatt) {
  if (istBlatt) return [nr];
  const ziele = alleKnoten()
    .filter((k) => k.nr === nr || vorfahren(k.nr).includes(nr))
    .map((k) => k.nr);
  return ziele.length ? ziele : [nr];
}

// Ein Klick aufs Kästchen darf NIE wortlos wirkungslos bleiben: "ich klicke
// und es passiert nichts" ist von aussen nicht von einem Fehler zu
// unterscheiden, und genau so wurde es gemeldet (November 2026). Bleibt der
// Stand gleich, sagt die Sync-Zeile warum.
function setzeHaken(nr, istBlatt) {
  const ich = meinKuerzel();
  if (!ich) {
    setSyncLine("Kein Kürzel vorhanden – Anzeigename in den Einstellungen ⚙ eintragen");
    return;
  }
  const ziele = hakenZiele(nr, istBlatt);
  const an = !ziele.every((ziel) => hakenVon(ziel).includes(ich));
  // Würde sich überhaupt etwas ändern? Wenn nein, gar nicht erst speichern:
  // ein Schreibvorgang ohne Wirkung überschriebe nur die Erklärung unten
  // mit "Gespeichert". Übrig bleibt dann genau ein Grund -- dort stehen
  // schon zwei andere Kürzel, und eine dritte Person hakt weder ab noch
  // nimmt sie weg (HAKEN_MAX, siehe mitHaken()).
  const wirkt = ziele.some(
    (ziel) => mitHaken(hakenVon(ziel), ich, an).join("/") !== hakenVon(ziel).join("/")
  );
  if (!wirkt) {
    setSyncLine(
      ziele.length === 1
        ? `Kein Häkchen gesetzt: bei ${ziele[0]} haben schon zwei andere abgehakt`
        : "Kein Häkchen gesetzt: dort haben schon zwei andere abgehakt"
    );
    return;
  }
  mutate((data) => {
    if (!data.haken) data.haken = {};
    ziele.forEach((ziel) => {
      const neu = mitHaken(data.haken[ziel] || [], ich, an);
      if (neu.length) data.haken[ziel] = neu;
      else delete data.haken[ziel];
    });
    return data;
  });
  renderTabelleErhalten();
}

// Eine Frage stellen oder wegnehmen -- wegnehmen darf jede Person, auch
// wenn die Frage von der anderen stammt: wer sie beantwortet hat, soll sie
// schliessen können.
function setzeFrage(nr) {
  const ich = meinKuerzel();
  const weg = !!frageVon(nr);
  if (!weg && !ich) return;
  mutate((data) => {
    if (!data.fragen) data.fragen = {};
    if (weg) delete data.fragen[nr];
    else data.fragen[nr] = ich;
    return data;
  });
  renderTabelleErhalten();
}

function setzeFeld(nr, rowId, feld, wert, quelle) {
  mutate((data) => {
    const zeile = (data.positionen[nr] || []).find((z) => z.id === rowId);
    if (zeile) {
      zeile[feld] = wert;
      // Ein von Hand getippter Kennwert sticht die Optionen aus -- sonst
      // wäre er beim nächsten Klick auf eine Option wieder weg. Im Fenster
      // ist das Feld dann schreibgeschützt, in der Tabelle nicht: dort ist
      // dieses Tippen die Umschaltung.
      if (feld === "kennwert" && optionenVon(zeile).length) zeile.kennwertManuell = true;
      // Bei einer eigenen Endposition SIND Name und Beschrieb dasselbe --
      // also zieht der Name mit, solange es die einzige Zeile ist.
      const name = String(wert || "").trim();
      const eigene = data.eigenePositionen || [];
      const knoten = eigene.find((p) => p.nr === nr);
      if (
        feld === "beschrieb" && name && knoten && !katalogTitel[nr] && !preislisteZuNr(nr) &&
        (data.positionen[nr] || []).length === 1 && !eigene.some((p) => p.nr.startsWith(nr + "."))
      ) {
        knoten.titel = name;
      }
    }
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
  // Die Bemerkungs-Punkte in der Beschrieb-Spalte hängen am Inhalt, ein
  // Wechsel der Berechnungsart an der Struktur -- beides ist mehr als eine
  // Wertänderung, refreshSummen() genügt dafür nicht.
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
  // Preis und Menge einer Option hängen nicht an einer Tabellenzeile --
  // sie gehen ihren eigenen Weg (siehe uebernimmOffeneOption()).
  if (el.dataset.optFeld) return uebernimmOffeneOption(el);
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
  if (ansichtModus === "kapitel") {
    renderKapitel();
    renderKpis(alleSummen().gesamt);
  } else {
    const { gesamt } = renderTabelle();
    renderKpis(gesamt);
  }
  renderPanel();
  window.scrollTo(0, scroll);
}

// ---------- Wo war ich zuletzt? ----------
//
// Eine Kostenschätzung ist gross, und man arbeitet tagelang an derselben
// Stelle. Beim Öffnen landet man deshalb wieder dort: gleicher Modus
// (Tabelle/Kapitel), gleiches Kapitel, gleiche Ebene, gleiche Stelle in der
// Tabelle. Gemerkt wird je SCHÄTZUNG und nur im localStorage -- es ist die
// Sicht dieser Person auf ihrem Gerät, nicht etwas, das in die Datei auf
// Nextcloud gehört (zwei Leute sind an derselben Schätzung an verschiedenen
// Stellen).
// Bis November 2026 öffnete eine Schätzung bewusst IMMER auf Ebene 1 im
// Überblick. Das war bei elf Hauptgruppen vertretbar; seit die Gliederung
// der Preisliste im Baum hängt, ist der Weg zurück an die Arbeitsstelle zu
// weit -- deshalb umgestellt.

const SICHT_MAX = 40; // mehr Schätzungen hat niemand gleichzeitig offen

function alleSichten() {
  const roh = loadJSON(LS_KEYS.sicht, {});
  return roh && typeof roh === "object" ? roh : {};
}

function letzteSicht(filename) {
  const eintrag = alleSichten()[filename];
  return eintrag && typeof eintrag === "object" ? eintrag : {};
}

// Wird NUR aus Nutzeraktionen heraus gerufen (Ebene, Modus, Kapitel,
// Scrollen, Zurück) -- nicht aus setzeEbene() selbst, das läuft auch beim
// Öffnen und beim Nachladen der Preisliste und würde das Gemerkte
// überschreiben, bevor es wiederhergestellt ist.
function merkeSicht() {
  if (!offenFilename) return;
  const alle = alleSichten();
  alle[offenFilename] = {
    modus: ansichtModus,
    kapitel: kapitelKnoten,
    ebene: ansicht.ebene,
    // Solange die Wiederherstellung noch aussteht, steht die Seite ganz
    // oben -- dann zählt der gemerkte Wert, nicht die aktuelle Null.
    scroll: wiederherstellen ? wiederherstellen.scroll : Math.round(window.scrollY),
    at: Date.now()
  };
  const namen = Object.keys(alle);
  if (namen.length > SICHT_MAX) {
    namen
      .sort((a, b) => (alle[a].at || 0) - (alle[b].at || 0))
      .slice(0, namen.length - SICHT_MAX)
      .forEach((n) => delete alle[n]);
  }
  saveJSON(LS_KEYS.sicht, alle);
}

// Kapitel und Scrollposition brauchen den FERTIGEN Baum: die Gliederung der
// Preisliste kommt nachträglich und schiebt alles nach unten. Deshalb wird
// beides erst gesetzt, wenn nichts mehr nachlädt -- einmal direkt beim
// Öffnen (Preisliste schon da, Demomodus, offline) und sonst, sobald sie
// geladen ist.
let wiederherstellen = null; // { kapitel, scroll }

function stelleSichtHer() {
  if (!wiederherstellen || !offen) return;
  if (preislisteLaedt()) return; // Baum noch nicht fertig
  const { scroll } = wiederherstellen;
  let { kapitel } = wiederherstellen;
  wiederherstellen = null;
  // Stand man zuletzt IN einer eigenen Endposition (gemerkt, als sie noch
  // ein leeres Unterkapitel war), geht es beim Kapitel darüber weiter --
  // sonst sähe die Endposition aus wie ein Kapitel mit sich selbst darin.
  if (kapitel && istEigeneEndposition(kapitel)) kapitel = elterNummer(kapitel);
  // Das Kapitel kann es nicht mehr geben (gelöscht, oder die Preisliste ist
  // umsortiert) -- dann bleibt es beim Überblick.
  if (kapitel && kapitel !== kapitelKnoten && alleKnoten().some((k) => k.nr === kapitel)) {
    kapitelKnoten = kapitel;
    render();
  }
  if (ansichtModus === "tabelle" && scroll) {
    requestAnimationFrame(() => window.scrollTo(0, scroll));
  }
}

// ---------- Interaktion: Tabelle ----------

function setzeEbene(stufe) {
  ansicht.ebene = stufe;
  saveJSON(LS_KEYS.ansicht, ansicht);
  zugeklappt = new Set();
  // Stufe 9 heisst "Alles" -- auch die eigenen Unterkapitel (Ebene 5 und
  // tiefer) bleiben offen. 4 ist die tiefste Ebene, die der Katalog führt.
  alleKnoten().forEach((k) => {
    if (stufe < 9 && knotenEbene(k.nr) >= stufe) return zugeklappt.add(k.nr);
    // Die Gliederung der Preisliste bleibt zu, solange nichts darin erfasst
    // ist: es sind über fünftausend Knoten, und niemand will sie alle auf
    // einmal sehen. Aufklappen ist ein Klick, und was BENUTZT wird, bleibt
    // offen -- sonst wären die eigenen Zeilen plötzlich versteckt.
    if (k.ausPreisliste && !zeilenUnter(k.nr).length) zugeklappt.add(k.nr);
  });
  renderToolbar();
  render();
}

function renderToolbar() {
  document.querySelectorAll("#ebeneSeg button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.ebene) === ansicht.ebene);
  });
  document.getElementById("nurVerwendetBtn").classList.toggle("active", ansicht.nurVerwendet);
  document.getElementById("bemerkungenBtn").classList.toggle("active", ansicht.bemerkungen);

  document.querySelectorAll("#modusSeg button").forEach((b) => {
    b.classList.toggle("active", b.dataset.modus === ansichtModus);
  });
  // In der Kapitelansicht bestimmt der offene Knoten die Tiefe, und
  // Bemerkungsspalten gibt es dort nicht -- beides weicht.
  const kapitel = ansichtModus === "kapitel";
  document.getElementById("ebeneSeg").hidden = kapitel;
  document.getElementById("ebeneLabel").hidden = kapitel;
  document.getElementById("bemerkungenBtn").hidden = kapitel;
}

function umklappen(nr) {
  if (zugeklappt.has(nr)) zugeklappt.delete(nr);
  else zugeklappt.add(nr);
  renderTabelleErhalten();
}

// Kennung für ein neues eigenes Unterkapitel: 211 -> "211.10", dann
// "211.11" und so fort. Sie wird nirgends angezeigt (knotenLabel()), sie
// hält den Knoten nur im Baum an seinem Platz -- deshalb vergibt sie die
// App selber, statt danach zu fragen.
// Gezählt wird ab ZEHN: die Norm belegt die vierte Stelle einstellig
// (211.0 bis 211.9), ab 10 kann eine eigene Gliederung also nie mit einer
// Gattung kollidieren, auch wenn der Katalog später wächst.
function naechsteUnterteilung(nr) {
  const vergeben = new Set(((offen && offen.eigenePositionen) || []).map((p) => p.nr));
  let i = 10;
  while (vergeben.has(`${nr}.${i}`) || katalogTitel[`${nr}.${i}`] || preislisteZuNr(`${nr}.${i}`)) i++;
  return `${nr}.${i}`;
}

// Alle Blätter (Knoten ohne Kinder) unterhalb einer Gruppe -- nur dort wird
// der Status gespeichert, der Stand der Gruppe ergibt sich daraus.
function blattNummernUnter(nr) {
  const knoten = alleKnoten();
  const kinder = kinderMap(knoten);
  return knoten
    .filter((k) => k.nr !== nr && vorfahren(k.nr).includes(nr) && !(kinder[k.nr] || []).length)
    .map((k) => k.nr);
}

// Klicks in der Kapitelansicht: Statuskästchen und "+ Zeile" laufen über
// dieselbe Logik wie in der Tabelle (onBodyClick), eine Unterposition öffnet
// die Bearbeitung, alles andere mit data-kap-ziel navigiert.
function onKapitelClick(e) {
  if (e.target.closest("[data-action]")) return onBodyClick(e);
  const pos = e.target.closest("[data-kap-zeile]");
  if (pos) {
    waehleZeile(kapitelKnoten, pos.dataset.kapZeile);
    return;
  }
  const ziel = e.target.closest("[data-kap-ziel]");
  if (!ziel || ziel.disabled) return;
  // Eine Preislisten-Position ist kein Kapitel zum Hineingehen, sondern der
  // Ort, wo erfasst wird -- dort geht das Fenster auf. Hineingehen lohnt
  // sich erst ab der zweiten Erfassung, dann gibt es dort wirklich eine
  // Liste zu sehen.
  const nr = ziel.dataset.kapZiel;
  if (istPreislistePosition(nr) && zeilenVon(nr).length <= 1) return erfassePreislistePosition(nr);
  if (istEigeneEndposition(nr)) return waehleZeile(nr, zeilenVon(nr)[0].id);
  setzeKapitel(nr);
}

function onBodyClick(e) {
  uebernimmOffeneEingabe(); // siehe Kommentar dort
  const btn = e.target.closest("[data-action]");
  if (!btn) {
    // Klick irgendwo auf eine Gruppen-/Positionszeile klappt sie auf und zu.
    // In der Zeile selbst gibt es sonst nichts anzuklicken -- dadurch
    // braucht es keine eigenen Klapp-Dreiecke mehr.
    const zeile = e.target.closest("tr.bk-group");
    if (!zeile) return;
    const nr = zeile.dataset.nr;
    // Eine PREISLISTEN-POSITION ist der Ort, wo erfasst wird -- dort öffnet
    // der Klick das Fenster statt auf- und zuzuklappen.
    if (istPreislistePosition(nr) && !zeilenVon(nr).length) return erfassePreislistePosition(nr);
    if (zeile.classList.contains("klappbar")) umklappen(nr);
    return;
  }
  const { action, nr, row } = btn.dataset;

  if (action === "status") {
    setzeHaken(nr, !!btn.dataset.blatt);
    return;
  }

  if (action === "frage") {
    setzeFrage(nr);
    return;
  }

  if (action === "add-zeile") {
    // Gibt es Vorlagen, wird zuerst gefragt, WAS dazukommt -- erst danach
    // geht es um die Zahlen. Ohne Vorlagen (Demomodus, keine Datei) bleibt
    // es beim alten Weg: Zeile anlegen und lostippen.
    if (vorlagenMoeglich()) return oeffneVorlagenWahl(nr);
    legeZeileAn(nr, { mitFenster: ansichtModus === "kapitel" });
    return;
  }

  if (action === "bearbeiten") {
    waehleZeile(nr, row);
    return;
  }

  if (action === "del-zeile") {
    loescheZeile(nr, row);
    return;
  }

  if (action === "add-endposition") {
    // Erst der Name, dann (wenn es Vorlagen gibt) die Wahl, WAS es ist --
    // angelegt wird erst danach. Wer abbricht, hinterlässt nichts.
    const titel = (prompt(`Neue Position in "${knotenLabel(nr)}":`, "") || "").trim();
    if (!titel) return;
    if (vorlagenMoeglich()) return oeffneVorlagenWahl(nr, null, { endposition: titel });
    legeEndpositionAn(nr, titel);
    return;
  }

  if (action === "add-position") {
    // Gefragt wird nur nach dem Namen -- die Kennung vergibt die App
    // (siehe naechsteUnterteilung()), unterhalb der Norm gibt es keine
    // Nummern mehr zu wählen.
    const titel = (prompt(`Neues Unterkapitel in "${knotenLabel(nr)}":`, "") || "").trim();
    if (!titel) return;
    const eingabe = naechsteUnterteilung(nr);
    // Nur die Gliederung anlegen, keine erste Zeile: wer gleich erfassen
    // will, nimmt "+ Position". So lässt sich auch bloss ein Kapitelbaum
    // aufbauen ("Wände" › "Innenwände" › "Aussenwände"), ohne jedes Mal
    // eine leere Zeile wegräumen zu müssen.
    vorfahren(eingabe).forEach((v) => zugeklappt.delete(v));
    zugeklappt.delete(eingabe);
    mutate(
      (data) => {
        if (!data.eigenePositionen) data.eigenePositionen = [];
        if (!data.eigenePositionen.some((p) => p.nr === eingabe)) data.eigenePositionen.push({ nr: eingabe, titel });
        if (!data.positionen[eingabe]) data.positionen[eingabe] = [];
        return data;
      },
      { neuRendern: true }
    );
    // In der Kapitelansicht gleich hineinspringen -- dort ist das neue
    // Kapitel der Ort, an dem es weitergeht.
    if (ansichtModus === "kapitel") setzeKapitel(eingabe);
    return;
  }

  if (action === "del-position") {
    // Mit dem Unterkapitel geht alles mit, was darunter hängt -- ein
    // stehengelassenes Enkelkapitel wäre im Baum nicht mehr erreichbar.
    const drunter = (n) => n === nr || n.startsWith(nr + ".");
    const anzahl = zeilenUnter(nr).length;
    const kapitel = (offen.eigenePositionen || []).filter((p) => drunter(p.nr)).length - 1;
    const was = [
      anzahl ? `${anzahl} Zeile(n)` : "",
      kapitel > 0 ? `${kapitel} Unterkapitel` : ""
    ].filter(Boolean).join(" und ");
    if (!confirm(`"${knotenLabel(nr)}"${was ? ` mit ${was}` : ""} wirklich löschen?`)) return;
    if (gewaehlteZeile && drunter(gewaehlteZeile.nr)) gewaehlteZeile = null;
    mutate(
      (data) => {
        data.eigenePositionen = (data.eigenePositionen || []).filter((p) => !drunter(p.nr));
        Object.keys(data.positionen).forEach((n) => {
          if (drunter(n)) delete data.positionen[n];
        });
        [data.haken, data.fragen].forEach((topf) => {
          Object.keys(topf || {}).forEach((n) => {
            if (drunter(n)) delete topf[n];
          });
        });
        return data;
      },
      { neuRendern: true }
    );
    // In der Kapitelansicht stünde man sonst in einem Kapitel, das es
    // nicht mehr gibt.
    if (ansichtModus === "kapitel" && drunter(kapitelKnoten)) setzeKapitel(elterNummer(nr) || "");
  }
}

function loescheZeile(nr, rowId) {
  const zeile = zeileSuchen(offen, rowId);
  // Der Riegel, nicht bloss ein versteckter Knopf: Zeilen aus der
  // Preisliste werden nicht gelöscht, egal über welchen Weg (siehe
  // ausVorlage()).
  if (ausVorlage(zeile)) return;
  const text = (zeile && zeile.beschrieb) || "";
  // Ist es die einzige Zeile einer eigenen Endposition, geht die Position
  // mit -- ein leeres Unterkapitel ohne Sinn bliebe sonst stehen.
  const endposition = istEigeneEndposition(nr);
  if (endposition ? !confirm(`Position "${text || knotenLabel(nr)}" wirklich löschen?`) : text && !confirm(`Zeile "${text}" wirklich löschen?`)) return;
  if (gewaehlteZeile && gewaehlteZeile.id === rowId) gewaehlteZeile = null;
  mutate(
    (data) => {
      data.positionen[nr] = (data.positionen[nr] || []).filter((z) => z.id !== rowId);
      if (!data.positionen[nr].length) delete data.positionen[nr];
      if (endposition && !data.positionen[nr]) {
        data.eigenePositionen = (data.eigenePositionen || []).filter((p) => p.nr !== nr);
        [data.haken, data.fragen].forEach((topf) => {
          if (topf) delete topf[nr];
        });
      }
      return data;
    },
    { neuRendern: true }
  );
  if (endposition && ansichtModus === "kapitel" && kapitelKnoten === nr) setzeKapitel(elterNummer(nr) || "");
}

// Beim Hineinklicken in ein Ausmass-/Kennwert-Feld erscheint wieder die
// eingetippte Rechnung statt des Resultats.
function onBodyFocusIn(e) {
  // Bewusst KEIN waehleZeile() mehr: das Bearbeitungsfenster soll nicht
  // aufspringen, nur weil jemand in ein Feld tippt (siehe renderPanel()).
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

// ---------- Interaktion: Vorlage und Optionen ----------

// Die Ordner einer Vorlage als eigene UNTERKAPITEL anlegen und die Nummer
// des tiefsten zurückgeben. Unterhalb der Gattung hört die Norm auf -- dort
// gliedert die Preisliste weiter, und genauso soll die Schätzung es tun, statt
// alles flach unter die BKP-Nummer zu kippen.
//
// Läuft INNERHALB von mutate() und muss deshalb mit dem Stand arbeiten, den
// es gerade sieht: gesucht wird über den TITEL, eine Nummer wird nur
// vergeben, wenn es das Kapitel dort noch nicht gibt. Beide Durchläufe
// (lokal und auf dem Serverstand) landen so beim selben Kapitel, auch wenn
// die interne Kennung einmal abweicht -- sichtbar ist sie nirgends.
function kapitelFuerPfad(data, startNr, ordner) {
  let nr = startNr;
  ordner.forEach((titel) => {
    const name = String(titel || "").trim();
    if (!name) return;
    const vorhanden = (data.eigenePositionen || []).find(
      (p) => elterNummer(p.nr) === nr && gleicheBezeichnung(p.titel, name)
    );
    if (vorhanden) {
      nr = vorhanden.nr;
      return;
    }
    // Freie Kennung im STAND VON DATA suchen, nicht über
    // naechsteUnterteilung() -- das schaut auf die offene Schätzung.
    const vergeben = new Set((data.eigenePositionen || []).map((p) => p.nr));
    let i = 10;
    while (vergeben.has(`${nr}.${i}`) || katalogTitel[`${nr}.${i}`]) i++;
    const neueNr = `${nr}.${i}`;
    data.eigenePositionen.push({ nr: neueNr, titel: name });
    nr = neueNr;
  });
  return nr;
}

// Die Ordner einer Vorlage unterhalb des passenden BKP-Knotens -- also der
// Pfad ohne den Ast, der schon über die Nummer abgebildet ist, und ohne die
// Position selbst.
function vorlageOrdner(eintrag, zielNr) {
  const knoten = preislisteKnotenFuer(zielNr);
  const tief = knoten && (eintrag.pfadText === knoten.pfadText || eintrag.pfadText.startsWith(knoten.pfadText + PFAD_TRENNER))
      ? knoten.pfad.length
      : 0;
  // Stammt die Vorlage aus einem anderen Ast, steht ihr ganzer Pfad als
  // Gliederung da -- sonst wüsste niemand, wo das Ding herkommt.
  return eintrag.pfad.slice(tief, -1);
}

// Eine Preislisten-Position in eine Zeile übernehmen. Danach hängt die
// Schätzung nicht mehr an der Datei: Einheit, Beschrieb und Optionen stehen
// als KOPIE in der Zeile, der Pfad bleibt nur als Herkunftsangabe stehen.
// Die Zeile wandert dabei unter die Ordner der Vorlage.
function uebernimmVorlage(pfadText, { verschieben = true } = {}) {
  if (!gewaehlteZeile) return;
  const eintrag = preislisteNachPfad(pfadText);
  if (!eintrag) return;
  const knoten = eintrag.knoten;
  // Einmal vor dem mutate() bauen, nicht darin: mutateFn läuft zweimal
  // (lokal und auf dem frisch geholten Serverstand) und muss beide Male
  // dasselbe ergeben -- beim Einsetzen bekommt jeder Stand seine eigene
  // Kopie der Optionen.
  const optionen = optionenKopie(Array.isArray(knoten.optionen) ? knoten.optionen : []);
  const einheit = String(knoten.einheit || "");
  const beschrieb = String(knoten.bezeichnung || "");
  const { nr, id } = gewaehlteZeile;
  // Eine eigene Endposition ("Dach anheben") bleibt, wo sie ist, und behält
  // ihren Namen -- die Vorlage liefert nur Einheit und Preispositionen.
  // Sonst wanderte die Zeile in den Ast der Vorlage und liesse ein leeres
  // Unterkapitel zurück.
  const endposition = istEigeneEndposition(nr);
  // Gleiches gilt für eine weitere Zeile in einer eigenen Position.
  if (endposition || (istPositionsKnoten(nr) && !istPreislistePosition(nr))) verschieben = false;
  // Die BKP-Nummer, unter der die Zeile heute hängt -- von dort aus wird
  // die Gliederung der Vorlage aufgebaut. Hängt die Zeile schon in einem
  // eigenen Unterkapitel, zählt der Katalogknoten darüber: sonst
  // verschachtelte sich beim zweiten Übernehmen alles ineinander.
  const basisNr = [nr, ...vorfahren(nr)].find((n) => !istEigen(n)) || nr;
  // Steht die Zeile schon am richtigen Platz (Gliederung der Preisliste im
  // Baum), wird sie nicht noch einmal umgehängt.
  const ordner = verschieben ? vorlageOrdner(eintrag, basisNr) : null;
  let zielNr = nr;
  mutate((data) => {
    const alteListe = data.positionen[nr] || [];
    const zeile = alteListe.find((z) => z.id === id);
    if (!zeile) return data;
    // Zeile unter die Ordner der Vorlage hängen.
    zielNr = ordner ? kapitelFuerPfad(data, basisNr, ordner) : nr;
    if (zielNr !== nr) {
      data.positionen[nr] = alteListe.filter((z) => z.id !== id);
      if (!data.positionen[nr].length) delete data.positionen[nr];
      if (!data.positionen[zielNr]) data.positionen[zielNr] = [];
      data.positionen[zielNr].push(zeile);
    }
    if (!(endposition && String(zeile.beschrieb || "").trim())) zeile.beschrieb = beschrieb;
    // Eine leere Einheit der Vorlage überschreibt keine vorhandene -- im
    // echten Export tragen viele Platzhalter-Positionen gar keine.
    if (einheit) zeile.einheit = einheit;
    zeile.vorlage = { quelle: "preisliste", pfad: pfadText };
    if (optionen.length) {
      zeile.optionen = JSON.parse(JSON.stringify(optionen));
      // Eine frisch übernommene Vorlage rechnet immer automatisch -- ein
      // alter Kennwert von Hand gehörte zur vorherigen Position.
      zeile.kennwertManuell = false;
      zeile.kennwert = kennwertAusOptionen(zeile);
    } else {
      // Rund 600 Positionen im echten Export sind reine Platzhalter ohne
      // Preisoptionen. Die bringen Beschrieb und Einheit mit, aber keinen
      // Preis -- einen vorhandenen Kennwert dafür auf 0 zu setzen wäre das
      // Gegenteil von hilfreich. Die Felder der vorherigen Vorlage müssen
      // trotzdem weg, sie gehörten zu einer anderen Position.
      delete zeile.optionen;
      delete zeile.kennwertManuell;
    }
    return data;
  });
  // Die Zeile steht jetzt woanders -- das Fenster muss mitziehen.
  gewaehlteZeile = { nr: zielNr, id };
  vorfahren(zielNr).forEach((v) => zugeklappt.delete(v));
  zugeklappt.delete(zielNr);
  vorlageSuche = "";
  render();
  fokussierePanel();
}

// Eine einzelne Option ändern. aendern() muss rein rechnend sein (kein
// uid(), kein Datum): mutateFn läuft zweimal, siehe mutate().
function aendereOption(index, aendern) {
  if (!gewaehlteZeile) return;
  const { nr, id } = gewaehlteZeile;
  mutate((data) => {
    const zeile = (data.positionen[nr] || []).find((z) => z.id === id);
    const opt = zeile && optionenVon(zeile)[index];
    if (!opt) return data;
    aendern(opt, zeile);
    if (!zeile.kennwertManuell) zeile.kennwert = kennwertAusOptionen(zeile);
    return data;
  });
}

// Die Herkunft aus der Preisliste wegnehmen. Danach ist es eine von Hand
// erfasste Zeile wie jede andere -- mit allem, was die Vorlage mitgebracht
// hat (Beschrieb, Einheit, Preispositionen), aber ohne Löschschutz. Das ist
// der einzige Weg, eine versehentlich angeklickte Position wieder
// loszuwerden, deshalb fragt er nach.
function loeseVorlage() {
  if (!gewaehlteZeile) return;
  const { nr, id } = gewaehlteZeile;
  const zeile = zeileSuchen(offen, id);
  if (!ausVorlage(zeile)) return;
  if (
    !confirm(
      `Herkunft "${zeile.vorlage.pfad}" entfernen?\n\nDie Zeile bleibt mit allen Preispositionen stehen und lässt sich danach löschen.`
    )
  )
    return;
  mutate((data) => {
    const z = (data.positionen[nr] || []).find((x) => x.id === id);
    if (z) delete z.vorlage;
    return data;
  });
  // Im Fenster wechselt der Knopf, in der Tabelle kommt das × zurück.
  renderTabelleErhalten();
}

function setzeKennwertManuell(manuell) {
  if (!gewaehlteZeile) return;
  const { nr, id } = gewaehlteZeile;
  mutate((data) => {
    const zeile = (data.positionen[nr] || []).find((z) => z.id === id);
    if (!zeile) return data;
    zeile.kennwertManuell = !!manuell;
    if (!manuell) zeile.kennwert = kennwertAusOptionen(zeile);
    return data;
  });
  // Das Feld wird schreibbar bzw. schreibgeschützt -- das ist mehr als eine
  // Wertänderung, also neu zeichnen.
  renderTabelleErhalten();
}

// Zahlen im offenen Fenster nachführen, OHNE es neu zu bauen: wer gerade
// einen Preis tippt, soll den Fokus behalten.
function aktualisierePanelZahlen() {
  const zeile = gewaehlteZeile && zeileSuchen(offen, gewaehlteZeile.id);
  if (!zeile) return;
  const optionen = optionenVon(zeile);
  document.querySelectorAll("#panelOptionen [data-opt]").forEach((li) => {
    const opt = optionen[Number(li.dataset.opt)];
    if (!opt) return;
    li.classList.toggle("aus", !opt.aktiv);
    const betrag = li.querySelector("[data-opt-betrag]");
    if (betrag) betrag.textContent = zahl(optionBetrag(opt));
    // Der Hinweis auf den Vorlagepreis muss beim Tippen mitkommen -- er ist
    // deshalb immer im Baum und wird nur ein- und ausgeblendet.
    const hinweis = li.querySelector("[data-opt-vorlage]");
    const abweichung = vorlagePreisAbweichung(opt);
    if (hinweis) {
      hinweis.hidden = abweichung === null;
      if (abweichung !== null) hinweis.textContent = `Vorlagepreis: ${zahl(abweichung)}`;
    }
  });
  const gesamt = document.querySelector("#panelOptionen [data-opt-gesamt]");
  if (gesamt) gesamt.textContent = zahl(optionenSumme(zeile));
  const kw = document.querySelector('#detailPanel [data-panel-feld="kennwert"]');
  if (kw && kennwertAutomatisch(zeile)) kw.value = zeile.kennwert || "";
  renderPanelKosten();
}

// ---------- Auswahl beim Anlegen einer Zeile ----------
//
// "Was soll dazu?" steht VOR dem Bearbeitungsfenster: dort entscheidet sich,
// welche Position es wird, danach geht es nur noch um die Zahlen. Zwei
// Fälle: eine neue Zeile anlegen (rowId null) oder die Vorlage einer
// bestehenden wechseln.
let vorlagenZiel = null; // { nr, rowId }

function vorlagenMoeglich() {
  return !istDemo() && isConfigured() && !preislisteFehlt;
}

function oeffneVorlagenWahl(nr, rowId, { endposition = "" } = {}) {
  vorlagenZiel = { nr, rowId: rowId || null, endposition };
  vorlageSuche = "";
  ladePreislisteBeiBedarf();
  document.getElementById("vorlagenTitel").textContent = rowId
    ? "Andere Vorlage"
    : endposition
    ? `Neue Position "${endposition}"`
    : `Was soll unter "${knotenLabel(nr)}"?`;
  zeichneVorlagenWahl();
  overlay("vorlagenOverlay", true);
  const feld = document.getElementById("vorlageSuche");
  if (feld) feld.focus();
}

function zeichneVorlagenWahl() {
  const box = document.getElementById("vorlagenInhalt");
  if (!box || !vorlagenZiel) return;
  const leer = vorlagenZiel.rowId
    ? ""
    : vorlagenZiel.endposition
    ? `<button type="button" class="bk-vorlage-leerzeile" data-vorlagen-aktion="leer">
         + Ohne Vorlage — "${escapeHtml(vorlagenZiel.endposition)}" selber erfassen
       </button>`
    : `<button type="button" class="bk-vorlage-leerzeile" data-vorlagen-aktion="leer">
         + Leere Zeile — Beschrieb und Kennwert selber erfassen
       </button>`;
  const liste = preislisteBaum
    ? `<input type="search" id="vorlageSuche" class="bk-vorlage-suche" placeholder="Vorlage suchen …" autocomplete="off" value="${escapeHtml(
        vorlageSuche
      )}">
       <div id="vorlageListe">${vorlageListeHtml(vorlagenZiel.nr)}</div>`
    : `<div class="bk-vorlage-leer">${
        preislisteLaedt()
          ? "Vorlagen werden geladen …"
          : preislisteFehler
          ? `Vorlagen konnten nicht geladen werden (${escapeHtml(
              preislisteFehler
            )}). <button type="button" class="bk-toggle" data-vorlagen-aktion="neu">Nochmals versuchen</button>`
          : "Keine Vorlagen vorhanden."
      }</div>`;
  box.innerHTML = leer + liste;
}

function schliesseVorlagenWahl() {
  overlay("vorlagenOverlay", false);
  vorlagenZiel = null;
  vorlageSuche = "";
}

function onVorlagenClick(e) {
  if (e.target.id === "vorlagenOverlay") return schliesseVorlagenWahl();
  const neu = e.target.closest('[data-vorlagen-aktion="neu"]');
  if (neu) {
    preislisteFehler = "";
    preislistePromise = null;
    ladePreislisteBeiBedarf();
    zeichneVorlagenWahl();
    return;
  }
  const leer = e.target.closest('[data-vorlagen-aktion="leer"]');
  if (leer) {
    const { nr, endposition } = vorlagenZiel || {};
    schliesseVorlagenWahl();
    if (nr && endposition) legeEndpositionAn(nr, endposition);
    else if (nr) legeZeileAn(nr, { mitFenster: ansichtModus === "kapitel" });
    return;
  }
  const btn = e.target.closest('[data-panel-action="vorlage"]');
  if (!btn || !vorlagenZiel) return;
  const { nr, rowId, endposition } = vorlagenZiel;
  const pfad = btn.dataset.pfad || "";
  schliesseVorlagenWahl();
  // Neue eigene Position MIT Vorlage: die Position entsteht unter dem
  // gewählten Kapitel und behält ihren Namen, die Vorlage bringt Einheit
  // und Preispositionen (siehe uebernimmVorlage()).
  if (endposition) {
    legeEndpositionAn(nr, endposition);
    uebernimmVorlage(pfad);
    return;
  }
  // Eine neue Zeile entsteht zuerst leer unter der BKP-Nummer;
  // uebernimmVorlage() hängt sie anschliessend unter die Ordner.
  if (!rowId) legeZeileAn(nr, { mitFenster: true });
  else gewaehlteZeile = { nr, id: rowId };
  uebernimmVorlage(pfad);
}

function zeichneVorlageListe() {
  const box = document.getElementById("vorlageListe");
  if (box && vorlagenZiel) box.innerHTML = vorlageListeHtml(vorlagenZiel.nr);
}

function onOptionAenderung(el) {
  const li = el.closest("[data-opt]");
  if (!li || !gewaehlteZeile) return;
  const index = Number(li.dataset.opt);
  const feld = el.dataset.optFeld;
  const wert = el.value;
  aendereOption(index, (opt) => {
    opt[feld] = wert;
  });
  aktualisierePanelZahlen();
}

function onOptionWahl(el) {
  const li = el.closest("[data-opt]");
  if (!li || !gewaehlteZeile) return;
  const index = Number(li.dataset.opt);
  const an = el.checked;
  aendereOption(index, (opt) => {
    opt.aktiv = an;
  });
  aktualisierePanelZahlen();
}

// Ein noch offenes Preis-/Mengenfeld übernehmen -- dasselbe Problem wie bei
// uebernimmOffeneEingabe(), nur führen Optionen ihren eigenen Weg.
function uebernimmOffeneOption(el) {
  const li = el.closest ? el.closest("[data-opt]") : null;
  if (!li || !gewaehlteZeile) return;
  const index = Number(li.dataset.opt);
  const feld = el.dataset.optFeld;
  const zeile = zeileSuchen(offen, gewaehlteZeile.id);
  const opt = zeile && optionenVon(zeile)[index];
  if (!opt || String(opt[feld] ?? "") === el.value) return;
  const wert = el.value;
  aendereOption(index, (o) => {
    o[feld] = wert;
  });
}

// ---------- Interaktion: Bearbeitungsfenster ----------

function onPanelChange(e) {
  const optEl = e.target.closest("[data-opt-feld]");
  if (optEl) return onOptionAenderung(optEl);
  const wahlEl = e.target.closest("[data-opt-wahl]");
  if (wahlEl) return onOptionWahl(wahlEl);
  const el = e.target.closest("[data-panel-feld]");
  if (!el || !gewaehlteZeile) return;
  setzeFeld(gewaehlteZeile.nr, gewaehlteZeile.id, el.dataset.panelFeld, el.value, "panel");
}

function onPanelClick(e) {
  // Klick neben das Fenster schliesst ebenfalls.
  if (e.target.id === "detailPanel") return schliessePanel();
  // Häkchen und Fragezeichen sind dieselben Knöpfe wie im Baum.
  const stand = e.target.closest('[data-action="status"], [data-action="frage"]');
  if (stand) {
    if (stand.dataset.action === "status") setzeHaken(stand.dataset.nr, !!stand.dataset.blatt);
    else setzeFrage(stand.dataset.nr);
    return;
  }
  const btn = e.target.closest("[data-panel-action]");
  if (!btn || !gewaehlteZeile) return;
  const was = btn.dataset.panelAction;
  if (was === "close") schliessePanel();
  else if (was === "delete") loescheZeile(gewaehlteZeile.nr, gewaehlteZeile.id);
  else if (was === "prev") panelNachbar(-1);
  else if (was === "next") panelNachbar(1);
  else if (was === "vorlage-wechseln") oeffneVorlagenWahl(gewaehlteZeile.nr, gewaehlteZeile.id);
  else if (was === "vorlage-loesen") loeseVorlage();
  else if (was === "kennwert-manuell") setzeKennwertManuell(true);
  else if (was === "kennwert-auto") setzeKennwertManuell(false);
}

function onVorlagenInput(e) {
  if (e.target.id !== "vorlageSuche") return;
  vorlageSuche = e.target.value;
  zeichneVorlageListe();
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
  // Dort weitermachen, wo man zuletzt war (siehe merkeSicht()). Beim ersten
  // Öffnen einer Schätzung gilt der Überblick: Tabelle, Ebene 1.
  const sicht = letzteSicht(filename);
  ansichtModus = sicht.modus === "kapitel" ? "kapitel" : "tabelle";
  kapitelKnoten = "";
  wiederherstellen = { kapitel: sicht.kapitel || "", scroll: Number(sicht.scroll) || 0 };
  renderToolbar();
  // Die Gliederung der Preisliste gehört zum BAUM, nicht nur zur Vorlagenwahl --
  // deshalb beim Öffnen einer Schätzung holen, nicht erst beim Erfassen.
  // In der Liste passiert nichts: wer nur schaut, lädt keine 6 MB.
  ladePreislisteBeiBedarf();
  setzeEbene(ebeneAusSicht(sicht.ebene));
  stelleSichtHer();
  starteLive();
}

// Nur Werte, die der Umschalter wirklich kennt -- sonst stünde nach einem
// alten Eintrag eine Ebene da, die es nicht gibt.
function ebeneAusSicht(wert) {
  return [1, 2, 3, 4, 9].includes(Number(wert)) ? Number(wert) : 1;
}

function zurueckZurListe() {
  merkeSicht();
  meldeAbwesend(); // noch mit offenFilename -- stoppeLive() räumt danach auf
  stoppeLive();
  wiederherstellen = null;
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
  document.getElementById("kopfMwst").value = String(mwstSatz());
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
  const mwstEingabe = rechne(document.getElementById("kopfMwst").value);
  const mwst = mwstEingabe === null || isNaN(mwstEingabe) || mwstEingabe < 0 ? 0 : mwstEingabe;
  const grundlagen = document.getElementById("kopfGrundlagen").value;
  lesKopfModulNamen();
  const neueModule = kopfModule.map((m) => ({ id: m.id, name: m.name.trim() })).filter((m) => m.name);
  const gueltigeIds = new Set(neueModule.map((m) => m.id));
  overlay("kopfOverlay", false);
  mutate(
    (data) => {
      data.projekt = projekt;
      data.projektName = projektName;
      data.titel = titel || data.titel;
      data.genauigkeit = genauigkeit;
      data.kostenstand = kostenstand;
      data.mwst = mwst;
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
  optModulSummen: "modulSummen",
  optModulSeiten: "modulSeiten"
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
//
// druckSeite() rendert eine solche Seite. Ohne Modul ist das die ganze
// Schätzung; mit Modul dieselbe Tabelle, aber nur mit dessen Zeilen und
// dessen Summen -- eine vollwertige, für sich lesbare Berechnung des
// Teilbereichs (Option "Je Modul eine eigene Seite").
function druckSeite(opt, modul) {
  const filter = modul ? (z) => z.modul === modul.id : () => true;
  const { summen, gesamt } = summenMit(filter);
  const verwendet = verwendeteKnoten(filter);
  // Modulspalten und die Modul-Aufstellung ergeben nur auf der Gesamtseite
  // Sinn -- eine Modulseite IST schon die Aufteilung.
  const mods = !modul && opt.modulSpalten ? module_() : [];
  const betragZelle = (summe) => (summe ? franken(summe) : "");
  // Katalogknoten bekommen immer eine eigene Zeile (die Gattung "211.5"
  // gehört zur Norm), eigene Unterkapitel nur auf Wunsch.
  const eigenstaendig = (nr) => !istEigen(nr) || opt.unterteilungen;
  // Was auf der Zeile eines Knotens erscheint: seine eigenen Zeilen plus
  // die aller Nachfahren, die NICHT selber gedruckt werden -- sonst stünde
  // dieselbe Zeile zweimal da.
  const zeilenDavon = (nr) =>
    Object.keys(offen.positionen || {})
      .filter((n) => n === nr || (n.startsWith(nr + ".") && !eigenstaendig(n)))
      .flatMap((n) => zeilenVon(n))
      .filter(filter);

  const kopf = [
    `<th>BKP</th>`,
    `<th>Bezeichnung</th>`,
    `<th class="r">Ausmass</th>`,
    `<th>Einheit</th>`,
    `<th class="r">${mwstSatz() ? "Kennwert exkl." : "Kennwert"}</th>`,
    `<th class="r">${mwstSatz() ? "Kosten inkl." : "Kosten"}</th>`,
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

    // Eigene Unterkapitel (beliebig tief) werden standardmässig nicht
    // separat ausgewiesen -- ihre Kosten stecken über die Summen ohnehin
    // schon im Katalogknoten darüber.
    if (!eigenstaendig(k.nr)) return;
    if (e === 1) {
      if (!opt.alleHauptgruppen && !istVerwendet) return;
    } else if (opt.nurVerwendete && !istVerwendet) {
      return;
    }

    const leerKlasse = istVerwendet ? "" : " pr-leer";
    // Gattungen und eigene Unterkapitel rücken ein, sonst sähen sie aus
    // wie die dreistellige Position darüber.
    const einzug = e > 3 ? ` style="padding-left:${(e - 3) * 10}px"` : "";
    if (e < 3) {
      zeilen += `<tr class="pr-l${e}${leerKlasse}">
        <td>${k.eigen ? "" : escapeHtml(k.nr)}</td>
        <td>${escapeHtml(k.titel)}</td>
        <td colspan="3"></td>
        <td class="r">${betragZelle(summe)}</td>
        ${mods.length ? modulZellen(modulAnteile(k.nr)) : ""}
        ${opt.bemerkungExtern ? "<td></td>" : ""}
      </tr>`;
      return;
    }

    // Position, Gattung bzw. ein separat ausgewiesenes eigenes Unterkapitel
    const posZeilen = zeilenDavon(k.nr);
    if (opt.unterpositionen && posZeilen.length) {
      zeilen += `<tr class="pr-pos">
        <td${einzug}>${k.eigen ? "" : escapeHtml(k.nr)}</td>
        <td>${escapeHtml(k.titel)}</td>
        <td colspan="3"></td>
        <td class="r">${betragZelle(summe)}</td>
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
          <td class="r">${z.basis ? franken(basisBetrag()) : zahl(rechne(z.kennwert))}</td>
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
    // Trennzeichen wie am Bildschirm (bemerkungenZusammen()).
    zeilen += `<tr class="pr-pos${leerKlasse}">
      <td${einzug}>${k.eigen ? "" : escapeHtml(k.nr)}</td>
      <td>${escapeHtml(k.titel)}${beschriebe.length ? `<div class="pr-formel">${escapeHtml(beschriebe.join("; "))}</div>` : ""}</td>
      <td class="r">${einzeln ? zahl(rechne(einzeln.ausmass)) : ""}</td>
      <td>${einzeln ? (einzeln.basis ? "%" : escapeHtml(einzeln.einheit || "")) : ""}</td>
      <td class="r">${einzeln ? (einzeln.basis ? franken(basisBetrag()) : zahl(rechne(einzeln.kennwert))) : ""}</td>
      <td class="r">${betragZelle(summe)}</td>
      ${mods.length ? modulZellen(modulAnteile(k.nr)) : ""}
      ${opt.bemerkungExtern ? `<td>${escapeHtml(bemerkungen.join(", "))}</td>` : ""}
    </tr>`;
  });

  const gesamtModule = mods.length ? modulZellen(modulAnteile("")) : "";
  const druckAufstellung = !modul && opt.modulSummen ? modulAufstellung() : null;
  if (druckAufstellung) {
    const leerZellen = `${mods.map(() => "<td></td>").join("")}${opt.bemerkungExtern ? "<td></td>" : ""}`;
    zeilen += `<tr class="pr-teil"><td></td><td>${escapeHtml(grundTotalBeschriftung())}</td><td colspan="3"></td><td class="r">${franken(
      druckAufstellung.ohne
    )}</td>${leerZellen}</tr>`;
    module_().forEach((m) => {
      zeilen += `<tr class="pr-teil"><td></td><td>Modul: ${escapeHtml(m.name)}</td><td colspan="3"></td><td class="r">+ ${franken(
        druckAufstellung.summen[m.id]
      )}</td>${leerZellen}</tr>`;
    });
  }
  zeilen += `<tr class="pr-gesamt">
    <td></td>
    <td>${escapeHtml(modul ? `Total Modul ${modul.name}` : totalBeschriftung())}</td>
    <td colspan="3"></td>
    <td class="r">CHF ${franken(gesamt)}</td>
    ${gesamtModule}
    ${opt.bemerkungExtern ? "<td></td>" : ""}
  </tr>`;

  const meta = [
    projektLabel(offen),
    offen.genauigkeit,
    offen.kostenstand ? `Kostenstand ${offen.kostenstand}` : "",
    mwstSatz() ? `Kosten inkl. ${zahl(mwstSatz())}% MwSt` : "Kosten exkl. MwSt"
  ]
    .filter(Boolean)
    .join(" · ");

  return `<section class="pr-seite">
    <div class="pr-kopf">
      <h2>${escapeHtml(offen.titel || "")}${modul ? ` — Modul ${escapeHtml(modul.name)}` : ""}</h2>
      <div class="pr-meta">${escapeHtml(meta)}</div>
      ${offen.grundlagen && !modul ? `<div class="pr-grundlagen">${escapeHtml(offen.grundlagen)}</div>` : ""}
    </div>
    <table class="pr-table">
      <thead><tr>${kopf.join("")}</tr></thead>
      <tbody>${zeilen}</tbody>
    </table>
  </section>`;
}

function renderDruck(opt) {
  const seiten = [druckSeite(opt, null)];
  if (opt.modulSeiten) {
    const { summen } = modulSummen();
    // Module ohne eine einzige Zeile bekommen keine Seite -- ein Blatt mit
    // lauter Nullen hilft niemandem.
    module_()
      .filter((m) => summen[m.id])
      .forEach((m) => seiten.push(druckSeite(opt, m)));
  }
  document.getElementById("printView").innerHTML = seiten.join("");
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
  document.getElementById("preislisteHinweis").addEventListener("click", (e) => {
    if (e.target.closest("[data-gliederung]")) wiederholeGliederung();
  });
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
  const vorlagenBox = document.getElementById("vorlagenOverlay");
  vorlagenBox.addEventListener("click", onVorlagenClick);
  vorlagenBox.addEventListener("input", onVorlagenInput);
  document.getElementById("closeVorlagen").addEventListener("click", schliesseVorlagenWahl);
  panel.addEventListener("keydown", onPanelKeydown);

  document.getElementById("ebeneSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-ebene]");
    if (!btn) return;
    setzeEbene(Number(btn.dataset.ebene));
    merkeSicht();
  });
  document.getElementById("modusSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-modus]");
    if (btn && btn.dataset.modus !== ansichtModus) setzeModus(btn.dataset.modus);
  });
  document.getElementById("kapitelView").addEventListener("click", onKapitelClick);
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
    // Gesucht wird in der Tabelle -- dort steht die Trefferliste.
    if (suche.trim() && ansichtModus === "kapitel") {
      ansichtModus = "tabelle";
      renderToolbar();
      render();
    }
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
    kopfModule.push({ id: uid(), name: "" });
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

  // ⌘K / Ctrl+K springt ins Suchfeld, Escape schliesst das Bearbeitungsfenster
  // bzw. leert die Suche.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && offen) {
      e.preventDefault();
      document.getElementById("sucheInput").focus();
      document.getElementById("sucheInput").select();
      return;
    }
    if (e.key === "Escape" && !document.getElementById("vorlagenOverlay").classList.contains("hidden")) {
      schliesseVorlagenWahl();
      return;
    }
    if (e.key === "Escape" && offen) {
      const sucheEl = document.getElementById("sucheInput");
      if (document.activeElement === sucheEl && sucheEl.value) {
        sucheEl.value = "";
        suche = "";
        renderTabelleErhalten();
      } else if (gewaehlteZeile) {
        schliessePanel();
      }
    }
  });

  const sticky = document.getElementById("bkSticky");
  if (window.ResizeObserver) new ResizeObserver(messeSticky).observe(sticky);
  window.addEventListener("resize", messeSticky);
  window.addEventListener("scroll", () => sticky.classList.toggle("geklebt", window.scrollY > 4), { passive: true });
  messeSticky();

  window.addEventListener("online", () => {
    refreshAlle();
    if (offenFilename) starteLive();
  });

  // Ein aufgeschobener fremder Stand (es wurde gerade getippt) wird
  // nachgeholt, sobald das Feld verlassen ist -- sonst wartete er bis zum
  // nächsten Takt. Die kurze Verzögerung überspringt das Weitertabben ins
  // nächste Feld.
  document.addEventListener("focusout", () => {
    if (!standAusstehend) return;
    clearTimeout(nachholTimer);
    nachholTimer = setTimeout(() => {
      if (!eingabeImFokus()) liveTakt();
    }, 300);
  });
  // Beim Zurückkehren in den Tab nachsehen, ob jemand anders an derselben
  // Schätzung war. Ohne offene Schätzung ist die Liste dran, die holt
  // nebenbei den Katalog mit.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      merkeSicht(); // Tab gewechselt oder weggelegt -- Stand festhalten
      // Im Hintergrund wird weder nachgefragt noch Anwesenheit gemeldet;
      // beim anderen verschwindet das Kürzel darum nach gut einer Minute.
      stoppeLive();
      return;
    }
    if (offenFilename) {
      starteLive();
      // Kein Live-Takt möglich (Demomodus, offline): dann wie bisher einmal
      // beim Zurückkehren in den Tab nachladen.
      if (!liveAn) holeFremdenStand();
    } else refreshAlle();
  });
  // Beim Schliessen des Tabs kommt kein visibilitychange mehr, das ist die
  // einzige verlässliche letzte Gelegenheit.
  window.addEventListener("pagehide", merkeSicht);

  // Die Stelle in der Tabelle: gedämpft mitschreiben, sonst schriebe jedes
  // Rad-Tick in den localStorage. Solange die Wiederherstellung aussteht,
  // steht die Seite oben -- das wäre kein Stand, den man merken will.
  let scrollTimer = null;
  window.addEventListener("scroll", () => {
    if (!offenFilename || wiederherstellen) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(merkeSicht, 500);
  }, { passive: true });

  // Der Katalog aus dem localStorage steht sofort, auch offline und bevor
  // refreshAlle() ihn frisch holt.
  ladeKatalog();

  render();
  refreshAppData();
  refreshAlle();

  registerServiceWorkerWithAutoUpdate();
}

document.addEventListener("DOMContentLoaded", init);
