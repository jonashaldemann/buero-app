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

// ---------- Freigaben (Nextcloud-OCS) ----------
//
// Die Kundenansicht hängt an einem passwortgeschützten Freigabelink auf den
// Modellordner. Angelegt wird der über Nextclouds OCS-Schnittstelle -- das
// ist der einzige Ort im ganzen Repo, der nicht WebDAV spricht. Ohne den
// Header "OCS-APIRequest" lehnt Nextcloud jeden solchen Aufruf ab; der
// Worker-Proxy reicht ihn (und POST) erst seit November 2026 durch, deshalb
// die ausdrückliche Fehlermeldung in freigabeFehlerText().
//
// Das Passwort selbst bekommt man aus Nextcloud NIE wieder heraus (es liegt
// dort nur als Hash). Damit es sich nachschlagen lässt, merkt die App es in
// _passwoerter.json -- im MODULORDNER, also eine Ebene über den einzelnen
// Modellordnern und damit ausserhalb jeder Freigabe. Ein Kunde kann die
// Datei nicht sehen.

const OCS_SHARES = "ocs/v2.php/apps/files_sharing/api/v1/shares";
const PW_DATEI = "_passwoerter.json";
const SHARE_TYP_LINK = 3;

class OcsFehler extends Error {
  constructor(status, text) {
    super(text || `Antwort ${status}`);
    this.status = status;
  }
}

function ocsFetch(pfadMitQuery, optionen = {}) {
  return proxyFetch(pfadMitQuery, {
    ...optionen,
    headers: { ...authHeader(), "OCS-APIRequest": "true", ...(optionen.headers || {}) }
  });
}

// Pfad, wie ihn die OCS-Schnittstelle erwartet: ab dem persönlichen
// Dateibereich, OHNE den WebDAV-Vorspann und ohne Benutzernamen.
function ordnerAufNextcloud(ordner) {
  return `/${appModuleFolderPath(MODUL)}/${ordner}`;
}

async function ocsAntwort(res) {
  let daten = null;
  try {
    daten = await res.json();
  } catch (err) {
    /* kein JSON -- fällt unten in die Fehlermeldung */
  }
  const meta = daten && daten.ocs && daten.ocs.meta;
  // OCS v1 antwortet mit 100, v2 mit 200 -- beides heisst "hat geklappt".
  if (res.ok && meta && (meta.statuscode === 100 || meta.statuscode === 200)) return daten.ocs.data;
  throw new OcsFehler(res.status, meta && meta.message);
}

function freigabeFehlerText(err) {
  if (err.status === 405) {
    return "Dazu fehlt dem Worker-Proxy noch die neue Fassung (POST und OCS-APIRequest, siehe worker.js). Bis dahin: Freigabe in Nextcloud anlegen und die Kennung unten eintragen.";
  }
  if (err.status === 403) {
    return `Nextcloud hat die Freigabe abgelehnt: ${err.message} (Passwortregeln? Freigaben erlaubt?)`;
  }
  return `Freigabe fehlgeschlagen: ${err.message}`;
}

async function freigabeSuchen(ordner) {
  const daten = await ocsAntwort(
    await ocsFetch(`${OCS_SHARES}?format=json&reshares=false&path=${ordnerAufNextcloud(ordner)}`)
  );
  const links = (Array.isArray(daten) ? daten : []).filter((f) => Number(f.share_type) === SHARE_TYP_LINK);
  // Mehrere Links auf denselben Ordner sind möglich (von Hand angelegt) --
  // dann gilt der neuste, denn der steckt auch in unserem Kundenlink.
  return links.length ? links[links.length - 1] : null;
}

