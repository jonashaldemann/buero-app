/* ============================================================
   Protokoll — PDF-Export (eine durchgehende Aktennotiz, keine
   Brief/Positionen-Trennung wie bei den Offerten).

   Nutzt pdf-lib + @pdf-lib/fontkit (CDN, siehe <script>-Tags in
   index.html) sowie die Nudica-Schriftdateien in ../fonts/*.otf --
   siehe Kommentar in offerten/pdf.js für die Begründung (kein
   Font-Subsetting).

   Rechts neben jedem Stichpunkt bleibt eine schmale Spalte frei, in der
   -- falls gesetzt -- das Kürzel der zuständigen Person steht (dort, wo
   der Punkt eine Pendenz ist, siehe abschnitt.kuerzel in app.js).

   Eigenständig gehalten (keine Funktionen aus app.js verwendet, siehe
   Kommentar in offerten/pdf.js), nutzt aber proxyFetch/davPath/ncSegments/
   authHeader aus ../shared/common.js indirekt nicht -- Protokoll-PDFs
   brauchen keinen Nextcloud-Zugriff (keine Unterschriften/Bilder).
   ============================================================ */

const PDF_PAGE_WIDTH = 595.28; // A4 in pt
const PDF_PAGE_HEIGHT = 841.89;
const PDF_MARGIN = 56;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;

// Rechte Spalte für die Pendenzen-Kürzel -- der Stichpunkt-Text wird auf
// die verbleibende Breite umgebrochen, damit das Kürzel nie mit langem
// Text kollidiert.
const KUERZEL_COL_WIDTH = 34;
const BULLET_TEXT_WIDTH = PDF_CONTENT_WIDTH - KUERZEL_COL_WIDTH - 10;

const GERMAN_MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

function pdfHexRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

let PDF_COLOR_TEXT, PDF_COLOR_MUTED, PDF_COLOR_BORDER;
function initPdfColors() {
  PDF_COLOR_TEXT = pdfHexRgb("#333333");
  PDF_COLOR_MUTED = pdfHexRgb("#888888");
  PDF_COLOR_BORDER = pdfHexRgb("#DDDDDD");
}

const SIZE_TITLE = 15;
const SIZE_HEAD = 11;
const SIZE_BODY = 10;
const SIZE_SMALL = 9;

function chDateShort(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || "");
  if (!m) return dateStr || "–";
  return `${m[3]}.${m[2]}.${m[1]}`;
}
function chDateLong(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || "");
  if (!m) return dateStr || "";
  const day = parseInt(m[3], 10);
  const month = GERMAN_MONTHS[parseInt(m[2], 10) - 1] || "";
  return `${day}. ${month} ${m[1]}`;
}

function wrapText(font, str, size, maxWidth) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function newPage(ctx) {
  ctx.page = ctx.pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  ctx.y = PDF_PAGE_HEIGHT - PDF_MARGIN;
}

function ensureSpace(ctx, height) {
  if (ctx.y - height < PDF_MARGIN) {
    newPage(ctx);
    return true;
  }
  return false;
}

function drawText(ctx, str, x, y, { size = SIZE_BODY, font, color, align = "left" } = {}) {
  if (!str) return 0;
  const f = font || ctx.light;
  const c = color || PDF_COLOR_TEXT;
  const w = f.widthOfTextAtSize(str, size);
  const drawX = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  ctx.page.drawText(str, { x: drawX, y, size, font: f, color: c });
  return w;
}

function drawRule(ctx, y, { x0 = PDF_MARGIN, x1 = PDF_PAGE_WIDTH - PDF_MARGIN, thickness = 0.75, color } = {}) {
  ctx.page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color: color || PDF_COLOR_BORDER });
}

// ---------- Kopf: Absender, Titel, Meta-Infos, Teilnehmende ----------

