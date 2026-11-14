/* ============================================================
   Modellviewer -- Kundenansicht (ohne Nextcloud-Login).

   Diese Seite ist der einzige Teil der Büro-Apps, den Aussenstehende zu
   sehen bekommen. Sie bindet deshalb bewusst NICHT shared/common.js ein:
   kein Einstellungen-Dialog, kein Demo-Banner, keine Zugangsdaten im Spiel.

   Zugang: pro Modell ein passwortgeschützter Nextcloud-Freigabelink. Dessen
   Kennung (Token) steht im Seitenlink hinter dem "#", das Passwort tippt der
   Kunde ein. Nextcloud lässt eine solche Freigabe per WebDAV lesen, wenn man
   das Token als Benutzernamen und das Freigabepasswort als Passwort schickt
   -- das geht durch den bestehenden Worker-Proxy, ohne dass dieser oder das
   Repo je Zugangsdaten kennen müsste.

   Das Passwort setzt und ändert das Büro in der Nextcloud-Oberfläche; es
   steht nirgends im Code. Widerrufen heisst: Freigabe löschen.
   ============================================================ */

import { erstelleViewer } from "./viewer.js";
import { oeffneFreigabe, ladeDateien, formatiereGroesse, istModellDatei, HttpFehler, FreigabeFehler, GRUND } from "./dateien.js";

// Bewusst hier wiederholt statt aus shared/common.js übernommen -- siehe
// Dateikopf: diese Seite lädt common.js nicht. Ändert sich die Adresse des
// Proxys, muss sie an beiden Stellen nachgezogen werden.
const PROXY_URL = "https://zeit-proxy.haldejonas.workers.dev";

// Freigabe-Tokens von Nextcloud sind rein alphanumerisch. Die Prüfung ist
// keine Sicherheitsmassnahme, sie fängt nur abgeschnittene Links ab.
const TOKEN_MUSTER = /^[A-Za-z0-9]{4,64}$/;

const feldPasswort = document.getElementById("passwortFeld");
const overlayPasswort = document.getElementById("passwortOverlay");
const overlayWahl = document.getElementById("wahlOverlay");
const fehlerZeile = document.getElementById("passwortFehler");

const viewer = erstelleViewer(document.getElementById("viewerBox"));

const token = (location.hash || "").replace(/^#/, "").trim();
// Das Passwort bleibt nur für diesen Tab gespeichert (sessionStorage), damit
// ein Neuladen oder ein zweiter Blick später am Tag nicht jedes Mal neu
// danach fragt -- aber nichts davon auf dem Gerät zurückbleibt.
const SPEICHER_SCHLUESSEL = `modellviewer_pw_${token}`;

async function leseMeta(hole, eintrag) {
  if (!eintrag) return {};
  try {
    const res = await hole(eintrag.pfad, { method: "GET" });
    if (!res.ok) return {};
    return (await res.json()) || {};
  } catch (err) {
    console.warn("modell.json unlesbar:", err);
    return {};
  }
}

function zeigeKopf(meta, dateiname) {
  const titel = meta.titel || dateiname || "Modell";
  document.title = titel;
  document.getElementById("modellTitel").textContent = titel;
  document.getElementById("modellUnterzeile").textContent = [meta.projekt, meta.beschreibung]
    .filter(Boolean)
    .join(" · ");
  document.getElementById("bueroName").textContent = meta.bueroName || "";
}

// Mehrere Modelle in einer Freigabe: auswählen lassen. Der Normalfall ist
// ein Modell pro Freigabe (ein Ordner, ein Kunde, ein Passwort).
function frageModell(modelle) {
  return new Promise((gewaehlt) => {
    const liste = document.getElementById("wahlListe");
    liste.innerHTML = "";
    modelle.forEach((m) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `${m.name} <span class="groesse">${formatiereGroesse(m.groesse)}</span>`;
      btn.addEventListener("click", () => {
        overlayWahl.classList.add("hidden");
        gewaehlt(m);
      });
      li.appendChild(btn);
      liste.appendChild(li);
    });
    overlayWahl.classList.remove("hidden");
  });
}

async function oeffne(passwort) {
  viewer.zeigeStatus("Freigabe wird geöffnet…");
  const { hole, eintraege, kurz } = await oeffneFreigabe({ proxyUrl: PROXY_URL, token, passwort });
  console.info(`Freigabe gelesen über "${kurz}".`);

  const metaEintrag = eintraege.find((e) => e.name.toLowerCase() === "modell.json");
  const meta = await leseMeta(hole, metaEintrag);
  const modelle = eintraege.filter((e) => istModellDatei(e.name));
  if (!modelle.length) throw new Error("In dieser Freigabe liegt kein Modell (.glb, .gltf oder .obj).");

  let haupt =
    (meta.hauptdatei && modelle.find((m) => m.name.toLowerCase() === String(meta.hauptdatei).toLowerCase())) ||
    (modelle.length === 1 ? modelle[0] : null);
  if (!haupt) {
    viewer.zeigeStatus("");
    haupt = await frageModell(modelle);
  }

  zeigeKopf(meta, haupt.name);

  // Alles mitladen, was zum Modell gehört (Materialdatei, Texturen,
  // .bin-Dateien) -- nur die anderen Modelle derselben Freigabe nicht.
  const zuLaden = eintraege.filter((e) => e !== metaEintrag && (!istModellDatei(e.name) || e === haupt));
  const dateien = await ladeDateien(hole, zuLaden, (anteil) => {
    viewer.zeigeStatus(`Modell wird geladen… ${Math.round(anteil * 100)} %`);
  });

  viewer.zeigeStatus("Modell wird aufgebaut…");
  await viewer.ladeModell({ dateien, hauptdatei: haupt.pfad, zUp: !!meta.zUp, titel: meta.titel || "" });
  viewer.zeigeStatus("");
}

