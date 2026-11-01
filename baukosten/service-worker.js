const CACHE_NAME = "baukosten-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./bkp.js",
  "./manifest.json",
  "../shared/common.js",
  "../css/style.css",
  "../icons/baukosten-192.png",
  "../icons/baukosten-512.png"
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

// App-Shell (inkl. BKP-Katalog) aus dem Cache, Fallback Netz. Die
// Kostenschätzungen selbst liegen auf Nextcloud (siehe app.js) und kommen
// immer frisch, nie aus dem Service-Worker-Cache.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
