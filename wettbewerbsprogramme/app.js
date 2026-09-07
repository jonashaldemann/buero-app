/* ============================================================
   Wettbewerbsprogramme — mehrere strukturierte JSON-Zusammen-
   fassungen von Architekturwettbewerbs-Ausschreibungen hochladen,
   auf Nextcloud sichern (geräteübergreifend) und tabellarisch
   vergleichen.

   Nextcloud-Login, proxyFetch/authHeader/davPath, Einstellungen-UI
   usw. kommen aus ../shared/common.js (gemeinsam mit Zeiterfassung
   und Quittung).
   ============================================================ */

const LS_KEYS = {
  cache: "wettbewerb_cache" // zuletzt geladene Wettbewerbsprogramme (Offline-Fallback)
};

// Zielordner auf Nextcloud -- kein Jahresordner, da Wettbewerbe nicht
// zwingend jahresgebunden sind (Programm-Datum kann vom Upload-Jahr abweichen).
const WETTBEWERB_TARGET_FOLDER_PATH = "Buero/Admin/Wettbewerbsprogramme";

// { filename, data } -- data ist das geparste JSON.
let competitions = loadJSON(LS_KEYS.cache, []);

function wettbewerbSegments() {
  return ncSegments(WETTBEWERB_TARGET_FOLDER_PATH);
}

function ensureWettbewerbFolder() {
  return ensureFolderPath(wettbewerbSegments());
}

