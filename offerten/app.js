/* ============================================================
   Offerten — Offerten aus Positionen zusammenstellen: Phasen
   (freie Zwischenüberschrift, z.B. "Vorprojekt") und Module (Titel
   mit automatischer Nummerierung, Kurzbeschrieb als Bulletpoints --
   eine Zeile im Textfeld = ein Punkt --, Stunden, Kosten = Stunden x
   Stundensatz). Positionen beliebig hoch-/runterschieben,
   Zwischentotal/MWST/Total berechnen, auf Nextcloud sichern
   (geräteübergreifend verfügbar). Offerten lassen sich duplizieren,
   um nicht jedes Mal alles neu erfassen zu müssen. Beim Erfassen eines
   Moduls kann auch live in allen bisherigen Offerten nach ähnlichen
   Modulen gesucht und übernommen werden (keine separate Library --
   siehe allKnownModules()).

   Jede Offerte hat einen "typ" (offerte/rechnung) -- ändert Beschriftung
   ("Offert-Nr." -> "Rechnungs-Nr.") und ergänzt im PDF den fixen Satz
   "Zahlbar innert 30 Tagen", sonst identisches Modell/Formular für beide.

   PDF-Export (Brief + Offerte/Rechnung) kommt aus pdf.js
   (exportOfferPdf()). Die Absenderadresse dafür kommt aus
   offerten/absender.json (bleibt praktisch immer gleich, deshalb
   nicht pro Offerte erfasst) -- siehe loadAbsender().

   Nextcloud-Login, proxyFetch/authHeader/davPath, Einstellungen-UI
   usw. kommen aus ../shared/common.js (gemeinsam mit Zeiterfassung,
   Quittung und Wettbewerbsprogramme).

   Für den Fall, dass zwei Personen dieselbe Offerte gleichzeitig geöffnet
   haben: anders als bei der Adressliste (ganze Datei überschreiben oder
   verwerfen) wird hier pro Feld gemergt, siehe mergeOfferFields() und deren
   Verwendung in saveCurrentOffer() -- ändert die eine Person den Brieftext
   und die andere die Kostenmodule, werden beide Änderungen automatisch
   übernommen. Nur wenn beide Seiten dasselbe Feld unterschiedlich geändert
   haben, wird nachgefragt, welche Version gelten soll. Auch kein echtes
   Locking, nur ein Best-Effort-Merge.
   ============================================================ */

const LS_KEYS = {
  cache: "offerten_cache", // zuletzt geladene Offerten (Offline-Fallback)
  rate: "offerten_stundensatz" // Vorgabe-Stundensatz für NEUE Offerten
};

const DEFAULT_STUNDENSATZ = 150;
const DEFAULT_MWST_PROZENT = 8.1;

// Zielordner auf Nextcloud -- kein Jahresordner, Offerten sind über die
// gesamte Akquise-Ablage hinweg relevant, nicht an ein Jahr gebunden.
const OFFERTEN_TARGET_FOLDER_PATH = "Buero/Admin/Offerten und Rechnungen";

// { filename, data } -- data ist das geparste JSON.
let offers = loadJSON(LS_KEYS.cache, []);

// Zentral verwaltete Projektliste (Kopie aus zeiterfassung/app.js, siehe
// dort für die Begründung der Dopplung) -- bei Rechnungen (typ "rechnung")
// wird Projektnummer+Projekt daraus ausgewählt statt frei eingegeben, weil
// eine Rechnung praktisch immer ein bereits laufendes, nummeriertes Projekt
// betrifft. Bei Offerten (typ "offerte") bleiben beide Felder frei eingebbar
// -- aus einer Offerte entsteht nicht immer ein Projekt mit eigener Nummer.
const PROJECTS_SHARE_TOKEN = "cRyoZG6fzBQYDeH";
let projectList = loadJSON("offerten_projects_cache", []);

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
    saveJSON("offerten_projects_cache", list);
    renderProjektAuswahl();
  } catch (err) {
    console.warn("Zentrale Projektnamen konnten nicht geladen werden:", err);
  }
}

