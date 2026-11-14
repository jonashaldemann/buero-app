/* ============================================================
   Kilometer-Quittung — Spesenbeleg für eine gefahrene Strecke.

   Start- und Zieladresse eingeben, die App sucht die Route, zeichnet sie
   auf eine Karte und macht daraus ein A4-PDF mit der Abrechnung darunter
   (gefahrene Kilometer × Ansatz des Fahrzeugs).

   KEIN Google Maps, sondern OpenStreetMap -- aus drei Gründen: die
   Google-APIs brauchen alle einen Schlüssel, der in diesem öffentlichen
   Repo stünde; es braucht ein Konto mit Kreditkarte; und vor allem käme
   das Kartenbild gar nicht ins PDF (ein eingebettetes Google-Fenster lässt
   sich nicht als Bild auslesen, und die Nutzungsbedingungen verbieten es).
   Die drei OSM-Dienste hier brauchen keinen Schlüssel und schicken alle
   CORS-Header, weshalb sich die Kacheln auf ein Canvas zeichnen und von
   dort sauber ins PDF übernehmen lassen:

     - Nominatim  Adresse -> Koordinaten
     - OSRM       Route zwischen zwei Punkten, inklusive Alternativen
     - OSM-Tiles  die Kartenkacheln

   Alle drei sind für gelegentliche Nutzung gedacht und erlauben sie
   ausdrücklich -- ein paar Quittungen pro Woche sind das. Bei jedem
   Kartenbild steht die verlangte Quellenangabe.

   Die Karte wird bewusst SELBST auf ein Canvas gezeichnet statt über eine
   Kartenbibliothek: dasselbe Bild, das am Bildschirm steht, wandert so
   unverändert ins PDF, und es braucht keine weitere Abhängigkeit.
   ============================================================ */

// Fallback, falls in der zentralen config.json keine Fahrzeuge stehen.
// Der Ansatz gehört dem Büro, nicht dem Programm -- siehe fahrzeugListe().
const KM_FAHRZEUGE_FALLBACK = [
  { name: "VW-Bus", satz: 0.7 },
  { name: "Citroën", satz: 0.45 }
];

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const TILE_URL = "https://tile.openstreetmap.org";
const KARTE_BREITE = 1200; // Pixel; ergibt im A4-PDF rund 150 dpi
const KARTE_HOEHE = 820;

// Arbeitsstand des Dialogs (nicht gespeichert -- eine Quittung ist einmalig)
let kmStart = null; // { label, lat, lon }
let kmZiel = null;
let kmRouten = []; // [{ meter, sekunden, punkte: [[lon,lat], ...] }]
let kmGewaehlt = 0;
let kmPdfBlob = null;

function fahrzeugListe() {
  const aus = (appConfig && appConfig.fahrzeuge) || [];
  const brauchbar = aus.filter((f) => f && f.name && Number(f.satz) > 0);
  return brauchbar.length ? brauchbar.map((f) => ({ name: f.name, satz: Number(f.satz) })) : KM_FAHRZEUGE_FALLBACK;
}

// ---------- Adresse -> Koordinaten ----------