// Für "Verbindung testen": ein garantiert nicht existierender Dateiname im
// (zuvor angelegten) Zielordner -- 200 oder 404 sind beides ein Erfolg.
function pingRelPath() {
  return davPath([...wettbewerbSegments(), "_ping"].join("/"));
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';

async function listWettbewerbFilenames() {
  const relPath = davPath(wettbewerbSegments().join("/") + "/");
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

async function fetchCompetitionFile(filename) {
  const relPath = davPath([...wettbewerbSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (!res.ok) throw new Error(`${filename}: Status ${res.status}`);
  const text = await res.text();
  return JSON.parse(text);
}

async function refreshCompetitions() {
  const line = document.getElementById("syncLine");
  if (!isConfigured()) {
    line.textContent = "Nextcloud noch nicht eingerichtet · Einstellungen ⚙";
    renderTable();
    return;
  }
  if (!navigator.onLine) {
    line.textContent = "Offline · zeige zuletzt geladenen Stand";
    renderTable();
    return;
  }
  line.textContent = "Lädt…";
  try {
    await ensureWettbewerbFolder();
    const filenames = await listWettbewerbFilenames();
    const loaded = await Promise.all(
      filenames.map(async (filename) => {
        try {
          const data = await fetchCompetitionFile(filename);
          return { filename, data };
        } catch (err) {
          console.warn("Konnte Wettbewerbsdatei nicht laden:", filename, err);
          return null;
        }
      })
    );
    competitions = loaded.filter(Boolean);
    saveJSON(LS_KEYS.cache, competitions);
    line.textContent = `Synchronisiert · ${competitions.length} Programm(e)`;
  } catch (err) {
    console.warn("Wettbewerbsprogramme konnten nicht geladen werden:", err);
    line.textContent = "Fehler beim Laden · zeige zuletzt geladenen Stand";
  }
  renderTable();
}

function sanitizeJsonFilename(name) {
  let clean = name.trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) clean = `wettbewerb-${uid()}`;
  if (!clean.toLowerCase().endsWith(".json")) clean += ".json";
  return clean;
}

async function uploadCompetitionFiles(fileList) {
  const resultEl = document.getElementById("uploadResult");
  resultEl.textContent = "Lädt hoch…";
  resultEl.className = "test-result";

  if (!isConfigured()) {
    resultEl.textContent = "Bitte zuerst Nextcloud in den Einstellungen einrichten.";
    resultEl.className = "test-result err";
    return;
  }

  const files = Array.from(fileList);
  const errors = [];
  let okCount = 0;

  try {
    await ensureWettbewerbFolder();
  } catch (err) {
    resultEl.textContent = "Fehler: " + err.message;
    resultEl.className = "test-result err";
    return;
  }

  for (const file of files) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || !data.projektname) {
        throw new Error("kein gültiges Wettbewerbsprogramm (Feld \"projektname\" fehlt)");
      }
      const filename = sanitizeJsonFilename(file.name);
      const relPath = davPath([...wettbewerbSegments(), filename].join("/"));
      const putRes = await proxyFetch(relPath, {
        method: "PUT",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: text
      });
      if (!putRes.ok) throw new Error(`Hochladen fehlgeschlagen (${putRes.status})`);
      okCount++;
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  if (errors.length === 0) {
    resultEl.textContent = `${okCount} Datei(en) hochgeladen.`;
    resultEl.className = "test-result ok";
  } else {
    resultEl.textContent = `${okCount} ok, Fehler bei: ${errors.join("; ")}`;
    resultEl.className = "test-result err";
  }

  await refreshCompetitions();
}

async function deleteCompetition(filename) {
  const relPath = davPath([...wettbewerbSegments(), filename].join("/"));
  const res = await proxyFetch(relPath, { method: "DELETE", headers: authHeader() });
  if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
  competitions = competitions.filter((c) => c.filename !== filename);
  saveJSON(LS_KEYS.cache, competitions);
  renderTable();
}

// ---------- Formatierung ----------

function chDate(dateStr) {
  if (!dateStr) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return dateStr;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
function chDateTime(dateStr) {
  if (!dateStr) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dateStr);
  if (!m) return chDate(dateStr);
  return `${m[3]}.${m[2]}.${m[1]}, ${m[4]}:${m[5]}`;
}
function chNumber(n) {
  if (n === undefined || n === null || n === "") return "–";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  return num.toLocaleString("de-CH");
}
function chCurrency(n) {
  if (n === undefined || n === null || n === "") return "–";
  return `CHF ${chNumber(n)}`;
}
function get(obj, path, fallback) {
  return path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? fallback;
}

// ---------- Rendering ----------

function renderTable() {
  document.getElementById("countLabel").textContent = String(competitions.length);
  const body = document.getElementById("wettbewerbBody");

  if (competitions.length === 0) {
    body.innerHTML = '<tr><td colspan="7">Noch keine Wettbewerbsprogramme geladen.</td></tr>';
    return;
  }

  body.innerHTML = competitions
    .map((c, i) => {
      const d = c.data;
      const groesse = [d.groesse?.hnf_m2, d.groesse?.gf_m2].map((v) => (v === undefined ? "–" : chNumber(v))).join(" / ");
      return `<tr data-clickable data-index="${i}">
        <td>${escapeHtml(d.projektname || c.filename)}</td>
        <td>${escapeHtml(get(d, "auftraggeber.name", "–"))}</td>
        <td>${escapeHtml(chCurrency(get(d, "bausumme.betrag_chf")))}</td>
        <td>${escapeHtml(groesse)}</td>
        <td>${escapeHtml(chCurrency(get(d, "preisgeld.gesamtsumme_chf")))}</td>
        <td>${escapeHtml(chDateTime(get(d, "termine.abgabe_plaene")))}</td>
        <td>${escapeHtml(String(get(d, "preisgeld.anzahl_preise", "–")))}</td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("tr[data-clickable]").forEach((tr) => {
    tr.addEventListener("click", () => openDetail(parseInt(tr.dataset.index, 10)));
  });
}

function detailRow(label, value) {
  return `<li><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value)}</span></li>`;
}

function renderPersonList(list) {
  if (!Array.isArray(list) || list.length === 0) return "<p class=\"hint\">–</p>";
  return (
    '<ul class="plain">' +
    list
      .map((p) => {
        if (typeof p === "string") return `<li>${escapeHtml(p)}</li>`;
        const parts = [p.name, p.funktion, p.rolle].filter(Boolean).join(" – ");
        return `<li>${escapeHtml(parts)}</li>`;
      })
      .join("") +
    "</ul>"
  );
}

function openDetail(index) {
  const c = competitions[index];
  if (!c) return;
  const d = c.data;

  document.getElementById("detailTitle").textContent = d.projektname || c.filename;

  const html = `
    <ul class="detail-list">
      ${detailRow("Auftraggeber", get(d, "auftraggeber.name", "–"))}
      ${detailRow("Adresse", get(d, "auftraggeber.adresse", "–"))}
      ${detailRow("Verfahrensart", d.verfahrensart_detail || d.stufigkeit || "–")}
      ${detailRow("Offenes Verfahren", d.offenes_verfahren === undefined ? "–" : d.offenes_verfahren ? "Ja" : "Nein")}
      ${detailRow("Programmdatum", chDate(d.datum_programm))}
      ${detailRow("HNF / GF (m²)", `${chNumber(get(d, "groesse.hnf_m2"))} / ${chNumber(get(d, "groesse.gf_m2"))}`)}
      ${detailRow("Bausumme", chCurrency(get(d, "bausumme.betrag_chf")) + (get(d, "bausumme.bkp") ? ` (BKP ${d.bausumme.bkp})` : ""))}
      ${detailRow("Abgabe Pläne", chDateTime(get(d, "termine.abgabe_plaene")))}
      ${detailRow("Abgabe Modell", chDateTime(get(d, "termine.abgabe_modell")))}
      ${detailRow("Preisgeld", chCurrency(get(d, "preisgeld.gesamtsumme_chf")) + (d.preisgeld?.mwst ? ` (${d.preisgeld.mwst})` : ""))}
      ${detailRow("Anzahl Preise", get(d, "preisgeld.anzahl_preise", "–"))}
      ${detailRow("Ankäufe max. Anteil", get(d, "preisgeld.ankaeufe_max_anteil_prozent") !== undefined ? `${d.preisgeld.ankaeufe_max_anteil_prozent}%` : "–")}
      ${detailRow("Modelldepot", chCurrency(get(d, "modelldepot.betrag_chf")))}
      ${detailRow("Verfahrenssekretariat", get(d, "verfahrenssekretariat.stelle", "–"))}
      ${detailRow("Ansprechperson", get(d, "verfahrenssekretariat.ansprechperson", "–"))}
      ${detailRow("E-Mail", get(d, "verfahrenssekretariat.email", "–"))}
    </ul>

    ${d.aufgabe_kurzbeschrieb ? `<div class="detail-block"><h3>Aufgabe</h3><p class="hint">${escapeHtml(d.aufgabe_kurzbeschrieb)}</p></div>` : ""}

    ${Array.isArray(d.zwingend_beizuziehende_planer) && d.zwingend_beizuziehende_planer.length
      ? `<div class="detail-block"><h3>Zwingend beizuziehende Planer</h3>${renderPersonList(d.zwingend_beizuziehende_planer)}</div>`
      : ""}

    <div class="detail-block"><h3>Sachjury</h3>${renderPersonList(d.sachjury)}</div>
    <div class="detail-block"><h3>Fachjury</h3>${renderPersonList(d.fachjury)}</div>
    ${Array.isArray(d.experten_ohne_stimmrecht) && d.experten_ohne_stimmrecht.length
      ? `<div class="detail-block"><h3>Experten ohne Stimmrecht</h3>${renderPersonList(d.experten_ohne_stimmrecht)}</div>`
      : ""}

    <p class="hint">Quelle: ${escapeHtml(d.quelldokument || c.filename)}</p>
  `;
  document.getElementById("detailBody").innerHTML = html;

  const deleteBtn = document.getElementById("deleteWettbewerbBtn");
  deleteBtn.onclick = async () => {
    if (!confirm(`"${d.projektname || c.filename}" wirklich löschen?`)) return;
    deleteBtn.disabled = true;
    try {
      await deleteCompetition(c.filename);
      closeDetail();
    } catch (err) {
      alert("Fehler beim Löschen: " + err.message);
    } finally {
      deleteBtn.disabled = false;
    }
  };

  document.getElementById("detailOverlay").classList.remove("hidden");
}

function closeDetail() {
  document.getElementById("detailOverlay").classList.add("hidden");
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: pingRelPath,
    ensureFolderFn: ensureWettbewerbFolder,
    onSaved: refreshCompetitions
  });

  document.getElementById("closeDetail").addEventListener("click", closeDetail);
  document.getElementById("refreshBtn").addEventListener("click", refreshCompetitions);
  document.getElementById("uploadInput").addEventListener("change", (e) => {
    if (e.target.files.length > 0) uploadCompetitionFiles(e.target.files);
    e.target.value = "";
  });

  window.addEventListener("online", refreshCompetitions);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshCompetitions();
  });

  renderTable();
  if (isConfigured()) refreshCompetitions();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