// Dropdown für Rechnungen: "021 – Neubau Werkhof" -- Nummer UND Name in
// einem Feld, siehe Kommentar bei PROJECTS_SHARE_TOKEN oben.
function renderProjektAuswahl() {
  const select = document.getElementById("inputProjektAuswahl");
  if (!select) return;
  const current = editingOffer ? editingOffer.projektnummer : "";
  const currentInList = projectList.some((p) => p.id === current);

  let options = projectList.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.id)} – ${escapeHtml(p.name)}</option>`);
  // Nummer nicht (mehr) in der aktiven Liste (z.B. altes, inzwischen
  // abgeschlossenes/archiviertes Projekt einer bestehenden Rechnung) --
  // trotzdem als eigene, vorausgewählte Option zeigen statt einfach auf
  // "– Projekt wählen –" zurückzufallen. Sonst sieht es beim Öffnen einer
  // alten Rechnung so aus, als sei das Projekt verloren gegangen (ist es
  // nicht, projektnummer/projekt bleiben im Hintergrund unverändert) -- und
  // eine versehentliche Neuauswahl würde die alten Werte überschreiben.
  if (current && !currentInList) {
    options = [
      `<option value="${escapeHtml(current)}" data-name="${escapeHtml(editingOffer.projekt || "")}">${escapeHtml(current)} – ${escapeHtml(editingOffer.projekt || "")} (nicht mehr in der Liste)</option>`,
      ...options
    ];
  }

  select.innerHTML = '<option value="">– Projekt wählen –</option>' + options.join("");
  select.value = current || "";
}

// Aktuell im Editor offene Offerte (Arbeitskopie) und ihr Dateiname auf
// Nextcloud (null = noch nicht gespeichert, also eine neue Offerte).
let editingOffer = null;
let editingFilename = null;

// Stand der Offerte beim Öffnen des Editors (tiefe Kopie) -- für den
// Feld-Merge beim Speichern: nur damit lässt sich pro Feld unterscheiden,
// ob es seither lokal, auf dem Server, in beiden oder in keinem der beiden
// verändert wurde (siehe mergeOfferFields()). null bei einer neuen Offerte.
let editingBaselineOffer = null;

// DOM-Element der gerade per Drag & Drop gezogenen Zeile (Modul oder Phase),
// null ausserhalb eines Drag-Vorgangs. Siehe renderPositionen().
let draggedRow = null;

// Absenderadresse fürs PDF-Anschreiben -- ändert sich praktisch nie,
// deshalb zentral in einer Datei statt pro Offerte erfasst.
let absender = null;
async function loadAbsender() {
  try {
    const res = await fetch("absender.json");
    absender = res.ok ? await res.json() : null;
  } catch (e) {
    absender = null;
  }
}

// Liste möglicher Unterzeichner (Name + Dateiname der Unterschrift auf
// Nextcloud) -- ändert sich praktisch nie, deshalb zentral in einer Datei
// statt pro Offerte erfasst. Zentral in ../shared/personen.json (nicht hier
// in offerten/), weil dieselbe Personenliste auch bei den Pendenzen fürs
// Zuordnen/Filtern verwendet wird -- eine Person einmal pflegen statt in
// mehreren Modulen duplizieren. Die Unterschrift-PNGs selbst liegen auf
// Nextcloud (siehe SIGNATURE_FOLDER_PATH in pdf.js) und werden erst beim
// PDF-Export nachgeladen, nicht hier.
let unterzeichnerConfig = [];
async function loadUnterzeichnerConfig() {
  try {
    const res = await fetch("../shared/personen.json");
    unterzeichnerConfig = res.ok ? await res.json() : [];
  } catch (e) {
    unterzeichnerConfig = [];
  }
}

function offerSegments() {
  return ncSegments(OFFERTEN_TARGET_FOLDER_PATH);
}
function ensureOfferFolder() {
  return ensureFolderPath(offerSegments());
}

// Für "Verbindung testen": ein garantiert nicht existierender Dateiname im
// (zuvor angelegten) Zielordner -- 200 oder 404 sind beides ein Erfolg.
function pingRelPath() {
  return davPath([...offerSegments(), "_ping"].join("/"));
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';

async function listOfferFilenames() {
  const relPath = davPath(offerSegments().join("/") + "/");
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

async function fetchOfferFile(filename) {
  const relPath = davPath([...offerSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (!res.ok) throw new Error(`${filename}: Status ${res.status}`);
  const text = await res.text();
  return JSON.parse(text);
}

async function putOfferFile(filename, data) {
  const relPath = davPath([...offerSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(data, null, 2)
  });
  if (!res.ok) throw new Error(`Speichern fehlgeschlagen (${res.status})`);
}

async function deleteOfferFile(filename) {
  const relPath = davPath([...offerSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "DELETE", headers: authHeader() });
  if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
}

async function refreshOffers() {
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
    await ensureOfferFolder();
    const filenames = await listOfferFilenames();
    const loaded = await Promise.all(
      filenames.map(async (filename) => {
        try {
          const data = await fetchOfferFile(filename);
          // Eine Datei mit ungültigem/leerem Inhalt (z.B. nur "null") würde
          // sonst als {filename, data: null} durchrutschen -- .filter(Boolean)
          // greift hier NICHT, weil das umgebende Objekt selbst truthy ist,
          // und liesse jede spätere Verwendung von .data crashen (siehe
          // renderList()). Deshalb hier wie ein fehlgeschlagener Ladevorgang
          // behandeln: überspringen, nicht in die Liste aufnehmen.
          if (!data || typeof data !== "object") throw new Error("ungültiger/leerer Inhalt");
          return { filename, data };
        } catch (err) {
          console.warn("Konnte Offerte nicht laden:", filename, err);
          return null;
        }
      })
    );
    offers = loaded.filter(Boolean);
    saveJSON(LS_KEYS.cache, offers);
    line.textContent = "Synchronisiert";
  } catch (err) {
    console.warn("Offerten konnten nicht geladen werden:", err);
    line.textContent = "Fehler beim Laden · zeige zuletzt geladenen Stand";
  }
  renderList();
}

function sanitizeJsonFilename(name) {
  let clean = name.trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) clean = `offerte-${uid()}`;
  if (!clean.toLowerCase().endsWith(".json")) clean += ".json";
  return clean;
}

// Der Dateiname für NEUE Offerten kommt nur aus Datum+Projekt (nicht aus der
// frei bleibenden Offert-Nr.) -- zwei Offerten zum selben Projekt am selben
// Tag (z.B. eine Duplizierung mit neuer Offert-Nr., aber unverändertem
// Projektnamen) hätten sonst denselben Dateinamen und die ältere würde beim
// Speichern der neuen stillschweigend überschrieben. Deshalb bei einer
// Kollision mit einer bereits bekannten Datei " (2)", " (3)", … anhängen.
function uniqueFilename(base) {
  const known = new Set(offers.map((o) => o.filename));
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

function chDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function chDate(dateStr) {
  if (!dateStr) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return dateStr;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
function chFr(n) {
  if (n === undefined || n === null || n === "") return "–";
  return `${chNumber(n)} Fr.`;
}
// Für Summen ab Zwischentotal: auf 5 Rappen gerundet (übliche Schweizer
// Rundung), immer mit 2 Nachkommastellen.
function chFrRounded(n) {
  if (n === undefined || n === null || n === "") return "–";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  const rounded = Math.round(num / 0.05) * 0.05;
  return `${rounded.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Fr.`;
}

// ---------- Stundensatz-Vorgabe (Liste) ----------

function loadDefaultRate() {
  const raw = localStorage.getItem(LS_KEYS.rate);
  const num = raw !== null ? Number(raw) : NaN;
  return isNaN(num) ? DEFAULT_STUNDENSATZ : num;
}
function saveDefaultRate(value) {
  localStorage.setItem(LS_KEYS.rate, String(value));
}

// ---------- Rendering: Liste ----------

function renderList() {
  document.getElementById("countLabel").textContent = String(offers.length);
  const body = document.getElementById("offerBody");

  if (offers.length === 0) {
    body.innerHTML = '<tr><td colspan="9">Noch keine Offerten geladen.</td></tr>';
    return;
  }

  const sorted = offers
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o && o.data) // s. refreshOffers(): schützt zusätzlich vor kaputten Einträgen
    .sort((a, b) => String(b.o.data.datum || "").localeCompare(String(a.o.data.datum || "")));

  body.innerHTML = sorted
    .map(({ o, i }) => {
      const d = o.data;
      const { stundenTotal, total } = calcTotals(d);
      const isRechnung = d.typ === "rechnung";
      const status = d.status || "in_bearbeitung";
      const statusOptions = Object.keys(STATUS_LABELS)
        .map((key) => `<option value="${key}" ${key === status ? "selected" : ""}>${STATUS_LABELS[key]}</option>`)
        .join("");
      return `<tr data-clickable data-index="${i}">
        <td>${escapeHtml(d.offert_nr || "–")}</td>
        <td>${escapeHtml(chDate(d.datum))}</td>
        <td><span class="typ-badge${isRechnung ? " rechnung" : ""}">${typLabel(d.typ)}</span></td>
        <td>${escapeHtml([d.projektnummer, d.projekt || o.filename].filter(Boolean).join(" – "))}</td>
        <td>${escapeHtml(d.empfaenger || "–")}</td>
        <td>${escapeHtml(chNumber(stundenTotal))}</td>
        <td>${escapeHtml(chFrRounded(total))}</td>
        <td class="row-actions">
          <button type="button" class="row-action" data-action="pdf" data-index="${i}" title="PDF erstellen">📄</button>
          <button type="button" class="row-action" data-action="duplicate" data-index="${i}" title="Duplizieren">⧉</button>
        </td>
        <td>
          <select class="status-select" data-action="status" data-index="${i}" data-status="${status}">${statusOptions}</select>
        </td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("tr[data-clickable]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.index, 10);
      openEditor(offers[idx].data, offers[idx].filename);
    });
  });

  body.querySelectorAll('[data-action="duplicate"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      duplicateOffer(offers[idx].data);
    });
  });

  body.querySelectorAll('[data-action="status"]').forEach((select) => {
    select.addEventListener("click", (e) => e.stopPropagation());
    select.addEventListener("change", (e) => {
      e.stopPropagation();
      const idx = parseInt(select.dataset.index, 10);
      updateOfferStatus(idx, select.value);
    });
  });

  body.querySelectorAll('[data-action="pdf"]').forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      btn.disabled = true;
      try {
        const { warnings } = await exportOfferPdf(offers[idx].data, absender, unterzeichnerConfig);
        if (warnings.length) alert(warnings.join("\n"));
      } catch (err) {
        alert("Fehler beim PDF-Erstellen: " + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ---------- Modul-Suche (in bisherigen Offerten) ----------
//
// Bewusst keine separate Modul-Library: die Offerten sind ohnehin schon
// geladen (für die Liste), also durchsucht das hier einfach deren
// Positionen live. Weniger zu pflegen, immer aktuell.

function allKnownModules() {
  const result = [];
  offers.forEach((o) => {
    (o.data.positionen || []).forEach((p) => {
      if (p.typ === "modul" && p.titel) {
        result.push({
          titel: p.titel,
          beschrieb: Array.isArray(p.beschrieb) ? p.beschrieb : [],
          bemerkung: p.bemerkung || "",
          bemerkungAktiv: !!p.bemerkungAktiv,
          stunden: Number(p.stunden) || 0,
          pauschalAktiv: !!p.pauschalAktiv,
          pauschalBetrag: Number(p.pauschalBetrag) || 0,
          projekt: o.data.projekt || o.filename,
          datum: o.data.datum || ""
        });
      }
    });
  });
  return result;
}

function searchModules(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return allKnownModules()
    .filter((m) => `${m.titel} ${m.beschrieb.join(" ")}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.datum).localeCompare(String(a.datum)))
    .slice(0, 8);
}

function renderModSearchResults(results, query) {
  const box = document.getElementById("modSearchResults");
  if (!query.trim()) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  if (results.length === 0) {
    box.innerHTML = '<div class="mod-search-empty">Keine passenden Module gefunden.</div>';
    return;
  }
  box.innerHTML = results
    .map(
      (m, i) => `<div class="mod-search-result" data-index="${i}">
        <span class="msr-title">${escapeHtml(m.titel)}</span>
        <span class="msr-meta">${m.pauschalAktiv ? escapeHtml(chFr(m.pauschalBetrag)) : escapeHtml(chNumber(m.stunden)) + " Std."} · ${escapeHtml(m.projekt)}, ${escapeHtml(chDate(m.datum))}</span>
      </div>`
    )
    .join("");
  box.querySelectorAll(".mod-search-result").forEach((el) => {
    el.addEventListener("click", () => importModule(results[parseInt(el.dataset.index, 10)]));
  });
}

// Übernimmt Titel/Beschrieb/Stunden als Ausgangspunkt -- Stunden lassen sich
// danach wie gewohnt fürs neue Projekt anpassen.
function importModule(m) {
  editingOffer.positionen.push({
    typ: "modul",
    titel: m.titel,
    beschrieb: [...m.beschrieb],
    bemerkung: m.bemerkung || "",
    bemerkungAktiv: !!m.bemerkungAktiv,
    stunden: m.stunden,
    pauschalAktiv: !!m.pauschalAktiv,
    pauschalBetrag: m.pauschalBetrag || 0
  });
  document.getElementById("modSearchInput").value = "";
  renderModSearchResults([], "");
  renderPositionen();
}

// ---------- Berechnung ----------

// Rundungsrabatt: der Endbetrag inkl. MWST wird auf die nächst-tieferen
// CHF 5.- abgerundet (übliche Kundenfreundlichkeit) und die Differenz als
// eigene Rabatt-Zeile vor dem Zwischentotal ausgewiesen -- nicht die MWST
// selbst wird gekürzt, sondern die (steuerbare) Honorarsumme. Die MWST wird
// danach als Differenz zum bereits gerundeten Endbetrag berechnet statt
// separat gerundet, damit Zwischentotal + MWST den Endbetrag exakt ergeben
// (sonst könnten zwei unabhängige 5-Rappen-Rundungen minimal auseinanderdriften).
// Ist der nötige Rabatt kleiner als ein Rappen (Endbetrag war schon rund),
// bleibt alles beim gewohnten, ungerundeten Verhalten -- keine 0.00-Zeile.
const ROUNDING_STEP_CHF = 5;

function calcTotals(offer) {
  const rate = Number(offer.stundensatz_chf) || 0;
  const modulPositionen = (offer.positionen || []).filter((p) => p.typ === "modul");
  // Pauschal-Module zählen mit ihrem festen Betrag statt Stunden × Stundensatz
  // und tragen keine Stunden zum Stundentotal bei (siehe Todo "Pauschalposition").
  const stundenTotal = modulPositionen.reduce((sum, m) => sum + (m.pauschalAktiv ? 0 : Number(m.stunden) || 0), 0);
  const modulSumme = modulPositionen.reduce(
    (sum, m) => sum + (m.pauschalAktiv ? Number(m.pauschalBetrag) || 0 : (Number(m.stunden) || 0) * rate),
    0
  );
  const nebenkosten = Number(offer.nebenkosten_chf) || 0;
  const subtotalRoh = modulSumme + nebenkosten;
  const mwstProzent = Number(offer.mwst_prozent) || 0;
  const mwstFaktor = 1 + mwstProzent / 100;

  const totalRoh = subtotalRoh * mwstFaktor;
  const totalGerundet = Math.floor((totalRoh + 1e-9) / ROUNDING_STEP_CHF) * ROUNDING_STEP_CHF;
  const subtotalErforderlich = mwstFaktor ? totalGerundet / mwstFaktor : totalGerundet;
  let rundungsrabatt = Math.round((subtotalRoh - subtotalErforderlich) / 0.05) * 0.05;
  if (Math.abs(rundungsrabatt) < 0.01) rundungsrabatt = 0;

  const subtotal = subtotalRoh - rundungsrabatt;
  const mwst = rundungsrabatt ? totalGerundet - subtotal : subtotalRoh * (mwstProzent / 100);
  const total = rundungsrabatt ? totalGerundet : subtotal + mwst;

  return { stundenTotal, modulSumme, nebenkosten, subtotalRoh, rundungsrabatt, subtotal, mwst, total };
}

// ---------- Rendering: Editor ----------

function blankOffer(typ) {
  return {
    typ: typ === "rechnung" ? "rechnung" : "offerte",
    empfaenger: "",
    adresse: "",
    projektnummer: "",
    projekt: "",
    datum: formatDate(new Date()),
    offert_nr: "",
    status: "in_bearbeitung",
    betreff: "",
    brieftext: "",
    unterzeichner: [],
    stundensatz_chf: loadDefaultRate(),
    mwst_prozent: DEFAULT_MWST_PROZENT,
    nebenkosten_chf: 0,
    automatische_nummerierung: true,
    positionen: [{ typ: "modul", titel: "", beschrieb: [], stunden: 0, bemerkung: "", bemerkungAktiv: false, pauschalAktiv: false, pauschalBetrag: 0 }],
    updatedAt: null,
    updatedBy: null
  };
}

// ---------- Feld-Merge beim Speichern ----------
//
// Anders als bei der Adressliste (ganze Datei überschreiben oder verwerfen)
// lohnt sich bei Offerten ein Merge pro Feld: Brieftext und Kostenmodule
// werden oft von verschiedenen Personen bearbeitet, ohne dass das ein
// echter Konflikt ist. Vergleichsbasis ist der Stand beim Öffnen des
// Editors (editingBaselineOffer): ein Feld gilt als "verändert", wenn es
// vom aktuellen Stand (lokal bzw. auf dem Server) abweicht. Nur wenn
// dasselbe Feld auf beiden Seiten anders als die Baseline UND
// unterschiedlich voneinander ist, ist das ein echter Konflikt.
const MERGE_FIELDS = [
  "typ", "empfaenger", "adresse", "projektnummer", "projekt", "datum", "offert_nr", "status",
  "betreff", "brieftext", "unterzeichner", "stundensatz_chf", "mwst_prozent",
  "nebenkosten_chf", "automatische_nummerierung", "positionen"
];
const MERGE_FIELD_LABELS = {
  typ: "Typ", empfaenger: "Empfänger", adresse: "Adresse", projektnummer: "Projektnummer", projekt: "Projekt",
  datum: "Datum", offert_nr: "Offert-/Rechnungsnummer", status: "Status",
  betreff: "Betreff", brieftext: "Brieftext", unterzeichner: "Unterzeichner",
  stundensatz_chf: "Stundensatz", mwst_prozent: "MWST-Prozent",
  nebenkosten_chf: "Nebenkosten", automatische_nummerierung: "Automatische Nummerierung",
  positionen: "Kostenmodule/Positionen"
};

function fieldsEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// Baut aus Baseline/Server/lokalem Stand eine gemergte Offerte. Felder, die
// nur auf einer Seite verändert wurden, übernimmt der Merge automatisch;
// bei echten Konflikten (beide Seiten haben dasselbe Feld unterschiedlich
// geändert) bleibt vorerst der lokale Wert stehen, das Feld wird aber in
// `conflicts` gemeldet, damit die aufrufende Stelle nachfragen kann.
function mergeOfferFields(baseline, server, local) {
  const merged = { ...local };
  const conflicts = [];
  MERGE_FIELDS.forEach((key) => {
    const serverChanged = !fieldsEqual(server[key], baseline[key]);
    const localChanged = !fieldsEqual(local[key], baseline[key]);
    if (serverChanged && !localChanged) {
      merged[key] = server[key];
    } else if (serverChanged && localChanged && !fieldsEqual(server[key], local[key])) {
      conflicts.push(key);
    }
  });
  return { merged, conflicts };
}

function typLabel(typ) {
  return typ === "rechnung" ? "Rechnung" : "Offerte";
}

// Rein interner Status (nicht Teil des PDFs) -- Reihenfolge hier bestimmt
// auch die Reihenfolge im Status-Dropdown.
const STATUS_LABELS = {
  in_bearbeitung: "In Bearbeitung",
  versendet: "Versendet",
  bezahlt: "Bezahlt"
};
function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.in_bearbeitung;
}

// Blendet die rechnungsspezifischen Felder ein/aus und passt Titel/Labels an
// -- Offerte und Rechnung teilen sich sonst dasselbe Formular/Datenmodell.
function applyTypVisibility(typ) {
  const isRechnung = typ === "rechnung";
  document.getElementById("offertNrLabel").textContent = isRechnung ? "Rechnungs-Nr. (optional)" : "Offert-Nr. (optional)";
  document.getElementById("editorTitle").textContent = editingFilename ? `${typLabel(typ)} bearbeiten` : `Neue ${typLabel(typ)}`;
  // Rechnung: Projekt aus der zentralen Liste wählen (Nummer+Name daraus
  // übernehmen). Offerte: beide Felder frei eingeben (siehe Kommentar bei
  // PROJECTS_SHARE_TOKEN oben).
  document.getElementById("projektFreitextGroup").style.display = isRechnung ? "none" : "";
  document.getElementById("projektAuswahlGroup").style.display = isRechnung ? "" : "none";
  if (isRechnung) renderProjektAuswahl();
}

// Übernimmt bei Auswahl eines Projekts aus der zentralen Liste (nur bei
// Rechnungen sichtbar) Nummer+Name in die eigentlichen (bei Rechnungen
// versteckten, aber weiterhin massgeblichen) Freitext-Felder -- so bleibt
// readHeaderFieldsIntoOffer() für beide Typen identisch, nur die
// EINGABE-Widgets unterscheiden sich.
function onProjektAuswahlChange() {
  const select = document.getElementById("inputProjektAuswahl");
  const p = projectList.find((x) => x.id === select.value);
  // Neben echten Listeneinträgen kann auch die synthetische "(nicht mehr in
  // der Liste)"-Option ausgewählt sein (siehe renderProjektAuswahl()) --
  // deren Name steckt im data-name-Attribut, nicht in projectList. Ohne
  // diesen Fallback würde ein erneutes Auswählen dieser Option Nummer/Name
  // fälschlich leeren statt sie zu erhalten.
  const opt = select.options[select.selectedIndex];
  document.getElementById("inputProjektnummer").value = select.value || "";
  document.getElementById("inputProjekt").value = p ? p.name : (opt && opt.dataset.name) || "";
}

function openEditor(offer, filename, newTyp) {
  editingOffer = offer ? JSON.parse(JSON.stringify(offer)) : blankOffer(newTyp);
  editingFilename = filename || null;
  // Nur bei bestehenden Offerten relevant -- für neue gibt's serverseitig
  // noch nichts, mit dem gemergt werden könnte (siehe saveCurrentOffer()).
  editingBaselineOffer = filename ? JSON.parse(JSON.stringify(editingOffer)) : null;

  document.getElementById("inputTyp").value = editingOffer.typ || "offerte";
  applyTypVisibility(editingOffer.typ);
  document.getElementById("inputEmpfaenger").value = editingOffer.empfaenger || "";
  document.getElementById("inputAdresse").value = editingOffer.adresse || "";
  document.getElementById("inputProjektnummer").value = editingOffer.projektnummer || "";
  document.getElementById("inputProjekt").value = editingOffer.projekt || "";
  renderProjektAuswahl();
  document.getElementById("inputDatum").value = editingOffer.datum || formatDate(new Date());
  document.getElementById("inputOffertNr").value = editingOffer.offert_nr || "";
  document.getElementById("inputStatus").value = editingOffer.status || "in_bearbeitung";
  document.getElementById("inputStundensatz").value = editingOffer.stundensatz_chf;
  document.getElementById("inputMwstProzent").value = editingOffer.mwst_prozent;
  document.getElementById("inputNebenkosten").value = editingOffer.nebenkosten_chf || 0;
  document.getElementById("inputBetreff").value = editingOffer.betreff || "";
  document.getElementById("inputBrieftext").value = editingOffer.brieftext || "";
  document.getElementById("inputNummerierung").checked = editingOffer.automatische_nummerierung !== false;
  renderUnterzeichnerCheckboxes();
  document.getElementById("editorResult").textContent = "";
  document.getElementById("editorResult").className = "test-result";
  document.getElementById("deleteOfferBtn").style.display = filename ? "" : "none";
  document.getElementById("duplicateOfferBtn").style.display = filename ? "" : "none";
  document.getElementById("modSearchInput").value = "";
  renderModSearchResults([], "");

  renderPositionen();
  document.getElementById("editorOverlay").classList.remove("hidden");
}

function renderUnterzeichnerCheckboxes() {
  const list = document.getElementById("unterzeichnerList");
  if (!unterzeichnerConfig.length) {
    list.innerHTML = '<p class="hint" style="margin:0;">Keine Unterzeichner konfiguriert (../shared/personen.json).</p>';
    return;
  }
  const selected = new Set(editingOffer.unterzeichner || []);
  list.innerHTML = unterzeichnerConfig
    .map(
      (u) => `<label>
        <input type="checkbox" value="${escapeHtml(u.key)}" ${selected.has(u.key) ? "checked" : ""}>
        ${escapeHtml(u.name)}
      </label>`
    )
    .join("");
}

function closeEditor() {
  document.getElementById("editorOverlay").classList.add("hidden");
  editingOffer = null;
  editingFilename = null;
  editingBaselineOffer = null;
}

// Kurzbeschrieb wird als ein Punkt pro Zeile erfasst (Bulletpoints) --
// gespeichert als Array von Zeilen, im Textfeld als mehrzeiliger Text.
function beschriebToText(beschrieb) {
  return Array.isArray(beschrieb) ? beschrieb.join("\n") : beschrieb || "";
}
function textToBeschrieb(text) {
  return text.split("\n");
}

// Drei kräftige Balken statt feiner Punkte -- ein 6-Punkte-Icon (Material
// "drag_indicator") verschwimmt bei dieser Grösse zu unleserlichen Strichen.
const DRAG_HANDLE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="6" width="12" height="2.4" rx="1.2" fill="currentColor"/><rect x="6" y="10.8" width="12" height="2.4" rx="1.2" fill="currentColor"/><rect x="6" y="15.6" width="12" height="2.4" rx="1.2" fill="currentColor"/></svg>';
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>';

function renderPositionen() {
  const list = document.getElementById("modList");
  const rate = Number(editingOffer.stundensatz_chf) || 0;
  const positionen = editingOffer.positionen;
  const numbered = editingOffer.automatische_nummerierung !== false;

  let modulNr = 0;
  list.innerHTML = positionen
    .map((p, i) => {
      const handle = `<span class="drag-handle" draggable="true" title="Ziehen zum Verschieben">${DRAG_HANDLE_SVG}</span>`;

      if (p.typ === "phase") {
        return `<div class="phase-row" data-index="${i}">
          ${handle}
          <input type="text" class="phase-titel" data-field="titel" placeholder="Phase, z.B. Vorprojekt" value="${escapeHtml(p.titel || "")}">
          <button type="button" class="mod-delete" data-action="delete" aria-label="Phase löschen">${TRASH_SVG}</button>
        </div>`;
      }

      modulNr++;
      const pauschalAktiv = !!p.pauschalAktiv;
      const kosten = pauschalAktiv ? Number(p.pauschalBetrag) || 0 : (Number(p.stunden) || 0) * rate;
      const bemerkungAktiv = !!p.bemerkungAktiv;
      return `<div class="mod-row" data-index="${i}">
        ${handle}
        <div class="mod-main">
          <div class="mod-title-row">
            ${numbered ? `<span class="mod-num">${modulNr})</span>` : ""}
            <input type="text" class="mod-titel" data-field="titel" placeholder="Titel" value="${escapeHtml(p.titel || "")}">
          </div>
          <textarea class="mod-beschrieb" data-field="beschrieb" rows="2" placeholder="Ein Punkt pro Zeile">${escapeHtml(beschriebToText(p.beschrieb))}</textarea>
          <label class="bemerkung-toggle">
            <input type="checkbox" data-field="pauschalAktiv" ${pauschalAktiv ? "checked" : ""}>
            Pauschalbetrag (statt Stunden × Stundensatz)
          </label>
          <label class="bemerkung-toggle">
            <input type="checkbox" data-field="bemerkungAktiv" ${bemerkungAktiv ? "checked" : ""}>
            Bemerkung (kursiv, ohne Punkt, nach den Stichpunkten)
          </label>
          <textarea class="mod-bemerkung" data-field="bemerkung" rows="1" placeholder="z.B. Wegstrecken werden nicht verrechnet" style="${bemerkungAktiv ? "" : "display:none;"}">${escapeHtml(p.bemerkung || "")}</textarea>
        </div>
        <div class="mod-stunden">
          ${
            pauschalAktiv
              ? `<input type="number" class="no-spinner" data-field="pauschalBetrag" min="0" step="10" value="${p.pauschalBetrag ?? 0}"><span class="unit">Fr.</span>`
              : `<input type="number" class="no-spinner" data-field="stunden" min="0" step="0.25" value="${p.stunden ?? 0}"><span class="unit">Std.</span>`
          }
        </div>
        <div class="mod-kosten">${escapeHtml(chFr(kosten))}</div>
        <button type="button" class="mod-delete" data-action="delete" aria-label="Modul löschen">${TRASH_SVG}</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll(".mod-row, .phase-row").forEach((row) => {
    const index = parseInt(row.dataset.index, 10);
    // Referenz auf die zugehörigen Positionsdaten direkt am DOM-Element --
    // beim Live-Verschieben (siehe unten) ändert sich nur die Reihenfolge
    // der DOM-Knoten, nie ihr Inhalt, darum bleibt diese Referenz gültig.
    row.__posRef = positionen[index];

    row.querySelectorAll("[data-field]").forEach((el) => {
      const field = el.dataset.field;
      const eventName = el.type === "checkbox" ? "change" : "input";
      el.addEventListener(eventName, () => {
        if (field === "stunden" || field === "pauschalBetrag") {
          row.__posRef[field] = Number(el.value) || 0;
          recalcAll();
        } else if (field === "beschrieb") {
          row.__posRef[field] = textToBeschrieb(el.value);
        } else if (el.type === "checkbox") {
          row.__posRef[field] = el.checked;
          if (field === "bemerkungAktiv") {
            const ta = row.querySelector(".mod-bemerkung");
            if (ta) ta.style.display = el.checked ? "" : "none";
          } else if (field === "pauschalAktiv") {
            // Tauscht das Stunden- gegen das Pauschalbetrag-Eingabefeld (und
            // umgekehrt) -- anders als bei bemerkungAktiv reicht hier kein
            // einfaches Ein-/Ausblenden, das ganze Feld muss neu aufgebaut werden.
            renderPositionen();
          }
        } else {
          row.__posRef[field] = el.value;
        }
      });
    });

    row.querySelector('[data-action="delete"]')?.addEventListener("click", () => removePosition(positionen.indexOf(row.__posRef)));

    // Drag & Drop: der Griff startet den Drag, die Zeile wird dabei live an
    // die neue Stelle verschoben (statt nur eine dünne Linie anzuzeigen) --
    // das gibt sofortiges, eindeutiges Feedback wie in üblichen
    // Reorder-Listen. Die Positionen-Liste selbst wird erst bei
    // "dragend" aus der finalen DOM-Reihenfolge neu aufgebaut.
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
      editingOffer.positionen = Array.from(list.children).map((el) => el.__posRef);
      renderPositionen();
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

  recalcTotalsDisplay();
}

// Erlaubt das Ablegen unterhalb der letzten Zeile (ans Ende verschieben).
// Einmalig verdrahtet (in init()), da #modList als Element bestehen bleibt
// und nur sein Inhalt bei jedem renderPositionen() neu aufgebaut wird.
function wireModListEndDrop() {
  const list = document.getElementById("modList");
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

function removePosition(index) {
  const positionen = editingOffer.positionen;
  positionen.splice(index, 1);
  if (positionen.length === 0) positionen.push({ typ: "modul", titel: "", beschrieb: [], stunden: 0, bemerkung: "", bemerkungAktiv: false, pauschalAktiv: false, pauschalBetrag: 0 });
  renderPositionen();
}

function recalcAll() {
  // Kosten pro Zeile neu anzeigen, ohne die Eingabefelder neu aufzubauen
  // (sonst verliert das gerade fokussierte Feld den Fokus beim Tippen).
  const rate = Number(editingOffer.stundensatz_chf) || 0;
  document.querySelectorAll("#modList .mod-row").forEach((row) => {
    const index = parseInt(row.dataset.index, 10);
    const p = editingOffer.positionen[index];
    const kosten = p.pauschalAktiv ? Number(p.pauschalBetrag) || 0 : (Number(p.stunden) || 0) * rate;
    row.querySelector(".mod-kosten").textContent = chFr(kosten);
  });
  recalcTotalsDisplay();
}

function recalcTotalsDisplay() {
  const { stundenTotal, rundungsrabatt, subtotal, mwst, total } = calcTotals(editingOffer);
  document.getElementById("totalStunden").textContent = `${chNumber(stundenTotal)} Std.`;
  const rabattRow = document.getElementById("rundungsrabattRow");
  if (rundungsrabatt) {
    rabattRow.style.display = "";
    document.getElementById("totalRundungsrabatt").textContent = `−${chFrRounded(rundungsrabatt)}`;
  } else {
    rabattRow.style.display = "none";
  }
  document.getElementById("totalSubtotal").textContent = chFrRounded(subtotal);
  document.getElementById("totalMwst").textContent = chFrRounded(mwst);
  document.getElementById("totalFinal").textContent = chFrRounded(total);
}

function readHeaderFieldsIntoOffer() {
  editingOffer.typ = document.getElementById("inputTyp").value === "rechnung" ? "rechnung" : "offerte";
  editingOffer.empfaenger = document.getElementById("inputEmpfaenger").value.trim();
  editingOffer.adresse = document.getElementById("inputAdresse").value.trim();
  editingOffer.projektnummer = document.getElementById("inputProjektnummer").value.trim();
  editingOffer.projekt = document.getElementById("inputProjekt").value.trim();
  editingOffer.datum = document.getElementById("inputDatum").value || formatDate(new Date());
  editingOffer.offert_nr = document.getElementById("inputOffertNr").value.trim();
  editingOffer.status = document.getElementById("inputStatus").value || "in_bearbeitung";
  editingOffer.stundensatz_chf = Number(document.getElementById("inputStundensatz").value) || 0;
  editingOffer.mwst_prozent = Number(document.getElementById("inputMwstProzent").value) || 0;
  editingOffer.nebenkosten_chf = Number(document.getElementById("inputNebenkosten").value) || 0;
  editingOffer.betreff = document.getElementById("inputBetreff").value.trim();
  editingOffer.brieftext = document.getElementById("inputBrieftext").value;
  editingOffer.unterzeichner = Array.from(
    document.querySelectorAll('#unterzeichnerList input[type="checkbox"]:checked')
  ).map((el) => el.value);
  editingOffer.automatische_nummerierung = document.getElementById("inputNummerierung").checked;
}

// Übernimmt den aktuellen Stand (inkl. noch nicht gespeicherter Änderungen)
// in eine neue, noch nicht gespeicherte Offerte -- damit nicht jedes Mal
// Empfänger, Module etc. neu erfasst werden müssen.
function duplicateOffer(offer) {
  const copy = JSON.parse(JSON.stringify(offer));
  copy.datum = formatDate(new Date());
  copy.offert_nr = "";
  openEditor(copy, null);
}

// Status-Änderung direkt aus der Liste (einziges dort editierbares Feld) --
// übernimmt sofort optisch (Badge-Farbe) und schreibt im Hintergrund auf
// Nextcloud zurück, ohne den vollen Editor zu öffnen.
async function updateOfferStatus(index, status) {
  const entry = offers[index];
  if (!entry) return;
  entry.data.status = status;
  saveJSON(LS_KEYS.cache, offers);
  renderList();

  if (!isConfigured()) return;
  try {
    await ensureOfferFolder();
    // Frischen Serverstand als Basis nehmen statt des evtl. veralteten
    // lokalen Caches (entry.data) -- sonst könnte ein zwischenzeitliches
    // Speichern aus dem vollen Editor (andere Felder) hier stillschweigend
    // wieder rückgängig gemacht werden. Nur der Status wird bewusst geändert.
    const serverData = await fetchOfferFile(entry.filename).catch(() => null);
    const toSave = { ...(serverData || entry.data), status, updatedAt: new Date().toISOString(), updatedBy: personName() };
    await putOfferFile(entry.filename, toSave);
    entry.data = toSave;
    saveJSON(LS_KEYS.cache, offers);
  } catch (err) {
    alert("Status konnte nicht gespeichert werden: " + err.message);
  }
}

async function saveCurrentOffer() {
  const resultEl = document.getElementById("editorResult");
  readHeaderFieldsIntoOffer();

  if (!editingOffer.projekt) {
    resultEl.textContent = "Bitte ein Projekt angeben.";
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

  const filename = editingFilename || uniqueFilename(sanitizeJsonFilename(`${editingOffer.datum} ${editingOffer.projekt}`));

  try {
    await ensureOfferFolder();

    // Nur bei bestehenden Offerten relevant: hat jemand anders diese Offerte
    // zwischenzeitlich ebenfalls bearbeitet? Verschiedene Felder (z.B.
    // Brieftext hier, Kostenmodule dort) werden automatisch zusammengeführt;
    // nur bei einem echten Konflikt (dasselbe Feld auf beiden Seiten anders
    // verändert) wird nachgefragt, welche Version gelten soll.
    if (editingFilename) {
      const serverData = await fetchOfferFile(editingFilename).catch(() => null);
      if (serverData) {
        const baseline = editingBaselineOffer || serverData;
        const { merged, conflicts } = mergeOfferFields(baseline, serverData, editingOffer);
        if (conflicts.length > 0) {
          const labels = conflicts.map((key) => MERGE_FIELD_LABELS[key] || key).join(", ");
          const keepMine = confirm(
            `Diese Felder wurden von ${serverData.updatedBy || "jemandem"} zwischenzeitlich ebenfalls geändert: ${labels} ` +
              `(zuletzt ${chDateTime(serverData.updatedAt)}).\n\n` +
              `OK = deine Änderungen an diesen Feldern behalten\n` +
              `Abbrechen = die andere Version für diese Felder übernehmen (deine Änderungen daran gehen verloren)`
          );
          conflicts.forEach((key) => {
            merged[key] = keepMine ? editingOffer[key] : serverData[key];
          });
        }
        editingOffer = merged;
      }
    }

    editingOffer.updatedAt = new Date().toISOString();
    editingOffer.updatedBy = personName();

    await putOfferFile(filename, editingOffer);
    editingFilename = filename;
    resultEl.textContent = "Gespeichert.";
    resultEl.className = "test-result ok";
    await refreshOffers();
    closeEditor();
  } catch (err) {
    resultEl.textContent = "Fehler: " + err.message;
    resultEl.className = "test-result err";
  }
}

async function deleteCurrentOffer() {
  if (!editingFilename) return;
  if (!confirm(`Offerte "${editingOffer.projekt || editingFilename}" wirklich löschen?`)) return;

  const deleteBtn = document.getElementById("deleteOfferBtn");
  deleteBtn.disabled = true;
  try {
    await deleteOfferFile(editingFilename);
    offers = offers.filter((o) => o.filename !== editingFilename);
    saveJSON(LS_KEYS.cache, offers);
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
    ensureFolderFn: ensureOfferFolder,
    onSaved: refreshOffers
  });

  wireModListEndDrop();

  const rateInput = document.getElementById("stundensatzInput");
  rateInput.value = loadDefaultRate();
  rateInput.addEventListener("change", () => {
    const value = Number(rateInput.value) || DEFAULT_STUNDENSATZ;
    saveDefaultRate(value);
  });

  document.getElementById("newOfferBtn").addEventListener("click", () => openEditor(null, null, "offerte"));
  document.getElementById("refreshBtn").addEventListener("click", refreshOffers);
  document.getElementById("closeEditor").addEventListener("click", closeEditor);
  document.getElementById("saveOfferBtn").addEventListener("click", saveCurrentOffer);
  document.getElementById("deleteOfferBtn").addEventListener("click", deleteCurrentOffer);
  document.getElementById("duplicateOfferBtn").addEventListener("click", () => {
    readHeaderFieldsIntoOffer();
    duplicateOffer(editingOffer);
  });
  document.getElementById("pdfOfferBtn").addEventListener("click", async () => {
    readHeaderFieldsIntoOffer();
    const resultEl = document.getElementById("editorResult");
    const btn = document.getElementById("pdfOfferBtn");
    btn.disabled = true;
    resultEl.textContent = "Erstellt PDF…";
    resultEl.className = "test-result";
    try {
      const { warnings } = await exportOfferPdf(editingOffer, absender, unterzeichnerConfig);
      resultEl.textContent = warnings.length ? `PDF erstellt · ${warnings.join(" ")}` : "PDF erstellt.";
      resultEl.className = warnings.length ? "test-result err" : "test-result ok";
    } catch (err) {
      resultEl.textContent = "Fehler: " + err.message;
      resultEl.className = "test-result err";
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById("inputTyp").addEventListener("change", (e) => {
    applyTypVisibility(e.target.value);
  });
  document.getElementById("inputProjektAuswahl").addEventListener("change", onProjektAuswahlChange);
  document.getElementById("addModBtn").addEventListener("click", () => {
    editingOffer.positionen.push({ typ: "modul", titel: "", beschrieb: [], stunden: 0, bemerkung: "", bemerkungAktiv: false, pauschalAktiv: false, pauschalBetrag: 0 });
    renderPositionen();
  });
  document.getElementById("addPhaseBtn").addEventListener("click", () => {
    editingOffer.positionen.push({ typ: "phase", titel: "" });
    renderPositionen();
  });
  document.getElementById("modSearchInput").addEventListener("input", (e) => {
    renderModSearchResults(searchModules(e.target.value), e.target.value);
  });

  document.getElementById("inputStundensatz").addEventListener("input", (e) => {
    editingOffer.stundensatz_chf = Number(e.target.value) || 0;
    recalcAll();
  });
  document.getElementById("inputMwstProzent").addEventListener("input", (e) => {
    editingOffer.mwst_prozent = Number(e.target.value) || 0;
    recalcTotalsDisplay();
  });
  document.getElementById("inputNebenkosten").addEventListener("input", (e) => {
    editingOffer.nebenkosten_chf = Number(e.target.value) || 0;
    recalcTotalsDisplay();
  });
  document.getElementById("inputNummerierung").addEventListener("change", (e) => {
    editingOffer.automatische_nummerierung = e.target.checked;
    renderPositionen();
  });

  window.addEventListener("online", refreshOffers);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { refreshOffers(); refreshProjectNames(); }
  });
  setInterval(refreshProjectNames, 60000);

  loadAbsender();
  loadUnterzeichnerConfig();
  refreshProjectNames();
  renderList();
  if (isConfigured()) refreshOffers();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
