/* ============================================================
   Quittung — Beleg erfassen (Foto/PDF -> Nextcloud + Banana-Import)
   Anders als bei "Nachtragen" in der Zeiterfassung braucht dieser
   Ablauf zwingend eine Online-Verbindung: die nächste Belegnummer
   wird aus dem aktuellen Ordnerinhalt ermittelt (PROPFIND), es gibt
   also keine Offline-Queue.

   Nextcloud-Login, proxyFetch/authHeader/davPath, Einstellungen-UI
   usw. kommen aus ../shared/common.js (gemeinsam mit Zeiterfassung
   und Wettbewerbsprogramme).
   ============================================================ */

const LS_KEYS = {
  kontenCache: "zeit_konten_cache",         // letzter bekannter Kontenplan (Offline-Fallback)
  kategorienCache: "zeit_kategorien_cache", // letzte bekannten Kategorien (Offline-Fallback)
  mwstCache: "zeit_mwst_cache"               // letzte bekannten MwSt/USt-Codes (Offline-Fallback)
};

// Zielordner für gescannte Belege (Quittungen/Rechnungen). Das aktuelle Jahr
// wird automatisch als letzte Ebene angehängt (siehe receiptDavSegments()),
// z.B. "Buero/Admin/Finanzen/2026".
const RECEIPT_TARGET_FOLDER_PATH = "Buero/Admin/Finanzen";

// Kontenplan/Kategorien/MwSt-Codes werden zur Laufzeit aus konten.txt,
// kategorien.txt und mwst.txt geladen (gleicher Origin wie die App, also per
// simplem fetch() -- kein Nextcloud-Proxy nötig). Diese Dateien exportierst
// du bei Bedarf neu aus Banana (siehe README, Abschnitt "Beleg erfassen") und
// committest/pushst sie -- dann übernimmt die App die Änderung automatisch,
// ohne Code-Update. Die Konstanten hier sind nur der Offline-Fallback, falls
// die Dateien beim allerersten Start (noch kein localStorage-Cache) nicht
// erreichbar sind.
const FALLBACK_KONTEN = [
  ["1000", "Kasse"],
  ["1010", "Postkonto"],
  ["1020", "Bankkonto"],
  ["1100", "Forderungen gegenüber Dritten"],
  ["1110", "Forderungen gegenüber Beteiligung (Debitoren)"],
  ["1170", "Modelldepot Wettbewerbe"],
  ["1176", "Guthaben Verrechnungssteuer"],
  ["1500", "Maschinen und Apparate"],
  ["1510", "Mobiliar und Einrichtungen"],
  ["1520", "Bürogeräte"],
  ["2000", "Verbindlichkeiten für Material- und Warenaufwand"],
  ["2001", "Verrechnungskonto Manuel"],
  ["2002", "Verrechnungskonto Jonas"],
  ["2200", "Geschuldete MWST (Umsatzsteuer)"],
  ["2201", "Abrechnungskonto MWST"],
  ["2400", "Bankverbindlichkeiten langfristig"]
];