function drawHeader(ctx, protokoll, absender, projektLabelFn) {
  const rightX = PDF_PAGE_WIDTH - PDF_MARGIN;

  if (absender) {
    let ay = PDF_PAGE_HEIGHT - PDF_MARGIN;
    [absender.name, absender.adresse, absender.plz_ort].filter(Boolean).forEach((line) => {
      drawText(ctx, line, PDF_MARGIN, ay, { size: SIZE_BODY, font: ctx.light });
      ay -= SIZE_BODY + 4;
    });
  }

  let y = PDF_PAGE_HEIGHT - PDF_MARGIN - 70;
  const titleLine = `Protokoll${protokoll.titel ? " " + protokoll.titel : ""}`;
  drawText(ctx, titleLine, PDF_MARGIN, y, { size: SIZE_TITLE, font: ctx.medium });
  y -= 10;
  drawRule(ctx, y, { thickness: 1 });
  y -= 26;

  const labelX = PDF_MARGIN;
  const valueX = PDF_MARGIN + 100;
  const metaRows = [];
  const zeitraum = [protokoll.zeitVon, protokoll.zeitBis].filter(Boolean).join(" – ");
  metaRows.push(["Datum/Zeit", [chDateLong(protokoll.datum), zeitraum ? `${zeitraum} Uhr` : ""].filter(Boolean).join(", ")]);
  if (protokoll.projekt) metaRows.push(["Projekt", projektLabelFn(protokoll.projekt)]);
  if (protokoll.ort) metaRows.push(["Ort", protokoll.ort]);

  metaRows.forEach(([label, value]) => {
    drawText(ctx, label, labelX, y, { size: SIZE_BODY, font: ctx.light, color: PDF_COLOR_MUTED });
    drawText(ctx, value, valueX, y, { size: SIZE_BODY, font: ctx.light });
    y -= SIZE_BODY + 6;
  });

  const teilnehmende = (protokoll.teilnehmende || []).filter((t) => t.name && t.name.trim());
  if (teilnehmende.length) {
    y -= 6;
    drawText(ctx, "Teilnehmende", labelX, y, { size: SIZE_BODY, font: ctx.light, color: PDF_COLOR_MUTED });
    let ty = y;
    teilnehmende.forEach((t) => {
      drawText(ctx, t.name, valueX, ty, { size: SIZE_BODY, font: ctx.light });
      ty -= SIZE_BODY + 6;
    });
    y = ty;
  }

  ctx.y = y - 20;
}

// ---------- Hauptteil: Zwischentitel + Bullet Points ----------

function drawTitelRow(ctx, nr, text) {
  ensureSpace(ctx, 40);
  ctx.y -= 4;
  drawText(ctx, `${nr}. ${text || ""}`, PDF_MARGIN, ctx.y, { size: SIZE_HEAD, font: ctx.medium });
  ctx.y -= 14;
}

function drawBulletRow(ctx, text, kuerzel) {
  const lines = wrapText(ctx.light, text || "", SIZE_BODY, BULLET_TEXT_WIDTH);
  const blockHeight = lines.length * 15 + 4;
  ensureSpace(ctx, blockHeight);
  const startY = ctx.y;

  lines.forEach((line, i) => {
    ensureSpace(ctx, 15);
    if (i === 0) {
      drawText(ctx, "–", PDF_MARGIN, ctx.y, { size: SIZE_BODY, font: ctx.light });
    }
    drawText(ctx, line, PDF_MARGIN + 14, ctx.y, { size: SIZE_BODY, font: ctx.light });
    ctx.y -= 15;
  });

  if (kuerzel) {
    drawText(ctx, kuerzel, PDF_PAGE_WIDTH - PDF_MARGIN, startY, {
      size: SIZE_SMALL,
      font: ctx.medium,
      color: PDF_COLOR_MUTED,
      align: "right"
    });
  }

  ctx.y -= 4;
}

function drawAbschnitte(ctx, protokoll) {
  let titelNr = 0;
  (protokoll.abschnitte || []).forEach((a) => {
    if (a.typ === "titel") {
      titelNr++;
      drawTitelRow(ctx, titelNr, a.text);
    } else if (a.text && a.text.trim()) {
      drawBulletRow(ctx, a.text, a.kuerzel);
    }
  });
}

// ---------- Datei-Handling ----------

function pdfFilename(protokoll) {
  const base = `${protokoll.datum || ""} ${protokoll.titel || "Protokoll"}`.trim();
  return base.replace(/[\\/:*?"<>|]/g, "") + ".pdf";
}

function downloadPdfBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- Einstiegspunkt ----------

async function exportProtokollPdf(protokoll, projektLabelFn) {
  if (typeof PDFLib === "undefined" || typeof fontkit === "undefined") {
    throw new Error("PDF-Bibliothek nicht verfügbar (fürs erste Mal wird eine Internetverbindung gebraucht).");
  }
  initPdfColors();

  let absender = null;
  try {
    const res = await fetch("../offerten/absender.json");
    absender = res.ok ? await res.json() : null;
  } catch (e) {
    absender = null;
  }

  const { PDFDocument } = PDFLib;
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const [lightBytes, mediumBytes] = await Promise.all([
    fetch("../fonts/Nudica-Light.otf").then((r) => {
      if (!r.ok) throw new Error("Schriftdatei Nudica-Light.otf konnte nicht geladen werden");
      return r.arrayBuffer();
    }),
    fetch("../fonts/Nudica-Medium.otf").then((r) => {
      if (!r.ok) throw new Error("Schriftdatei Nudica-Medium.otf konnte nicht geladen werden");
      return r.arrayBuffer();
    })
  ]);

  const ctx = {
    pdfDoc,
    light: await pdfDoc.embedFont(lightBytes, { subset: false }),
    medium: await pdfDoc.embedFont(mediumBytes, { subset: false }),
    page: null,
    y: 0
  };

  newPage(ctx);
  drawHeader(ctx, protokoll, absender, projektLabelFn || ((id) => id));
  drawAbschnitte(ctx, protokoll);

  const bytes = await pdfDoc.save();
  downloadPdfBytes(bytes, pdfFilename(protokoll));
}
