const CACHE_NAME = "adressliste-v15";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./etiketten.js",
  "./plz-data.js",
  "./manifest.json",
  "../shared/common.js",
  "../css/style.css",
  "../icons/adressliste-192.png",
  "../icons/adressliste-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // cache: "reload" ist hier entscheidend: ohne das holt addAll() die
    // Dateien durch den HTTP-Cache, und GitHub Pages liefert alles mit
    // "Cache-Control: max-age=600" -- ein frisch deployter Worker legte
    // dann bis zu zehn Minuten alte Dateien in seinen neuen Cache und
    // servierte sie anschliessend cache-first weiter. Die neue Version kam
    // dadurch trotz Reload nicht an.
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS.map((pfad) => new Request(pfad, { cache: "reload" }))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App-Shell: aus Cache, Fallback Netz. Adressen und Ansichten liegen auf
// Nextcloud (siehe app.js), nicht hier -- die kommen sowieso nie aus dem
// Service-Worker-Cache. Die PDF-Bibliothek (CDN) und die Nudica-.otf-
// Schriftdateien für den Etiketten-Export sind bewusst nicht vorab gecacht
// -- ein fehlgeschlagener Cross-Origin-Fetch würde sonst das ganze
// cache.addAll() beim Install scheitern lassen (siehe offerten/
// service-worker.js für dieselbe Begründung). Der Etiketten-Export braucht
// deshalb (zumindest beim ersten Mal pro Browser-Cache) eine
// Internetverbindung.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