async function freigabeAnlegen(ordner, passwort, ablauf) {
  const felder = new URLSearchParams({
    path: ordnerAufNextcloud(ordner),
    shareType: String(SHARE_TYP_LINK),
    permissions: "1", // nur lesen
    password: passwort
  });
  if (ablauf) felder.set("expireDate", ablauf);
  return ocsAntwort(
    await ocsFetch(`${OCS_SHARES}?format=json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: felder.toString()
    })
  );
}

async function freigabeAendern(id, felder) {
  return ocsAntwort(
    await ocsFetch(`${OCS_SHARES}/${id}?format=json`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(felder).toString()
    })
  );
}

async function freigabeLoeschen(id) {
  return ocsAntwort(await ocsFetch(`${OCS_SHARES}/${id}?format=json`, { method: "DELETE" }));
}

// Sprechbares Passwort: muss am Telefon durchgegeben werden können und
// trotzdem die üblichen Nextcloud-Passwortregeln erfüllen (Länge, Gross-
// und Kleinbuchstaben, Ziffer).
const SILBEN = "ba be bi bo da de di do fa fe fi ga ge gi ka ke ki ko la le li lo ma me mi mo na ne ni no pa pe pi ra re ri ro sa se si so ta te ti to va ve wa we za zo".split(" ");

function zufallsZahl(grenze) {
  const feld = new Uint32Array(1);
  crypto.getRandomValues(feld);
  return feld[0] % grenze;
}

function neuesPasswort() {
  const wort = () => {
    let w = "";
    for (let i = 0; i < 3; i++) w += SILBEN[zufallsZahl(SILBEN.length)];
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  return `${wort()}-${wort()}-${100 + zufallsZahl(900)}`;
}

async function ladePasswoerter() {
  try {
    const res = await proxyFetch(mvPfad([PW_DATEI]), { method: "GET", headers: authHeader() });
    if (!res.ok) return {};
    return (await res.json()) || {};
  } catch (err) {
    return {};
  }
}

async function merkePasswort(ordner, passwort) {
  const alle = await ladePasswoerter();
  if (passwort) alle[ordner] = { passwort, gesetzt: formatDate(new Date()), von: personName() };
  else delete alle[ordner];
  const res = await proxyFetch(mvPfad([PW_DATEI]), {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(alle, null, 2)
  });
  if (!res.ok) throw new Error(`Passwort merken fehlgeschlagen (${res.status})`);
}

// ---------- Zustand ----------

let modelle = []; // [{ ordner, meta }]
let aktuell = null; // im Dialog bearbeitetes Modell, null = neues
let vorschau = null; // laufende Viewer-Instanz
let aktuelleFreigabe = null; // Freigabe-Datensatz aus Nextcloud zum offenen Modell
let aktuellesPasswort = ""; // zuletzt bekanntes Passwort -- um Tippen davon zu unterscheiden

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
  aktuelleFreigabe = null;
  el("modellDialogTitel").textContent = modell ? "Modell bearbeiten" : "Modell hochladen";
  el("feldTitel").value = modell ? modell.meta.titel || modell.ordner : "";
  el("feldBeschreibung").value = modell ? modell.meta.beschreibung || "" : "";
  el("feldZup").checked = modell ? !!modell.meta.zUp : false;
  el("feldToken").value = modell ? modell.meta.token || "" : "";
  el("feldDateien").value = "";
  el("feldAblauf").value = "";
  el("feldPasswort").value = "";
  aktuellesPasswort = "";
  el("freigabeDetails").hidden = false;
  el("dateiListe").innerHTML = "";
  el("hauptdateiGruppe").hidden = true;
  el("loeschBtn").hidden = !modell;
  fuelleProjekte(modell ? modell.meta.projekt : "");
  zeigeKundenlink();
  dialogMelde("");
  el("modellOverlay").classList.remove("hidden");
  if (modell) {
    zeigeDateien(modell);
    zeigeFreigabe(modell);
  } else {
    // Freigeben geht erst, wenn der Ordner existiert -- also nach dem
    // ersten Speichern. Danach öffnet sich dieser Dialog gleich wieder.
    el("freigabeDetails").hidden = true;
    el("freigabeStatus").textContent = "Nach dem Hochladen kannst du das Modell hier freigeben.";
  }
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

function setzeFreigabeKnoepfe(freigebenDa, freigabeDa) {
  el("freigebenBtn").hidden = !freigebenDa;
  el("neuesPwBtn").hidden = !freigabeDa;
  el("freigabeWegBtn").hidden = !freigabeDa;
}

function freigabeStatusText() {
  if (!aktuelleFreigabe) return "Noch nicht freigegeben.";
  const bis = el("feldAblauf").value;
  return bis ? `Freigegeben, gültig bis ${bis.split("-").reverse().join(".")}.` : "Freigegeben, unbefristet.";
}

// Sucht die bestehende Freigabe zum Modell und zeigt Link und Passwort an.
async function zeigeFreigabe(modell) {
  // Im Demomodus gibt es keine Nextcloud und damit keine Freigaben -- die
  // einzige Stelle im Repo, die das wissen muss (sonst kennt kein Modul den
  // Demomodus, siehe shared/common.js).
  if (istDemo()) {
    el("freigabeDetails").hidden = true;
    el("freigabeStatus").textContent = "Im Demomodus gibt es keine Nextcloud-Freigaben.";
    return;
  }
  setzeFreigabeKnoepfe(false, false);
  el("freigabeStatus").textContent = "Freigabe wird geprüft…";
  try {
    aktuelleFreigabe = await freigabeSuchen(modell.ordner);
  } catch (err) {
    console.warn("Freigabe nicht lesbar:", err);
    el("freigabeStatus").textContent = freigabeFehlerText(err);
    setzeFreigabeKnoepfe(false, false);
    return;
  }
  if (aktuelleFreigabe) {
    // expiration kommt als "2026-12-31 00:00:00"
    el("feldAblauf").value = (aktuelleFreigabe.expiration || "").slice(0, 10);
    el("feldToken").value = aktuelleFreigabe.token || el("feldToken").value;
    const gemerkt = (await ladePasswoerter())[modell.ordner];
    aktuellesPasswort = gemerkt ? gemerkt.passwort : "";
    el("feldPasswort").value = aktuellesPasswort;
    zeigeKundenlink();
  }
  setzeFreigabeKnoepfe(!aktuelleFreigabe, !!aktuelleFreigabe);
  el("freigabeStatus").textContent = freigabeStatusText();
}

// Schreibt NUR die Kennung in die modell.json -- der Kundenlink soll sofort
// funktionieren, auch wenn niemand mehr auf "Speichern" drückt.
async function merkeToken(token) {
  if (!aktuell) return;
  aktuell.meta = { ...aktuell.meta, token };
  el("feldToken").value = token;
  zeigeKundenlink();
  await schreibeMeta(aktuell.ordner, aktuell.meta);
}

async function freigeben() {
  if (!aktuell) return;
  el("freigebenBtn").disabled = true;
  try {
    el("freigabeStatus").textContent = "Freigabe wird angelegt…";
    // Eigenes Passwort hat Vorrang; leer heisst "würfle eines".
    const passwort = el("feldPasswort").value.trim() || neuesPasswort();
    aktuelleFreigabe = await freigabeAnlegen(aktuell.ordner, passwort, el("feldAblauf").value);
    await merkePasswort(aktuell.ordner, passwort);
    aktuellesPasswort = passwort;
    el("feldPasswort").value = passwort;
    await merkeToken(aktuelleFreigabe.token);
    setzeFreigabeKnoepfe(false, true);
    el("freigabeStatus").textContent = freigabeStatusText();
    dialogMelde("Freigegeben. Link und Passwort bitte getrennt verschicken.");
    zeichneListe();
  } catch (err) {
    console.error(err);
    el("freigabeStatus").textContent = err instanceof OcsFehler ? freigabeFehlerText(err) : err.message;
  } finally {
    el("freigebenBtn").disabled = false;
  }
}

async function passwortErneuern() {
  if (!aktuelleFreigabe) return;
  el("neuesPwBtn").disabled = true;
  try {
    const passwort = neuesPasswort();
    await freigabeAendern(aktuelleFreigabe.id, { password: passwort });
    await merkePasswort(aktuell.ordner, passwort);
    aktuellesPasswort = passwort;
    el("feldPasswort").value = passwort;
    dialogMelde("Neues Passwort gesetzt — der alte Link gilt weiter, das alte Passwort nicht mehr.");
  } catch (err) {
    console.error(err);
    el("freigabeStatus").textContent = err instanceof OcsFehler ? freigabeFehlerText(err) : err.message;
  } finally {
    el("neuesPwBtn").disabled = false;
  }
}

async function freigabeAufheben() {
  if (!aktuelleFreigabe) return;
  if (!confirm("Freigabe aufheben? Ein bereits verschickter Kundenlink funktioniert danach nicht mehr.")) return;
  el("freigabeWegBtn").disabled = true;
  try {
    await freigabeLoeschen(aktuelleFreigabe.id);
    await merkePasswort(aktuell.ordner, null);
    aktuelleFreigabe = null;
    aktuellesPasswort = "";
    el("feldPasswort").value = "";
    el("feldAblauf").value = "";
    await merkeToken("");
    setzeFreigabeKnoepfe(true, false);
    el("freigabeStatus").textContent = freigabeStatusText();
    dialogMelde("Freigabe aufgehoben.");
    zeichneListe();
  } catch (err) {
    console.error(err);
    el("freigabeStatus").textContent = err instanceof OcsFehler ? freigabeFehlerText(err) : err.message;
  } finally {
    el("freigabeWegBtn").disabled = false;
  }
}

// Ein von Hand eingetipptes Passwort wirkt wie das Ablaufdatum sofort --
// solange es noch keine Freigabe gibt, wird es beim Freigeben verwendet.
async function passwortUebernehmen() {
  const eingetippt = el("feldPasswort").value.trim();
  if (!aktuelleFreigabe || eingetippt === aktuellesPasswort) return;
  if (!eingetippt) {
    // Leeren hiesse "Passwortschutz weg" -- das ist nie gemeint und wäre
    // genau der gefährliche Fall. Also zurücksetzen.
    el("feldPasswort").value = aktuellesPasswort;
    return;
  }
  try {
    await freigabeAendern(aktuelleFreigabe.id, { password: eingetippt });
    await merkePasswort(aktuell.ordner, eingetippt);
    aktuellesPasswort = eingetippt;
    dialogMelde("Passwort gespeichert. Das alte gilt nicht mehr.");
  } catch (err) {
    console.error(err);
    el("feldPasswort").value = aktuellesPasswort;
    el("freigabeStatus").textContent = err instanceof OcsFehler ? freigabeFehlerText(err) : err.message;
  }
}

// Das Ablaufdatum wirkt sofort -- ein eigener Knopf dafür wäre der dritte
// in einer Reihe, die schon voll ist.
async function ablaufUebernehmen() {
  if (!aktuelleFreigabe) return;
  try {
    await freigabeAendern(aktuelleFreigabe.id, { expireDate: el("feldAblauf").value });
    aktuelleFreigabe.expiration = el("feldAblauf").value;
    el("freigabeStatus").textContent = freigabeStatusText();
  } catch (err) {
    console.error(err);
    el("freigabeStatus").textContent = err instanceof OcsFehler ? freigabeFehlerText(err) : err.message;
  }
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

    const warNeu = !aktuell;
    schliesseDialog();
    await ladeListe();
    if (warNeu) {
      const frisch = modelle.find((m) => m.ordner === ordner);
      if (frisch) {
        oeffneDialog(frisch);
        dialogMelde("Hochgeladen. Jetzt noch freigeben, damit der Kunde es sehen kann.");
      }
    }
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
    const ordner = aktuell.ordner;
    const res = await proxyFetch(mvPfad([ordner]), { method: "DELETE", headers: authHeader() });
    if (!res.ok && res.status !== 404) throw new Error(`Löschen fehlgeschlagen (${res.status})`);
    // Die Nextcloud-Freigabe verschwindet mit dem Ordner; die gemerkte
    // Passwortnotiz muss von Hand weg, sonst bleibt sie für immer stehen.
    await merkePasswort(ordner, null).catch((err) => console.warn("Passwortnotiz:", err));
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
el("freigebenBtn").addEventListener("click", freigeben);
el("neuesPwBtn").addEventListener("click", passwortErneuern);
el("freigabeWegBtn").addEventListener("click", freigabeAufheben);
el("feldAblauf").addEventListener("change", ablaufUebernehmen);
el("feldPasswort").addEventListener("change", passwortUebernehmen);
el("kopierPwBtn").addEventListener("click", async () => {
  const pw = el("feldPasswort").value;
  if (!pw) return;
  try {
    await navigator.clipboard.writeText(pw);
    dialogMelde("Passwort kopiert.");
  } catch (err) {
    el("feldPasswort").select();
    dialogMelde("Bitte von Hand kopieren.", true);
  }
});
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