async function adresseSuchen(text) {
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=5&countrycodes=ch,li,de,at,fr,it&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Adresssuche fehlgeschlagen (${res.status})`);
  const treffer = await res.json();
  return treffer.map((t) => ({ label: t.display_name, lat: Number(t.lat), lon: Number(t.lon) }));
}

// ---------- Route ----------

// alternatives=true liefert bis zu drei Varianten -- genau dafür, dass man
// die tatsächlich gefahrene Strecke auswählen kann statt der kürzesten.
async function routeSuchen(a, b) {
  const url = `${OSRM_URL}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&alternatives=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routensuche fehlgeschlagen (${res.status})`);
  const daten = await res.json();
  if (daten.code !== "Ok" || !(daten.routes || []).length) throw new Error("Keine Route gefunden.");
  return daten.routes.map((r) => ({
    meter: r.distance,
    sekunden: r.duration,
    punkte: r.geometry.coordinates
  }));
}

// ---------- Karte zeichnen ----------

// Web-Mercator: Längen-/Breitengrad -> Pixel auf der Weltkarte einer
// Zoomstufe (256 Pixel pro Kachel).
function lonZuX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z) * 256;
}
function latZuY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

// Grösste Zoomstufe, bei der die ganze Route noch ins Bild passt.
function passenderZoom(punkte, breite, hoehe) {
  const lons = punkte.map((p) => p[0]);
  const lats = punkte.map((p) => p[1]);
  const [lonMin, lonMax] = [Math.min(...lons), Math.max(...lons)];
  const [latMin, latMax] = [Math.min(...lats), Math.max(...lats)];
  for (let z = 17; z >= 1; z--) {
    const dx = Math.abs(lonZuX(lonMax, z) - lonZuX(lonMin, z));
    const dy = Math.abs(latZuY(latMin, z) - latZuY(latMax, z));
    if (dx <= breite - 80 && dy <= hoehe - 80) return z;
  }
  return 1;
}

function kachelLaden(z, x, y) {
  return new Promise((fertig) => {
    const img = new Image();
    // Ohne crossOrigin wäre das Canvas "tainted" und liesse sich nicht mehr
    // auslesen -- dann gäbe es kein Bild fürs PDF.
    img.crossOrigin = "anonymous";
    img.onload = () => fertig(img);
    img.onerror = () => fertig(null); // fehlende Kachel: bleibt einfach leer
    img.src = `${TILE_URL}/${z}/${x}/${y}.png`;
  });
}

async function zeichneKarte(canvas, route) {
  const punkte = route.punkte;
  const breite = canvas.width;
  const hoehe = canvas.height;
  const z = passenderZoom(punkte, breite, hoehe);
  const xs = punkte.map((p) => lonZuX(p[0], z));
  const ys = punkte.map((p) => latZuY(p[1], z));
  // Mittelpunkt der Route -> linke obere Ecke des Ausschnitts
  const mitteX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const mitteY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const links = mitteX - breite / 2;
  const oben = mitteY - hoehe / 2;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#E8E4DC";
  ctx.fillRect(0, 0, breite, hoehe);

  const maxKachel = Math.pow(2, z);
  const kacheln = [];
  for (let kx = Math.floor(links / 256); kx <= Math.floor((links + breite) / 256); kx++) {
    for (let ky = Math.floor(oben / 256); ky <= Math.floor((oben + hoehe) / 256); ky++) {
      if (ky < 0 || ky >= maxKachel) continue;
      kacheln.push({ kx: ((kx % maxKachel) + maxKachel) % maxKachel, ky, px: kx * 256 - links, py: ky * 256 - oben });
    }
  }
  const bilder = await Promise.all(kacheln.map((k) => kachelLaden(z, k.kx, k.ky)));
  bilder.forEach((img, i) => {
    if (img) ctx.drawImage(img, kacheln[i].px, kacheln[i].py, 256, 256);
  });

  // Route: erst breit und hell, dann schmal und kräftig -- so bleibt sie
  // auch über dunklen Kartenstellen lesbar.
  const linie = () => {
    ctx.beginPath();
    punkte.forEach((p, i) => {
      const x = lonZuX(p[0], z) - links;
      const y = latZuY(p[1], z) - oben;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  };
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  linie();
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 11;
  ctx.stroke();
  linie();
  ctx.strokeStyle = "#4F7089";
  ctx.lineWidth = 6;
  ctx.stroke();

  // Start- und Zielpunkt
  const marker = (p, fuellung) => {
    const x = lonZuX(p[0], z) - links;
    const y = latZuY(p[1], z) - oben;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = fuellung;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  };
  marker(punkte[0], "#4A7856");
  marker(punkte[punkte.length - 1], "#C97960");

  // Quellenangabe -- von der OSM-Lizenz verlangt, gehört aufs Bild selbst,
  // damit sie auch im PDF steht.
  const hinweis = "© OpenStreetMap-Mitwirkende";
  ctx.font = "16px system-ui, sans-serif";
  const textBreite = ctx.measureText(hinweis).width;
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillRect(breite - textBreite - 18, hoehe - 30, textBreite + 14, 24);
  ctx.fillStyle = "#46433C";
  ctx.fillText(hinweis, breite - textBreite - 11, hoehe - 12);
  return canvas;
}

// ---------- PDF ----------

function kmBetrag(km, satz) {
  return Math.round(km * satz * 100) / 100;
}

async function baueKmPdf({ datum, person, start, ziel, km, fahrzeug, satz, hinUndZurueck, canvas }) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  const seite = pdf.addPage([595.28, 841.89]); // A4 hoch
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const fett = await pdf.embedFont(StandardFonts.HelveticaBold);
  const rand = 50;
  const innen = 595.28 - 2 * rand;
  const dunkel = rgb(0.27, 0.26, 0.24);
  const grau = rgb(0.54, 0.52, 0.47);
  let y = 841.89 - rand;

  const text = (s, { x = rand, groesse = 10, schrift = normal, farbe = dunkel } = {}) => {
    seite.drawText(String(s), { x, y, size: groesse, font: schrift, color: farbe });
  };
  const rechts = (s, { groesse = 10, schrift = normal, farbe = dunkel } = {}) => {
    const b = schrift.widthOfTextAtSize(String(s), groesse);
    seite.drawText(String(s), { x: 595.28 - rand - b, y, size: groesse, font: schrift, color: farbe });
  };

  text("Kilometer-Quittung", { groesse: 20, schrift: fett });
  y -= 18;
  text([datum, person].filter(Boolean).join(" · "), { groesse: 10, farbe: grau });
  y -= 28;

  text("Von", { groesse: 9, schrift: fett, farbe: grau });
  y -= 13;
  text(start, { groesse: 11 });
  y -= 20;
  text("Nach", { groesse: 9, schrift: fett, farbe: grau });
  y -= 13;
  text(ziel, { groesse: 11 });
  y -= 10;

  // Karte: volle Textbreite, Seitenverhältnis des Canvas beibehalten
  const bild = await pdf.embedJpg(canvasZuJpegBytes(canvas));
  const bildHoehe = (innen * canvas.height) / canvas.width;
  y -= bildHoehe;
  seite.drawImage(bild, { x: rand, y, width: innen, height: bildHoehe });
  y -= 30;

  // Abrechnung
  seite.drawLine({ start: { x: rand, y: y + 12 }, end: { x: 595.28 - rand, y: y + 12 }, thickness: 0.7, color: grau });
  const zeile = (links, rechtsText, { schrift = normal, groesse = 11 } = {}) => {
    text(links, { groesse, schrift });
    rechts(rechtsText, { groesse, schrift });
    y -= 18;
  };
  zeile(`Strecke${hinUndZurueck ? " (Hin- und Rückfahrt)" : ""}`, `${kmZahl(km)} km`);
  zeile(`Ansatz ${fahrzeug}`, `${satz.toFixed(2)} Fr./km`);
  y -= 4;
  seite.drawLine({ start: { x: rand, y: y + 12 }, end: { x: 595.28 - rand, y: y + 12 }, thickness: 0.7, color: dunkel });
  zeile("Total", `CHF ${franken2(kmBetrag(km, satz))}`, { schrift: fett, groesse: 13 });

  y = rand;
  text("Kartendaten © OpenStreetMap-Mitwirkende · Route: OSRM", { groesse: 8, farbe: grau });

  const bytes = await pdf.save();
  return new Blob([bytes], { type: "application/pdf" });
}

// Zwei Nachkommastellen, Schweizer Schreibweise -- die Beträge einer
// Quittung müssen zum Rappen stimmen.
function franken2(wert) {
  return wert.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Kilometer: höchstens eine Nachkommastelle, Schweizer Schreibweise.
function kmZahl(wert) {
  return Number(wert).toLocaleString("de-CH", { maximumFractionDigits: 1 });
}

function canvasZuJpegBytes(canvas) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  return base64ToUint8Array(dataUrl.split(",")[1]);
}

// ---------- Dialog ----------

function kmEl(id) {
  return document.getElementById(id);
}

function oeffneKmDialog() {
  kmStart = null;
  kmZiel = null;
  kmRouten = [];
  kmGewaehlt = 0;
  kmPdfBlob = null;
  kmEl("kmStart").value = "";
  kmEl("kmZiel").value = "";
  kmEl("kmDatum").value = formatDate(new Date());
  kmEl("kmHinZurueck").checked = false;
  kmEl("kmStrecke").value = "";
  kmEl("kmRouten").innerHTML = "";
  kmEl("kmKarte").getContext("2d").clearRect(0, 0, KARTE_BREITE, KARTE_HOEHE);
  kmEl("kmKartenBlock").hidden = true;
  kmEl("kmErgebnis").textContent = "";
  kmEl("kmErgebnis").className = "test-result";
  renderKmFahrzeuge();
  rechneKmTotal();
  kmEl("kmOverlay").classList.remove("hidden");
}

function schliesseKmDialog() {
  kmEl("kmOverlay").classList.add("hidden");
}

function renderKmFahrzeuge() {
  const liste = fahrzeugListe();
  kmEl("kmFahrzeug").innerHTML = liste
    .map((f, i) => `<option value="${i}"${i === 0 ? " selected" : ""}>${escapeHtml(f.name)} · ${f.satz.toFixed(2)} Fr./km</option>`)
    .join("");
}

function gewaehltesFahrzeug() {
  return fahrzeugListe()[Number(kmEl("kmFahrzeug").value) || 0] || KM_FAHRZEUGE_FALLBACK[0];
}

function gefahreneKm() {
  const roh = Number(String(kmEl("kmStrecke").value).replace(",", "."));
  if (!isFinite(roh) || roh <= 0) return 0;
  return kmEl("kmHinZurueck").checked ? roh * 2 : roh;
}

function rechneKmTotal() {
  const f = gewaehltesFahrzeug();
  const km = gefahreneKm();
  kmEl("kmTotal").textContent = km
    ? `${kmZahl(km)} km × ${f.satz.toFixed(2)} = CHF ${franken2(kmBetrag(km, f.satz))}`
    : "–";
  const bereit = km > 0 && kmRouten.length > 0;
  kmEl("kmPdfBtn").disabled = !bereit;
  kmEl("kmBelegBtn").disabled = !bereit;
}

// Adressfeld -> Koordinaten. Mehrere Treffer kommen als Auswahlliste.
async function sucheAdresse(feld) {
  const eingabe = kmEl(feld === "start" ? "kmStart" : "kmZiel").value.trim();
  const listeEl = kmEl(feld === "start" ? "kmStartTreffer" : "kmZielTreffer");
  if (!eingabe) return;
  listeEl.innerHTML = '<div class="km-treffer-lade">Suche…</div>';
  try {
    const treffer = await adresseSuchen(eingabe);
    if (!treffer.length) {
      listeEl.innerHTML = '<div class="km-treffer-lade">Nichts gefunden.</div>';
      return;
    }
    listeEl.innerHTML = treffer
      .map(
        (t, i) =>
          `<button type="button" class="km-treffer" data-feld="${feld}" data-i="${i}">${escapeHtml(t.label)}</button>`
      )
      .join("");
    listeEl.dataset.treffer = JSON.stringify(treffer);
  } catch (err) {
    listeEl.innerHTML = `<div class="km-treffer-lade">${escapeHtml(err.message)}</div>`;
  }
}

function waehleTreffer(feld, i) {
  const listeEl = kmEl(feld === "start" ? "kmStartTreffer" : "kmZielTreffer");
  const treffer = JSON.parse(listeEl.dataset.treffer || "[]")[i];
  if (!treffer) return;
  if (feld === "start") kmStart = treffer;
  else kmZiel = treffer;
  kmEl(feld === "start" ? "kmStart" : "kmZiel").value = treffer.label;
  listeEl.innerHTML = "";
  if (kmStart && kmZiel) holeRoute();
}

async function holeRoute() {
  const hinweis = kmEl("kmErgebnis");
  hinweis.textContent = "Route wird gesucht…";
  hinweis.className = "test-result";
  try {
    kmRouten = await routeSuchen(kmStart, kmZiel);
    kmGewaehlt = 0;
    renderRoutenAuswahl();
    await zeigeRoute();
    hinweis.textContent = "";
  } catch (err) {
    hinweis.textContent = "Fehler: " + err.message;
    hinweis.className = "test-result err";
  }
}

function renderRoutenAuswahl() {
  kmEl("kmRouten").innerHTML = kmRouten
    .map((r, i) => {
      const km = Math.round(r.meter / 100) / 10;
      const min = Math.round(r.sekunden / 60);
      return `<button type="button" class="km-route${i === kmGewaehlt ? " aktiv" : ""}" data-route="${i}">
        <span class="km-route-nr">Route ${i + 1}</span>
        <span class="km-route-wert">${kmZahl(km)} km · ${min} min</span>
      </button>`;
    })
    .join("");
}

async function zeigeRoute() {
  const route = kmRouten[kmGewaehlt];
  if (!route) return;
  kmEl("kmKartenBlock").hidden = false;
  kmEl("kmStrecke").value = String(Math.round(route.meter / 100) / 10);
  rechneKmTotal();
  await zeichneKarte(kmEl("kmKarte"), route);
}

function kmDaten() {
  const f = gewaehltesFahrzeug();
  const km = gefahreneKm();
  return {
    datum: kmEl("kmDatum").value || formatDate(new Date()),
    person: personName(),
    start: kmStart ? kmStart.label : kmEl("kmStart").value,
    ziel: kmZiel ? kmZiel.label : kmEl("kmZiel").value,
    km,
    fahrzeug: f.name,
    satz: f.satz,
    hinUndZurueck: kmEl("kmHinZurueck").checked,
    canvas: kmEl("kmKarte")
  };
}

function kmDateiname(d) {
  const kurz = (s) => (s || "").split(",")[0].trim();
  return sanitizeForFilename(`Fahrt ${kurz(d.start)}-${kurz(d.ziel)} ${d.datum}`) + ".pdf";
}

async function kmPdfErzeugen() {
  const d = kmDaten();
  const blob = await baueKmPdf(d);
  return { blob, name: kmDateiname(d), daten: d };
}

async function kmHerunterladen() {
  const hinweis = kmEl("kmErgebnis");
  try {
    hinweis.textContent = "PDF wird erstellt…";
    hinweis.className = "test-result";
    const { blob, name } = await kmPdfErzeugen();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    hinweis.textContent = `${name} heruntergeladen.`;
    hinweis.className = "test-result ok";
  } catch (err) {
    hinweis.textContent = "Fehler: " + err.message;
    hinweis.className = "test-result err";
  }
}

// Übergibt das fertige PDF an die normale Belegerfassung: Datei, Datum,
// Betrag und Verwendungszweck sind dort schon ausgefüllt, Konto/Kategorie
// und MwSt-Code wählt man wie bei jedem anderen Beleg.
async function kmAlsBeleg() {
  const hinweis = kmEl("kmErgebnis");
  try {
    hinweis.textContent = "PDF wird erstellt…";
    hinweis.className = "test-result";
    const { blob, name, daten } = await kmPdfErzeugen();
    const datei = new File([blob], name, { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(datei);
    schliesseKmDialog();
    openReceiptEntry();
    const feld = document.getElementById("receiptFile");
    feld.files = dt.files;
    document.getElementById("receiptFileName").textContent = name;
    document.getElementById("receiptDate").value = daten.datum;
    document.getElementById("receiptAmount").value = kmBetrag(daten.km, daten.satz).toFixed(2);
    document.getElementById("receiptPurpose").value =
      `Fahrt ${(daten.start || "").split(",")[0]} – ${(daten.ziel || "").split(",")[0]}, ` +
      `${kmZahl(daten.km)} km × ${daten.satz.toFixed(2)} (${daten.fahrzeug})`;
  } catch (err) {
    hinweis.textContent = "Fehler: " + err.message;
    hinweis.className = "test-result err";
  }
}

function initKmTool() {
  kmEl("kmBtn").addEventListener("click", oeffneKmDialog);
  kmEl("closeKm").addEventListener("click", schliesseKmDialog);
  kmEl("kmStartBtn").addEventListener("click", () => sucheAdresse("start"));
  kmEl("kmZielBtn").addEventListener("click", () => sucheAdresse("ziel"));
  ["kmStart", "kmZiel"].forEach((id) => {
    kmEl(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sucheAdresse(id === "kmStart" ? "start" : "ziel");
      }
    });
  });
  kmEl("kmOverlay").addEventListener("click", (e) => {
    const treffer = e.target.closest("[data-feld][data-i]");
    if (treffer) return waehleTreffer(treffer.dataset.feld, Number(treffer.dataset.i));
    const route = e.target.closest("[data-route]");
    if (route) {
      kmGewaehlt = Number(route.dataset.route);
      renderRoutenAuswahl();
      zeigeRoute();
    }
  });
  kmEl("kmStrecke").addEventListener("input", rechneKmTotal);
  kmEl("kmHinZurueck").addEventListener("change", rechneKmTotal);
  kmEl("kmFahrzeug").addEventListener("change", rechneKmTotal);
  kmEl("kmPdfBtn").addEventListener("click", kmHerunterladen);
  kmEl("kmBelegBtn").addEventListener("click", kmAlsBeleg);
}
