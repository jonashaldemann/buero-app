/* ============================================================
   Modellviewer -- Ordner lesen und Dateien holen.

   Beide Seiten des Moduls brauchen dasselbe: "sag mir, was in diesem
   Modellordner liegt" und "lade mir diese Dateien mit Fortschrittsanzeige".
   Unterschiedlich ist nur, WIE der Ordner erreichbar ist -- deshalb
   bekommen alle Funktionen hier eine Hole-Funktion übergeben:

     hole(relativerPfad, optionen) -> Promise<Response>

   Büro (index.html): angemeldeter Nextcloud-Zugang über shared/common.js.
   Kunde (ansicht.html): passwortgeschützter Freigabelink, ohne Login.
   ============================================================ */

// Unterstützte Hauptdateien. Alles andere in einem Modellordner sind
// Beidateien (.mtl, Texturen, .bin) -- die werden beim Laden über den
// LoadingManager nachgeschlagen, nicht einzeln geöffnet.
export const MODELL_ENDUNGEN = [".glb", ".gltf", ".obj"];

export function istModellDatei(name) {
  const n = String(name || "").toLowerCase();
  return MODELL_ENDUNGEN.some((e) => n.endsWith(e));
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>';

// Ordner mit Unterordnern sind bei Modellen die Regel (OBJ-Exporte legen
// Texturen gern in "textures/"). Nextcloud beantwortet PROPFIND mit
// "Depth: infinity" aus gutem Grund nicht, also Ebene für Ebene -- mit einer
// Grenze, damit ein versehentlich freigegebener Riesenordner nicht hunderte
// Anfragen auslöst.
const MAX_TIEFE = 3;

export class HttpFehler extends Error {
  constructor(status, text) {
    super(text || `HTTP ${status}`);
    this.status = status;
  }
}

function hrefSegmente(href) {
  return href
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch (e) {
        return s;
      }
    });
}

// Liest eine PROPFIND-Antwort und gibt die Einträge EINER Ebene zurück --
// ohne den abgefragten Ordner selbst (der steht immer als erster drin).
function leseEbene(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const antworten = Array.from(doc.getElementsByTagNameNS("DAV:", "response"));
  if (!antworten.length) return [];
  const basis = hrefSegmente(antworten[0].getElementsByTagNameNS("DAV:", "href")[0]?.textContent || "");
  return antworten.slice(1).map((r) => {
    const segmente = hrefSegmente(r.getElementsByTagNameNS("DAV:", "href")[0]?.textContent || "");
    const laenge = r.getElementsByTagNameNS("DAV:", "getcontentlength")[0];
    return {
      name: segmente[segmente.length - 1] || "",
      pfad: segmente.slice(basis.length).join("/"),
      istOrdner: !!r.getElementsByTagNameNS("DAV:", "collection").length,
      groesse: laenge ? Number(laenge.textContent) || 0 : 0
    };
  });
}

// Eine Ebene eines Ordners: Dateien UND Unterordner. Die Verwaltung
// braucht sie, um die Modellordner aufzulisten.
export async function ordnerEbene(hole, pfad) {
  const res = await hole(pfad, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body: PROPFIND_BODY
  });
  if (!res.ok) throw new HttpFehler(res.status, `Ordner lesen fehlgeschlagen (${res.status})`);
  return leseEbene(await res.text());
}

// Alle Dateien im Ordner, Unterordner eingeschlossen. pfad ist relativ zur
// Hole-Funktion ("" = deren Wurzel), die Rückgabe-Pfade ebenso.
export async function ordnerInhalt(hole, pfad = "", tiefe = 0) {
  const ebene = await ordnerEbene(hole, pfad ? `${pfad}/` : "");
  const dateien = [];
  for (const eintrag of ebene) {
    const vollerPfad = pfad ? `${pfad}/${eintrag.pfad}` : eintrag.pfad;
    if (!eintrag.istOrdner) {
      dateien.push({ ...eintrag, pfad: vollerPfad });
    } else if (tiefe < MAX_TIEFE) {
      dateien.push(...(await ordnerInhalt(hole, vollerPfad, tiefe + 1)));
    }
  }
  return dateien;
}

// Eine Datei mit Fortschritt. Content-Length fehlt bei Antworten durch den
// Worker-Proxy manchmal -- dann meldet onTeil nur die bisher gelesenen
// Bytes und der Aufrufer rechnet mit der Grösse aus dem Ordnerlisting.
async function holeMitFortschritt(hole, pfad, onTeil) {
  const res = await hole(pfad, { method: "GET" });
  if (!res.ok) throw new HttpFehler(res.status, `"${pfad}" konnte nicht geladen werden (${res.status})`);
  if (!res.body || !onTeil) return await res.arrayBuffer();

  const leser = res.body.getReader();
  const stuecke = [];
  let gelesen = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    stuecke.push(value);
    gelesen += value.length;
    // Gemeldet wird der Stand DIESER Datei, nicht die Grösse des Stücks --
    // der Aufrufer zählt die bereits fertigen Dateien dazu.
    onTeil(gelesen);
  }
  const alles = new Uint8Array(gelesen);
  let pos = 0;
  stuecke.forEach((s) => {
    alles.set(s, pos);
    pos += s.length;
  });
  return alles.buffer;
}

// Lädt mehrere Dateien nacheinander (nicht parallel: bei grossen Modellen
// ist das für die Fortschrittsanzeige ehrlicher und schont den Proxy) und
// gibt sie als Map Dateiname -> ArrayBuffer zurück. Der Schlüssel ist der
// volle relative Pfad; der Viewer schlägt zusätzlich über den reinen
// Dateinamen nach.
export async function ladeDateien(hole, eintraege, onFortschritt) {
  const gesamt = eintraege.reduce((s, e) => s + (e.groesse || 0), 0);
  const dateien = new Map();
  let fertig = 0;
  for (const eintrag of eintraege) {
    const puffer = await holeMitFortschritt(hole, eintrag.pfad, (n) => {
      if (onFortschritt && gesamt) onFortschritt(Math.min(1, (fertig + n) / gesamt), eintrag.name);
    });
    fertig += puffer.byteLength;
    dateien.set(eintrag.pfad, puffer);
    if (onFortschritt) onFortschritt(gesamt ? Math.min(1, fertig / gesamt) : 0, eintrag.name);
  }
  return dateien;
}

export function formatiereGroesse(bytes) {
  if (!bytes) return "–";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