const FALLBACK_KATEGORIEN = {
  "Erlöse": [
    ["3000", "Bruttoerlöse Verkäufe"],
    ["3000.007", "007 Herrliberg Honorare"],
    ["3000.015", "015 Studienauftrag Rothrist Honorare"],
    ["3000.016", "016 Bürglenstrasse Honorare"],
    ["3090", "Aktive Skonti"],
    ["3400", "Bruttoerlöse Dienstleistungen"],
    ["3490", "Skonti auf Dienstleistungsertrag"],
    ["3680", "Sonstige Erlöse"]
  ],
  "Aufwände": [
    ["4000", "Einkäufe"],
    ["4090", "Passive Skonti"],
    ["4401.018", "018 Bönigen Nebenkosten nicht verrechenbar"],
    ["5000", "Löhne"],
    ["5700", "Sozialversicherungen"],
    ["5790", "Quellensteuer"],
    ["5820", "Reisespesen"],
    ["5880", "Sonstiger Personalaufwand"],
    ["5900", "Leistungen Dritter"],
    ["6000", "Mietzins"],
    ["6100", "Unterhalt, Reparaturen, Ersatz (URE) Maschinen und Apparate"],
    ["6210", "Benzin"],
    ["6300", "Versicherungen"],
    ["6360", "Abgaben und Gebühren"],
    ["6400", "Elektrizität"],
    ["6420", "Heizung"],
    ["6430", "Wasser"],
    ["6460", "Kehrichtabfuhr"],
    ["6500", "Büromaterial"],
    ["6503", "Fachzeitschriften & Fachliteratur"],
    ["6510", "Telefon"],
    ["6512", "Internet"],
    ["6513", "Porti (Brief- und Paketsendungen)"],
    ["6601", "Webesite & Online-Werbung"],
    ["6650.000", "Akquisition: Präqualis und Werbeversand"],
    ["6650.015", "Akquisition 015 Studienauftrag Rothrist"],
    ["6650.019", "Akquisition 019 Wettbewerb Lausanne"],
    ["6650.020", "Akquisition 020 Villars-sur-Glâne"],
    ["6651", "Abgeschriebene Modelldepots"],
    ["6700", "Buchführungs- und Beratungsaufwand"],
    ["6800", "Abschreibungen und Wertberichtigungen auf Positionen des Anlagevermögens"],
    ["6900", "Finanzaufwand"],
    ["8900", "Steuern"]
  ]
};

// Nur die aktuell gültigen Sätze (0/2.6/3.8/8.1%) -- die alten Sätze
// (7.7/2.5/3.7%, bis Ende 2023) sowie Spezialfälle (Bezugsteuer B*,
// Saldosteuersatz F*/FS*, Korrekturen K*) sind bewusst nicht dabei, um die
// Auswahl kurz zu halten. V-Codes = Umsatzsteuer (Verkauf/Einnahme),
// M-/I-Codes = Vorsteuer (Ausgabe): M = Material- und Dienstleistungsaufwand,
// I = Investition und Betriebsaufwand. Diese Zuordnung (welche Codes es gibt
// und ob sie zu Einnahme oder Ausgabe gehören) ist hart hinterlegt, weil
// mwst.txt (Banana-Referenzliste) sich praktisch nie ändert; nur die
// Beschreibungstexte werden live aus mwst.txt übernommen.
const MWST_EINNAHME_CODES = ["V0", "V0-N", "V26", "V38", "V81"];
const MWST_AUSGABE_CODES = ["M0", "M26", "M38", "M81", "I0", "I26", "I38", "I81"];
const FALLBACK_MWST_CODES = {
  Einnahme: [
    ["V0", "V0 – Von der Steuer befreite Leistungen, u.a. Exporte (220)"],
    ["V0-N", "V0-N – Nicht steuerbare Leistungen (230)"],
    ["V26", "V26 – Verkauf und Dienstleistungen 2.6%"],
    ["V38", "V38 – Verkauf und Dienstleistungen 3.8%"],
    ["V81", "V81 – Verkauf und Dienstleistungen 8.1%"]
  ],
  Ausgabe: [
    ["M0", "M0 – Befreite Material- und Dienstleistungsaufwand"],
    ["M26", "M26 – Material-/Dienstleistungsaufwand 2.6%"],
    ["M38", "M38 – Material-/Dienstleistungsaufwand 3.8%"],
    ["M81", "M81 – Material-/Dienstleistungsaufwand 8.1% (inkl. MwSt/USt)"],
    ["I0", "I0 – Befreite Investition und Betriebsaufwand"],
    ["I26", "I26 – Investition/Betriebsaufwand 2.6%"],
    ["I38", "I38 – Investition/Betriebsaufwand 3.8%"],
    ["I81", "I81 – Investition/Betriebsaufwand 8.1%"]
  ]
};

let KONTEN = loadJSON(LS_KEYS.kontenCache, FALLBACK_KONTEN);
let KATEGORIEN = loadJSON(LS_KEYS.kategorienCache, FALLBACK_KATEGORIEN);
let MWST_CODES = loadJSON(LS_KEYS.mwstCache, FALLBACK_MWST_CODES);

// Tab-getrennte Zeilen "Code<TAB>Beschreibung" -- Zeilen ohne Code (leer oder
// nur Überschrift/Total-Zeile aus dem Banana-Export) werden übersprungen.
function parseFlatCodeList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter(([code]) => (code || "").trim() !== "")
    .map(([code, label]) => [code.trim(), (label || "").trim()]);
}

