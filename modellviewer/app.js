/* ============================================================
   Modellviewer -- Verwaltung (Büro-Seite).

   Hier werden Modelle hochgeladen, beschriftet und wieder gelöscht. Die
   Kundenansicht ist eine eigene Seite (ansicht.html) und braucht kein
   Login -- siehe deren Dateikopf.

   Ablage auf Nextcloud: ein ORDNER je Modell unter
   Buero/Admin/App/Modellviewer, darin die Modelldatei(en) und eine
   modell.json mit Titel, Projekt, Hauptdatei und der Kennung des
   Freigabelinks. Ein Ordner je Modell, weil die Freigabe genau auf diesen
   Ordner zeigt: so sieht ein Kunde nur sein eigenes Modell.

   Dieses Skript ist ein ES-Modul (wegen der Loader-Importe), läuft aber
   NACH shared/common.js -- dessen Funktionen (proxyFetch, authHeader,
   appConfig …) sind deshalb hier ganz normal verfügbar.
   ============================================================ */

import { ordnerEbene, ordnerInhalt, ladeDateien, formatiereGroesse, istModellDatei } from "./dateien.js";

const MODUL = "Modellviewer";
const META_DATEI = "modell.json";

// ---------- Nextcloud-Zugriff ----------

function mvSegmente() {
  return ncSegments(appModuleFolderPath(MODUL));
}

function mvPfad(teile = []) {
  return davPath([...mvSegmente(), ...teile].join("/"));
}

// Hole-Funktion für dateien.js: Pfade sind relativ zum übergebenen Ordner
// ("" = der Ordner selbst). Der abschliessende Schrägstrich muss erhalten
// bleiben, sonst antwortet Nextcloud auf PROPFIND mit einer Umleitung.
function holeIn(ordnerTeile) {
  const basis = mvPfad(ordnerTeile);
  return (pfad, optionen = {}) =>
    proxyFetch(pfad ? `${basis}/${pfad}` : `${basis}/`, {
      ...optionen,
      headers: { ...authHeader(), ...(optionen.headers || {}) }
    });
}

function ensureMvOrdner() {
  return ensureFolderPath(mvSegmente());
}

// ---------- Zustand ----------

let modelle = []; // [{ ordner, meta }]
let aktuell = null; // im Dialog bearbeitetes Modell, null = neues
let vorschau = null; // laufende Viewer-Instanz

const el = (id) => document.getElementById(id);

function melde(text, istFehler = false) {
  const zeile = el("syncLine");
  zeile.textContent = text || " ";
  zeile.style.color = istFehler ? "#B5654C" : "";
}

function dialogMelde(text, istFehler = false) {
  const zeile = el("dialogStatus");
  zeile.textContent = text || "";
  zeile.className = `test-result${istFehler ? " err" : ""}`;
}

// ---------- Liste ----------

async function ladeListe() {
  melde("Modelle werden geladen…");
  try {
    await ensureMvOrdner();
    const ebene = await ordnerEbene(holeIn([]), "");
    const ordner = ebene.filter((e) => e.istOrdner && e.name && !e.name.startsWith("_"));
    modelle = await Promise.all(
      ordner.map(async (o) => ({ ordner: o.name, meta: await leseMeta(o.name) }))
    );
    modelle.sort((a, b) => (b.meta.hochgeladen || "").localeCompare(a.meta.hochgeladen || ""));
    zeichneListe();
    melde(modelle.length ? `${modelle.length} Modell${modelle.length === 1 ? "" : "e"}` : "");
  } catch (err) {
    console.error(err);
    melde("Modelle konnten nicht geladen werden: " + err.message, true);
  }
}

async function leseMeta(ordner) {
  try {
    const res = await proxyFetch(mvPfad([ordner, META_DATEI]), { method: "GET", headers: authHeader() });
    if (!res.ok) return {};
    return (await res.json()) || {};
  } catch (err) {
    // Ein Ordner ohne modell.json ist kein Fehler: dann wurde das Modell
    // von Hand auf Nextcloud abgelegt. Die Kundenansicht kommt damit
    // ebenfalls klar (sie nimmt dann einfach die einzige Modelldatei).
    return {};
  }
}

function kundenlink(token) {
  if (!token) return "";
  return `${new URL("ansicht.html", location.href).href}#${token}`;
}

