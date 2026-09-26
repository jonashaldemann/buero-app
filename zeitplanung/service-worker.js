/* Redirect-Stub: "Zeitplanung" wurde nach ../timeline/ verschoben und in
   "Timeline" umbenannt. Dieser Service Worker existiert nur noch, damit
   bereits installierte/gecachte alte Versionen an dieser Adresse zuverlässig
   auf die neue Version (den Redirect-Stub in index.html) aktualisiert
   werden, statt für immer die alte, alte gecachte App weiter auszuliefern. */
const CACHE_NAME = "zeitplanung-redirect-v1";
const ASSETS = ["./", "./index.html", "./manifest.json"];

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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
