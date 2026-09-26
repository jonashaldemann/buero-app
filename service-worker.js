const CACHE_NAME = "buero-startseite-v10";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/home-192.png",
  "./icons/home-512.png",
  "./css/style.css",
  "./shared/common.js"
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

// Nur die Startseite selbst wird hier gecacht -- die Unterseiten
// (zeiterfassung/, quittung/, wettbewerbsprogramme/, offerten/,
// adressliste/, pendenzen/) haben je ihren eigenen, enger begrenzten
// Service Worker mit eigenem Scope.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
