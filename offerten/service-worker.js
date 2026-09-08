const CACHE_NAME = "offerten-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./pdf.js",
  "./manifest.json",
  "../shared/common.js",
  "../css/style.css",
  "../icons/offerten-192.png",
  "../icons/offerten-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
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

// App-Shell: aus Cache, Fallback Netz. absender.json/unterzeichner.json
// bewusst NICHT in ASSETS gelistet -- die sollen immer frisch vom Netz
// kommen, damit Änderungen (Adresse, neue/andere Unterzeichner etc.) ohne
// Code-Update ankommen. Die PDF-Bibliothek
// (CDN) und die Nudica-.otf-Schriftdateien für den PDF-Export sind
// ebenfalls bewusst nicht vorab gecacht -- ein einzelner fehlgeschlagener
// Cross-Origin-Fetch würde sonst das ganze cache.addAll() beim Install
// scheitern lassen und die App-Shell selbst offline unbrauchbar machen.
// "PDF erstellen" braucht deshalb (zumindest beim ersten Mal pro
// Browser-Cache) eine Internetverbindung; Liste/Bearbeiten/Speichern
// funktionieren offline unverändert.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