// Wie parseFlatCodeList, aber Zeilen ohne Code, deren Text auf eine der
// übergebenen Gruppen-Überschriften passt (z.B. "ERLÖSE"), starten eine neue
// Gruppe -- andere Zeilen ohne Code (Leerzeilen, "TOTAL ...", u.ä.) sind
// Rauschen aus dem Export und werden ignoriert.
function parseGroupedCodeList(text, groupLabels) {
  const groups = {};
  let current = null;
  text.split(/\r?\n/).forEach((line) => {
    const [rawCode, rawLabel] = line.split("\t");
    const code = (rawCode || "").trim();
    const label = (rawLabel || "").trim();
    if (code) {
      if (current) groups[current].push([code, label]);
      return;
    }
    if (groupLabels[label]) {
      current = groupLabels[label];
      if (!groups[current]) groups[current] = [];
    }
  });
  return groups;
}

const KATEGORIEN_GROUP_LABELS = { "ERLÖSE": "Erlöse", "AUFWÄNDE": "Aufwände" };

function buildMwstCodes(flatList) {
  const map = {};
  flatList.forEach(([code, label]) => {
    map[code] = label;
  });
  const pick = (codes) => codes.filter((c) => map[c]).map((c) => [c, `${c} – ${map[c]}`]);
  return { Einnahme: pick(MWST_EINNAHME_CODES), Ausgabe: pick(MWST_AUSGABE_CODES) };
}

// Lädt konten.txt/kategorien.txt/mwst.txt vom eigenen Origin (gleiches Repo,
// per GitHub Pages ausgeliefert) -- kein Nextcloud-Proxy nötig, da same-origin.
// {cache:"no-cache"} erzwingt eine Revalidierung, damit frisch gepushte
// Änderungen nicht durch den Browser-Cache verzögert werden.
async function refreshReceiptMasterData() {
  try {
    const [kontenText, kategorienText, mwstText] = await Promise.all(
      ["konten.txt", "kategorien.txt", "mwst.txt"].map((path) =>
        fetch(path, { cache: "no-cache" }).then((res) => {
          if (!res.ok) throw new Error(`${path}: Status ${res.status}`);
          return res.text();
        })
      )
    );

    KONTEN = parseFlatCodeList(kontenText);
    KATEGORIEN = parseGroupedCodeList(kategorienText, KATEGORIEN_GROUP_LABELS);
    MWST_CODES = buildMwstCodes(parseFlatCodeList(mwstText));

    saveJSON(LS_KEYS.kontenCache, KONTEN);
    saveJSON(LS_KEYS.kategorienCache, KATEGORIEN);
    saveJSON(LS_KEYS.mwstCache, MWST_CODES);
  } catch (err) {
    // Offline oder Datei (noch) nicht erreichbar -> zuletzt bekannter Stand
    // (aus localStorage bzw. Fallback-Konstanten) bleibt aktiv.
    console.warn("Kontenplan/Kategorien/MwSt-Codes konnten nicht geladen werden:", err);
  }
}

function receiptDavSegments() {
  const year = new Date().getFullYear();
  return [...ncSegments(RECEIPT_TARGET_FOLDER_PATH), String(year)];
}