function zeichneListe() {
  const box = el("modellListe");
  if (!modelle.length) {
    box.innerHTML = '<div class="leer">Noch kein Modell hochgeladen.</div>';
    return;
  }
  box.innerHTML = modelle
    .map((m, i) => {
      const teile = [m.meta.projekt, m.meta.hauptdatei || "ohne modell.json", m.meta.hochgeladen].filter(Boolean);
      const freigabe = m.meta.token
        ? ""
        : ' <span class="ohne-freigabe">· noch nicht freigegeben</span>';
      return `
        <div class="modell-karte">
          <div class="modell-haupt">
            <div class="modell-titel">${escapeHtml(m.meta.titel || m.ordner)}</div>
            <div class="modell-meta">${escapeHtml(teile.join(" · "))}${freigabe}</div>
          </div>
          <div class="karten-aktionen">
            <button type="button" data-vorschau="${i}" aria-label="Vorschau" title="Vorschau">
              <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 12a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z" fill="currentColor"/></svg>
            </button>
            <button type="button" data-bearbeiten="${i}" aria-label="Bearbeiten" title="Bearbeiten">
              <svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>
            </button>
          </div>
        </div>`;
    })
    .join("");
}

// ---------- Dialog ----------

function fuelleProjekte(gewaehlt) {
  const sel = el("feldProjekt");
  const projekte = appConfig.projekte || [];
  sel.innerHTML =
    '<option value="">– ohne Projekt –</option>' +
    projekte.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
  // Ein Projekt, das inzwischen aus projekte.txt verschwunden ist, darf
  // trotzdem stehen bleiben -- sonst verliert ein altes Modell seine
  // Zuordnung, bloss weil jemand die Liste aufgeräumt hat.
  if (gewaehlt && !projekte.some((p) => p.name === gewaehlt)) {
    sel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(gewaehlt)}">${escapeHtml(gewaehlt)}</option>`);
  }
  sel.value = gewaehlt || "";
}

function oeffneDialog(modell) {
  aktuell = modell || null;
  el("modellDialogTitel").textContent = modell ? "Modell bearbeiten" : "Modell hochladen";
  el("feldTitel").value = modell ? modell.meta.titel || modell.ordner : "";
  el("feldBeschreibung").value = modell ? modell.meta.beschreibung || "" : "";
  el("feldZup").checked = modell ? !!modell.meta.zUp : false;
  el("feldToken").value = modell ? modell.meta.token || "" : "";
  el("feldDateien").value = "";
  el("dateiListe").innerHTML = "";
  el("hauptdateiGruppe").hidden = true;
  el("loeschBtn").hidden = !modell;
  fuelleProjekte(modell ? modell.meta.projekt : "");
  zeigeKundenlink();
  dialogMelde("");
  el("modellOverlay").classList.remove("hidden");
  if (modell) zeigeDateien(modell);
}

function schliesseDialog() {
  el("modellOverlay").classList.add("hidden");
  aktuell = null;
}

function zeigeKundenlink() {
  const token = tokenAus(el("feldToken").value);
  const link = kundenlink(token);
  el("linkGruppe").hidden = !link;
  el("feldKundenlink").value = link;
}

// Nextcloud zeigt den Freigabelink als ganze Adresse an -- die lässt sich
// bequem hineinkopieren, die Kennung ziehen wir selbst heraus.
function tokenAus(text) {
  const t = String(text || "").trim();
  const m = /\/s\/([A-Za-z0-9]+)/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9]{4,64}$/.test(t) ? t : "";
}

