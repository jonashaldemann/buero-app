/* ============================================================
   Offerten — PDF-Export (Seite 1 Brief, ab Seite 2 Offerte/Rechnung).

   Nutzt pdf-lib + @pdf-lib/fontkit (CDN, siehe <script>-Tags in
   index.html) sowie die echten Nudica-Schriftdateien in ../fonts/*.otf
   (NICHT die woff/woff2 -- die sind fürs Web-UI; fürs PDF reichen
   Light + Medium). Bewusst OHNE Subsetting eingebettet: mit Subsetting
   (`{ subset: true }`) erzeugt pdf-lib mit diesen Schriften eine
   Einbettung, die manche PDF-Reader (z.B. poppler) als ungültig
   ablehnen -- ohne Subsetting rendert es überall sauber, auf Kosten
   von ein paar zusätzlichen KB pro PDF (vernachlässigbar).

   Eigenständig gehalten (keine Funktionen aus app.js verwendet), damit
   die Skript-Ladereihenfolge keine Rolle spielt und der Export auch
   losgelöst wiederverwendbar bleibt.
   ============================================================ */

const PDF_PAGE_WIDTH = 595.28; // A4 in pt
const PDF_PAGE_HEIGHT = 841.89;
const PDF_MARGIN = 56;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;

const COL_TITLE_X = PDF_MARGIN;
const COL_TITLE_WRAP_WIDTH = 300;
const COL_STUNDEN_RIGHT = PDF_MARGIN + 380;
const COL_KOSTEN_RIGHT = PDF_PAGE_WIDTH - PDF_MARGIN;

const GERMAN_MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

function pdfHexRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

let PDF_COLOR_TEXT, PDF_COLOR_MUTED, PDF_COLOR_BORDER, PDF_COLOR_ACCENT;
function initPdfColors() {
  PDF_COLOR_TEXT = pdfHexRgb("#46433C");
  PDF_COLOR_MUTED = pdfHexRgb("#A79C8C");
  PDF_COLOR_BORDER = pdfHexRgb("#E3DED2");
  PDF_COLOR_ACCENT = pdfHexRgb("#4F7089");
}

// ---------- Formatierung (eigene, kleine Kopien -- siehe Kommentar oben) ----------

function chNumberPdf(n) {
  if (n === undefined || n === null || n === "") return "–";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  return (Math.round(num * 100) / 100).toLocaleString("de-CH");
}
function chFrPdf(n) {
  return `${chNumberPdf(n)} Fr.`;
}
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

// ---------- Seiten-/Zeichen-Helfer ----------

function newPage(ctx) {
  ctx.page = ctx.pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  ctx.y = PDF_PAGE_HEIGHT - PDF_MARGIN;
}

// Bricht auf eine neue Seite um, falls "height" ab der aktuellen Position
// nicht mehr bis zum unteren Rand passt. onBreak (optional) zeichnet z.B.
// die Spaltenköpfe auf der neuen Seite erneut.
function ensureSpace(ctx, height, onBreak) {
  if (ctx.y - height < PDF_MARGIN) {
    newPage(ctx);
    if (onBreak) onBreak();
    return true;
  }
  return false;
}

