const CACHE_NAME = "buero-startseite-v23";
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

// Nur die Startseite selbst wird hier gecacht -- die Unterseiten
// (zeiterfassung/, quittung/, wettbewerbsprogramme/, offerten/,
// adressliste/, pendenzen/) haben je ihren eigenen, enger begrenzten
// Service Worker mit eigenem Scope.
// NETZ ZUERST, Cache als Rückfall. Vorher war es umgekehrt: die App kam
// aus dem Cache, und eine frisch deployte Fassung sah man erst, nachdem im
// Hintergrund ein neuer Worker installiert, aktiviert und die Seite neu
// geladen worden war. Ging davon etwas schief, half nur noch "Webseite
// vergessen" im Browser -- und das nimmt die Zugangsdaten gleich mit.
// Jetzt gilt: online immer die aktuelle Fassung, der Cache ist nur noch
// fürs Offline-Arbeiten da und wird bei jeder Antwort nachgeführt.
//
// `cache: "no-cache"` erzwingt dabei eine Rückfrage beim Server: GitHub
// Pages liefert alles mit "Cache-Control: max-age=600", sonst käme bis zu
// zehn Minuten lang die alte Datei aus dem HTTP-Cache des Browsers. Es ist
// kein voller Download -- unverändert antwortet der Server mit 304.
self.addEventListener("fetch", (event) => {
  const anfrage = event.request;
  if (anfrage.method !== "GET") return;
  // Fremde Adressen (Nextcloud über den Worker-Proxy, Karten) gehen den
  // gewöhnlichen Weg -- sie stehen nie im Cache.
  if (new URL(anfrage.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(anfrage, { cache: "no-cache" })
      .then((antwort) => {
        if (antwort && antwort.ok) {
          const kopie = antwort.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(anfrage, kopie));
        }
        return antwort;
      })
      // ignoreSearch: die Seiten verweisen mit "?v=<nummer>" auf ihre
      // Dateien (siehe version.mjs), im Cache stehen sie ohne.
      .catch(() =>
        caches.match(anfrage, { ignoreSearch: true }).then((cached) => cached || Response.error())
      )
  );
});

// Ein wartender Worker übernimmt auf Zuruf (siehe
// registerServiceWorkerWithAutoUpdate() in shared/common.js): installiert
// eine ältere Fassung den neuen Worker, ohne dass skipWaiting() greift,
// bliebe er sonst hängen, bis alle Tabs der Seite geschlossen sind -- und
// das sind elf Module auf derselben Adresse.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