async function zeigeDateien(modell) {
  try {
    const eintraege = await ordnerInhalt(holeIn([modell.ordner]));
    const dateien = eintraege.filter((e) => e.name !== META_DATEI);
    el("dateiListe").innerHTML =
      '<label style="font-size:12px;color:var(--text-muted);">Dateien im Ordner</label>' +
      dateien
        .map(
          (d) =>
            `<div class="datei-zeile"><span>${escapeHtml(d.pfad)}</span><span class="groesse">${formatiereGroesse(
              d.groesse
            )}</span></div>`
        )
        .join("");

    // Hauptdatei nur anbieten, wenn es überhaupt etwas zu wählen gibt.
    const modelldateien = dateien.filter((d) => istModellDatei(d.name));
    if (modelldateien.length > 1) {
      el("hauptdateiGruppe").hidden = false;
      el("feldHauptdatei").innerHTML = modelldateien
        .map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`)
        .join("");
      el("feldHauptdatei").value = modell.meta.hauptdatei || modelldateien[0].name;
    }
  } catch (err) {
    console.warn("Dateiliste nicht lesbar:", err);
  }
}

// Ordnername aus dem Titel: nur Kleinbuchstaben, Ziffern und Bindestriche.
// Der Ordner taucht im Freigabelink des Kunden nicht auf, muss also nicht
// hübsch sein -- aber auf Nextcloud von Hand auffindbar.
function ordnerName(titel) {
  const umlaute = { ä: "ae", ö: "oe", ü: "ue", Ä: "ae", Ö: "oe", Ü: "ue", ß: "ss" };
  const roh = String(titel || "")
    .replace(/[äöüÄÖÜß]/g, (c) => umlaute[c])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return roh || "modell";
}

function freierOrdnerName(titel) {
  const basis = ordnerName(titel);
  const belegt = new Set(modelle.map((m) => m.ordner.toLowerCase()));
  if (!belegt.has(basis)) return basis;
  for (let i = 2; i < 999; i++) {
    if (!belegt.has(`${basis}-${i}`)) return `${basis}-${i}`;
  }
  return `${basis}-${uid()}`;
}

async function ladeDateiHoch(ordner, datei) {
  const res = await proxyFetch(mvPfad([ordner, datei.name]), {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": datei.type || "application/octet-stream" },
    body: datei
  });
  if (!res.ok) throw new Error(`"${datei.name}" hochladen fehlgeschlagen (${res.status})`);
}

async function schreibeMeta(ordner, meta) {
  const res = await proxyFetch(mvPfad([ordner, META_DATEI]), {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(meta, null, 2)
  });
  if (!res.ok) throw new Error(`Angaben speichern fehlgeschlagen (${res.status})`);
}

async function speichere() {
  const titel = el("feldTitel").value.trim();
  const neueDateien = Array.from(el("feldDateien").files || []);
  if (!titel && !aktuell) return dialogMelde("Bitte einen Titel eintragen.", true);
  if (!aktuell && !neueDateien.length) return dialogMelde("Bitte mindestens eine Modelldatei wählen.", true);

  const modelldateien = neueDateien.filter((d) => istModellDatei(d.name));
  if (!aktuell && !modelldateien.length) {
    return dialogMelde("Keine Modelldatei dabei – gebraucht wird .glb, .gltf oder .obj.", true);
  }

  el("speichernBtn").disabled = true;
  try {
    const ordner = aktuell ? aktuell.ordner : freierOrdnerName(titel);
    if (!aktuell) {
      dialogMelde("Ordner wird angelegt…");
      await ensureFolderPath([...mvSegmente(), ordner]);
    }

    for (let i = 0; i < neueDateien.length; i++) {
      dialogMelde(`Lade hoch: ${i + 1} von ${neueDateien.length} (${neueDateien[i].name})…`);
      await ladeDateiHoch(ordner, neueDateien[i]);
    }

    // Hauptdatei: die eben hochgeladene, sonst die im Dialog gewählte,
    // sonst die bisherige.
    const gewaehlt = el("hauptdateiGruppe").hidden ? "" : el("feldHauptdatei").value;
    const hauptdatei = modelldateien.length ? modelldateien[0].name : gewaehlt || (aktuell && aktuell.meta.hauptdatei) || "";

    const meta = {
      ...(aktuell ? aktuell.meta : {}),
      titel: titel || (aktuell && aktuell.meta.titel) || ordner,
      projekt: el("feldProjekt").value,
      beschreibung: el("feldBeschreibung").value.trim(),
      hauptdatei,
      zUp: el("feldZup").checked,
      token: tokenAus(el("feldToken").value),
      // Der Büro-Name steht in der zentralen config.json, die ein Kunde
      // nicht lesen darf -- deshalb wandert er hier mit in die modell.json.
      bueroName: appConfig.bueroName || "",
      hochgeladen: formatDate(new Date()),
      von: personName()
    };
    dialogMelde("Angaben werden gespeichert…");
    await schreibeMeta(ordner, meta);

    schliesseDialog();
    await ladeListe();
  } catch (err) {
    console.error(err);
    dialogMelde(err.message, true);
  } finally {
    el("speichernBtn").disabled = false;
  }
}

async function loesche() {
  if (!aktuell) return;
  const name = aktuell.meta.titel || aktuell.ordner;
  if (!confirm(`"${name}" mit allen Dateien löschen? Ein bereits verschickter Kundenlink führt danach ins Leere.`)) return;
  el("loeschBtn").disabled = true;
  try {
    // DELETE auf den Ordner nimmt den ganzen Inhalt mit. Die Nextcloud-
    // Freigabe verschwindet damit ebenfalls -- sie hängt an diesem Ordner.
    const res = await proxyFetch(mvPfad([aktuell.ordner]), { method: "DELETE", headers: authHeader() });
    if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
    schliesseDialog();
    await ladeListe();
  } catch (err) {
    dialogMelde(err.message, true);
  } finally {
    el("loeschBtn").disabled = false;
  }
}

// ---------- Vorschau ----------

async function oeffneVorschau(modell) {
  el("vorschauTitel").textContent = modell.meta.titel || modell.ordner;
  el("vorschauOverlay").classList.remove("hidden");
  // three.js wird erst hier geladen (rund zwei Megabyte) -- die Liste soll
  // ohne diese Wartezeit erscheinen.
  const { erstelleViewer } = await import("./viewer.js");
  if (vorschau) vorschau.dispose();
  vorschau = erstelleViewer(el("vorschauViewer"));
  try {
    vorschau.zeigeStatus("Ordner wird gelesen…");
    const hole = holeIn([modell.ordner]);
    const eintraege = await ordnerInhalt(hole);
    const modelldateien = eintraege.filter((e) => istModellDatei(e.name));
    if (!modelldateien.length) throw new Error("In diesem Ordner liegt keine Modelldatei.");
    const haupt =
      modelldateien.find((m) => m.name === modell.meta.hauptdatei) || modelldateien[0];
    const zuLaden = eintraege.filter((e) => e.name !== META_DATEI && (!istModellDatei(e.name) || e === haupt));
    const dateien = await ladeDateien(hole, zuLaden, (anteil) =>
      vorschau.zeigeStatus(`Modell wird geladen… ${Math.round(anteil * 100)} %`)
    );
    vorschau.zeigeStatus("Modell wird aufgebaut…");
    await vorschau.ladeModell({ dateien, hauptdatei: haupt.pfad, zUp: !!modell.meta.zUp, titel: modell.meta.titel || "" });
    vorschau.zeigeStatus("");
  } catch (err) {
    console.error(err);
    vorschau.zeigeStatus(err.message || "Modell konnte nicht geladen werden.", true);
  }
}

function schliesseVorschau() {
  el("vorschauOverlay").classList.add("hidden");
  if (vorschau) {
    vorschau.dispose();
    vorschau = null;
  }
  el("vorschauViewer").innerHTML = "";
}

// ---------- Verdrahtung ----------

el("neuBtn").addEventListener("click", () => oeffneDialog(null));
el("modellSchliessen").addEventListener("click", schliesseDialog);
el("speichernBtn").addEventListener("click", speichere);
el("loeschBtn").addEventListener("click", loesche);
el("feldToken").addEventListener("input", zeigeKundenlink);
el("refreshBtn").addEventListener("click", () => {
  refreshAppConfig();
  ladeListe();
});
el("vorschauSchliessen").addEventListener("click", schliesseVorschau);

el("kopierBtn").addEventListener("click", async () => {
  const link = el("feldKundenlink").value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    dialogMelde("Link kopiert. Das Passwort bitte separat mitteilen.");
  } catch (err) {
    el("feldKundenlink").select();
    dialogMelde("Bitte von Hand kopieren.", true);
  }
});

el("modellListe").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  if (btn.dataset.vorschau !== undefined) return oeffneVorschau(modelle[Number(btn.dataset.vorschau)]);
  if (btn.dataset.bearbeiten !== undefined) return oeffneDialog(modelle[Number(btn.dataset.bearbeiten)]);
});

// Klick neben das Blatt schliesst den Dialog -- wie in den übrigen Modulen.
el("modellOverlay").addEventListener("click", (ev) => {
  if (ev.target === el("modellOverlay")) schliesseDialog();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!el("vorschauOverlay").classList.contains("hidden")) return schliesseVorschau();
  if (!el("modellOverlay").classList.contains("hidden")) schliesseDialog();
});

initSettingsUI({
  checkRelPath: () => mvPfad(["_ping"]),
  ensureFolderFn: ensureMvOrdner,
  onSaved: () => {
    refreshAppConfig().then(() => fuelleProjekte(el("feldProjekt").value));
    ladeListe();
  }
});

registerServiceWorkerWithAutoUpdate();

zeichneListe();
refreshAppConfig().then(() => fuelleProjekte(""));
ladeListe();