function drawText(ctx, str, x, y, { size = 10.5, font, color, align = "left" } = {}) {
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

// ---------- Seite 1: Brief ----------

function drawLetterPage(ctx, offer, absender) {
  const rightX = PDF_PAGE_WIDTH - PDF_MARGIN;

  if (absender) {
    let ay = PDF_PAGE_HEIGHT - PDF_MARGIN;
    [
      { t: absender.name, font: ctx.medium, size: 10.5 },
      { t: absender.adresse, font: ctx.light, size: 9 },
      { t: absender.plz_ort, font: ctx.light, size: 9 }
    ]
      .filter((l) => l.t)
      .forEach((l) => {
        drawText(ctx, l.t, rightX, ay, { size: l.size, font: l.font, align: "right" });
        ay -= l.size + 4;
      });
    const contact = [absender.telefon, absender.email, absender.website].filter(Boolean);
    if (contact.length) {
      ay -= 4;
      contact.forEach((p) => {
        drawText(ctx, p, rightX, ay, { size: 8.5, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
        ay -= 12;
      });
    }
  }

  let y = PDF_PAGE_HEIGHT - PDF_MARGIN - 130;

  if (absender) {
    const returnLine = [absender.name, absender.adresse, absender.plz_ort].filter(Boolean).join(", ");
    if (returnLine) {
      drawText(ctx, returnLine, PDF_MARGIN, y, { size: 7.5, font: ctx.light, color: PDF_COLOR_MUTED });
      y -= 8;
      drawRule(ctx, y, { x1: PDF_MARGIN + 240 });
      y -= 18;
    }
  }

  if (offer.empfaenger) {
    drawText(ctx, offer.empfaenger, PDF_MARGIN, y, { size: 10.5, font: ctx.medium });
    y -= 14;
  }
  (offer.adresse || "")
    .split("\n")
    .filter((l) => l.trim())
    .forEach((line) => {
      drawText(ctx, line, PDF_MARGIN, y, { size: 10.5, font: ctx.light });
      y -= 14;
    });

  y -= 16;
  const ortDatum = [offer.ort, chDateLong(offer.datum)].filter(Boolean).join(", ");
  if (ortDatum) drawText(ctx, ortDatum, rightX, y, { size: 10.5, font: ctx.light, align: "right" });

  y -= 30;
  const titleWord = offer.typ === "rechnung" ? "Rechnung" : "Offerte";
  const betreff = offer.betreff || `${titleWord}${offer.projekt ? " " + offer.projekt : ""}`;
  drawText(ctx, betreff, PDF_MARGIN, y, { size: 11, font: ctx.medium });

  y -= 26;
  (offer.brieftext || "").split("\n").forEach((raw) => {
    if (!raw.trim()) {
      y -= 12;
      return;
    }
    wrapText(ctx.light, raw, 10.5, PDF_CONTENT_WIDTH).forEach((line) => {
      if (y < PDF_MARGIN) {
        newPage(ctx);
        y = ctx.y;
      }
      drawText(ctx, line, PDF_MARGIN, y, { size: 10.5, font: ctx.light });
      y -= 14;
    });
  });

  ctx.y = y;
}

// ---------- Seite 2+: Offerte/Rechnung ----------

function drawColumnHeader(ctx) {
  drawText(ctx, "Modul", COL_TITLE_X, ctx.y, { size: 9, font: ctx.light, color: PDF_COLOR_MUTED });
  drawText(ctx, "Stunden", COL_STUNDEN_RIGHT, ctx.y, { size: 9, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
  drawText(ctx, "Kosten", COL_KOSTEN_RIGHT, ctx.y, { size: 9, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
  ctx.y -= 6;
  drawRule(ctx, ctx.y);
  ctx.y -= 14;
}

function drawPhaseRow(ctx, p) {
  ensureSpace(ctx, 40, () => drawColumnHeader(ctx));
  ctx.y -= 6;
  drawText(ctx, p.titel || "", PDF_MARGIN, ctx.y, { size: 12, font: ctx.medium });
  ctx.y -= 6;
  drawRule(ctx, ctx.y, { thickness: 1.2 });
  ctx.y -= 16;
}

function drawModulRow(ctx, p, nr, rate) {
  const bulletLines = (Array.isArray(p.beschrieb) ? p.beschrieb : [])
    .filter((l) => l && l.trim())
    .flatMap((line) => wrapText(ctx.light, line, 9.5, COL_TITLE_WRAP_WIDTH - 12));

  const blockHeight = 15 + bulletLines.length * 13 + 20;
  ensureSpace(ctx, blockHeight, () => drawColumnHeader(ctx));

  const kosten = (Number(p.stunden) || 0) * rate;
  drawText(ctx, `${nr})  ${p.titel || ""}`, COL_TITLE_X, ctx.y, { size: 10.5, font: ctx.medium });
  drawText(ctx, chNumberPdf(p.stunden), COL_STUNDEN_RIGHT, ctx.y, { size: 10.5, font: ctx.light, align: "right" });
  drawText(ctx, chFrPdf(kosten), COL_KOSTEN_RIGHT, ctx.y, { size: 10.5, font: ctx.light, align: "right" });
  ctx.y -= 15;

  bulletLines.forEach((line) => {
    ensureSpace(ctx, 13, () => drawColumnHeader(ctx));
    drawText(ctx, `•  ${line}`, COL_TITLE_X + 10, ctx.y, { size: 9.5, font: ctx.light, color: PDF_COLOR_MUTED });
    ctx.y -= 13;
  });

  ctx.y -= 6;
  drawRule(ctx, ctx.y, { thickness: 0.5 });
  ctx.y -= 14;
}

function drawTotals(ctx, offer) {
  const rate = Number(offer.stundensatz_chf) || 0;
  const subtotal = (offer.positionen || [])
    .filter((p) => p.typ === "modul")
    .reduce((sum, m) => sum + (Number(m.stunden) || 0) * rate, 0);
  const mwstProzent = Number(offer.mwst_prozent) || 0;
  const mwst = subtotal * (mwstProzent / 100);
  const total = subtotal + mwst;
  const labelX = COL_STUNDEN_RIGHT - 140;

  ensureSpace(ctx, 100);
  ctx.y -= 10;

  [
    ["Zwischentotal exkl. MWST", chFrPdf(subtotal)],
    [`MWST ${chNumberPdf(mwstProzent)}%`, chFrPdf(mwst)]
  ].forEach(([label, val]) => {
    drawText(ctx, label, labelX, ctx.y, { size: 10, font: ctx.light });
    drawText(ctx, val, COL_KOSTEN_RIGHT, ctx.y, { size: 10, font: ctx.light, align: "right" });
    ctx.y -= 15;
  });

  ctx.y -= 4;
  drawRule(ctx, ctx.y + 10, { x0: labelX });
  const totalLabel = offer.typ === "rechnung" ? "Rechnungsbetrag inkl. MWST" : "Total inkl. MWST";
  drawText(ctx, totalLabel, labelX, ctx.y, { size: 11.5, font: ctx.medium });
  drawText(ctx, chFrPdf(total), COL_KOSTEN_RIGHT, ctx.y, { size: 11.5, font: ctx.medium, align: "right" });
  ctx.y -= 26;

  if (offer.typ === "rechnung" && offer.zahlungshinweis && offer.zahlungshinweis.trim()) {
    ensureSpace(ctx, 60);
    wrapText(ctx.light, offer.zahlungshinweis, 9.5, PDF_CONTENT_WIDTH).forEach((line) => {
      drawText(ctx, line, PDF_MARGIN, ctx.y, { size: 9.5, font: ctx.light, color: PDF_COLOR_MUTED });
      ctx.y -= 13;
    });
  }
}

function drawPositionenPage(ctx, offer) {
  const titleWord = offer.typ === "rechnung" ? "RECHNUNG" : "OFFERTE";
  let y = ctx.y;

  drawText(ctx, titleWord, PDF_MARGIN, y, { size: 18, font: ctx.medium, color: PDF_COLOR_ACCENT });
  y -= 8;
  drawRule(ctx, y, { thickness: 1.2, color: PDF_COLOR_ACCENT });
  y -= 24;

  if (offer.projekt) {
    drawText(ctx, offer.projekt, PDF_MARGIN, y, { size: 13, font: ctx.medium });
    y -= 20;
  }

  if (offer.empfaenger) {
    drawText(ctx, offer.empfaenger, PDF_MARGIN, y, { size: 10, font: ctx.light, color: PDF_COLOR_MUTED });
  }

  const nrLabel = offer.typ === "rechnung" ? "Rechnungs-Nr." : "Offert-Nr.";
  const metaLines = [];
  if (offer.offert_nr) metaLines.push(`${nrLabel} ${offer.offert_nr}`);
  metaLines.push(`Datum ${chDateShort(offer.datum)}`);
  if (offer.typ === "rechnung" && offer.zahlbar_bis) metaLines.push(`Zahlbar bis ${chDateShort(offer.zahlbar_bis)}`);
  let metaY = y;
  metaLines.forEach((line) => {
    drawText(ctx, line, PDF_PAGE_WIDTH - PDF_MARGIN, metaY, { size: 10, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
    metaY -= 13;
  });

  ctx.y = Math.min(y, metaY) - 20;
  drawColumnHeader(ctx);

  let modulNr = 0;
  const rate = Number(offer.stundensatz_chf) || 0;
  (offer.positionen || []).forEach((p) => {
    if (p.typ === "phase") {
      drawPhaseRow(ctx, p);
    } else {
      modulNr++;
      drawModulRow(ctx, p, modulNr, rate);
    }
  });

  drawTotals(ctx, offer);
}

// ---------- Datei-Handling ----------

function pdfFilename(offer) {
  const typLabel = offer.typ === "rechnung" ? "Rechnung" : "Offerte";
  const base = `${offer.datum || ""} ${offer.projekt || typLabel} - ${typLabel}`.trim();
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

async function exportOfferPdf(offer, absender) {
  if (typeof PDFLib === "undefined" || typeof fontkit === "undefined") {
    throw new Error("PDF-Bibliothek nicht verfügbar (fürs erste Mal wird eine Internetverbindung gebraucht).");
  }
  initPdfColors();

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
  drawLetterPage(ctx, offer, absender);

  newPage(ctx); // Offerte/Rechnung beginnt bewusst auf einer eigenen Seite
  drawPositionenPage(ctx, offer);

  const bytes = await pdfDoc.save();
  downloadPdfBytes(bytes, pdfFilename(offer));
}
