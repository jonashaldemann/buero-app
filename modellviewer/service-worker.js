const CACHE_NAME = "modellviewer-v8";
const ASSETS = [
  "./",
  "./index.html",
  "./ansicht.html",
  "./app.js",
  "./ansicht.js",
  "./viewer.js",
  "./dateien.js",
  "./viewer.css",
  "./manifest.json",
  "../shared/common.js",
  "../css/style.css",
  "../icons/modellviewer-192.png",
  "../icons/modellviewer-512.png",
  // three.js liegt als Kopie im Repo (MIT-Lizenz) statt an einem CDN: die
  // Apps haben keinen Build-Schritt, sollen offline laufen und nichts an
  // fremde Server melden -- das gilt besonders für die Kundenansicht.
  "./vendor/three.module.js",
  "./vendor/addons/controls/OrbitControls.js",
  "./vendor/addons/loaders/GLTFLoader.js",
  "./vendor/addons/loaders/DRACOLoader.js",
  "./vendor/addons/loaders/OBJLoader.js",
  "./vendor/addons/loaders/MTLLoader.js",
  "./vendor/addons/utils/BufferGeometryUtils.js",
  "./vendor/addons/environments/RoomEnvironment.js",
  "./vendor/addons/libs/draco/gltf/draco_wasm_wrapper.js",
  "./vendor/addons/libs/draco/gltf/draco_decoder.wasm"
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

// App-Shell aus dem Cache, Fallback Netz. Die Modelle selbst liegen auf
// Nextcloud und laufen über den Worker-Proxy -- die kommen nie von hier
// (anderer Origin, und ein 200-MB-Modell hat im App-Cache nichts verloren).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