function ensureReceiptFolder() {
  return ensureFolderPath(receiptDavSegments());
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';

async function listReceiptFolderFilenames() {
  const relPath = davPath(receiptDavSegments().join("/") + "/");
  const res = await proxyFetch(relPath, {
    method: "PROPFIND",
    headers: { ...authHeader(), Depth: "1", "Content-Type": "application/xml" },
    body: PROPFIND_LIST_BODY
  });
  if (!res.ok) throw new Error(`Ordnerinhalt lesen fehlgeschlagen (${res.status})`);
  const xmlText = await res.text();
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const hrefs = Array.from(doc.getElementsByTagNameNS("DAV:", "href")).map((el) => el.textContent);
  return hrefs.map((href) => decodeURIComponent(href.replace(/\/$/, "").split("/").pop() || "")).filter(Boolean);
}

// Belegnummer-Schema: [JJ]-[A|E][NNN], z.B. "26-A003" -- JJ = aktuelles Jahr
// (2-stellig), A/E = Ausgabe/Einnahme, NNN = dreistellig fortlaufend, je
// getrennt gezählt pro Jahr UND Typ (A und E haben je eigene Zählung).
function belegPrefix(typ) {
  const yy = String(new Date().getFullYear()).slice(-2);
  const letter = typ === "Einnahme" ? "E" : "A";
  return `${yy}-${letter}`;
}

async function nextBelegnummer(typ) {
  const filenames = await listReceiptFolderFilenames();
  const prefix = belegPrefix(typ);
  const re = new RegExp(`^${prefix}(\\d{3})`);
  let max = 0;
  filenames.forEach((name) => {
    const m = re.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function sanitizeForFilename(s) {
  return s.trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").slice(0, 15).trim();
}

function fileExtension(file) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(file.name);
  if (m) return m[1].toLowerCase();
  return file.type === "application/pdf" ? "pdf" : "jpg";
}

// ---------- Foto -> PDF (Fotos werden vor der Ablage vereinheitlicht) ----------
// Kein PDF-Build nötig: Canvas re-encodiert das Bild als JPEG, das dann roh
// (DCTDecode) in ein von Hand zusammengesetztes Ein-Bild-PDF eingebettet wird.

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Bild konnte nicht geladen werden."));
    img.src = dataUrl;
  });
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Baut ein minimales, gültiges Ein-Seiten-PDF (A4, Bild zentriert und
// eingepasst) direkt aus JPEG-Bytes -- ohne externe Bibliothek.
function buildSingleImagePdf(jpegBytes, imgWidthPx, imgHeightPx) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const objOffset = {};

  function push(bytes) {
    chunks.push(bytes);
    offset += bytes.length;
  }
  function pushText(s) {
    push(enc.encode(s));
  }

  const A4_W = 595.28;
  const A4_H = 841.89;
  const landscape = imgWidthPx > imgHeightPx;
  const pageW = landscape ? A4_H : A4_W;
  const pageH = landscape ? A4_W : A4_H;
  const margin = 20;
  const scale = Math.min((pageW - margin * 2) / imgWidthPx, (pageH - margin * 2) / imgHeightPx);
  const drawW = imgWidthPx * scale;
  const drawH = imgHeightPx * scale;
  const x = (pageW - drawW) / 2;
  const y = (pageH - drawH) / 2;

  pushText("%PDF-1.4\n");

  objOffset[1] = offset;
  pushText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  objOffset[2] = offset;
  pushText("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  objOffset[3] = offset;
  pushText(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
      "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
  );

  objOffset[4] = offset;
  pushText(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgWidthPx} /Height ${imgHeightPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  push(jpegBytes);
  pushText("\nendstream\nendobj\n");

  const content = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ`;
  objOffset[5] = offset;
  pushText(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefOffset = offset;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    xref += String(objOffset[i]).padStart(10, "0") + " 00000 n \n";
  }
  pushText(xref);
  pushText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(chunks, { type: "application/pdf" });
}

async function imageFileToPdfBlob(file) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImageElement(dataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);

  const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.9);
  const jpegBytes = base64ToUint8Array(jpegDataUrl.split(",")[1]);

  return buildSingleImagePdf(jpegBytes, canvas.width, canvas.height);
}

// Banana kann kein CSV importieren, sondern nur das eigene generische
// TXT-Format "Bewegungen Einnahmen-Ausgaben" (tab-getrennt, feste englische
// Spaltennamen unabhängig von der Banana-UI-Sprache):
// https://www.banana.ch/doc/en/node/9946
// Date(yyyy-mm-dd) Description Income Expenses Doc Category Account VatCode
// (die offizielle Doku nennt die Spalten "DocInvoice"/"ContraAccount", im
// tatsächlichen Import-Dialog heissen sie aber "Doc"/"Category" --
// getestet/bestätigt, buchungen.txt importiert damit korrekt.)
const BANANA_TXT_HEADER = "Date\tDescription\tIncome\tExpenses\tDoc\tCategory\tAccount\tVatCode";

// Tabs/Zeilenumbrüche killen, da das Format (anders als CSV) kein Quoting
// für eingebettete Tabs kennt -- sonst würde die Spaltenstruktur brechen.
function tsvField(v) {
  return String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function bananaTxtRelativePath() {
  // Der Ordner ist bereits pro Jahr getrennt (receiptDavSegments()) --
  // deshalb hier kein zusätzliches Jahr im Dateinamen nötig.
  return davPath([...receiptDavSegments(), "buchungen.txt"].join("/"));
}

async function appendBananaBooking(entry) {
  const relPath = bananaTxtRelativePath();
  let existingText = "";
  const getRes = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
  if (getRes.status === 200) {
    existingText = await getRes.text();
  } else if (getRes.status === 404) {
    existingText = BANANA_TXT_HEADER + "\n";
  } else {
    throw new Error(`Buchungsdatei lesen fehlgeschlagen (${getRes.status})`);
  }

  const amountStr = entry.amount.toFixed(2);
  const row = [
    entry.date,
    entry.purpose,
    entry.typ === "Einnahme" ? amountStr : "",
    entry.typ === "Ausgabe" ? amountStr : "",
    entry.belegnummer,
    entry.kategorie,
    entry.konto,
    entry.mwst
  ].map(tsvField).join("\t");

  const updated = existingText.replace(/\n?$/, "\n") + row + "\n";

  const putRes = await proxyFetch(relPath, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "text/plain" },
    body: updated
  });
  if (!putRes.ok) throw new Error(`Buchung schreiben fehlgeschlagen (${putRes.status})`);
}

// Passende MwSt/USt-Codes je nach Einnahme/Ausgabe -- Umsatzsteuer- und
// Vorsteuer-Codes schliessen sich in Banana gegenseitig aus.
function renderReceiptMwstOptions(typ) {
  const mwstSelect = document.getElementById("receiptMwst");
  const codes = MWST_CODES[typ] || [];
  mwstSelect.innerHTML = codes.map(([code, label]) => `<option value="${escapeHtml(code)}">${escapeHtml(label)}</option>`).join("");
  mwstSelect.value = typ === "Einnahme" ? "V81" : "M81";
}

// Kategorie zeigt nur die zum gewählten Typ passende Gruppe -- Ausgabe nur
// Aufwände, Einnahme nur Erlöse, statt beider Gruppen gemischt.
const KATEGORIE_GROUP_FOR_TYP = { Einnahme: "Erlöse", Ausgabe: "Aufwände" };

function renderReceiptKategorieOptions(typ) {
  const kategorieSelect = document.getElementById("receiptKategorie");
  const items = KATEGORIEN[KATEGORIE_GROUP_FOR_TYP[typ]] || [];
  kategorieSelect.innerHTML =
    '<option value="">– wählen –</option>' +
    items.map(([code, label]) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} – ${escapeHtml(label)}</option>`).join("");
}

function renderReceiptSelects() {
  const kontoSelect = document.getElementById("receiptKonto");
  kontoSelect.innerHTML =
    '<option value="">– wählen –</option>' +
    KONTEN.map(([code, label]) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} – ${escapeHtml(label)}</option>`).join("");
}

function onReceiptTypChange(e) {
  renderReceiptMwstOptions(e.target.value);
  renderReceiptKategorieOptions(e.target.value);
}

function openReceiptEntry() {
  renderReceiptSelects(); // Konto-Dropdown mit dem aktuell bekannten Stand neu aufbauen
  document.getElementById("receiptFile").value = "";
  document.getElementById("receiptFileName").textContent = "";
  document.getElementById("receiptDate").value = formatDate(new Date());
  document.getElementById("receiptTyp").value = "Ausgabe";
  document.getElementById("receiptAmount").value = "";
  renderReceiptMwstOptions("Ausgabe");
  document.getElementById("receiptKonto").value = "";
  renderReceiptKategorieOptions("Ausgabe");
  document.getElementById("receiptPurpose").value = "";
  document.getElementById("receiptResult").textContent = "";
  document.getElementById("receiptResult").className = "test-result";
  document.getElementById("receiptOverlay").classList.remove("hidden");
}

function closeReceiptEntry() {
  document.getElementById("receiptOverlay").classList.add("hidden");
}

function onReceiptFileChange(e) {
  const file = e.target.files[0];
  document.getElementById("receiptFileName").textContent = file ? file.name : "";
}

async function saveReceiptEntry() {
  const resultEl = document.getElementById("receiptResult");
  const setErr = (msg) => {
    resultEl.textContent = msg;
    resultEl.className = "test-result err";
  };

  if (!isConfigured()) return setErr("Bitte zuerst Nextcloud in den Einstellungen einrichten.");
  if (!navigator.onLine) return setErr("Keine Internetverbindung – Beleg erfassen braucht Online-Zugriff.");

  const file = document.getElementById("receiptFile").files[0];
  const date = document.getElementById("receiptDate").value;
  const typ = document.getElementById("receiptTyp").value;
  const amountRaw = document.getElementById("receiptAmount").value;
  const amount = parseFloat(amountRaw);
  const mwst = document.getElementById("receiptMwst").value;
  const konto = document.getElementById("receiptKonto").value;
  const kategorie = document.getElementById("receiptKategorie").value;
  const purpose = document.getElementById("receiptPurpose").value.trim();

  if (!file) return setErr("Bitte ein Foto oder PDF auswählen.");
  if (!date) return setErr("Bitte ein Datum wählen.");
  if (!purpose) return setErr("Bitte einen Verwendungszweck eingeben.");
  if (!amountRaw || isNaN(amount) || amount <= 0) return setErr("Bitte einen Betrag grösser als 0 eingeben.");
  if (!konto) return setErr("Bitte ein Konto wählen.");
  if (!kategorie) return setErr("Bitte eine Kategorie wählen.");

  const saveBtn = document.getElementById("saveReceiptBtn");
  saveBtn.disabled = true;
  resultEl.textContent = "Wird gespeichert…";
  resultEl.className = "test-result";

  try {
    await ensureReceiptFolder();
    const belegnummer = await nextBelegnummer(typ);
    const shortPurpose = sanitizeForFilename(purpose) || "Beleg";

    // Fotos vor der Ablage vereinheitlicht als PDF speichern; ist die Datei
    // bereits ein PDF, unverändert lassen.
    const isImage = file.type.startsWith("image/");
    let uploadBlob = file;
    let ext = fileExtension(file);
    let uploadContentType = file.type || "application/octet-stream";
    if (isImage) {
      resultEl.textContent = "Wandle Foto in PDF um…";
      uploadBlob = await imageFileToPdfBlob(file);
      ext = "pdf";
      uploadContentType = "application/pdf";
    }

    const filename = `${belegnummer} ${shortPurpose}.${ext}`;
    const relPath = davPath([...receiptDavSegments(), filename].join("/"));

    const uploadRes = await proxyFetch(relPath, {
      method: "PUT",
      headers: { ...authHeader(), "Content-Type": uploadContentType },
      body: uploadBlob
    });
    if (!uploadRes.ok) throw new Error(`Hochladen fehlgeschlagen (${uploadRes.status})`);

    await appendBananaBooking({ date, belegnummer, typ, konto, kategorie, amount, mwst, purpose, filename });

    resultEl.textContent = `Beleg ${belegnummer} gespeichert.`;
    resultEl.className = "test-result ok";
    setTimeout(closeReceiptEntry, 1200);
  } catch (err) {
    setErr("Fehler: " + err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

// ---------- Init ----------

function init() {
  initSettingsUI({
    checkRelPath: bananaTxtRelativePath,
    ensureFolderFn: ensureReceiptFolder
  });

  document.getElementById("receiptEntryBtn").addEventListener("click", openReceiptEntry);
  document.getElementById("closeReceipt").addEventListener("click", closeReceiptEntry);
  document.getElementById("cancelReceiptBtn").addEventListener("click", closeReceiptEntry);
  document.getElementById("saveReceiptBtn").addEventListener("click", saveReceiptEntry);
  document.getElementById("receiptFile").addEventListener("change", onReceiptFileChange);
  document.getElementById("receiptTyp").addEventListener("change", onReceiptTypChange);

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshReceiptMasterData();
  });

  setInterval(refreshReceiptMasterData, 60000); // Kontenplan/Kategorien/MwSt-Codes alle 60s neu laden
  refreshReceiptMasterData();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
