/* ============================================================
   Offerten — PDF-Export (Seite 1 Brief, ab Seite 2 Offerte/Rechnung).

   Nutzt pdf-lib + @pdf-lib/fontkit (CDN, siehe <script>-Tags in
   index.html) sowie die echten Nudica-Schriftdateien in ../fonts/*.otf
   (NICHT die woff/woff2 -- die sind fürs Web-UI; fürs PDF reichen
   Light, Medium und LightItalic). Bewusst OHNE Subsetting eingebettet: mit
   Subsetting (`{ subset: true }`) erzeugt pdf-lib mit diesen Schriften eine
   Einbettung, die manche PDF-Reader (z.B. poppler) als ungültig
   ablehnen -- ohne Subsetting rendert es überall sauber, auf Kosten
   von ein paar zusätzlichen KB pro PDF (vernachlässigbar).

   Modul-Nummerierung ist pro Offerte/Rechnung ab-/anschaltbar
   (automatische_nummerierung), Module können zusätzlich eine kursive
   "Bemerkung" ohne Bulletpoint nach den Stichpunkten haben (bemerkung/
   bemerkungAktiv). Optional werden nach dem Brieftext ausgewählte
   Unterschriften (Bild + Name) eingefügt -- die PNGs kommen live von
   Nextcloud (siehe fetchSignatureImages()), nicht aus dem PDF-Code selbst.

   Eigenständig gehalten (keine Funktionen aus app.js verwendet -- die
   Unterzeichner-Konfiguration wird als Parameter übergeben statt hier
   geladen), damit die Skript-Ladereihenfolge keine Rolle spielt und der
   Export auch losgelöst wiederverwendbar bleibt. Nutzt aber proxyFetch/
   davPath/ncSegments/authHeader aus ../shared/common.js für den
   Unterschriften-Abruf (dieselbe Schicht, die auch app.js fürs Lesen/
   Schreiben der Offerten verwendet).
   ============================================================ */

const PDF_PAGE_WIDTH = 595.28; // A4 in pt
const PDF_PAGE_HEIGHT = 841.89;
const PDF_MARGIN = 56;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;

const COL_TITLE_X = PDF_MARGIN;
const COL_TITLE_WRAP_WIDTH = 300;
const COL_STUNDEN_RIGHT = PDF_MARGIN + 380;
const COL_KOSTEN_RIGHT = PDF_PAGE_WIDTH - PDF_MARGIN;

// Brief (Seite 1): Position des Adressblocks -- IMMER fix, unabhängig von
// der Brieflänge. Anders als z.B. beim Rundungsrabatt gibt es hier keinen
// Spielraum: Fensterkuverts haben ihr Sichtfenster an einer festen Stelle,
// der Adressat muss also unabhängig vom Rest immer an derselben Höhe stehen.
const LETTER_BLOCK_TOP_Y = PDF_PAGE_HEIGHT - PDF_MARGIN - 140;
// Ort/Datum + Betreff stehen bewusst NICHT direkt unter dem Adressblock,
// sondern an einer eigenen fixen Position bei ca. 40% der Seitenhöhe (von
// oben) -- ergibt bei kurzen Briefen spürbar mehr Abstand zwischen Adresse
// und Text, ohne dass (wegen des Fensterkuverts) der Adressblock selbst
// mitwandern dürfte.
const LETTER_DATUM_BETREFF_Y = Math.round(PDF_PAGE_HEIGHT * 0.6);

// Unterschriften-Bilder: Breite fix, Höhe ergibt sich aus dem Seitenverhältnis
// (siehe drawSignatureImages()).
const SIGNATURE_IMG_WIDTH = 130;

// Unterschriften-Bilder liegen im jeweils eigenen Nextcloud-Bereich (wie
// alles andere in dieser App) unter diesem Ordner. davPath/ncSegments/
// authHeader/proxyFetch kommen aus ../shared/common.js (bereits vor pdf.js
// geladen, siehe <script>-Tags in index.html).
const SIGNATURE_FOLDER_PATH = "Buero/Admin/KLG und Rechtliches/Unterschriften";

const GERMAN_MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

function pdfHexRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Bewusst nur Graustufen (kein Farbakzent) -- typografisch schlicht und
// druckt auch schwarz/weiss sauber. Hierarchie kommt über Schriftschnitt
// (Light/Medium) und wenige, gezielt eingesetzte Grössen, nicht über Farbe.
let PDF_COLOR_TEXT, PDF_COLOR_MUTED, PDF_COLOR_BORDER;
function initPdfColors() {
  PDF_COLOR_TEXT = pdfHexRgb("#333333");
  PDF_COLOR_MUTED = pdfHexRgb("#888888");
  PDF_COLOR_BORDER = pdfHexRgb("#DDDDDD");
}

// Eingeschränkter Grössen-Massstab (statt vieler verschiedener Grössen):
// 16 nur für den Seitentitel OFFERTE/RECHNUNG, 11 für Zwischenüberschriften
// (Phase, Projekt-Titel Seite 2), 10 als durchgehende Standardgrösse
// (Light normal, Medium für Betonung), 9 fürs Kleingedruckte (Bullets,
// Spaltenköpfe, Meta-Angaben, Zahlungshinweis).
const SIZE_TITLE = 16;
const SIZE_HEAD = 11;
const SIZE_BODY = 10;
const SIZE_SMALL = 9;

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
// Für die Summenzeilen (Zwischentotal/MWST/Total): auf 5 Rappen gerundet
// (übliche Schweizer Rundung) und immer mit 2 Nachkommastellen.
function chFrRoundedPdf(n) {
  if (n === undefined || n === null || n === "") return "–";
  const num = Number(n);
  if (isNaN(num)) return String(n);
  const rounded = Math.round(num / 0.05) * 0.05;
  return `${rounded.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Fr.`;
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

// ---------- Seite 1: Brief ----------

function drawLetterPage(ctx, offer, absender) {
  const rightX = PDF_PAGE_WIDTH - PDF_MARGIN;

  // Absenderblock oben rechts -- durchgehend Light/10, keine eigene
  // Auszeichnung mehr (weniger Farben/Grössen als möglich). Fixe Position.
  if (absender) {
    let ay = PDF_PAGE_HEIGHT - PDF_MARGIN;
    [absender.name, absender.adresse, absender.plz_ort, absender.telefon, absender.email, absender.website]
      .filter(Boolean)
      .forEach((line) => {
        drawText(ctx, line, rightX, ay, { size: SIZE_BODY, font: ctx.light, align: "right" });
        ay -= SIZE_BODY + 4;
      });
  }

  // Adressat: ebenfalls fixe Position (siehe LETTER_BLOCK_TOP_Y) -- kein
  // wiederholter Absender darüber (bewusst weggelassen).
  let y = LETTER_BLOCK_TOP_Y;
  if (offer.empfaenger) {
    drawText(ctx, offer.empfaenger, PDF_MARGIN, y, { size: SIZE_BODY, font: ctx.light });
    y -= SIZE_BODY + 4;
  }
  (offer.adresse || "")
    .split("\n")
    .filter((l) => l.trim())
    .forEach((line) => {
      drawText(ctx, line, PDF_MARGIN, y, { size: SIZE_BODY, font: ctx.light });
      y -= SIZE_BODY + 4;
    });

  // Ort/Datum + Betreff: eigene fixe Position (siehe LETTER_DATUM_BETREFF_Y),
  // absichtlich unabhängig davon, wo der Adressblock oben endet.
  let y2 = LETTER_DATUM_BETREFF_Y;
  const ortDatum = [absender && absender.ort, chDateLong(offer.datum)].filter(Boolean).join(", ");
  if (ortDatum) drawText(ctx, ortDatum, rightX, y2, { size: SIZE_BODY, font: ctx.light, align: "right" });

  y2 -= 28;
  const titleWord = offer.typ === "rechnung" ? "Rechnung" : "Offerte";
  const betreff = offer.betreff || `${titleWord}${offer.projekt ? " " + offer.projekt : ""}`;
  drawText(ctx, betreff, PDF_MARGIN, y2, { size: SIZE_BODY, font: ctx.medium });

  y2 -= 24;
  (offer.brieftext || "").split("\n").forEach((raw) => {
    if (!raw.trim()) {
      y2 -= 12;
      return;
    }
    wrapText(ctx.light, raw, SIZE_BODY, PDF_CONTENT_WIDTH).forEach((line) => {
      if (y2 < PDF_MARGIN) {
        newPage(ctx);
        y2 = ctx.y;
      }
      drawText(ctx, line, PDF_MARGIN, y2, { size: SIZE_BODY, font: ctx.light });
      y2 -= SIZE_BODY + 4;
    });
  });

  ctx.y = y2;
}

// ---------- Seite 2+: Offerte/Rechnung ----------

function drawColumnHeader(ctx) {
  drawText(ctx, "Modul", COL_TITLE_X, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
  drawText(ctx, "Stunden", COL_STUNDEN_RIGHT, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
  drawText(ctx, "Kosten", COL_KOSTEN_RIGHT, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
  ctx.y -= 6;
  drawRule(ctx, ctx.y);
  ctx.y -= 14;
}

function drawPhaseRow(ctx, p) {
  ensureSpace(ctx, 40, () => drawColumnHeader(ctx));
  ctx.y -= 6;
  drawText(ctx, p.titel || "", PDF_MARGIN, ctx.y, { size: SIZE_HEAD, font: ctx.medium });
  ctx.y -= 6;
  drawRule(ctx, ctx.y, { thickness: 1 });
  ctx.y -= 16;
}

// Abstand vom Bullet-Zeichen zum Textanfang -- Folgezeilen eines umgebrochenen
// Punktes rücken um genau diese Breite weiter ein, damit sie unter dem TEXT
// (nicht unter dem Punkt) hängen, statt fälschlich selbst wieder ein "•" zu
// bekommen (siehe drawModulRow()/bulletGroups unten).
const BULLET_INDENT = 10;
function bulletTextIndentWidth(ctx) {
  return ctx.light.widthOfTextAtSize("•  ", SIZE_SMALL);
}

function drawModulRow(ctx, p, nr, rate, numbered) {
  // Pro Bulletpoint eine eigene Gruppe von (ggf. mehreren, umgebrochenen)
  // Zeilen -- wichtig, damit beim Zeichnen nur die jeweils ERSTE Zeile einen
  // Punkt bekommt und nicht jede umgebrochene Folgezeile fälschlich als
  // eigener neuer Punkt erscheint.
  const bulletTextIndent = bulletTextIndentWidth(ctx);
  const bulletWrapWidth = COL_TITLE_WRAP_WIDTH - BULLET_INDENT - bulletTextIndent;
  const bulletGroups = (Array.isArray(p.beschrieb) ? p.beschrieb : [])
    .filter((l) => l && l.trim())
    .map((line) => wrapText(ctx.light, line, SIZE_SMALL, bulletWrapWidth));
  const bulletLineCount = bulletGroups.reduce((sum, lines) => sum + lines.length, 0);

  const hasBemerkung = !!(p.bemerkungAktiv && p.bemerkung && p.bemerkung.trim());
  const bemerkungLines = hasBemerkung
    ? wrapText(ctx.italic, p.bemerkung, SIZE_SMALL, COL_TITLE_WRAP_WIDTH)
    : [];

  const blockHeight = 15 + bulletLineCount * 13 + bemerkungLines.length * 13 + 20;
  ensureSpace(ctx, blockHeight, () => drawColumnHeader(ctx));

  const pauschalAktiv = !!p.pauschalAktiv;
  const kosten = pauschalAktiv ? Number(p.pauschalBetrag) || 0 : (Number(p.stunden) || 0) * rate;
  const titleText = numbered ? `${nr})  ${p.titel || ""}` : p.titel || "";
  drawText(ctx, titleText, COL_TITLE_X, ctx.y, { size: SIZE_BODY, font: ctx.medium });
  drawText(ctx, pauschalAktiv ? "Pauschal" : chNumberPdf(p.stunden), COL_STUNDEN_RIGHT, ctx.y, {
    size: SIZE_BODY,
    font: ctx.light,
    color: pauschalAktiv ? PDF_COLOR_MUTED : undefined,
    align: "right"
  });
  drawText(ctx, chFrPdf(kosten), COL_KOSTEN_RIGHT, ctx.y, { size: SIZE_BODY, font: ctx.light, align: "right" });
  ctx.y -= 15;

  bulletGroups.forEach((lines) => {
    lines.forEach((line, lineIndex) => {
      ensureSpace(ctx, 13, () => drawColumnHeader(ctx));
      if (lineIndex === 0) {
        drawText(ctx, `•  ${line}`, COL_TITLE_X + BULLET_INDENT, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
      } else {
        // Umgebrochene Folgezeile desselben Punktes -- kein eigener Punkt,
        // stattdessen unter dem Text der ersten Zeile eingerückt.
        drawText(ctx, line, COL_TITLE_X + BULLET_INDENT + bulletTextIndent, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
      }
      ctx.y -= 13;
    });
  });

  // Bemerkung: kursiv, ohne Bulletpoint, nach den Stichpunkten (z.B. "Wege-
  // strecken werden nicht verrechnet") -- gleiche Einrückung wie die Bullets.
  bemerkungLines.forEach((line) => {
    ensureSpace(ctx, 13, () => drawColumnHeader(ctx));
    drawText(ctx, line, COL_TITLE_X + 10, ctx.y, { size: SIZE_SMALL, font: ctx.italic, color: PDF_COLOR_MUTED });
    ctx.y -= 13;
  });

  ctx.y -= 6;
  drawRule(ctx, ctx.y, { thickness: 0.5 });
  ctx.y -= 14;
}

// Rundungsrabatt: der Endbetrag inkl. MWST wird auf die nächst-tieferen
// CHF 5.- abgerundet (übliche Kundenfreundlichkeit) und die Differenz als
// eigene Rabatt-Zeile vor dem Zwischentotal ausgewiesen -- nicht die MWST
// selbst wird gekürzt, sondern die (steuerbare) Honorarsumme. Die MWST wird
// danach als Differenz zum bereits gerundeten Endbetrag berechnet statt
// separat gerundet, damit Zwischentotal + MWST den Endbetrag exakt ergeben.
// War der Endbetrag schon rund (Rabatt < 1 Rappen), bleibt alles beim
// gewohnten, ungerundeten Verhalten -- keine "Honorar"/0.00-Zeilen.
const PDF_ROUNDING_STEP_CHF = 5;

function drawTotals(ctx, offer) {
  const rate = Number(offer.stundensatz_chf) || 0;
  const modulPositionen = (offer.positionen || []).filter((p) => p.typ === "modul");
  // Pauschal-Module zählen mit ihrem festen Betrag statt Stunden × Stundensatz
  // und tragen keine Stunden zum Stundentotal bei.
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
  const totalGerundet = Math.floor((totalRoh + 1e-9) / PDF_ROUNDING_STEP_CHF) * PDF_ROUNDING_STEP_CHF;
  const subtotalErforderlich = mwstFaktor ? totalGerundet / mwstFaktor : totalGerundet;
  let rundungsrabatt = Math.round((subtotalRoh - subtotalErforderlich) / 0.05) * 0.05;
  if (Math.abs(rundungsrabatt) < 0.01) rundungsrabatt = 0;

  const subtotal = subtotalRoh - rundungsrabatt;
  const mwst = rundungsrabatt ? totalGerundet - subtotal : subtotalRoh * (mwstProzent / 100);
  const total = rundungsrabatt ? totalGerundet : subtotal + mwst;
  const labelX = COL_STUNDEN_RIGHT - 140;

  ensureSpace(ctx, 175);
  ctx.y -= 10;

  const stundensatzHinweis =
    offer.typ === "rechnung"
      ? `Der mittlere Stundensatz beträgt ${chFrPdf(rate)}`
      : `Der mittlere Stundensatz beträgt ${chFrPdf(rate)} Das Honorar wird nach effektivem Zeitaufwand abgerechnet, dabei gilt der total geschätzte Stundenaufwand als Kostendach.`;
  wrapText(ctx.light, stundensatzHinweis, SIZE_SMALL, PDF_CONTENT_WIDTH).forEach((line) => {
    ensureSpace(ctx, 13);
    drawText(ctx, line, PDF_MARGIN, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
    ctx.y -= 13;
  });
  ctx.y -= 10;

  const rows = [];
  if (nebenkosten) rows.push(["Nebenkostenpauschale", chFrPdf(nebenkosten)]);
  if (rundungsrabatt) {
    rows.push(["Honorar", chFrRoundedPdf(subtotalRoh)]);
    rows.push(["Rundungsrabatt", `−${chFrRoundedPdf(rundungsrabatt)}`]);
  }
  rows.push(
    ["Zwischentotal exkl. MWST", chFrRoundedPdf(subtotal)],
    [`MWST ${chNumberPdf(mwstProzent)}%`, chFrRoundedPdf(mwst)]
  );
  rows.forEach(([label, val]) => {
    drawText(ctx, label, labelX, ctx.y, { size: SIZE_BODY, font: ctx.light });
    drawText(ctx, val, COL_KOSTEN_RIGHT, ctx.y, { size: SIZE_BODY, font: ctx.light, align: "right" });
    ctx.y -= 15;
  });

  ctx.y -= 4;
  drawRule(ctx, ctx.y + 10, { x0: labelX });
  const totalLabel = offer.typ === "rechnung" ? "Rechnungsbetrag inkl. MWST" : "Total inkl. MWST";
  drawText(ctx, totalLabel, labelX, ctx.y, { size: SIZE_BODY, font: ctx.medium });
  drawText(ctx, chFrRoundedPdf(total), COL_KOSTEN_RIGHT, ctx.y, { size: SIZE_BODY, font: ctx.medium, align: "right" });
  ctx.y -= 26;

  if (offer.typ === "rechnung") {
    ensureSpace(ctx, 20);
    drawText(ctx, "Zahlbar innert 30 Tagen", PDF_MARGIN, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
    ctx.y -= 13;
  }
}

// Direkt unter den Modulen statt im Abrechnungsblock -- Stunden sind keine
// Frankenbeträge und würden dort mit Nebenkosten/Zwischentotal/MWST/Total
// vermischt, ausserdem macht das den Abrechnungsblock unnötig lang.
function drawStundenTotalRow(ctx, stundenTotal) {
  ensureSpace(ctx, 26);
  ctx.y -= 2;
  drawText(ctx, "Stundentotal", COL_TITLE_X, ctx.y, { size: SIZE_SMALL, font: ctx.medium, color: PDF_COLOR_MUTED });
  drawText(ctx, `${chNumberPdf(stundenTotal)} Std.`, COL_STUNDEN_RIGHT, ctx.y, { size: SIZE_SMALL, font: ctx.medium, color: PDF_COLOR_MUTED, align: "right" });
  ctx.y -= 22;
}

function drawPositionenPage(ctx, offer) {
  const titleWord = offer.typ === "rechnung" ? "RECHNUNG" : "OFFERTE";
  let y = ctx.y;

  drawText(ctx, titleWord, PDF_MARGIN, y, { size: SIZE_TITLE, font: ctx.medium });
  y -= 8;
  drawRule(ctx, y, { thickness: 1 });
  y -= 24;

  if (offer.projekt) {
    const projektLine = [offer.projektnummer, offer.projekt].filter(Boolean).join(" – ");
    drawText(ctx, projektLine, PDF_MARGIN, y, { size: SIZE_HEAD, font: ctx.medium });
    y -= 18;
  }

  if (offer.empfaenger) {
    drawText(ctx, offer.empfaenger, PDF_MARGIN, y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
  }

  const nrLabel = offer.typ === "rechnung" ? "Rechnungs-Nr." : "Offert-Nr.";
  const metaLines = [];
  if (offer.offert_nr) metaLines.push(`${nrLabel} ${offer.offert_nr}`);
  metaLines.push(`Datum ${chDateShort(offer.datum)}`);
  let metaY = y;
  metaLines.forEach((line) => {
    drawText(ctx, line, PDF_PAGE_WIDTH - PDF_MARGIN, metaY, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
    metaY -= 13;
  });

  ctx.y = Math.min(y, metaY) - 20;
  drawColumnHeader(ctx);

  let modulNr = 0;
  const rate = Number(offer.stundensatz_chf) || 0;
  const numbered = offer.automatische_nummerierung !== false;
  const stundenTotal = (offer.positionen || [])
    .filter((p) => p.typ === "modul")
    .reduce((sum, m) => sum + (m.pauschalAktiv ? 0 : Number(m.stunden) || 0), 0);

  (offer.positionen || []).forEach((p) => {
    if (p.typ === "phase") {
      drawPhaseRow(ctx, p);
    } else {
      modulNr++;
      drawModulRow(ctx, p, modulNr, rate, numbered);
    }
  });

  drawStundenTotalRow(ctx, stundenTotal);
  drawTotals(ctx, offer);
}

// ---------- Unterschriften (Seite 1, nach dem Brieftext) ----------

// Lädt die ausgewählten Unterschrift-PNGs vom Nextcloud der aktuell
// angemeldeten Person (gleicher Ordner für alle -- damit eine Person auch
// die Unterschrift der anderen einfügen kann, muss die entsprechende Datei
// in beiden Nextcloud-Konten unter demselben Pfad liegen). Schlägt eine
// einzelne Datei fehl (z.B. Datei fehlt, falscher Name), wird das nur als
// Warnung gemeldet -- der Rest des PDFs entsteht trotzdem.
async function fetchSignatureImages(ctx, offer, unterzeichnerConfig) {
  const keys = Array.isArray(offer.unterzeichner) ? offer.unterzeichner : [];
  const images = [];
  const warnings = [];
  if (!keys.length || !Array.isArray(unterzeichnerConfig)) return { images, warnings };

  for (const key of keys) {
    const cfg = unterzeichnerConfig.find((u) => u.key === key);
    if (!cfg) continue;
    try {
      const relPath = davPath([...ncSegments(SIGNATURE_FOLDER_PATH), cfg.datei].join("/"));
      const res = await proxyFetch(relPath, { method: "GET", headers: authHeader() });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const bytes = await res.arrayBuffer();
      const img = await ctx.pdfDoc.embedPng(bytes);
      images.push({ name: cfg.name, img });
    } catch (err) {
      warnings.push(`Unterschrift "${cfg.name}" konnte nicht geladen werden (${err.message}).`);
    }
  }
  return { images, warnings };
}

// Unterschriften nebeneinander, an der Unterkante ausgerichtet, Name
// darunter. Gibt die neue Y-Position zurück.
function drawSignatureImages(ctx, images, y) {
  if (!images.length) return y;
  y -= 10;
  const gap = 40;
  const maxImgHeight = maxSignatureImgHeight(images);

  let x = PDF_MARGIN;
  images.forEach(({ name, img }) => {
    const h = SIGNATURE_IMG_WIDTH * (img.height / img.width);
    ctx.page.drawImage(img, { x, y: y - maxImgHeight, width: SIGNATURE_IMG_WIDTH, height: h });
    drawText(ctx, name, x, y - maxImgHeight - 14, { size: SIZE_BODY, font: ctx.light });
    x += SIGNATURE_IMG_WIDTH + gap;
  });

  return y - maxImgHeight - 14 - 10;
}

function maxSignatureImgHeight(images) {
  if (!images.length) return null;
  return Math.max(...images.map(({ img }) => SIGNATURE_IMG_WIDTH * (img.height / img.width)));
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

// unterzeichnerConfig ([{key,name,datei}], aus ../shared/personen.json)
// wird von app.js übergeben statt hier selbst geladen, damit pdf.js von
// nichts aus app.js abhängt (siehe Kommentar oben).
async function exportOfferPdf(offer, absender, unterzeichnerConfig) {
  if (typeof PDFLib === "undefined" || typeof fontkit === "undefined") {
    throw new Error("PDF-Bibliothek nicht verfügbar (fürs erste Mal wird eine Internetverbindung gebraucht).");
  }
  initPdfColors();

  const { PDFDocument } = PDFLib;
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const [lightBytes, mediumBytes, italicBytes] = await Promise.all([
    fetch("../fonts/Nudica-Light.otf").then((r) => {
      if (!r.ok) throw new Error("Schriftdatei Nudica-Light.otf konnte nicht geladen werden");
      return r.arrayBuffer();
    }),
    fetch("../fonts/Nudica-Medium.otf").then((r) => {
      if (!r.ok) throw new Error("Schriftdatei Nudica-Medium.otf konnte nicht geladen werden");
      return r.arrayBuffer();
    }),
    fetch("../fonts/Nudica-LightItalic.otf").then((r) => {
      if (!r.ok) throw new Error("Schriftdatei Nudica-LightItalic.otf konnte nicht geladen werden");
      return r.arrayBuffer();
    })
  ]);

  const ctx = {
    pdfDoc,
    light: await pdfDoc.embedFont(lightBytes, { subset: false }),
    medium: await pdfDoc.embedFont(mediumBytes, { subset: false }),
    italic: await pdfDoc.embedFont(italicBytes, { subset: false }),
    page: null,
    y: 0
  };

  newPage(ctx);
  drawLetterPage(ctx, offer, absender);

  const { images: signatureImages, warnings } = await fetchSignatureImages(ctx, offer, unterzeichnerConfig);
  ctx.y = drawSignatureImages(ctx, signatureImages, ctx.y);

  newPage(ctx); // Offerte/Rechnung beginnt bewusst auf einer eigenen Seite
  drawPositionenPage(ctx, offer);

  const bytes = await pdfDoc.save();
  downloadPdfBytes(bytes, pdfFilename(offer));
  return { warnings };
}
