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

// Aktuell im Editor offene Offerte (Arbeitskopie) und ihr Dateiname auf
// Nextcloud (null = noch nicht gespeichert, also eine neue Offerte).
let editingOffer = null;
let editingFilename = null;

// Index der gerade per Drag & Drop gezogenen Position (Modul oder Phase) in
// editingOffer.positionen -- null ausserhalb eines Drag-Vorgangs.
let dragFromIndex = null;

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
          return { filename, data };
        } catch (err) {
          console.warn("Konnte Offerte nicht laden:", filename, err);
          return null;
        }
      })
    );
    offers = loaded.filter(Boolean);
    saveJSON(LS_KEYS.cache, offers);
    line.textContent = `Synchronisiert · ${offers.length} Offerte(n)`;
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

function chDate(dateStr) {
  if (!dateStr) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return dateStr;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
function chNumber(n) {
  if (n === undefined || n === null || n === "") return "–";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  return (Math.round(num * 100) / 100).toLocaleString("de-CH");
}
function chFr(n) {
  if (n === undefined || n === null || n === "") return "–";
  return `${chNumber(n)} Fr.`;
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
    body.innerHTML = '<tr><td colspan="7">Noch keine Offerten geladen.</td></tr>';
    return;
  }

  const sorted = offers
    .map((o, i) => ({ o, i }))
    .sort((a, b) => String(b.o.data.datum || "").localeCompare(String(a.o.data.datum || "")));

  body.innerHTML = sorted
    .map(({ o, i }) => {
      const d = o.data;
      const total = calcTotals(d).total;
      const isRechnung = d.typ === "rechnung";
      return `<tr data-clickable data-index="${i}">
        <td>${escapeHtml(d.offert_nr || "–")}</td>
        <td>${escapeHtml(chDate(d.datum))}</td>
        <td><span class="typ-badge${isRechnung ? " rechnung" : ""}">${typLabel(d.typ)}</span></td>
        <td>${escapeHtml(d.projekt || o.filename)}</td>
        <td>${escapeHtml(d.empfaenger || "–")}</td>
        <td>${escapeHtml(chFr(total))}</td>
        <td class="row-actions">
          <button type="button" class="row-action" data-action="pdf" data-index="${i}" title="PDF erstellen">📄</button>
          <button type="button" class="row-action" data-action="duplicate" data-index="${i}" title="Duplizieren">⧉</button>
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

  body.querySelectorAll('[data-action="pdf"]').forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      btn.disabled = true;
      try {
        await exportOfferPdf(offers[idx].data, absender);
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
          stunden: Number(p.stunden) || 0,
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
        <span class="msr-meta">${escapeHtml(chNumber(m.stunden))} Std. · ${escapeHtml(m.projekt)}, ${escapeHtml(chDate(m.datum))}</span>
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
    stunden: m.stunden
  });
  document.getElementById("modSearchInput").value = "";
  renderModSearchResults([], "");
  renderPositionen();
}

// ---------- Berechnung ----------

function calcTotals(offer) {
  const rate = Number(offer.stundensatz_chf) || 0;
  const modulSumme = (offer.positionen || [])
    .filter((p) => p.typ === "modul")
    .reduce((sum, m) => sum + (Number(m.stunden) || 0) * rate, 0);
  const nebenkosten = Number(offer.nebenkosten_chf) || 0;
  const subtotal = modulSumme + nebenkosten;
  const mwstProzent = Number(offer.mwst_prozent) || 0;
  const mwst = subtotal * (mwstProzent / 100);
  return { modulSumme, nebenkosten, subtotal, mwst, total: subtotal + mwst };
}

// ---------- Rendering: Editor ----------

function blankOffer(typ) {
  return {
    typ: typ === "rechnung" ? "rechnung" : "offerte",
    empfaenger: "",
    adresse: "",
    projekt: "",
    datum: formatDate(new Date()),
    offert_nr: "",
    betreff: "",
    brieftext: "",
    stundensatz_chf: loadDefaultRate(),
    mwst_prozent: DEFAULT_MWST_PROZENT,
    nebenkosten_chf: 0,
    positionen: [{ typ: "modul", titel: "", beschrieb: [], stunden: 0 }]
  };
}

function typLabel(typ) {
  return typ === "rechnung" ? "Rechnung" : "Offerte";
}

// Blendet die rechnungsspezifischen Felder ein/aus und passt Titel/Labels an
// -- Offerte und Rechnung teilen sich sonst dasselbe Formular/Datenmodell.
function applyTypVisibility(typ) {
  const isRechnung = typ === "rechnung";
  document.getElementById("offertNrLabel").textContent = isRechnung ? "Rechnungs-Nr. (optional)" : "Offert-Nr. (optional)";
  document.getElementById("editorTitle").textContent = editingFilename ? `${typLabel(typ)} bearbeiten` : `Neue ${typLabel(typ)}`;
}

function openEditor(offer, filename, newTyp) {
  editingOffer = offer ? JSON.parse(JSON.stringify(offer)) : blankOffer(newTyp);
  editingFilename = filename || null;

  document.getElementById("inputTyp").value = editingOffer.typ || "offerte";
  applyTypVisibility(editingOffer.typ);
  document.getElementById("inputEmpfaenger").value = editingOffer.empfaenger || "";
  document.getElementById("inputAdresse").value = editingOffer.adresse || "";
  document.getElementById("inputProjekt").value = editingOffer.projekt || "";
  document.getElementById("inputDatum").value = editingOffer.datum || formatDate(new Date());
  document.getElementById("inputOffertNr").value = editingOffer.offert_nr || "";
  document.getElementById("inputStundensatz").value = editingOffer.stundensatz_chf;
  document.getElementById("inputMwstProzent").value = editingOffer.mwst_prozent;
  document.getElementById("inputNebenkosten").value = editingOffer.nebenkosten_chf || 0;
  document.getElementById("inputBetreff").value = editingOffer.betreff || "";
  document.getElementById("inputBrieftext").value = editingOffer.brieftext || "";
  document.getElementById("editorResult").textContent = "";
  document.getElementById("editorResult").className = "test-result";
  document.getElementById("deleteOfferBtn").style.display = filename ? "" : "none";
  document.getElementById("duplicateOfferBtn").style.display = filename ? "" : "none";
  document.getElementById("modSearchInput").value = "";
  renderModSearchResults([], "");

  renderPositionen();
  document.getElementById("editorOverlay").classList.remove("hidden");
}

function closeEditor() {
  document.getElementById("editorOverlay").classList.add("hidden");
  editingOffer = null;
  editingFilename = null;
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
      const kosten = (Number(p.stunden) || 0) * rate;
      return `<div class="mod-row" data-index="${i}">
        ${handle}
        <div class="mod-main">
          <div class="mod-title-row">
            <span class="mod-num">${modulNr})</span>
            <input type="text" class="mod-titel" data-field="titel" placeholder="Titel" value="${escapeHtml(p.titel || "")}">
          </div>
          <textarea class="mod-beschrieb" data-field="beschrieb" rows="2" placeholder="Ein Punkt pro Zeile">${escapeHtml(beschriebToText(p.beschrieb))}</textarea>
        </div>
        <div class="mod-stunden">
          <input type="number" class="no-spinner" data-field="stunden" min="0" step="0.25" value="${p.stunden ?? 0}">
          <span class="unit">Std.</span>
        </div>
        <div class="mod-kosten">${escapeHtml(chFr(kosten))}</div>
        <button type="button" class="mod-delete" data-action="delete" aria-label="Modul löschen">${TRASH_SVG}</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll(".mod-row, .phase-row").forEach((row) => {
    const index = parseInt(row.dataset.index, 10);

    row.querySelectorAll("[data-field]").forEach((el) => {
      const field = el.dataset.field;
      el.addEventListener("input", () => {
        if (field === "stunden") {
          positionen[index][field] = Number(el.value) || 0;
          recalcAll();
        } else if (field === "beschrieb") {
          positionen[index][field] = textToBeschrieb(el.value);
        } else {
          positionen[index][field] = el.value;
        }
      });
    });

    row.querySelector('[data-action="delete"]')?.addEventListener("click", () => removePosition(index));

    // Drag & Drop neu anordnen: der Griff startet den Drag, die ganze Zeile
    // ist Drop-Ziel (so lässt sich in Textfeldern trotzdem normal markieren).
    const handleEl = row.querySelector(".drag-handle");
    handleEl.addEventListener("dragstart", (e) => {
      dragFromIndex = index;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
      row.classList.add("dragging");
    });
    handleEl.addEventListener("dragend", () => {
      dragFromIndex = null;
      row.classList.remove("dragging");
      list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    });

    row.addEventListener("dragover", (e) => {
      if (dragFromIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragenter", (e) => {
      if (dragFromIndex === null || dragFromIndex === index) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (dragFromIndex === null || dragFromIndex === index) return;
      reorderPositionen(dragFromIndex, index);
    });
  });

  recalcTotalsDisplay();
}

// Verschiebt die Position an fromIndex so, dass sie direkt vor der Position
// landet, die aktuell bei toIndex steht (unabhängig von der Zugrichtung).
function reorderPositionen(fromIndex, toIndex) {
  const positionen = editingOffer.positionen;
  const [item] = positionen.splice(fromIndex, 1);
  const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
  positionen.splice(insertAt, 0, item);
  renderPositionen();
}

function removePosition(index) {
  const positionen = editingOffer.positionen;
  positionen.splice(index, 1);
  if (positionen.length === 0) positionen.push({ typ: "modul", titel: "", beschrieb: [], stunden: 0 });
  renderPositionen();
}

function recalcAll() {
  // Kosten pro Zeile neu anzeigen, ohne die Eingabefelder neu aufzubauen
  // (sonst verliert das gerade fokussierte Feld den Fokus beim Tippen).
  const rate = Number(editingOffer.stundensatz_chf) || 0;
  document.querySelectorAll("#modList .mod-row").forEach((row) => {
    const index = parseInt(row.dataset.index, 10);
    const p = editingOffer.positionen[index];
    const kosten = (Number(p.stunden) || 0) * rate;
    row.querySelector(".mod-kosten").textContent = chFr(kosten);
  });
  recalcTotalsDisplay();
}

function recalcTotalsDisplay() {
  const { subtotal, mwst, total } = calcTotals(editingOffer);
  document.getElementById("totalSubtotal").textContent = chFr(subtotal);
  document.getElementById("totalMwst").textContent = chFr(mwst);
  document.getElementById("totalFinal").textContent = chFr(total);
}

function readHeaderFieldsIntoOffer() {
  editingOffer.typ = document.getElementById("inputTyp").value === "rechnung" ? "rechnung" : "offerte";
  editingOffer.empfaenger = document.getElementById("inputEmpfaenger").value.trim();
  editingOffer.adresse = document.getElementById("inputAdresse").value.trim();
  editingOffer.projekt = document.getElementById("inputProjekt").value.trim();
  editingOffer.datum = document.getElementById("inputDatum").value || formatDate(new Date());
  editingOffer.offert_nr = document.getElementById("inputOffertNr").value.trim();
  editingOffer.stundensatz_chf = Number(document.getElementById("inputStundensatz").value) || 0;
  editingOffer.mwst_prozent = Number(document.getElementById("inputMwstProzent").value) || 0;
  editingOffer.nebenkosten_chf = Number(document.getElementById("inputNebenkosten").value) || 0;
  editingOffer.betreff = document.getElementById("inputBetreff").value.trim();
  editingOffer.brieftext = document.getElementById("inputBrieftext").value;
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
      await exportOfferPdf(editingOffer, absender);
      resultEl.textContent = "PDF erstellt.";
      resultEl.className = "test-result ok";
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
  document.getElementById("addModBtn").addEventListener("click", () => {
    editingOffer.positionen.push({ typ: "modul", titel: "", beschrieb: [], stunden: 0 });
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

  window.addEventListener("online", refreshOffers);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshOffers();
  });

  loadAbsender();
  renderList();
  if (isConfigured()) refreshOffers();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
