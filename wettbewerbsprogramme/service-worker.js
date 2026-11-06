const CACHE_NAME = "wettbewerbsprogramme-v8";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "../shared/common.js",
  "../css/style.css",
  "../icons/wettbewerb-192.png",
  "../icons/wettbewerb-512.png"
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
