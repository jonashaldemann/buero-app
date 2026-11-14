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
     - OSRM       Route über beliebig viele Punkte, mit Alternativen
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

// Arbeitsstand des Dialogs (nicht gespeichert -- eine Quittung ist einmalig).
// kmOrte ist die Punktfolge der Fahrt: [0] Start, letzter Eintrag Ziel,
// dazwischen beliebig viele Zwischenstopps.
let kmOrte = []; // [{ text, ort: { label, kurz, lat, lon } | null }]
let kmRouten = []; // [{ meter, sekunden, punkte: [[lon,lat], ...] }]
let kmGewaehlt = 0;
let kmPdfBlob = null;

function leererOrt() {
  return { text: "", ort: null };
}
function kmOrtName(i) {
  if (i === 0) return "Start";
  if (i === kmOrte.length - 1) return "Ziel";
  return `Zwischenstopp ${i}`;
}
function kmOrteBereit() {
  return kmOrte.length >= 2 && kmOrte.every((o) => o.ort);
}
function kmZwischen() {
  return kmOrte.slice(1, -1);
}
function ortLabel(o) {
  return o && o.ort ? o.ort.label : (o ? o.text : "");
}
function ortKurz(o) {
  if (o && o.ort && o.ort.kurz) return o.ort.kurz;
  return ((o ? o.text : "") || "").split(",")[0].trim();
}

function fahrzeugListe() {
  const aus = (appConfig && appConfig.fahrzeuge) || [];
  const brauchbar = aus.filter((f) => f && f.name && Number(f.satz) > 0);
  return brauchbar.length ? brauchbar.map((f) => ({ name: f.name, satz: Number(f.satz) })) : KM_FAHRZEUGE_FALLBACK;
}

// ---------- Adresse -> Koordinaten ----------

// Nominatim liefert als `display_name` die ganze Kette ("12, Rautistrasse,
// Altstetten, Kreis 9, ..., 8047, Schweiz") -- fürs PDF richtig, für
// Dateiname und Verwendungszweck viel zu lang. Daraus die Teile zu raten
// geht schief (der erste Teil ist die Hausnummer, vor der PLZ steht mal
// die Stadt, mal der Kanton), deshalb kommt mit `addressdetails=1` die
// aufgeschlüsselte Adresse mit und daraus entsteht die Kurzform.
function kurzAdresse(a, ersatz) {
  const ausweg = String(ersatz || "").split(",")[0].trim();
  if (!a) return ausweg;
  const strasse = [a.road, a.house_number].filter(Boolean).join(" ");
  const ort = a.city || a.town || a.village || a.municipality || "";
  return [strasse || a.name || a.amenity || ausweg, ort].filter(Boolean).join(", ") || ausweg;
}

