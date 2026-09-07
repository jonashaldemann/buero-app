/* ============================================================
   Offerten — Offerten aus Modulen zusammenstellen (Titel,
   Kurzbeschrieb, Stunden, Kosten = Stunden x Stundensatz),
   Module hoch-/runterschieben, Zwischentotal/MWST/Total berechnen,
   auf Nextcloud sichern (geräteübergreifend verfügbar).

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
    body.innerHTML = '<tr><td colspan="4">Noch keine Offerten geladen.</td></tr>';
    return;
  }

  const sorted = offers
    .map((o, i) => ({ o, i }))
    .sort((a, b) => String(b.o.data.datum || "").localeCompare(String(a.o.data.datum || "")));

  body.innerHTML = sorted
    .map(({ o, i }) => {
      const d = o.data;
      const total = calcTotals(d).total;
      return `<tr data-clickable data-index="${i}">
        <td>${escapeHtml(chDate(d.datum))}</td>
        <td>${escapeHtml(d.projekt || o.filename)}</td>
        <td>${escapeHtml(d.empfaenger || "–")}</td>
        <td>${escapeHtml(chFr(total))}</td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("tr[data-clickable]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.index, 10);
      openEditor(offers[idx].data, offers[idx].filename);
    });
  });
}

// ---------- Berechnung ----------

function calcTotals(offer) {
  const rate = Number(offer.stundensatz_chf) || 0;
  const subtotal = (offer.module || []).reduce((sum, m) => sum + (Number(m.stunden) || 0) * rate, 0);
  const mwstProzent = Number(offer.mwst_prozent) || 0;
  const mwst = subtotal * (mwstProzent / 100);
  return { subtotal, mwst, total: subtotal + mwst };
}

// ---------- Rendering: Editor ----------

function blankOffer() {
  return {
    empfaenger: "",
    adresse: "",
    projekt: "",
    datum: formatDate(new Date()),
    offert_nr: "",
    stundensatz_chf: loadDefaultRate(),
    mwst_prozent: DEFAULT_MWST_PROZENT,
    module: [{ titel: "", beschrieb: "", stunden: 0 }]
  };
}

function openEditor(offer, filename) {
  editingOffer = offer ? JSON.parse(JSON.stringify(offer)) : blankOffer();
  editingFilename = filename || null;

  document.getElementById("editorTitle").textContent = filename ? "Offerte bearbeiten" : "Neue Offerte";
  document.getElementById("inputEmpfaenger").value = editingOffer.empfaenger || "";
  document.getElementById("inputAdresse").value = editingOffer.adresse || "";
  document.getElementById("inputProjekt").value = editingOffer.projekt || "";
  document.getElementById("inputDatum").value = editingOffer.datum || formatDate(new Date());
  document.getElementById("inputOffertNr").value = editingOffer.offert_nr || "";
  document.getElementById("inputStundensatz").value = editingOffer.stundensatz_chf;
  document.getElementById("inputMwstProzent").value = editingOffer.mwst_prozent;
  document.getElementById("editorResult").textContent = "";
  document.getElementById("editorResult").className = "test-result";
  document.getElementById("deleteOfferBtn").style.display = filename ? "" : "none";

  renderModules();
  document.getElementById("editorOverlay").classList.remove("hidden");
}

function closeEditor() {
  document.getElementById("editorOverlay").classList.add("hidden");
  editingOffer = null;
  editingFilename = null;
}

function renderModules() {
  const list = document.getElementById("modList");
  const rate = Number(editingOffer.stundensatz_chf) || 0;

  list.innerHTML = editingOffer.module
    .map((m, i) => {
      const kosten = (Number(m.stunden) || 0) * rate;
      return `<div class="mod-row" data-index="${i}">
        <div class="mod-arrows">
          <button type="button" class="mod-arrow" data-action="up" ${i === 0 ? "disabled" : ""} aria-label="Nach oben">▲</button>
          <button type="button" class="mod-arrow" data-action="down" ${i === editingOffer.module.length - 1 ? "disabled" : ""} aria-label="Nach unten">▼</button>
        </div>
        <div class="mod-main">
          <div class="mod-title-row">
            <span class="mod-num">${i + 1})</span>
            <input type="text" class="mod-titel" data-field="titel" placeholder="Titel" value="${escapeHtml(m.titel || "")}">
          </div>
          <textarea class="mod-beschrieb" data-field="beschrieb" rows="2" placeholder="Kurzbeschrieb">${escapeHtml(m.beschrieb || "")}</textarea>
        </div>
        <div class="mod-stunden">
          <input type="number" data-field="stunden" min="0" step="0.25" value="${m.stunden ?? 0}">
          <span class="unit">Std.</span>
        </div>
        <div class="mod-kosten">${escapeHtml(chFr(kosten))}</div>
        <button type="button" class="mod-delete" data-action="delete" aria-label="Modul löschen">✕</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll(".mod-row").forEach((row) => {
    const index = parseInt(row.dataset.index, 10);

    row.querySelectorAll("[data-field]").forEach((el) => {
      const field = el.dataset.field;
      el.addEventListener("input", () => {
        editingOffer.module[index][field] = field === "stunden" ? Number(el.value) || 0 : el.value;
        if (field === "stunden") recalcAll();
      });
    });

    row.querySelector('[data-action="up"]')?.addEventListener("click", () => moveModule(index, -1));
    row.querySelector('[data-action="down"]')?.addEventListener("click", () => moveModule(index, 1));
    row.querySelector('[data-action="delete"]')?.addEventListener("click", () => removeModule(index));
  });

  recalcTotalsDisplay();
}

function moveModule(index, dir) {
  const target = index + dir;
  if (target < 0 || target >= editingOffer.module.length) return;
  const [item] = editingOffer.module.splice(index, 1);
  editingOffer.module.splice(target, 0, item);
  renderModules();
}

function removeModule(index) {
  editingOffer.module.splice(index, 1);
  if (editingOffer.module.length === 0) editingOffer.module.push({ titel: "", beschrieb: "", stunden: 0 });
  renderModules();
}

function recalcAll() {
  // Kosten pro Zeile neu anzeigen, ohne die Eingabefelder neu aufzubauen
  // (sonst verliert das gerade fokussierte Feld den Fokus beim Tippen).
  const rate = Number(editingOffer.stundensatz_chf) || 0;
  document.querySelectorAll("#modList .mod-row").forEach((row) => {
    const index = parseInt(row.dataset.index, 10);
    const m = editingOffer.module[index];
    const kosten = (Number(m.stunden) || 0) * rate;
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
  editingOffer.empfaenger = document.getElementById("inputEmpfaenger").value.trim();
  editingOffer.adresse = document.getElementById("inputAdresse").value.trim();
  editingOffer.projekt = document.getElementById("inputProjekt").value.trim();
  editingOffer.datum = document.getElementById("inputDatum").value || formatDate(new Date());
  editingOffer.offert_nr = document.getElementById("inputOffertNr").value.trim();
  editingOffer.stundensatz_chf = Number(document.getElementById("inputStundensatz").value) || 0;
  editingOffer.mwst_prozent = Number(document.getElementById("inputMwstProzent").value) || 0;
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

  const filename = editingFilename || sanitizeJsonFilename(`${editingOffer.datum} ${editingOffer.projekt}`);

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

  document.getElementById("newOfferBtn").addEventListener("click", () => openEditor(null, null));
  document.getElementById("refreshBtn").addEventListener("click", refreshOffers);
  document.getElementById("closeEditor").addEventListener("click", closeEditor);
  document.getElementById("saveOfferBtn").addEventListener("click", saveCurrentOffer);
  document.getElementById("deleteOfferBtn").addEventListener("click", deleteCurrentOffer);
  document.getElementById("addModBtn").addEventListener("click", () => {
    editingOffer.module.push({ titel: "", beschrieb: "", stunden: 0 });
    renderModules();
  });

  document.getElementById("inputStundensatz").addEventListener("input", (e) => {
    editingOffer.stundensatz_chf = Number(e.target.value) || 0;
    recalcAll();
  });
  document.getElementById("inputMwstProzent").addEventListener("input", (e) => {
    editingOffer.mwst_prozent = Number(e.target.value) || 0;
    recalcTotalsDisplay();
  });

  window.addEventListener("online", refreshOffers);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshOffers();
  });

  renderList();
  if (isConfigured()) refreshOffers();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
