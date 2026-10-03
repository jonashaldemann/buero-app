/* ============================================================
   Adressliste — Etiketten-PDF-Export (Adressetiketten auf einem A4-Bogen).

   Nutzt pdf-lib + @pdf-lib/fontkit (CDN, siehe <script>-Tags in
   index.html) sowie die echten Nudica-Schriftdateien in ../fonts/*.otf
   (NICHT die woff/woff2 -- die sind fürs Web-UI), bewusst OHNE Subsetting
   eingebettet (siehe ausführliche Begründung dazu in offerten/pdf.js --
   dieselbe pdf-lib/fontkit-Kompatibilitätsfrage gilt hier genauso).

   Eigenständig gehalten (keine Funktionen aus app.js verwendet -- die
   Kontaktliste wird als Parameter übergeben statt hier geladen), damit die
   Skript-Ladereihenfolge keine Rolle spielt (gleiches Vorbild wie
   offerten/pdf.js).

   Raster: bewusst ein generisches, selbst berechnetes Layout (3 Spalten ×
   7 Zeilen = 21 Etiketten/Bogen, je ca. 63×37mm) statt die Masse eines
   konkreten, im Handel erhältlichen Etiketten-Produkts nachzubilden -- ohne
   bekannte genaue Perforations-/Randmasse eines bestimmten Produkts wäre
   das nur geraten und könnte bei echten vorgeschnittenen Bögen leicht
   daneben liegen. Mit diesem Raster lässt sich notfalls auch auf normales
   Papier drucken und von Hand zuschneiden.
   ============================================================ */

const MM_TO_PT = 72 / 25.4;
function mm(v) { return v * MM_TO_PT; }

const LABEL_PAGE_WIDTH = mm(210);
const LABEL_PAGE_HEIGHT = mm(297);
const LABEL_COLS = 3;
const LABEL_ROWS = 7;
const LABEL_W = mm(63);
const LABEL_H = mm(37);
const LABEL_GAP_X = mm(2);
const LABEL_GAP_Y = mm(2);
const LABEL_MARGIN_X = (LABEL_PAGE_WIDTH - LABEL_COLS * LABEL_W - (LABEL_COLS - 1) * LABEL_GAP_X) / 2;
const LABEL_MARGIN_Y = (LABEL_PAGE_HEIGHT - LABEL_ROWS * LABEL_H - (LABEL_ROWS - 1) * LABEL_GAP_Y) / 2;
const LABEL_PADDING = mm(3);

const LABEL_SIZE_FIRMA = 10;
const LABEL_SIZE_BODY = 9.5;
const LABEL_LINE_HEIGHT = 12.5;

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

// Druckbare Zeilen eines Kontakts -- jede nur, falls tatsächlich vorhanden
// (siehe Todo "falls vorhanden"). { text, font, size }[].
function labelLines(data, fonts) {
  const lines = [];
  if (data.firma && data.firma.trim()) {
    lines.push({ text: data.firma.trim(), font: fonts.medium, size: LABEL_SIZE_FIRMA });
  }
  const name = [data.vorname, data.name].filter((s) => s && s.trim()).join(" ").trim();
  if (name) lines.push({ text: name, font: fonts.light, size: LABEL_SIZE_BODY });
  if (data.strasse && data.strasse.trim()) {
    lines.push({ text: data.strasse.trim(), font: fonts.light, size: LABEL_SIZE_BODY });
  }
  if (data.ort && data.ort.trim()) {
    lines.push({ text: data.ort.trim(), font: fonts.light, size: LABEL_SIZE_BODY });
  }
  return lines;
}

function drawLabel(page, x, yTop, data, fonts) {
  const maxWidth = LABEL_W - 2 * LABEL_PADDING;
  const wrapped = [];
  labelLines(data, fonts).forEach(({ text, font, size }) => {
    wrapText(font, text, size, maxWidth).forEach((line) => wrapped.push({ text: line, font, size }));
  });

  // Vertikal zentriert innerhalb des Etiketts, nicht an der oberen Kante --
  // bei wenigen Zeilen (z.B. nur Name + Ort) wirkt das deutlich ruhiger.
  const blockHeight = wrapped.length * LABEL_LINE_HEIGHT;
  let y = yTop - (LABEL_H - blockHeight) / 2 - LABEL_SIZE_FIRMA;

  wrapped.forEach(({ text, font, size }) => {
    if (y < yTop - LABEL_H + LABEL_PADDING) return; // Sicherheitsnetz, falls doch zu viele Zeilen
    page.drawText(text, { x: x + LABEL_PADDING, y, size, font, color: PDFLib.rgb(0.2, 0.2, 0.2) });
    y -= LABEL_LINE_HEIGHT;
  });
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

// contactsList: [{filename, data}] -- vom Aufrufer bereits gefiltert/sortiert
// (siehe visibleContacts() in app.js), genau wie beim CSV-Export "aktuelle
// Ansicht". Gibt { printedCount, skippedCount } zurück -- übersprungen
// werden Kontakte ganz ohne druckbare Zeilen (z.B. nur eine Telefonnummer).
async function exportLabelsPdf(contactsList) {
  if (typeof PDFLib === "undefined" || typeof fontkit === "undefined") {
    throw new Error("PDF-Bibliothek nicht verfügbar (fürs erste Mal wird eine Internetverbindung gebraucht).");
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
  const fonts = {
    light: await pdfDoc.embedFont(lightBytes, { subset: false }),
    medium: await pdfDoc.embedFont(mediumBytes, { subset: false })
  };

  const printable = contactsList.filter(({ data }) => labelLines(data, fonts).length > 0);
  const skippedCount = contactsList.length - printable.length;

  let page = null;
  let slot = 0; // Index auf der aktuellen Seite, 0..LABEL_COLS*LABEL_ROWS-1
  const perPage = LABEL_COLS * LABEL_ROWS;

  printable.forEach(({ data }) => {
    if (!page || slot >= perPage) {
      page = pdfDoc.addPage([LABEL_PAGE_WIDTH, LABEL_PAGE_HEIGHT]);
      slot = 0;
    }
    const col = slot % LABEL_COLS;
    const row = Math.floor(slot / LABEL_COLS);
    const x = LABEL_MARGIN_X + col * (LABEL_W + LABEL_GAP_X);
    const yTop = LABEL_PAGE_HEIGHT - LABEL_MARGIN_Y - row * (LABEL_H + LABEL_GAP_Y);
    drawLabel(page, x, yTop, data, fonts);
    slot++;
  });

  if (!page) page = pdfDoc.addPage([LABEL_PAGE_WIDTH, LABEL_PAGE_HEIGHT]); // leerer Bogen statt Fehler bei 0 Etiketten

  const bytes = await pdfDoc.save();
  downloadPdfBytes(bytes, `etiketten-${new Date().toISOString().slice(0, 10)}.pdf`);
  return { printedCount: printable.length, skippedCount };
}
