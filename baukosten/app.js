/* ============================================================
   Baukosten — Kostenschätzung nach BKP (Baukostenplan).

   Ablöser der bisherigen Excel-Vorlage des Büros. Der BKP-Katalog selbst
   (ein-, zwei- und dreistellige Nummern) steht fix in bkp.js und ist für
   alle Schätzungen identisch; eine Schätzung speichert nur das, was
   tatsächlich erfasst wurde:

     positionen: { "224": [ {Unterposition}, ... ], "211.1": [ ... ] }
     eigenePositionen: [ { nr: "211.1", titel: "Gerüste" } ]

   Das hat zwei Vorteile gegenüber der Excel-Logik (dort ist der Katalog
   Teil jedes Dokuments): die Dateien bleiben klein, und eine Korrektur am
   Katalog gilt sofort für alle bestehenden Schätzungen.

   Eine Unterposition ist die eigentliche Eingabezeile. Ausmass und
   Kennwert werden als EINGETIPPTER TEXT gespeichert ("2x4x2", "136*1.08")
   und erst beim Anzeigen gerechnet (rechne()) -- so bleibt sichtbar,
   woher eine Zahl kommt, was bei einer Kostenschätzung der halbe Zweck
   ist. Kosten = Ausmass × Kennwert, leeres Ausmass zählt als 1 (damit
   Pauschal-/Budgetpositionen ohne Pseudo-Ausmass "1 Pl" auskommen).

   Ein File pro Kostenschätzung auf Nextcloud (Liste + Editor), Struktur
   bewusst analog zu Offerten/Protokoll. Speichern wie dort/bei der
   Finanzplanung: jede Änderung ist eine reine Funktion, die sowohl lokal
   (sofort) als auch seriell auf einen frisch geholten Serverstand
   angewendet wird.

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
const ansichtDefaults = { ebene: 4, nurVerwendet: true };
let ansicht = { ...ansichtDefaults, ...loadJSON(LS_KEYS.ansicht, {}) };
let suche = "";
let zugeklappt = new Set(); // Knoten-Nummern, die zugeklappt sind

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
    const eg = nr.slice(0, 2);
    const hg = nr.slice(0, 1);
    summen[eg] = (summen[eg] || 0) + summe;
    summen[hg] = (summen[hg] || 0) + summe;
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

// ---------- Rendering: Editor ----------

function chevron(nr, hatKinder, offenJetzt) {
  if (!hatKinder) return '<button class="bk-chevron leer" tabindex="-1"></button>';
  return `<button type="button" class="bk-chevron" data-action="toggle" data-nr="${nr}" aria-label="Ein-/ausklappen">${offenJetzt ? "▾" : "▸"}</button>`;
}

function gruppenZeileHtml(knoten, summe, hatKinder, offenJetzt) {
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
  return `<tr class="bk-group bk-l${e}" data-nr="${knoten.nr}">
    <td class="bk-nr${indent}">${chevron(knoten.nr, hatKinder, offenJetzt)}${escapeHtml(knoten.nr)}</td>
    <td class="bk-titel" colspan="4">${escapeHtml(knoten.titel)}</td>
    <td class="bk-total bk-right" data-total-for="${knoten.nr}">${summe ? franken(summe) : ""}</td>
    <td class="bk-col-intern"></td>
    <td></td>
    <td class="bk-col-aktion">${aktionen}</td>
  </tr>`;
}

// Ausmass- und Kennwert-Zelle: im Feld steht das gerechnete Resultat, die
// eingetippte Rechnung bleibt klein darunter stehen (und erscheint beim
// Hineinklicken wieder im Feld, siehe onFokus()).
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

function unterpositionHtml(nr, zeile) {
  return `<tr class="bk-sub" data-nr="${nr}" data-row="${zeile.id}">
    <td></td>
    <td><textarea rows="1" data-feld="beschrieb" placeholder="Beschrieb der Arbeiten">${escapeHtml(zeile.beschrieb || "")}</textarea></td>
    ${rechenZelle(zeile, "ausmass", "bk-ausmass")}
    <td><input type="text" data-feld="einheit" list="einheitenListe" value="${escapeHtml(zeile.einheit || "")}"></td>
    ${rechenZelle(zeile, "kennwert", "bk-kennwert")}
    <td class="bk-kosten" data-kosten-for="${zeile.id}">${zeilenKosten(zeile) ? franken(zeilenKosten(zeile)) : ""}</td>
    <td class="bk-col-intern"><textarea class="bk-bem" rows="1" data-feld="intern">${escapeHtml(zeile.intern || "")}</textarea></td>
    <td><textarea class="bk-bem" rows="1" data-feld="extern">${escapeHtml(zeile.extern || "")}</textarea></td>
    <td class="bk-col-aktion"><button type="button" class="bk-row-action" data-action="del-zeile" data-nr="${nr}" data-row="${zeile.id}" title="Zeile löschen">×</button></td>
  </tr>`;
}

function renderEditor() {
  const knoten = alleKnoten();
  const { summen, gesamt } = alleSummen();
  const q = suche.trim().toLowerCase();
  const sucheAktiv = q.length > 0;
  const trefferSet = sucheAktiv ? sichtbarDurchSuche(knoten, q) : null;
  const verwendet = verwendeteKnoten();

  // Welche Knoten haben überhaupt Kinder (unter den gerade geltenden
  // Filtern)? Nur die bekommen ein Klapp-Dreieck.
  const hatKinder = {};
  knoten.forEach((k) => {
    const eltern = elterNummer(k.nr);
    if (eltern) hatKinder[eltern] = true;
    if (knotenEbene(k.nr) === 3 && zeilenVon(k.nr).length) hatKinder[k.nr] = true;
  });

  let html = "";
  let sichtbareZeilen = 0;

  knoten.forEach((k) => {
    const e = knotenEbene(k.nr);
    if (sucheAktiv) {
      if (!trefferSet.has(k.nr)) return;
    } else {
      if (ansicht.nurVerwendet && !verwendet.has(k.nr)) return;
      // Sichtbar nur, wenn keiner der Vorfahren zugeklappt ist.
      let eltern = elterNummer(k.nr);
      let versteckt = false;
      while (eltern) {
        if (zugeklappt.has(eltern)) versteckt = true;
        eltern = elterNummer(eltern);
      }
      if (versteckt) return;
    }

    const kinderOffen = sucheAktiv || !zugeklappt.has(k.nr);
    html += gruppenZeileHtml(k, summen[k.nr] || 0, !!hatKinder[k.nr], kinderOffen);
    sichtbareZeilen++;

    if (e === 3 && kinderOffen) {
      zeilenVon(k.nr).forEach((z) => {
        html += unterpositionHtml(k.nr, z);
      });
    }
  });

  if (!sichtbareZeilen) {
    html = `<tr><td colspan="9"><div class="bk-leer-hinweis">${
      sucheAktiv
        ? "Keine Position gefunden."
        : 'Noch nichts erfasst. "Nur verwendete" ausschalten oder oben eine BKP-Nummer suchen.'
    }</div></td></tr>`;
  }

  html += `<tr class="bk-gesamt">
    <td colspan="5">Total${offen.genauigkeit ? " " + escapeHtml(offen.genauigkeit) : ""}</td>
    <td class="bk-total bk-right" id="gesamtTotalZelle">CHF ${franken(gesamt)}</td>
    <td class="bk-col-intern"></td><td></td><td class="bk-col-aktion"></td>
  </tr>`;

  document.getElementById("bkBody").innerHTML = html;
  document.getElementById("gesamtTotalHead").textContent = "CHF " + franken(gesamt);

  const meta = [projektLabel(offen), offen.genauigkeit, offen.kostenstand ? `Stand ${offen.kostenstand}` : ""]
    .filter(Boolean)
    .join(" · ");
  document.getElementById("headTitel").textContent = offen.titel || "(ohne Titel)";
  document.getElementById("headMeta").textContent = meta;
  document.getElementById("viewTitel").textContent = "Baukosten";
  document.getElementById("sucheHinweis").textContent = sucheAktiv
    ? "Suche aktiv – Filter und Ein-/Ausklappen sind ausgesetzt"
    : "";

  document.getElementById("printHead").innerHTML = `
    <h2>${escapeHtml(offen.titel || "")}</h2>
    <div class="bk-print-meta">${escapeHtml(meta)}</div>
    ${offen.grundlagen ? `<div class="bk-print-grundlagen">${escapeHtml(offen.grundlagen)}</div>` : ""}`;

  autoGrowAlle();
}

function render() {
  const imEditor = !!offen;
  document.getElementById("listView").style.display = imEditor ? "none" : "";
  document.getElementById("editorView").style.display = imEditor ? "" : "none";
  if (imEditor) renderEditor();
  else {
    document.getElementById("viewTitel").textContent = "Baukosten";
    renderList();
  }
}

// Nach einer reinen Wertänderung (Ausmass/Kennwert) müssen nur die
// gerechneten Zellen nachgeführt werden -- kein kompletter Neuaufbau, der
// den Cursor aus der Tabelle werfen würde.
function refreshSummen() {
  const { summen, gesamt } = alleSummen();
  document.querySelectorAll("[data-total-for]").forEach((el) => {
    const summe = summen[el.dataset.totalFor] || 0;
    el.textContent = summe ? franken(summe) : "";
  });
  document.querySelectorAll("[data-kosten-for]").forEach((el) => {
    const zeile = zeileSuchen(offen, el.dataset.kostenFor);
    if (zeile) el.textContent = zeilenKosten(zeile) ? franken(zeilenKosten(zeile)) : "";
  });
  const gesamtZelle = document.getElementById("gesamtTotalZelle");
  if (gesamtZelle) gesamtZelle.textContent = "CHF " + franken(gesamt);
  document.getElementById("gesamtTotalHead").textContent = "CHF " + franken(gesamt);
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}
function autoGrowAlle() {
  document.querySelectorAll("#bkBody textarea").forEach(autoGrow);
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
  document.getElementById("syncLine").textContent = text || " ";
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
  return { id: uid(), beschrieb: "", ausmass: "", einheit: "", kennwert: "", intern: "", extern: "" };
}

// ---------- Interaktion: Editor ----------

function setzeEbene(stufe) {
  ansicht.ebene = stufe;
  saveJSON(LS_KEYS.ansicht, ansicht);
  zugeklappt = new Set();
  if (stufe < 4) {
    alleKnoten().forEach((k) => {
      if (knotenEbene(k.nr) >= stufe) zugeklappt.add(k.nr);
    });
  }
  renderEbeneButtons();
  render();
}

function renderEbeneButtons() {
  document.querySelectorAll("#ebeneSeg button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.ebene) === ansicht.ebene);
  });
  document.getElementById("nurVerwendetBtn").classList.toggle("active", ansicht.nurVerwendet);
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
    render();
    return;
  }

  if (action === "add-zeile") {
    zugeklappt.delete(nr);
    // Die Zeile wird EINMAL vor dem mutate() erzeugt, nicht darin: mutateFn
    // läuft zweimal (lokal und auf dem frisch geholten Serverstand), und mit
    // einem uid() im Innern bekäme die Zeile dort eine andere ID -- alle
    // späteren Feldänderungen würden sie auf dem Server nicht mehr finden.
    const zeile = neueZeile();
    mutate(
      (data) => {
        if (!data.positionen[nr]) data.positionen[nr] = [];
        if (!data.positionen[nr].some((z) => z.id === zeile.id)) data.positionen[nr].push({ ...zeile });
        return data;
      },
      { neuRendern: true }
    );
    // Direkt in den Beschrieb der neuen Zeile springen.
    const zeilen = document.querySelectorAll(`#bkBody tr.bk-sub[data-nr="${nr}"] textarea[data-feld="beschrieb"]`);
    if (zeilen.length) zeilen[zeilen.length - 1].focus();
    return;
  }

  if (action === "del-zeile") {
    const zeile = zeileSuchen(offen, row);
    const text = (zeile && zeile.beschrieb) || "";
    if (text && !confirm(`Zeile "${text}" wirklich löschen?`)) return;
    mutate(
      (data) => {
        data.positionen[nr] = (data.positionen[nr] || []).filter((z) => z.id !== row);
        if (!data.positionen[nr].length) delete data.positionen[nr];
        return data;
      },
      { neuRendern: true }
    );
    return;
  }

  if (action === "add-position") {
    const vorschlag = `${nr}1.1`;
    const eingabe = (prompt(`Eigene Position unter BKP ${nr} – Nummer (z.B. ${vorschlag}):`, "") || "").trim();
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

// Beim Hineinklicken in ein Ausmass-/Kennwert-Feld erscheint wieder die
// eingetippte Rechnung statt des Resultats.
function onBodyFocusIn(e) {
  const input = e.target.closest("input.bk-num");
  if (!input) return;
  input.value = input.dataset.roh || input.value;
  input.select();
}

function onBodyFocusOut(e) {
  const input = e.target.closest("input.bk-num");
  if (!input) return;
  const berechnet = rechne(input.dataset.roh);
  input.value = berechnet === null ? "" : isNaN(berechnet) ? input.dataset.roh : zahl(berechnet);
}

function onBodyChange(e) {
  const feldEl = e.target.closest("[data-feld]");
  if (!feldEl) return;
  const tr = feldEl.closest("tr.bk-sub");
  if (!tr) return;
  const { nr, row } = tr.dataset;
  const feld = feldEl.dataset.feld;
  const wert = feldEl.value;

  mutate((data) => {
    const zeile = (data.positionen[nr] || []).find((z) => z.id === row);
    if (zeile) zeile[feld] = wert;
    return data;
  });

  // Rechenfelder zeigen nach dem Verlassen wieder das Resultat an.
  if (feldEl.matches("input.bk-num")) {
    feldEl.dataset.roh = wert;
    const berechnet = rechne(wert);
    feldEl.value = berechnet === null ? "" : isNaN(berechnet) ? wert : zahl(berechnet);
    const hinweis = feldEl.parentElement.querySelector(".bk-formel");
    if (hinweis) hinweis.textContent = isNaN(berechnet) ? "ungültig" : istRechnung(wert) ? wert : "";
  }
}

function onBodyInput(e) {
  if (e.target.tagName === "TEXTAREA") autoGrow(e.target);
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

async function erstelleUndOeffne(data) {
  const filename = dateinameFuer(data);
  data.updatedAt = new Date().toISOString();
  data.updatedBy = personName();
  schaetzungen.push({ filename, data });
  saveJSON(LS_KEYS.cache, schaetzungen);
  offen = data;
  offenFilename = filename;
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
  document.getElementById("sucheInput").value = "";
  setzeEbene(ansicht.ebene);
}

function zurueckZurListe() {
  offen = null;
  offenFilename = null;
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
  document.getElementById("kopfGrundlagen").value = offen.grundlagen || "";
  overlay("kopfOverlay", true);
}

function uebernimmKopfDialog() {
  const { projekt, projektName } = projektAusSelect("kopfProjekt");
  const titel = document.getElementById("kopfTitel").value.trim();
  const genauigkeit = document.getElementById("kopfGenauigkeit").value.trim();
  const kostenstand = document.getElementById("kopfKostenstand").value.trim();
  const grundlagen = document.getElementById("kopfGrundlagen").value;
  overlay("kopfOverlay", false);
  mutate(
    (data) => {
      data.projekt = projekt;
      data.projektName = projektName;
      data.titel = titel || data.titel;
      data.genauigkeit = genauigkeit;
      data.kostenstand = kostenstand;
      data.grundlagen = grundlagen;
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
  renderEbeneButtons();

  document.getElementById("bkList").addEventListener("click", onListClick);
  document.getElementById("neuBtn").addEventListener("click", oeffneNeuDialog);
  document.getElementById("backBtn").addEventListener("click", zurueckZurListe);
  document.getElementById("kopfBtn").addEventListener("click", oeffneKopfDialog);
  document.getElementById("printBtn").addEventListener("click", () => window.print());

  const body = document.getElementById("bkBody");
  body.addEventListener("click", onBodyClick);
  body.addEventListener("focusin", onBodyFocusIn);
  body.addEventListener("focusout", onBodyFocusOut);
  body.addEventListener("change", onBodyChange);
  body.addEventListener("input", onBodyInput);

  document.getElementById("ebeneSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-ebene]");
    if (btn) setzeEbene(Number(btn.dataset.ebene));
  });
  document.getElementById("nurVerwendetBtn").addEventListener("click", () => {
    ansicht.nurVerwendet = !ansicht.nurVerwendet;
    saveJSON(LS_KEYS.ansicht, ansicht);
    renderEbeneButtons();
    render();
  });
  document.getElementById("sucheInput").addEventListener("input", (e) => {
    suche = e.target.value;
    render();
  });

  document.getElementById("closeNeu").addEventListener("click", () => overlay("neuOverlay", false));
  document.getElementById("neuAbbrechenBtn").addEventListener("click", () => overlay("neuOverlay", false));
  document.getElementById("neuErstellenBtn").addEventListener("click", erstelleAusDialog);
  document.getElementById("closeKopf").addEventListener("click", () => overlay("kopfOverlay", false));
  document.getElementById("kopfSpeichernBtn").addEventListener("click", uebernimmKopfDialog);
  document.getElementById("kopfLoeschenBtn").addEventListener("click", loescheOffene);

  document.getElementById("helpBtn").addEventListener("click", () => overlay("helpOverlay", true));
  document.getElementById("closeHelp").addEventListener("click", () => overlay("helpOverlay", false));

  window.addEventListener("online", refreshAlle);

  render();
  refreshAppData();
  refreshAlle();

  registerServiceWorkerWithAutoUpdate();
}

document.addEventListener("DOMContentLoaded", init);