function zeigeFehler(err) {
  console.error(err, err instanceof FreigabeFehler ? err.versuche : "");
  const istPasswort = (err instanceof FreigabeFehler && err.passwortFalsch) || (err instanceof HttpFehler && err.status === 401);
  if (istPasswort) {
    sessionStorage.removeItem(SPEICHER_SCHLUESSEL);
    fehlerZeile.textContent = "Passwort stimmt nicht.";
    fehlerZeile.className = "test-result err";
    overlayPasswort.classList.remove("hidden");
    feldPasswort.value = "";
    feldPasswort.focus();
    viewer.zeigeStatus("");
    return;
  }
  if (err instanceof FreigabeFehler && err.grund === GRUND.gedrosselt) {
    viewer.zeigeStatus(
      "Nach mehreren Fehlversuchen macht der Server eine Pause. Bitte versuchen Sie es in ein paar Minuten nochmals.",
      true
    );
    return;
  }
  const abgelaufen =
    (err instanceof HttpFehler && (err.status === 404 || err.status === 403)) ||
    (err instanceof FreigabeFehler && err.grund === GRUND.unbekannt) ||
    (err instanceof FreigabeFehler && err.versuche.length > 0 && err.versuche.every((v) => v.status === 404));
  if (abgelaufen) {
    viewer.zeigeStatus(
      "Dieser Link ist nicht mehr gültig. Bitte melden Sie sich bei uns, wir schicken Ihnen einen neuen.",
      true
    );
    return;
  }
  // Bleibt etwas anderes übrig, gehört die technische Kurzfassung dazu --
  // sonst kann uns niemand sagen, woran es lag.
  const technisch = err instanceof FreigabeFehler ? ` (${err.bericht})` : "";
  viewer.zeigeStatus(`Das Modell konnte nicht geladen werden.${technisch}`, true);
}

async function versuche(passwort) {
  const btn = document.getElementById("passwortBtn");
  btn.disabled = true;
  try {
    overlayPasswort.classList.add("hidden");
    await oeffne(passwort);
    sessionStorage.setItem(SPEICHER_SCHLUESSEL, passwort);
  } catch (err) {
    zeigeFehler(err);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("passwortForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  fehlerZeile.textContent = "";
  const pw = feldPasswort.value;
  if (!pw) return;
  versuche(pw);
});

// ---------- Start ----------

// Nicht jede Freigabe hat ein Passwort. Deshalb wird IMMER zuerst ohne
// eines versucht -- klappt es, öffnet das Modell ohne Abfrage; verlangt die
// Freigabe eines, landen wir im 401-Zweig und fragen dann danach. Eine
// Abfrage auf Verdacht wäre für den Kunden unnötige Hürde und für uns keine
// Information.
async function starte() {
  const gemerkt = sessionStorage.getItem(SPEICHER_SCHLUESSEL);
  if (gemerkt !== null) return versuche(gemerkt);
  const btn = document.getElementById("passwortBtn");
  btn.disabled = true;
  try {
    await oeffne("");
    sessionStorage.setItem(SPEICHER_SCHLUESSEL, "");
  } catch (err) {
    const brauchtPasswort =
      (err instanceof FreigabeFehler && err.grund === GRUND.passwort) ||
      (err instanceof HttpFehler && err.status === 401);
    if (brauchtPasswort) {
      viewer.zeigeStatus("");
      overlayPasswort.classList.remove("hidden");
      feldPasswort.focus();
    } else {
      zeigeFehler(err);
    }
  } finally {
    btn.disabled = false;
  }
}

if (!TOKEN_MUSTER.test(token)) {
  viewer.zeigeStatus(
    "Dieser Link ist unvollständig. Bitte verwenden Sie den vollständigen Link aus unserer Nachricht (er endet mit einer Kennung nach dem #).",
    true
  );
} else {
  starte();
}

// Ein anderer Modell-Link im selben Tab ändert nur den Teil hinter dem "#"
// -- der Browser lädt dabei nichts neu, das Skript liefe also weiter mit der
// alten Kennung. Deshalb hier von Hand neu laden.
window.addEventListener("hashchange", () => window.location.reload());

// Service Worker wie in den übrigen Modulen (shared/common.js,
// registerServiceWorkerWithAutoUpdate()) -- hier von Hand, weil diese Seite
// common.js nicht lädt.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
  let laedtNeu = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (laedtNeu) return;
    laedtNeu = true;
    window.location.reload();
  });
}
