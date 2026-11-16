/* ============================================================
   Version eines Moduls hochzählen.

   Hintergrund: GitHub Pages liefert ALLES mit "Cache-Control: max-age=600".
   Der Browser bedient sich dadurch bis zu zehn Minuten aus seinem eigenen
   HTTP-Cache -- und zwar OHNE den Service Worker zu fragen (gemessen: beim
   Neuladen sieht der Worker nur die Nextcloud-Aufrufe, nicht index.html,
   app.js oder common.js). Deshalb half nach einem Deploy nur noch
   "Webseite vergessen" im Browser, was die Zugangsdaten gleich mit löscht.

   Lösung: die Seiten verweisen auf ihre Dateien mit "?v=<nummer>". Eine
   neue Nummer ist eine neue Adresse, die in keinem Cache liegen kann. Die
   Nummer ist dieselbe wie im CACHE_NAME des Service Workers -- dieses
   Skript zählt beide gemeinsam hoch, damit sie nie auseinanderlaufen.

   Aufruf:
     node version.mjs baukosten          ein Modul
     node version.mjs baukosten offerten mehrere
     node version.mjs --alle             alle (nach Änderungen an
                                         shared/common.js oder css/style.css)
   ============================================================ */

import fs from "node:fs";
import path from "node:path";

const WURZEL = path.dirname(new URL(import.meta.url).pathname);

function module_() {
  return fs
    .readdirSync(WURZEL, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(WURZEL, e.name, "service-worker.js")))
    .map((e) => e.name)
    .concat(fs.existsSync(path.join(WURZEL, "service-worker.js")) ? ["."] : []);
}

// Alle HTML-Dateien eines Moduls -- der Modellviewer hat zwei (Büro- und
// Kundenseite), die Zeiterfassung eine im Unterordner dashboard/. Ein
// Unterordner mit EIGENEM service-worker.js ist ein eigenes Modul und wird
// übersprungen: sonst stempelte die Wurzel ihre Nummer auf alle elf.
function htmlDateien(ordner, wurzel) {
  const treffer = [];
  const suche = (d) => {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (["vendor", "node_modules", ".git"].includes(e.name)) return;
        if (d === wurzel && fs.existsSync(path.join(p, "service-worker.js"))) return;
        suche(p);
      } else if (e.name.endsWith(".html")) treffer.push(p);
    });
  };
  suche(ordner);
  return treffer;
}

function hochzaehlen(modul) {
  const ordner = path.join(WURZEL, modul);
  const swPfad = path.join(ordner, "service-worker.js");
  const sw = fs.readFileSync(swPfad, "utf8");
  const treffer = sw.match(/const CACHE_NAME = "([a-z-]*?)v(\d+)";/);
  if (!treffer) throw new Error(`${modul}: kein CACHE_NAME gefunden`);
  const neu = Number(treffer[2]) + 1;
  fs.writeFileSync(swPfad, sw.replace(treffer[0], `const CACHE_NAME = "${treffer[1]}v${neu}";`));

  let seiten = 0;
  htmlDateien(ordner, ordner).forEach((p) => {
    const alt = fs.readFileSync(p, "utf8");
    // Nur EIGENE Dateien versionieren -- die Bibliotheken von den CDNs
    // tragen ihre Version schon im Pfad.
    const text = alt.replace(
      /((?:src|href)=")((?!https?:)[^"]+\.(?:js|css))(?:\?v=\d+)?(")/g,
      (_, vor, datei, nach) => `${vor}${datei}?v=${neu}${nach}`
    );
    if (text !== alt) {
      fs.writeFileSync(p, text);
      seiten++;
    }
  });
  console.log(`${modul.padEnd(22)} v${neu}   (${seiten} Seite${seiten === 1 ? "" : "n"})`);
}

const argumente = process.argv.slice(2);
const ziele = argumente.includes("--alle") ? module_() : argumente;
if (!ziele.length) {
  console.log("Aufruf: node version.mjs <modul> [...]   oder   node version.mjs --alle");
  process.exit(1);
}
ziele.forEach(hochzaehlen);
