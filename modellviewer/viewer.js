/* ============================================================
   Modellviewer -- der eigentliche 3D-Viewer (three.js).

   Dieses Modul rendert NUR. Es holt selbst nichts aus dem Netz: ladeModell()
   bekommt die bereits heruntergeladenen Dateien als Map (Dateiname ->
   ArrayBuffer) übergeben. Dadurch funktioniert derselbe Viewer für beide
   Seiten des Moduls, die ihre Dateien auf ganz verschiedenen Wegen holen:

     index.html  (Büro)  -- über den angemeldeten Nextcloud-Zugang,
                            inklusive Demomodus (shared/common.js)
     ansicht.html (Kunde) -- über einen passwortgeschützten Freigabelink,
                            ganz ohne Login (ansicht.js)

   Die Bedienleiste baut der Viewer selbst in den übergebenen Container --
   so sehen Vorschau (Büro) und Kundenansicht garantiert gleich aus und es
   gibt die Schnitt-Logik nur einmal.
   ============================================================ */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Farben aus derselben Palette wie css/style.css -- der Viewer steht auf
// einer Seite ohne die übrige App-Oberfläche, soll aber nicht fremd wirken.
const FARBE_AKZENT = 0x4f7089;
const FARBE_ERSATZMATERIAL = 0xd8d4cc;

// ---------- Hilfsfunktionen ----------

function basisName(pfad) {
  return String(pfad).split(/[\\/]/).pop().toLowerCase();
}

function endung(name) {
  const n = basisName(name);
  const i = n.lastIndexOf(".");
  return i < 0 ? "" : n.slice(i);
}

function textVon(inhalt) {
  if (typeof inhalt === "string") return inhalt;
  return new TextDecoder().decode(inhalt instanceof ArrayBuffer ? inhalt : inhalt.buffer);
}

function pufferVon(inhalt) {
  if (typeof inhalt === "string") return new TextEncoder().encode(inhalt).buffer;
  return inhalt instanceof ArrayBuffer ? inhalt : inhalt.buffer;
}