async function adresseSuchen(text) {
  const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&limit=5&countrycodes=ch,li,de,at,fr,it&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Adresssuche fehlgeschlagen (${res.status})`);
  const treffer = await res.json();
  return treffer.map((t) => ({
    label: t.display_name,
    kurz: kurzAdresse(t.address, t.display_name),
    lat: Number(t.lat),
    lon: Number(t.lon)
  }));
}

// ---------- Route ----------

// Alternativen gibt OSRM nur für eine Fahrt von A nach B aus -- und auch
// dort nur, wenn es eine wirklich ähnlich gute zweite Strecke gibt. Auf
// langen Autobahnfahrten (Zürich -> Bönigen) ist jede andere Variante
// deutlich länger, darum kommt genau eine Route zurück. Wer trotzdem eine
// bestimmte Strecke abrechnen will, setzt einen ZWISCHENSTOPP: mit mehr
// als zwei Punkten fährt OSRM garantiert dort durch -- Alternativen
// entfallen dann (die Route ist ja vorgegeben).
async function routeSuchen(orte) {
  const koordinaten = orte.map((o) => `${o.lon},${o.lat}`).join(";");
  const alternativen = orte.length === 2 ? "3" : "false";
  const url = `${OSRM_URL}/${koordinaten}?overview=full&geometries=geojson&alternatives=${alternativen}`;
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

async function zeichneKarte(canvas, route, zwischen = []) {
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

  // Start-, Zwischen- und Zielpunkte
  const marker = (p, fuellung, groesse = 10) => {
    const x = lonZuX(p[0], z) - links;
    const y = latZuY(p[1], z) - oben;
    ctx.beginPath();
    ctx.arc(x, y, groesse, 0, Math.PI * 2);
    ctx.fillStyle = fuellung;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  };
  // Zwischenstopps kleiner und in der Farbe der Linie -- sie sind Teil der
  // Strecke, nicht Anfang oder Ende.
  zwischen.forEach((o) => marker([o.lon, o.lat], "#4F7089", 7));
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

async function baueKmPdf({ datum, person, start, ziel, zwischen = [], km, fahrzeug, satz, hinUndZurueck, canvas }) {
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
  // Nominatim-Adressen sind lang -- was nicht auf die Zeile passt, wird
  // abgeschnitten, statt über den Blattrand hinauszulaufen.
  const aufBreite = (s, schrift, groesse) => {
    let t = String(s || "");
    if (schrift.widthOfTextAtSize(t, groesse) <= innen) return t;
    while (t.length > 1 && schrift.widthOfTextAtSize(t + "…", groesse) > innen) t = t.slice(0, -1);
    return t + "…";
  };

  text("Kilometer-Quittung", { groesse: 20, schrift: fett });
  y -= 18;
  text([datum, person].filter(Boolean).join(" · "), { groesse: 10, farbe: grau });
  y -= 28;

  text("Von", { groesse: 9, schrift: fett, farbe: grau });
  y -= 13;
  text(aufBreite(start, normal, 11), { groesse: 11 });
  y -= 20;
  text("Nach", { groesse: 9, schrift: fett, farbe: grau });
  y -= 13;
  text(aufBreite(ziel, normal, 11), { groesse: 11 });
  if (zwischen.length) {
    y -= 20;
    text("Über", { groesse: 9, schrift: fett, farbe: grau });
    y -= 13;
    text(aufBreite(zwischen.join(" · "), normal, 11), { groesse: 11 });
  }
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
  kmOrte = [leererOrt(), leererOrt()];
  kmRouten = [];
  kmGewaehlt = 0;
  kmPdfBlob = null;
  renderKmOrte();
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

// Die Adressfelder werden als Ganzes gerendert (Start, Zwischenstopps,
// Ziel), weil sich ihre Anzahl ändert. Getippter Text lebt in kmOrte[i].text
// weiter, damit ein neues Rendern nichts verliert.
function renderKmOrte() {
  const box = kmEl("kmOrte");
  box.innerHTML = kmOrte
    .map((o, i) => {
      const weg =
        i > 0 && i < kmOrte.length - 1
          ? `<button type="button" class="km-stopp-weg" data-weg="${i}" title="Zwischenstopp entfernen" aria-label="Zwischenstopp entfernen">&times;</button>`
          : "";
      return `<div class="km-ort">
        <label>${escapeHtml(kmOrtName(i))}</label>
        <div class="km-adresse">
          <input type="text" data-ort="${i}" placeholder="Strasse Nr, PLZ Ort" autocomplete="off" value="${escapeHtml(o.text)}">
          <button type="button" class="btn-secondary" data-suche="${i}">Suchen</button>
          ${weg}
        </div>
        <div class="km-treffer-liste" data-treffer="${i}"></div>
      </div>`;
    })
    .join("");

  box.querySelectorAll("input[data-ort]").forEach((el) => {
    const i = Number(el.dataset.ort);
    el.addEventListener("input", () => {
      kmOrte[i].text = el.value;
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      sucheAdresse(i);
    });
  });
  box.querySelectorAll("[data-suche]").forEach((el) => {
    el.addEventListener("click", () => sucheAdresse(Number(el.dataset.suche)));
  });
  box.querySelectorAll("[data-weg]").forEach((el) => {
    el.addEventListener("click", () => entferneZwischenstopp(Number(el.dataset.weg)));
  });
}

function neuerZwischenstopp() {
  kmOrte.splice(kmOrte.length - 1, 0, leererOrt());
  renderKmOrte();
  kmEl("kmOrte").querySelector(`input[data-ort="${kmOrte.length - 2}"]`)?.focus();
}

function entferneZwischenstopp(i) {
  kmOrte.splice(i, 1);
  renderKmOrte();
  if (kmOrteBereit()) holeRoute();
}

// Dreht die ganze Fahrt um: die Zwischenstopps kommen in umgekehrter
// Reihenfolge, das ist der Rückweg.
function tauscheStartZiel() {
  kmOrte.reverse();
  renderKmOrte();
  if (kmOrteBereit()) holeRoute();
}

function trefferBox(i) {
  return kmEl("kmOrte").querySelector(`[data-treffer="${i}"]`);
}

// Adressfeld -> Koordinaten. Mehrere Treffer kommen als Auswahlliste.
async function sucheAdresse(i) {
  const eingabe = (kmOrte[i] ? kmOrte[i].text : "").trim();
  const listeEl = trefferBox(i);
  if (!eingabe || !listeEl) return;
  listeEl.innerHTML = '<div class="km-treffer-lade">Suche…</div>';
  try {
    const treffer = await adresseSuchen(eingabe);
    if (!treffer.length) {
      listeEl.innerHTML = '<div class="km-treffer-lade">Nichts gefunden.</div>';
      return;
    }
    listeEl.innerHTML = treffer
      .map(
        (t, n) =>
          `<button type="button" class="km-treffer" data-treffer-ort="${i}" data-i="${n}">${escapeHtml(t.label)}</button>`
      )
      .join("");
    listeEl.dataset.gefunden = JSON.stringify(treffer);
  } catch (err) {
    listeEl.innerHTML = `<div class="km-treffer-lade">${escapeHtml(err.message)}</div>`;
  }
}

function waehleTreffer(i, n) {
  const listeEl = trefferBox(i);
  const treffer = JSON.parse((listeEl && listeEl.dataset.gefunden) || "[]")[n];
  if (!treffer || !kmOrte[i]) return;
  kmOrte[i].ort = treffer;
  kmOrte[i].text = treffer.label;
  const feld = kmEl("kmOrte").querySelector(`input[data-ort="${i}"]`);
  if (feld) feld.value = treffer.label;
  listeEl.innerHTML = "";
  if (kmOrteBereit()) holeRoute();
}

async function holeRoute() {
  const hinweis = kmEl("kmErgebnis");
  hinweis.textContent = "Route wird gesucht…";
  hinweis.className = "test-result";
  try {
    kmRouten = await routeSuchen(kmOrte.map((o) => o.ort));
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
  // Erklärt die häufigste Rückfrage: auf vielen Strecken kennt OSRM gar
  // keine zweite sinnvolle Variante (siehe routeSuchen()).
  const nurEine = kmRouten.length === 1 && kmOrte.length === 2;
  kmEl("kmRoutenHinweis").hidden = !nurEine;
}

async function zeigeRoute() {
  const route = kmRouten[kmGewaehlt];
  if (!route) return;
  kmEl("kmKartenBlock").hidden = false;
  kmEl("kmStrecke").value = String(Math.round(route.meter / 100) / 10);
  rechneKmTotal();
  await zeichneKarte(kmEl("kmKarte"), route, kmZwischen().map((o) => o.ort).filter(Boolean));
}

function kmDaten() {
  const f = gewaehltesFahrzeug();
  const km = gefahreneKm();
  return {
    datum: kmEl("kmDatum").value || formatDate(new Date()),
    person: personName(),
    start: ortLabel(kmOrte[0]),
    ziel: ortLabel(kmOrte[kmOrte.length - 1]),
    zwischen: kmZwischen().map((o) => ortKurz(o)).filter(Boolean),
    startKurz: ortKurz(kmOrte[0]),
    zielKurz: ortKurz(kmOrte[kmOrte.length - 1]),
    km,
    fahrzeug: f.name,
    satz: f.satz,
    hinUndZurueck: kmEl("kmHinZurueck").checked,
    canvas: kmEl("kmKarte")
  };
}

// sanitizeForFilename() kappt bei 60 Zeichen -- deshalb hier nur Strasse
// und Nummer, auf 20 Zeichen gekürzt, damit das Datum am Schluss sicher
// im Dateinamen bleibt.
function kmDateiname(d) {
  const kurz = (s) => String(s || "").split(",")[0].trim().slice(0, 20).trim();
  return sanitizeForFilename(`Fahrt ${kurz(d.startKurz)}-${kurz(d.zielKurz)} ${d.datum}`) + ".pdf";
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
    const ueber = daten.zwischen.length ? ` über ${daten.zwischen.join(", ")}` : "";
    document.getElementById("receiptPurpose").value =
      `Fahrt ${daten.startKurz} – ${daten.zielKurz}${ueber}, ` +
      `${kmZahl(daten.km)} km × ${daten.satz.toFixed(2)} (${daten.fahrzeug})`;
  } catch (err) {
    hinweis.textContent = "Fehler: " + err.message;
    hinweis.className = "test-result err";
  }
}

function initKmTool() {
  kmEl("kmBtn").addEventListener("click", oeffneKmDialog);
  kmEl("closeKm").addEventListener("click", schliesseKmDialog);
  kmEl("kmStoppBtn").addEventListener("click", neuerZwischenstopp);
  kmEl("kmTauschBtn").addEventListener("click", tauscheStartZiel);
  kmEl("kmOverlay").addEventListener("click", (e) => {
    const treffer = e.target.closest("[data-treffer-ort]");
    if (treffer) return waehleTreffer(Number(treffer.dataset.trefferOrt), Number(treffer.dataset.i));
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
