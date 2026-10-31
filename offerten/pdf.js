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
const FRENCH_MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"
];

// Sprachumschaltung Deutsch/Französisch -- nur bei Rechnungen wählbar
// (offer.sprache, siehe app.js applyTypVisibility()/blankOffer()), Offerten
// bleiben immer Deutsch. ctx.lang wird einmal in exportOfferPdf() gesetzt,
// T(ctx) liefert darüber das passende Textbausteine-Set; einzige Stelle, an
// der sprachspezifische PDF-Texte definiert sind.
const PDF_I18N = {
  de: {
    colModul: "Modul", colStunden: "Stunden", colKosten: "Kosten",
    pauschal: "Pauschal",
    titelOfferte: "Offerte", titelRechnung: "Rechnung",
    nrOfferte: "Offert-Nr.", nrRechnung: "Rechnungs-Nr.",
    datum: "Datum",
    stundensatzHinweis: (frBetrag, isRechnung) =>
      isRechnung
        ? `Der mittlere Stundensatz beträgt ${frBetrag}`
        : `Der mittlere Stundensatz beträgt ${frBetrag} Das Honorar wird nach effektivem Zeitaufwand abgerechnet, dabei gilt der total geschätzte Stundenaufwand als Kostendach.`,
    nebenkostenpauschale: "Nebenkostenpauschale",
    honorar: "Honorar",
    rundungsrabatt: "Rundungsrabatt",
    zwischentotal: "Zwischentotal exkl. MWST",
    mwst: (prozent) => `MWST ${prozent}%`,
    totalRechnung: "Rechnungsbetrag inkl. MWST",
    totalOfferte: "Total inkl. MWST",
    zahlbar: "Zahlbar innert 30 Tagen",
    stundentotal: "Stundentotal",
    std: "Std.",
    months: GERMAN_MONTHS,
    // Amtliche Beschriftungen der Schweizer QR-Rechnung (SIX "Swiss
    // Implementation Guidelines QR-bill") -- bewusst NICHT frei übersetzt,
    // sondern die vorgeschriebenen Begriffe, siehe drawQrBillPage() unten.
    qrBill: {
      receipt: "Empfangsschein",
      paymentPart: "Zahlteil",
      account: "Konto / Zahlbar an",
      payableByEmpty: "Zahlbar durch (Name/Adresse)",
      currency: "Währung",
      amount: "Betrag",
      acceptancePoint: "Annahmestelle"
    }
  },
  fr: {
    colModul: "Module", colStunden: "Heures", colKosten: "Coût",
    pauschal: "Forfait",
    titelOfferte: "Offre", titelRechnung: "Facture",
    nrOfferte: "N° d'offre", nrRechnung: "N° de facture",
    datum: "Date",
    stundensatzHinweis: (frBetrag, isRechnung) =>
      isRechnung
        ? `Le taux horaire moyen est de ${frBetrag}`
        : `Le taux horaire moyen est de ${frBetrag}. Les honoraires sont facturés selon le temps effectivement consacré, le nombre d'heures total estimé constituant un plafond de coûts.`,
    nebenkostenpauschale: "Forfait de frais annexes",
    honorar: "Honoraires",
    rundungsrabatt: "Rabais d'arrondi",
    zwischentotal: "Sous-total hors TVA",
    mwst: (prozent) => `TVA ${prozent}%`,
    totalRechnung: "Montant de la facture TVA incl.",
    totalOfferte: "Total TVA incl.",
    zahlbar: "Payable dans un délai de 30 jours",
    stundentotal: "Total des heures",
    std: "h",
    months: FRENCH_MONTHS,
    qrBill: {
      receipt: "Récépissé",
      paymentPart: "Section paiement",
      account: "Compte / Payable à",
      payableByEmpty: "Payable par (nom/adresse)",
      currency: "Monnaie",
      amount: "Montant",
      acceptancePoint: "Point de dépôt"
    }
  }
};
function T(ctx) {
  return PDF_I18N[ctx.lang] || PDF_I18N.de;
}

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
// Deutsch: "5. Oktober 2026" (Punkt nach der Tageszahl). Französisch: "5
// octobre 2026" (ohne Punkt) -- übliche Schreibweise im jeweiligen Sprachraum.
function chDateLong(dateStr, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || "");
  if (!m) return dateStr || "";
  const day = parseInt(m[3], 10);
  const months = lang === "fr" ? FRENCH_MONTHS : GERMAN_MONTHS;
  const month = months[parseInt(m[2], 10) - 1] || "";
  return lang === "fr" ? `${day} ${month} ${m[1]}` : `${day}. ${month} ${m[1]}`;
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
  // wiederholter Absender darüber (bewusst weggelassen, der Absenderblock
  // oben rechts reicht).
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
  const ortDatum = [absender && absender.ort, chDateLong(offer.datum, ctx.lang)].filter(Boolean).join(", ");
  if (ortDatum) drawText(ctx, ortDatum, rightX, y2, { size: SIZE_BODY, font: ctx.light, align: "right" });

  y2 -= 28;
  const titleWord = offer.typ === "rechnung" ? T(ctx).titelRechnung : T(ctx).titelOfferte;
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
  drawText(ctx, T(ctx).colModul, COL_TITLE_X, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
  if (!ctx.hideStunden) {
    drawText(ctx, T(ctx).colStunden, COL_STUNDEN_RIGHT, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
  }
  drawText(ctx, T(ctx).colKosten, COL_KOSTEN_RIGHT, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED, align: "right" });
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
  if (!ctx.hideStunden) {
    drawText(ctx, pauschalAktiv ? T(ctx).pauschal : chNumberPdf(p.stunden), COL_STUNDEN_RIGHT, ctx.y, {
      size: SIZE_BODY,
      font: ctx.light,
      color: pauschalAktiv ? PDF_COLOR_MUTED : undefined,
      align: "right"
    });
  }
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

// Reine Berechnung (keine Zeichen-Aufrufe) -- ausgelagert aus drawTotals(),
// damit drawQrBillPage() (siehe unten, QR-Rechnung-Anhang) exakt denselben,
// bereits gerundeten Endbetrag verwenden kann wie die gedruckte Summenzeile
// "Rechnungsbetrag inkl. MWST". Zwei unabhängige Berechnungen hätten bei
// künftigen Änderungen auseinanderlaufen können.
function computeTotals(offer) {
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

  return { rate, stundenTotal, nebenkosten, subtotalRoh, mwstProzent, rundungsrabatt, subtotal, mwst, total };
}

function drawTotals(ctx, offer) {
  const { rate, nebenkosten, subtotalRoh, mwstProzent, rundungsrabatt, subtotal, mwst, total } = computeTotals(offer);
  const labelX = COL_STUNDEN_RIGHT - 140;

  ensureSpace(ctx, 175);
  ctx.y -= 10;

  // Stundensatz-Hinweis ergibt keinen Sinn, wenn gar keine Position nach
  // Stunden abgerechnet wird (siehe ctx.hideStunden/allePositionenPauschal()).
  if (!ctx.hideStunden) {
    const stundensatzHinweis = T(ctx).stundensatzHinweis(chFrPdf(rate), offer.typ === "rechnung");
    wrapText(ctx.light, stundensatzHinweis, SIZE_SMALL, PDF_CONTENT_WIDTH).forEach((line) => {
      ensureSpace(ctx, 13);
      drawText(ctx, line, PDF_MARGIN, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
      ctx.y -= 13;
    });
    ctx.y -= 10;
  }

  const rows = [];
  if (nebenkosten) rows.push([T(ctx).nebenkostenpauschale, chFrPdf(nebenkosten)]);
  if (rundungsrabatt) {
    rows.push([T(ctx).honorar, chFrRoundedPdf(subtotalRoh)]);
    rows.push([T(ctx).rundungsrabatt, `−${chFrRoundedPdf(rundungsrabatt)}`]);
  }
  rows.push(
    [T(ctx).zwischentotal, chFrRoundedPdf(subtotal)],
    [T(ctx).mwst(chNumberPdf(mwstProzent)), chFrRoundedPdf(mwst)]
  );
  rows.forEach(([label, val]) => {
    drawText(ctx, label, labelX, ctx.y, { size: SIZE_BODY, font: ctx.light });
    drawText(ctx, val, COL_KOSTEN_RIGHT, ctx.y, { size: SIZE_BODY, font: ctx.light, align: "right" });
    ctx.y -= 15;
  });

  ctx.y -= 4;
  drawRule(ctx, ctx.y + 10, { x0: labelX });
  const totalLabel = offer.typ === "rechnung" ? T(ctx).totalRechnung : T(ctx).totalOfferte;
  drawText(ctx, totalLabel, labelX, ctx.y, { size: SIZE_BODY, font: ctx.medium });
  drawText(ctx, chFrRoundedPdf(total), COL_KOSTEN_RIGHT, ctx.y, { size: SIZE_BODY, font: ctx.medium, align: "right" });
  ctx.y -= 26;

  if (offer.typ === "rechnung") {
    ensureSpace(ctx, 20);
    drawText(ctx, T(ctx).zahlbar, PDF_MARGIN, ctx.y, { size: SIZE_SMALL, font: ctx.light, color: PDF_COLOR_MUTED });
    ctx.y -= 13;
  }
}

// Direkt unter den Modulen statt im Abrechnungsblock -- Stunden sind keine
// Frankenbeträge und würden dort mit Nebenkosten/Zwischentotal/MWST/Total
// vermischt, ausserdem macht das den Abrechnungsblock unnötig lang.
function drawStundenTotalRow(ctx, stundenTotal) {
  ensureSpace(ctx, 26);
  ctx.y -= 2;
  drawText(ctx, T(ctx).stundentotal, COL_TITLE_X, ctx.y, { size: SIZE_SMALL, font: ctx.medium, color: PDF_COLOR_MUTED });
  drawText(ctx, `${chNumberPdf(stundenTotal)} ${T(ctx).std}`, COL_STUNDEN_RIGHT, ctx.y, { size: SIZE_SMALL, font: ctx.medium, color: PDF_COLOR_MUTED, align: "right" });
  ctx.y -= 22;
}

// Sind ALLE Module pauschal abgerechnet (kein einziges nach Stunden), macht
// jeder Stunden-/Stundensatz-Bezug im PDF keinen Sinn -- weder die
// Stunden-Spalte noch "Stundentotal" noch der Stundensatz-Hinweis (siehe
// ctx.hideStunden, gesetzt in drawPositionenPage()). Eine leere Positionen-
// liste zählt nicht als "nur Pauschal" (es gibt dann schlicht nichts zu
// verbergen, normale Spalten bleiben sichtbar).
function allePositionenPauschal(offer) {
  const moduln = (offer.positionen || []).filter((p) => p.typ === "modul");
  return moduln.length > 0 && moduln.every((m) => m.pauschalAktiv);
}

function drawPositionenPage(ctx, offer) {
  ctx.hideStunden = allePositionenPauschal(offer);
  const titleWord = (offer.typ === "rechnung" ? T(ctx).titelRechnung : T(ctx).titelOfferte).toUpperCase();
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

  const nrLabel = offer.typ === "rechnung" ? T(ctx).nrRechnung : T(ctx).nrOfferte;
  const metaLines = [];
  if (offer.offert_nr) metaLines.push(`${nrLabel} ${offer.offert_nr}`);
  metaLines.push(`${T(ctx).datum} ${chDateShort(offer.datum)}`);
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

  if (!ctx.hideStunden) drawStundenTotalRow(ctx, stundenTotal);
  drawTotals(ctx, offer);
}

// ---------- QR-Rechnung (Swiss QR-bill) ----------
//
// Nur bei Rechnungen, automatisch als zusätzliche, eigene A4-Seite ans PDF
// angehängt (Block flächenbündig unten, Oberseite leer -- so handhaben es
// die meisten Buchhaltungsprogramme auch) -- SOFERN absender.iban gesetzt
// ist. Das Feld existiert bewusst nicht in der Repo-Vorlage, sondern muss
// einmalig manuell in der _absender.json auf Nextcloud ergänzt werden
// (siehe README "Absenderadresse") -- fehlt es, wird die Seite übersprungen
// und eine Warnung zurückgegeben (siehe exportOfferPdf()), der Rest des PDFs
// entsteht trotzdem normal.
//
// Format: "Swiss Payments Code" (SPC), 31 Textzeilen in fixer Reihenfolge
// gemäss den "Swiss Implementation Guidelines QR-bill" von SIX, als QR-Code
// kodiert (Fehlerkorrektur M, Byte-Modus/UTF-8 -- siehe qrcode-generator via
// CDN in index.html). Referenznummer bewusst immer "NON" (keine Referenz) --
// entspricht der bisher vom Büro genutzten Vorlage (reine IBAN-Zahlung ohne
// Referenz). Layout (Empfangsschein/Zahlteil, 210×105mm) und Beschriftungen
// sind von SIX ebenfalls vorgegeben -- deshalb bewusst NICHT die Hausschrift
// (Nudica), sondern die dafür zugelassene Standardschrift Helvetica (in
// pdf-lib fest eingebaut, kein Font-Download nötig, siehe ctx.helv/helvBold).
// "Zahlbar durch" (Debitor) bewusst IMMER leer gelassen -- Empfänger/Adresse
// der Rechnung sind freier Text ohne Längenbeschränkung und liefen bei
// langen Adressen im gedruckten Empfangsschein/Zahlteil (feste 52/87mm
// Spaltenbreite, kein Zeilenumbruch) bis in die QR-Code-Fläche hinein.

const QR_BILL_HEIGHT_MM = 105;
const QR_CODE_SIZE_MM = 46;

function mm2pt(mm) {
  return mm * 2.83465;
}

// Schweizer Konvention: PLZ+Ort stehen zusammen auf der letzten Adresszeile
// ("9000 St. Gallen"). absender.plz_ort ist bereits genau so eine Zeile
// (siehe shared/common.js-Nutzung in drawLetterPage() oben); absender.ort
// dient hier nur als Fallback, falls das Regex ausnahmsweise nicht greift.
function splitAbsenderAddress(absender) {
  const m = /^(\d{4})\s*(.*)$/.exec((absender && absender.plz_ort) || "");
  return {
    name: (absender && absender.name) || "",
    street: (absender && absender.adresse) || "",
    plz: m ? m[1] : "",
    ort: (m && m[2]) || (absender && absender.ort) || "",
    land: "CH"
  };
}

// SPC-Payload-Felder sind zeilenbasiert (ein Feld = eine Zeile) -- Umbrüche
// vorsichtshalber entfernen, falls ein Wert aus einem mehrzeiligen Textfeld
// stammt.
function spcField(s) {
  return String(s ?? "").replace(/[\r\n]+/g, " ").trim();
}

function buildSpcPayload(offer, absender, totalAmount) {
  const creditor = splitAbsenderAddress(absender);
  const message = spcField(offer.offert_nr ? `Rechnung ${offer.offert_nr}` : offer.projekt || "").slice(0, 140);

  const lines = [
    "SPC", "0200", "1",
    spcField(absender.iban).replace(/\s/g, "").toUpperCase(),
    "S", spcField(creditor.name), spcField(creditor.street), "", spcField(creditor.plz), spcField(creditor.ort), creditor.land,
    "", "", "", "", "", "", "", // Ultimate Creditor -- immer leer, veraltetes Feld
    totalAmount.toFixed(2), "CHF",
    "", "", "", "", "", "", "", // Debitor ("Zahlbar durch") -- siehe Kommentar oben, bewusst immer leer
    "NON", "", // Referenztyp/Referenz -- bewusst immer ohne Referenz
    message,
    "EPD"
  ];
  return lines.join("\n");
}

// isDark(row, col) -- empirisch gegen die eingebaute, garantiert korrekte
// createDataURL()-Referenzfunktion der Bibliothek verifiziert (pixelgleicher
// Vergleich), NICHT nur aus der Doku übernommen: ein vertauschtes row/col
// hätte einen optisch wie ein QR-Code aussehenden, aber unlesbaren Code
// erzeugt -- bei einem Zahlungsbeleg inakzeptabel.
function qrModuleMatrix(payload) {
  const qr = qrcode(0, "M"); // Typ 0 = automatische Grösse, Fehlerkorrektur M (SIX-Vorgabe)
  qr.addData(payload, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < count; r++) {
    const row = [];
    for (let c = 0; c < count; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

function drawQrModules(ctx, rows, xLeft, yTop, sizePt) {
  const count = rows.length;
  const cell = sizePt / count;
  ctx.page.drawRectangle({ x: xLeft, y: yTop - sizePt, width: sizePt, height: sizePt, color: PDFLib.rgb(1, 1, 1) });
  rows.forEach((rowVals, r) => {
    rowVals.forEach((dark, c) => {
      if (!dark) return;
      // +0.25pt Überlappung gegen Haarlinien-Lücken zwischen Modulen durch
      // Rundungsfehler beim separaten Zeichnen jedes einzelnen Rechtecks.
      ctx.page.drawRectangle({ x: xLeft + c * cell, y: yTop - (r + 1) * cell, width: cell + 0.25, height: cell + 0.25, color: PDFLib.rgb(0, 0, 0) });
    });
  });
}

// Schweizerkreuz in der Mitte des QR-Codes -- Masse gemäss SIX-Vorgabe,
// bezogen auf einen 46mm-Code (weisses Feld 7mm, schwarzes Feld 6mm,
// Kreuzbalken 1.17mm dick/3.89mm lang).
function drawSwissCross(ctx, xLeft, yTop, sizePt) {
  const cx = xLeft + sizePt / 2;
  const cy = yTop - sizePt / 2;
  const rect = (w, h, color) => ctx.page.drawRectangle({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, color });
  rect(mm2pt(7), mm2pt(7), PDFLib.rgb(1, 1, 1));
  rect(mm2pt(6), mm2pt(6), PDFLib.rgb(0, 0, 0));
  rect(mm2pt(3.89), mm2pt(1.17), PDFLib.rgb(1, 1, 1));
  rect(mm2pt(1.17), mm2pt(3.89), PDFLib.rgb(1, 1, 1));
}

function formatIbanSpaced(iban) {
  const clean = String(iban || "").replace(/\s/g, "");
  return (clean.match(/.{1,4}/g) || [clean]).join(" ");
}

// Sichtbarer Betrag auf dem Beleg: Tausender-Trennung mit Leerschlag statt
// Apostroph (anders als sonst im PDF, siehe chNumberPdf() oben) -- so
// schreibt es SIX für die QR-Rechnung vor (vergleiche mitgelieferte Vorlage).
function formatAmountSpaced(n) {
  const [intPart, dec] = Number(n).toFixed(2).split(".");
  return `${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${dec}`;
}

function drawQrBillPage(ctx, offer, absender, totalAmount) {
  newPage(ctx);
  const L = T(ctx).qrBill;
  const blockTopY = mm2pt(QR_BILL_HEIGHT_MM); // Block belegt die untersten 105mm der Seite
  const X = (mm) => mm2pt(mm);
  const Y = (mm) => blockTopY - mm2pt(mm); // mm = Abstand von der Oberkante des Blocks

  const modules = qrModuleMatrix(buildSpcPayload(offer, absender, totalAmount));

  // Trennlinien (Empfangsschein/Zahlteil, und oberer Rand des Blocks)
  ctx.page.drawLine({ start: { x: X(0), y: blockTopY }, end: { x: X(210), y: blockTopY }, thickness: 0.75, color: PDF_COLOR_BORDER, dashArray: [1, 2] });
  ctx.page.drawLine({ start: { x: X(62), y: 0 }, end: { x: X(62), y: blockTopY }, thickness: 0.75, color: PDF_COLOR_BORDER, dashArray: [1, 2] });

  const creditorLines = (addr) => [formatIbanSpaced(absender.iban), addr.name, addr.street, `${addr.plz} ${addr.ort}`.trim()];
  const creditorAddr = splitAbsenderAddress(absender);

  // ---------- Empfangsschein (links, Breite 52mm) ----------
  drawText(ctx, L.receipt, X(5), Y(5), { size: 11, font: ctx.helvBold });

  drawText(ctx, L.account, X(5), Y(12), { size: 6, font: ctx.helvBold, color: PDF_COLOR_MUTED });
  creditorLines(creditorAddr).forEach((line, i) => drawText(ctx, line, X(5), Y(17 + i * 4), { size: 8, font: ctx.helv }));

  // "Zahlbar durch" bewusst immer leer -- siehe Kommentar oben.
  drawText(ctx, L.payableByEmpty, X(5), Y(37), { size: 6, font: ctx.helvBold, color: PDF_COLOR_MUTED });

  drawText(ctx, L.currency, X(5), Y(68), { size: 6, font: ctx.helvBold, color: PDF_COLOR_MUTED });
  drawText(ctx, L.amount, X(20), Y(68), { size: 6, font: ctx.helvBold, color: PDF_COLOR_MUTED });
  drawText(ctx, "CHF", X(5), Y(73), { size: 8, font: ctx.helv });
  drawText(ctx, formatAmountSpaced(totalAmount), X(20), Y(73), { size: 8, font: ctx.helv });

  drawText(ctx, L.acceptancePoint, X(57), Y(88), { size: 6, font: ctx.helvBold, color: PDF_COLOR_MUTED, align: "right" });

  // ---------- Zahlteil (rechts): QR-Code-Spalte + Konto-/Debitor-Spalte ----------
  drawText(ctx, L.paymentPart, X(67), Y(5), { size: 11, font: ctx.helvBold });

  drawQrModules(ctx, modules, X(67), Y(17), mm2pt(QR_CODE_SIZE_MM));
  drawSwissCross(ctx, X(67), Y(17), mm2pt(QR_CODE_SIZE_MM));

  drawText(ctx, L.currency, X(67), Y(68), { size: 8, font: ctx.helvBold, color: PDF_COLOR_MUTED });
  drawText(ctx, L.amount, X(89), Y(68), { size: 8, font: ctx.helvBold, color: PDF_COLOR_MUTED });
  drawText(ctx, "CHF", X(67), Y(73), { size: 10, font: ctx.helv });
  drawText(ctx, formatAmountSpaced(totalAmount), X(89), Y(73), { size: 10, font: ctx.helv });

  drawText(ctx, L.account, X(118), Y(5), { size: 8, font: ctx.helvBold, color: PDF_COLOR_MUTED });
  creditorLines(creditorAddr).forEach((line, i) => drawText(ctx, line, X(118), Y(10 + i * 4.5), { size: 10, font: ctx.helv }));

  // "Zahlbar durch" bewusst immer leer -- siehe Kommentar oben.
  drawText(ctx, L.payableByEmpty, X(118), Y(32), { size: 8, font: ctx.helvBold, color: PDF_COLOR_MUTED });
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

// unterzeichnerConfig ([{key,name,datei}], aus der zentralen config.json)
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
    // Standardschriften (in pdf-lib fest eingebaut, kein Download) -- NUR für
    // die QR-Rechnung (drawQrBillPage()), siehe Kommentar dort: SIX schreibt
    // dafür eine der zugelassenen Standardschriften vor, nicht die Hausschrift.
    helv: await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica),
    helvBold: await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold),
    page: null,
    y: 0,
    // siehe PDF_I18N/T() oben -- nur bei Rechnungen wählbar, Offerten immer
    // Deutsch (auch falls offer.sprache aus einem früheren Rechnungs-Zustand
    // des Formulars "fr" trägt, z.B. nach Typ-Wechsel ohne Zwischenspeichern).
    lang: offer.typ === "rechnung" && offer.sprache === "fr" ? "fr" : "de"
  };

  newPage(ctx);
  drawLetterPage(ctx, offer, absender);

  const { images: signatureImages, warnings } = await fetchSignatureImages(ctx, offer, unterzeichnerConfig);
  ctx.y = drawSignatureImages(ctx, signatureImages, ctx.y);

  newPage(ctx); // Offerte/Rechnung beginnt bewusst auf einer eigenen Seite
  drawPositionenPage(ctx, offer);

  // QR-Rechnung: nur bei Rechnungen, nur wenn absender.iban gesetzt ist
  // (siehe Kommentar bei drawQrBillPage() oben) -- fehlt sie, wird das als
  // Warnung gemeldet statt den PDF-Export abzubrechen.
  if (offer.typ === "rechnung") {
    if (absender && absender.iban) {
      const { total } = computeTotals(offer);
      drawQrBillPage(ctx, offer, absender, total);
    } else {
      warnings.push('QR-Rechnung konnte nicht erstellt werden: IBAN fehlt in den Absender-Stammdaten ("iban" in _absender.json auf Nextcloud ergänzen).');
    }
  }

  const bytes = await pdfDoc.save();
  downloadPdfBytes(bytes, pdfFilename(offer));
  return { warnings };
}
