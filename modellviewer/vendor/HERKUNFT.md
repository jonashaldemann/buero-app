# Fremder Code in diesem Ordner

Beide Bibliotheken liegen bewusst als Kopie im Repo statt an einem CDN: die
Büro-Apps haben keinen Build-Schritt, sollen offline laufen und -- das ist
bei der Kundenansicht (`ansicht.html`) der wichtigste Punkt -- beim Öffnen
eines Modells nichts an fremde Server melden.

## three.js 0.169.0 (MIT, `LIZENZ-three.txt`)

Aus dem npm-Paket `three@0.169.0`, unverändert übernommen:

| Datei hier | Quelle im Paket |
| --- | --- |
| `three.module.js` | `build/three.module.js` |
| `addons/controls/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` |
| `addons/loaders/GLTFLoader.js` | `examples/jsm/loaders/GLTFLoader.js` |
| `addons/loaders/DRACOLoader.js` | `examples/jsm/loaders/DRACOLoader.js` |
| `addons/loaders/OBJLoader.js` | `examples/jsm/loaders/OBJLoader.js` |
| `addons/loaders/MTLLoader.js` | `examples/jsm/loaders/MTLLoader.js` |
| `addons/utils/BufferGeometryUtils.js` | `examples/jsm/utils/BufferGeometryUtils.js` (von GLTFLoader gebraucht) |
| `addons/environments/RoomEnvironment.js` | `examples/jsm/environments/RoomEnvironment.js` |

Die Zusatzmodule importieren `three` als blanken Namen; aufgelöst wird das
ohne Build-Schritt über die Import-Map in `index.html` und `ansicht.html`.

## Draco-Decoder (Apache 2.0, `LIZENZ-draco.txt`)

`addons/libs/draco/gltf/` aus demselben three.js-Paket. Gebraucht nur für
glTF-Dateien mit Draco-Komprimierung (viele Exporte sind damit ein Vielfaches
kleiner). Die reine JavaScript-Notlösung `draco_decoder.js` (0,5 MB) ist
bewusst NICHT dabei -- sie greift nur ohne WebAssembly, das jeder Browser
seit 2017 kann.

## Aktualisieren

Version in allen Pfaden ersetzen, Dateien einzeln neu holen (`curl` von
`https://cdn.jsdelivr.net/npm/three@<version>/...`), danach die Imports der
Zusatzmodule prüfen (`grep -h "from '" addons/*/*.js`) -- kommt ein neues
Modul dazu, muss es hier UND in `modellviewer/service-worker.js` stehen.