function svg(d, viewBox = "0 0 24 24") {
  return `<svg viewBox="${viewBox}" width="18" height="18" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
}

// ---------- Viewer ----------

export function erstelleViewer(container) {
  container.classList.add("mv-viewer");
  // Ohne tabindex bekommt der Container keinen Fokus und die Pfeiltasten
  // (Schnitt fein verschieben) kämen nie an. -1: per Klick fokussierbar,
  // aber nicht in der Tabulator-Reihenfolge vor der Bedienleiste.
  container.setAttribute("tabindex", "-1");
  container.innerHTML = `
    <div class="mv-canvas"></div>
    <div class="mv-status" hidden></div>
    <div class="mv-bar">
      <div class="mv-bar-zeile mv-bar-haupt">
        <button type="button" class="mv-btn" data-mv="fit" title="Alles zeigen">${svg("M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM4 15h2v3h3v2H4v-5zm14 0h2v5h-5v-2h3v-3z")}<span>Alles</span></button>
        <div class="mv-gruppe" data-mv="ansichten">
          <button type="button" class="mv-btn" data-mv-ansicht="axo" title="Schrägansicht">Axo</button>
          <button type="button" class="mv-btn" data-mv-ansicht="vorne" title="Ansicht von vorne">Vorne</button>
          <button type="button" class="mv-btn" data-mv-ansicht="hinten" title="Ansicht von hinten">Hinten</button>
          <button type="button" class="mv-btn" data-mv-ansicht="links" title="Ansicht von links">Links</button>
          <button type="button" class="mv-btn" data-mv-ansicht="rechts" title="Ansicht von rechts">Rechts</button>
          <button type="button" class="mv-btn" data-mv-ansicht="oben" title="Ansicht von oben">Oben</button>
        </div>
        <button type="button" class="mv-btn" data-mv="projektion" title="Perspektive / Parallelprojektion">Persp.</button>
        <div class="mv-gruppe" data-mv="schnittachsen">
          <span class="mv-label">Schnitt</span>
          <button type="button" class="mv-btn" data-mv-achse="x" title="Schnitt quer zur X-Achse">X</button>
          <button type="button" class="mv-btn" data-mv-achse="y" title="Waagrechter Schnitt (Grundriss)">Y</button>
          <button type="button" class="mv-btn" data-mv-achse="z" title="Schnitt quer zur Z-Achse">Z</button>
        </div>
        <button type="button" class="mv-btn" data-mv="boden" title="Boden und Schatten ein-/ausblenden">${svg("M2 18h20v2H2v-2zm4-4h12v2H6v-2zm3-4h6v2H9v-2z")}</button>
        <button type="button" class="mv-btn" data-mv="gitter" title="Drahtgitter ein-/ausblenden">${svg("M3 3h18v18H3V3zm2 2v5h5V5H5zm7 0v5h5V5h-5zM5 12v5h5v-5H5zm7 0v5h5v-5h-5z")}</button>
        <button type="button" class="mv-btn" data-mv="bild" title="Bild speichern">${svg("M12 15.5L7 10.5l1.4-1.4 2.6 2.6V3h2v8.7l2.6-2.6L17 10.5l-5 5zM5 19h14v2H5v-2z")}</button>
        <button type="button" class="mv-btn" data-mv="vollbild" title="Vollbild">${svg("M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z")}</button>
      </div>
      <div class="mv-bar-zeile mv-schnitt" hidden>
        <input type="range" class="mv-schieber" min="0" max="1000" value="500" aria-label="Schnitt verschieben">
        <button type="button" class="mv-btn" data-mv="umkehren" title="Schnittrichtung umkehren">${svg("M7 7h10V4l5 4.5L17 13v-3H7V7zm10 10H7v3l-5-4.5L7 11v3h10v3z")}</button>
        <button type="button" class="mv-btn" data-mv="schnittweg" title="Schnitt löschen">${svg("M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6l6.3-6.3 1.4 1.4z")}</button>
      </div>
    </div>`;

  const canvasBox = container.querySelector(".mv-canvas");
  const statusBox = container.querySelector(".mv-status");
  const schnittZeile = container.querySelector(".mv-schnitt");
  const schieber = container.querySelector(".mv-schieber");

  // ---------- Szene ----------

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    // alpha, damit der weiche Hintergrundverlauf aus CSS durchscheint
    // (siehe .mv-canvas) -- eine gerenderte Hintergrundfarbe wirkt bei
    // einem Architekturmodell flach. Fürs gespeicherte Bild wird der
    // Verlauf in bildSpeichern() auf eine zweite Leinwand mitgemalt.
    alpha: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Lokales statt globales Clipping: die Schnittebene darf nur das Modell
  // und den Boden beschneiden, nicht die eingeblendete Schnittfläche selbst
  // (die liegt ja genau auf der Ebene und würde sich sonst selbst wegclippen).
  renderer.localClippingEnabled = true;
  canvasBox.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Die Umgebung (oben) liefert das diffuse Licht und die Spiegelungen, die
  // Sonne nur noch Richtung und Schlagschatten -- deshalb ist sie bewusst
  // schwach eingestellt, sonst brennen helle Fassaden aus.
  const sonne = new THREE.DirectionalLight(0xfff3e2, 1.6);
  sonne.position.set(1, 1.6, 0.8);
  sonne.castShadow = true;
  sonne.shadow.mapSize.set(2048, 2048);
  sonne.shadow.bias = -0.0004;
  scene.add(sonne);
  scene.add(sonne.target);
  scene.add(new THREE.HemisphereLight(0xf2efea, 0x8a8178, 0.35));

  let kameraP = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  let kameraO = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  let kamera = kameraP;

  const controls = new OrbitControls(kamera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Beim Betrachten eines Gebäudes will man den Punkt unter dem Finger
  // mitnehmen, nicht in der Bodenebene schieben.
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.98;

  // Boden (nur Schatten, keine eigene Farbe) plus ein feines Raster als
  // Grössenbezug.
  const bodenMaterial = new THREE.ShadowMaterial({ opacity: 0.22 });
  const boden = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bodenMaterial);
  boden.rotation.x = -Math.PI / 2;
  boden.receiveShadow = true;
  scene.add(boden);

  let raster = null;

  // Schnittebene: eine einzige Ebene reicht für den Zweck ("einen Schnitt
  // platzieren, verschieben, löschen"). normal zeigt in die Richtung, die
  // SICHTBAR bleibt -- three.js clippt alles weg, wo normal·p + constant < 0.
  const schnittEbene = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  let schnittAchse = null; // "x" | "y" | "z" | null
  let schnittUmgekehrt = false;
  let schnittPos = 0; // Lage des Schnitts auf seiner Achse, in Modelleinheiten
  let schnittFlaeche = null; // sichtbares Rechteck auf der Ebene (zum Ziehen)

  let modell = null;
  let modellMaterialien = [];
  let box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  let mitte = new THREE.Vector3();
  let radius = 1;
  let gitterAn = false;
  let bodenAn = true;

  // ---------- Grösse / Renderschleife ----------

  function passeGroesseAn() {
    const b = Math.max(1, canvasBox.clientWidth);
    const h = Math.max(1, canvasBox.clientHeight);
    renderer.setSize(b, h, false);
    kameraP.aspect = b / h;
    kameraP.updateProjectionMatrix();
    setzeOrthoRahmen();
  }

  function setzeOrthoRahmen() {
    const b = Math.max(1, canvasBox.clientWidth);
    const h = Math.max(1, canvasBox.clientHeight);
    // Die Parallelprojektion soll beim Umschalten gleich gross wirken wie
    // die Perspektive: die halbe Bildhöhe an der Stelle des Drehpunkts.
    const dist = kamera.position.distanceTo(controls.target);
    const halbeHoehe = Math.tan((kameraP.fov * Math.PI) / 360) * dist;
    const halbeBreite = (halbeHoehe * b) / h;
    kameraO.left = -halbeBreite;
    kameraO.right = halbeBreite;
    kameraO.top = halbeHoehe;
    kameraO.bottom = -halbeHoehe;
    kameraO.updateProjectionMatrix();
  }

  const beobachter = new ResizeObserver(passeGroesseAn);
  beobachter.observe(canvasBox);

  let laeuft = true;
  function schleife() {
    if (!laeuft) return;
    requestAnimationFrame(schleife);
    controls.update();
    renderer.render(scene, kamera);
  }

  // ---------- Kamera / Ansichten ----------

  const RICHTUNGEN = {
    axo: new THREE.Vector3(1, 0.6, 1),
    vorne: new THREE.Vector3(0, 0, 1),
    hinten: new THREE.Vector3(0, 0, -1),
    links: new THREE.Vector3(-1, 0, 0),
    rechts: new THREE.Vector3(1, 0, 0),
    oben: new THREE.Vector3(0, 1, 0.0001)
  };

  function zeigeAlles(richtung = "axo") {
    const dir = RICHTUNGEN[richtung] || RICHTUNGEN.axo;
    // Im Hochformat (Handy) ist die Bildöffnung SEITLICH enger als nach
    // oben -- nur mit dem vertikalen Blickwinkel gerechnet, stünde ein
    // breites Gebäude über den Bildrand hinaus.
    const senkrecht = (kameraP.fov * Math.PI) / 360;
    const waagrecht = Math.atan(Math.tan(senkrecht) * Math.max(0.0001, kameraP.aspect));
    const abstand = Math.max(radius / Math.sin(senkrecht), radius / Math.sin(waagrecht)) * 1.08;
    const pos = mitte.clone().add(dir.clone().normalize().multiplyScalar(abstand));
    kameraP.position.copy(pos);
    kameraO.position.copy(pos);
    controls.target.copy(mitte);
    kameraP.near = Math.max(radius / 500, 0.01);
    kameraP.far = abstand + radius * 10;
    kameraP.updateProjectionMatrix();
    kameraO.near = -radius * 10;
    kameraO.far = abstand + radius * 10;
    setzeOrthoRahmen();
    controls.update();
  }

  function wechsleProjektion() {
    const neu = kamera === kameraP ? kameraO : kameraP;
    neu.position.copy(kamera.position);
    neu.up.copy(kamera.up);
    setzeOrthoRahmen();
    kamera = neu;
    controls.object = kamera;
    controls.update();
    container.querySelector('[data-mv="projektion"]').textContent = kamera === kameraP ? "Persp." : "Parallel";
  }

  // ---------- Modell laden ----------

  function entferneModell() {
    if (!modell) return;
    scene.remove(modell);
    modell.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => {
        Object.values(m).forEach((w) => {
          if (w && w.isTexture) w.dispose();
        });
        m.dispose();
      });
    });
    modell = null;
    modellMaterialien = [];
  }

  // Alle Beidateien (Texturen, .bin, .mtl) liegen als Blob-URL bereit; der
  // LoadingManager biegt jede im Modell genannte Adresse auf diese Kopien
  // um. Nur so lassen sich mehrteilige Modelle (OBJ+MTL+Texturen,
  // glTF+bin+Texturen) laden, ohne sie irgendwo abzulegen.
  function baueManager(blobUrls) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (/^(data|blob):/i.test(url)) return url;
      const treffer = blobUrls.get(basisName(decodeURIComponent(url)));
      return treffer || url;
    });
    // Der OBJ-Weg meldet "fertig", sobald die Geometrie steht -- die
    // Texturen aus der MTL-Datei laufen dann noch. Ohne dieses Warten
    // erscheint das Modell einen Moment lang SCHWARZ (ein zugewiesener,
    // aber noch leerer Bildspeicher), und zwar genau so lange, wie das
    // Entpacken der Bilder dauert. Beim glTF-Weg wartet der Loader selbst.
    let gestartet = false;
    let fertig = false;
    let melde;
    const geladen = new Promise((ok) => (melde = ok));
    manager.onStart = () => (gestartet = true);
    manager.onLoad = () => {
      fertig = true;
      melde();
    };
    manager.warteAufBeidateien = async () => {
      if (!gestartet || fertig) return;
      // Notbremse: eine kaputte Textur darf das Modell nicht ewig
      // zurückhalten -- lieber ungetextet zeigen als gar nicht.
      await Promise.race([geladen, new Promise((ok) => setTimeout(ok, 15000))]);
    };
    return manager;
  }

  function nachbearbeiten(wurzel) {
    const material = [];
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    wurzel.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m) return;
        material.push(m);
        if (m.map) {
          m.map.anisotropy = maxAniso;
          m.map.colorSpace = THREE.SRGBColorSpace;
        }
        // Viele CAD-Exporte haben nach aussen gedrehte Einzelflächen; ohne
        // DoubleSide fehlen im Modell dann scheinbar Wände. Kostet bei
        // diesen Modellgrössen nichts Spürbares.
        m.side = THREE.DoubleSide;
        m.wireframe = gitterAn;
      });
    });
    modellMaterialien = material;
    return material;
  }

  async function ladeGltf(inhalt, manager) {
    const loader = new GLTFLoader(manager);
    const draco = new DRACOLoader(manager);
    // Pfad relativ zu dieser Datei, nicht zur Seite -- beide Seiten des
    // Moduls liegen zwar im selben Ordner, aber so bleibt es auch richtig,
    // falls der Viewer je woanders eingebunden wird.
    draco.setDecoderPath(new URL("./vendor/addons/libs/draco/gltf/", import.meta.url).href);
    loader.setDRACOLoader(draco);
    const daten = typeof inhalt === "string" ? inhalt : pufferVon(inhalt);
    const gltf = await new Promise((ok, fehler) => loader.parse(daten, "", ok, fehler));
    draco.dispose();
    return gltf.scene;
  }

  async function ladeObj(inhalt, dateien, manager) {
    const text = textVon(inhalt);
    const loader = new OBJLoader(manager);
    // Die zugehörige Materialdatei steht im OBJ als "mtllib <name>"; fehlt
    // die Zeile, nehmen wir die einzige .mtl im Ordner.
    const genannt = /^\s*mtllib\s+(.+)$/im.exec(text);
    const mtlName = [...dateien.keys()].find((n) =>
      genannt ? basisName(n) === basisName(genannt[1].trim()) : endung(n) === ".mtl"
    );
    if (mtlName) {
      const mtl = new MTLLoader(manager).parse(textVon(dateien.get(mtlName)), "");
      mtl.preload();
      loader.setMaterials(mtl);
    }
    const objekt = loader.parse(text);
    if (!mtlName) {
      // Ohne Materialdatei liefert der OBJLoader ein grelles Weiss -- ein
      // ruhiges, leicht mattes Grau sieht wie ein Gipsmodell aus.
      const ersatz = new THREE.MeshStandardMaterial({ color: FARBE_ERSATZMATERIAL, roughness: 0.85, metalness: 0 });
      objekt.traverse((o) => {
        if (o.isMesh) o.material = ersatz;
      });
    }
    return objekt;
  }

  // dateien: Map<Dateiname, ArrayBuffer|string>, hauptdatei: Name darin.
  async function ladeModell({ dateien, hauptdatei, zUp = false, titel = "" }) {
    // Name fürs gespeicherte Bild -- ohne Zeichen, die in Dateinamen nichts
    // verloren haben.
    container.dataset.mvName = (titel || basisName(hauptdatei).replace(/\.[^.]+$/, "")).replace(/[\\/:*?"<>|]/g, "-");
    const blobUrls = new Map();
    dateien.forEach((inhalt, name) => {
      if (basisName(name) === basisName(hauptdatei)) return;
      blobUrls.set(basisName(name), URL.createObjectURL(new Blob([pufferVon(inhalt)])));
    });
    const manager = baueManager(blobUrls);

    try {
      entferneModell();
      // Die Schlüssel sind volle Pfade innerhalb des Modellordners, die
      // Hauptdatei kommt aber meist als blosser Name aus modell.json.
      const schluessel = dateien.has(hauptdatei)
        ? hauptdatei
        : [...dateien.keys()].find((k) => basisName(k) === basisName(hauptdatei));
      const inhalt = schluessel === undefined ? undefined : dateien.get(schluessel);
      if (inhalt === undefined) throw new Error(`Datei "${hauptdatei}" fehlt im Modellordner.`);
      const typ = endung(hauptdatei);
      const objekt = typ === ".obj" ? await ladeObj(inhalt, dateien, manager) : await ladeGltf(inhalt, manager);
      await manager.warteAufBeidateien();

      // Viele CAD-Programme exportieren mit Z nach oben; glTF ist auf Y
      // festgelegt. Welche der beiden Welten gilt, entscheidet das Büro beim
      // Hochladen (zUp in modell.json) -- raten lässt es sich nicht
      // zuverlässig, ein hohes Haus und ein liegender Baukörper sehen in den
      // Abmessungen gleich aus.
      modell = new THREE.Group();
      if (zUp) objekt.rotation.x = -Math.PI / 2;
      modell.add(objekt);
      nachbearbeiten(modell);
      scene.add(modell);

      richteSzeneEin();
      return { anzahlMeshes: modellMaterialien.length };
    } finally {
      // Die Loader haben die Beidateien inzwischen gelesen; die Blob-URLs
      // würden sonst bis zum Neuladen der Seite im Speicher bleiben.
      setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 10000);
    }
  }

  // Alles, was von der Modellgrösse abhängt: Boden, Sonne/Schattenkamera,
  // Raster, Kameraabstand, Schnittbereich.
  function richteSzeneEin() {
    box = new THREE.Box3().setFromObject(modell);
    if (!isFinite(box.min.x)) box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    box.getCenter(mitte);
    const groesse = box.getSize(new THREE.Vector3());
    radius = Math.max(0.001, box.getBoundingSphere(new THREE.Sphere()).radius);

    const bodenBreite = Math.max(groesse.x, groesse.z) * 6 + radius;
    boden.geometry.dispose();
    boden.geometry = new THREE.PlaneGeometry(bodenBreite, bodenBreite);
    boden.position.set(mitte.x, box.min.y - radius * 0.002, mitte.z);
    bodenMaterial.clippingPlanes = schnittAchse ? [schnittEbene] : null;

    if (raster) {
      scene.remove(raster);
      raster.geometry.dispose();
      raster.material.dispose();
    }
    const rasterSchritt = Math.pow(10, Math.round(Math.log10(radius)) - 1) || 1;
    const rasterFelder = Math.max(10, Math.ceil(bodenBreite / rasterSchritt / 2) * 2);
    raster = new THREE.GridHelper(rasterFelder * rasterSchritt, rasterFelder, 0xbdb6a8, 0xd7d1c5);
    raster.position.copy(boden.position);
    raster.material.transparent = true;
    raster.material.opacity = 0.55;
    raster.visible = bodenAn;
    scene.add(raster);
    boden.visible = bodenAn;

    // Die Sonne steht links VOR dem Modell, die Standardkamera (Axo)
    // rechts davor: so fällt der Schlagschatten nach hinten rechts und ist
    // im Bild zu sehen. Stünde sie wie die Kamera rechts vorne, läge der
    // Schatten komplett hinter dem Haus und man sähe gar keinen.
    sonne.position.copy(mitte).add(new THREE.Vector3(-radius * 1.3, radius * 2.0, radius * 0.9));
    sonne.target.position.copy(mitte);
    const s = sonne.shadow.camera;
    s.left = -radius * 1.4;
    s.right = radius * 1.4;
    s.top = radius * 1.4;
    s.bottom = -radius * 1.4;
    s.near = radius * 0.1;
    s.far = radius * 8;
    s.updateProjectionMatrix();
    sonne.shadow.normalBias = radius * 0.01;

    schnittAchse = null;
    schnittZeile.hidden = true;
    container.querySelectorAll("[data-mv-achse]").forEach((b) => b.classList.remove("aktiv"));
    wendeSchnittAn();
    zeigeAlles("axo");
  }

  // ---------- Schnitt ----------

  const ACHSEN = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1)
  };

  function schnittBereich() {
    const achse = ACHSEN[schnittAchse] || ACHSEN.x;
    const min = box.min.dot(achse);
    const max = box.max.dot(achse);
    // Etwas über das Modell hinaus, damit sich der Schnitt auch ganz an den
    // Rand schieben lässt (= praktisch kein Schnitt mehr).
    const luft = (max - min) * 0.02 + radius * 0.001;
    return { min: min - luft, max: max + luft };
  }

  function schnittPosition() {
    return schnittPos;
  }

  // three.js zeigt alles, wo normal*p + constant >= 0 ist. "Nicht umgekehrt"
  // heisst deshalb: Normale entgegen der Achse, sichtbar bleibt die Seite
  // VOR dem Schnitt (kleinere Koordinate).
  function setzeSchnittPosition(wert) {
    schnittPos = wert;
    const normal = ACHSEN[schnittAchse].clone().multiplyScalar(schnittUmgekehrt ? 1 : -1);
    schnittEbene.set(normal, schnittUmgekehrt ? -wert : wert);
    aktualisiereSchnittFlaeche();
  }

  function waehleSchnitt(achse) {
    if (schnittAchse === achse) {
      loescheSchnitt();
      return;
    }
    schnittAchse = achse;
    schnittUmgekehrt = false;
    container.querySelectorAll("[data-mv-achse]").forEach((b) => b.classList.toggle("aktiv", b.dataset.mvAchse === achse));
    schnittZeile.hidden = false;
    const { min, max } = schnittBereich();
    // Ein neuer Schnitt startet in der Mitte des Modells -- von dort aus
    // schiebt man ihn in die interessante Richtung.
    setzeSchnittPosition((min + max) / 2);
    schiebeSchieberAufPosition();
    wendeSchnittAn();
  }

  function loescheSchnitt() {
    schnittAchse = null;
    schnittZeile.hidden = true;
    container.querySelectorAll("[data-mv-achse]").forEach((b) => b.classList.remove("aktiv"));
    wendeSchnittAn();
  }

  function kehreSchnittUm() {
    if (!schnittAchse) return;
    const pos = schnittPosition();
    schnittUmgekehrt = !schnittUmgekehrt;
    setzeSchnittPosition(pos);
  }

  function wendeSchnittAn() {
    const ebenen = schnittAchse ? [schnittEbene] : null;
    modellMaterialien.forEach((m) => {
      m.clippingPlanes = ebenen;
      // Ohne clipShadows wirft ein aufgeschnittenes Haus weiter den
      // Schatten des ganzen Baukörpers -- three.js übernimmt die Ebenen
      // sonst nicht in den Schattendurchgang.
      m.clipShadows = !!ebenen;
      m.needsUpdate = true;
    });
    bodenMaterial.clippingPlanes = ebenen;
    bodenMaterial.needsUpdate = true;
    // Das Raster gehört zum Boden: ein waagrechter Schnitt unterhalb des
    // Bodens soll auch das Raster wegnehmen, sonst schwebt ein Gitter unter
    // dem halbierten Haus.
    if (raster) {
      raster.material.clippingPlanes = ebenen;
      raster.material.needsUpdate = true;
    }
    if (schnittFlaeche) {
      scene.remove(schnittFlaeche);
      schnittFlaeche.geometry.dispose();
      schnittFlaeche = null;
    }
    if (!schnittAchse) return;

    const groesse = box.getSize(new THREE.Vector3());
    const kante = Math.max(groesse.x, groesse.y, groesse.z) * 1.1;
    const geo = new THREE.PlaneGeometry(kante, kante);
    const mat = new THREE.MeshBasicMaterial({
      color: FARBE_AKZENT,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    schnittFlaeche = new THREE.Mesh(geo, mat);
    const rand = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: FARBE_AKZENT, transparent: true, opacity: 0.6 })
    );
    schnittFlaeche.add(rand);
    scene.add(schnittFlaeche);
    aktualisiereSchnittFlaeche();
  }

  function aktualisiereSchnittFlaeche() {
    if (!schnittFlaeche || !schnittAchse) return;
    const achse = ACHSEN[schnittAchse];
    const pos = schnittPosition();
    const punkt = mitte.clone();
    punkt[schnittAchse] = pos;
    schnittFlaeche.position.copy(punkt);
    schnittFlaeche.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), achse);
  }

  function schiebeSchieberAufPosition() {
    const { min, max } = schnittBereich();
    const t = max > min ? (schnittPosition() - min) / (max - min) : 0.5;
    schieber.value = String(Math.round(t * 1000));
  }

  // Schnittfläche direkt im Bild verschieben: Anfassen, in Richtung der
  // Achse ziehen. Umgerechnet wird über die Bildschirmrichtung der Achse,
  // damit das Ziehen in jeder Kameralage stimmt.
  const strahl = new THREE.Raycaster();
  let zieht = null;

  function zeigerNdc(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  renderer.domElement.addEventListener("pointerdown", (ev) => {
    if (!schnittFlaeche || ev.button !== 0) return;
    strahl.setFromCamera(zeigerNdc(ev), kamera);
    const treffer = strahl.intersectObject(schnittFlaeche, false)[0];
    if (!treffer) return;

    const r = renderer.domElement.getBoundingClientRect();
    const achse = ACHSEN[schnittAchse];
    const projiziere = (p) => {
      const v = p.clone().project(kamera);
      return new THREE.Vector2(((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height);
    };
    const a = projiziere(treffer.point);
    const b = projiziere(treffer.point.clone().add(achse.clone().multiplyScalar(radius * 0.1)));
    const richtungPx = b.clone().sub(a);
    const laenge2 = richtungPx.lengthSq();
    // Blickt man genau entlang der Achse, lässt sich am Bildschirm keine
    // Richtung ablesen -- dann bleibt der Schieber.
    if (laenge2 < 4) return;

    zieht = {
      startX: ev.clientX,
      startY: ev.clientY,
      startPos: schnittPosition(),
      einheitenProPixel: (radius * 0.1) / Math.sqrt(laenge2),
      richtung: richtungPx.normalize()
    };
    controls.enabled = false;
    renderer.domElement.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  renderer.domElement.addEventListener("pointermove", (ev) => {
    if (!zieht) return;
    const d = new THREE.Vector2(ev.clientX - zieht.startX, ev.clientY - zieht.startY);
    const { min, max } = schnittBereich();
    const neu = THREE.MathUtils.clamp(zieht.startPos + d.dot(zieht.richtung) * zieht.einheitenProPixel, min, max);
    setzeSchnittPosition(neu);
    schiebeSchieberAufPosition();
  });

  function beendeZiehen(ev) {
    if (!zieht) return;
    zieht = null;
    controls.enabled = true;
    try {
      renderer.domElement.releasePointerCapture(ev.pointerId);
    } catch (e) {
      /* Zeiger war schon weg */
    }
  }
  renderer.domElement.addEventListener("pointerup", beendeZiehen);
  renderer.domElement.addEventListener("pointercancel", beendeZiehen);

  schieber.addEventListener("input", () => {
    if (!schnittAchse) return;
    const { min, max } = schnittBereich();
    setzeSchnittPosition(min + ((max - min) * Number(schieber.value)) / 1000);
  });

  // ---------- Bild speichern ----------

  function bildSpeichern(dateiname = "modell.png") {
    renderer.render(scene, kamera);
    const quelle = renderer.domElement;
    const ziel = document.createElement("canvas");
    ziel.width = quelle.width;
    ziel.height = quelle.height;
    const ctx = ziel.getContext("2d");
    const verlauf = ctx.createLinearGradient(0, 0, 0, ziel.height);
    verlauf.addColorStop(0, "#FBFAF7");
    verlauf.addColorStop(1, "#DFDAD0");
    ctx.fillStyle = verlauf;
    ctx.fillRect(0, 0, ziel.width, ziel.height);
    ctx.drawImage(quelle, 0, 0);
    const a = document.createElement("a");
    a.href = ziel.toDataURL("image/png");
    a.download = dateiname;
    a.click();
  }

  // ---------- Status / Bedienung ----------

  function zeigeStatus(text, istFehler = false) {
    statusBox.hidden = !text;
    statusBox.textContent = text || "";
    statusBox.classList.toggle("fehler", !!istFehler);
  }

  container.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn || !container.contains(btn)) return;
    if (btn.dataset.mvAnsicht) return zeigeAlles(btn.dataset.mvAnsicht);
    if (btn.dataset.mvAchse) return waehleSchnitt(btn.dataset.mvAchse);
    switch (btn.dataset.mv) {
      case "fit":
        return zeigeAlles("axo");
      case "projektion":
        return wechsleProjektion();
      case "schnittweg":
        return loescheSchnitt();
      case "umkehren":
        return kehreSchnittUm();
      case "boden":
        bodenAn = !bodenAn;
        boden.visible = bodenAn;
        if (raster) raster.visible = bodenAn;
        // Hervorgehoben ist jeweils der Zustand, der NICHT der Standard ist
        // -- deshalb steht im Titel immer, was der nächste Klick tut.
        btn.classList.toggle("aktiv", !bodenAn);
        btn.title = bodenAn ? "Boden und Schatten ausblenden" : "Boden und Schatten einblenden";
        return;
      case "gitter":
        gitterAn = !gitterAn;
        modellMaterialien.forEach((m) => {
          m.wireframe = gitterAn;
        });
        btn.classList.toggle("aktiv", gitterAn);
        btn.title = gitterAn ? "Drahtgitter ausblenden" : "Drahtgitter einblenden";
        return;
      case "bild":
        return bildSpeichern(container.dataset.mvName ? `${container.dataset.mvName}.png` : "modell.png");
      case "vollbild":
        if (document.fullscreenElement) document.exitFullscreen();
        else if (container.requestFullscreen) container.requestFullscreen();
        return;
    }
  });

  // Pfeiltasten verschieben den Schnitt fein -- am Desktop deutlich genauer
  // als Ziehen oder Schieber.
  container.addEventListener("keydown", (ev) => {
    if (!schnittAchse || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
    const { min, max } = schnittBereich();
    const schritt = ((max - min) / 200) * (ev.key === "ArrowRight" ? 1 : -1);
    setzeSchnittPosition(THREE.MathUtils.clamp(schnittPosition() + schritt, min, max));
    schiebeSchieberAufPosition();
    ev.preventDefault();
  });

  // Safari auf dem iPhone kennt Vollbild nur für Videos -- der Knopf täte
  // dort schlicht nichts, also weg damit.
  if (!document.fullscreenEnabled) container.querySelector('[data-mv="vollbild"]').remove();

  passeGroesseAn();
  schleife();

  return {
    ladeModell,
    zeigeStatus,
    zeigeAlles,
    get hatModell() {
      return !!modell;
    },
    dispose() {
      laeuft = false;
      beobachter.disconnect();
      entferneModell();
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
    }
  };
}
