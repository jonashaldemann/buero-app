# Hinweise für Claude Code in diesem Repo

Büro-Apps für ein Architekturbüro — zehn kleine statische PWAs ohne
Build-Schritt, gehostet auf GitHub Pages (Branch `main`). Was die
Apps jeweils tun, steht ausführlich in `README.md` — diese Datei hier ist
bewusst kein Duplikat davon, sondern hält fest, **wie** wir zusammenarbeiten
und ein paar Architektur-Eckpunkte, die man sonst erst mühsam zusammensuchen
müsste.

**Diese Datei aktuell halten**: Sobald sich etwas Wichtiges ändert (neue
Architektur-Entscheidung, neue/geänderte Konvention im Arbeitsablauf, ein
Punkt aus "Bekannte offene Ideen" wird umgesetzt oder verworfen o.Ä.), diese
Datei im selben Zug anpassen — nicht erst auf Nachfrage warten.

## Arbeitsablauf mit dem Nutzer

- Der Nutzer sammelt Wünsche/Bugs auf Deutsch in einer **untracked**
  Scratch-Datei `claude_todos.txt` im Repo-Root und sagt dann sinngemäss
  "Nächste Todos?" / "geh die Todos durch".
- Jedes Todo wird umgesetzt **und per Playwright getestet**, bevor es als
  erledigt gilt (siehe Testvorgehen unten).
- Nach erfolgreicher Umsetzung: `README.md` aktualisieren (es ist die
  einzige Quelle der Wahrheit für Nutzerverhalten, immer aktuell halten),
  in `claude_todos.txt` die erledigten Zeilen entfernen (bei einem
  mehrzeiligen Todo reicht es, Zeile für Zeile zu streichen sobald sie
  erledigt ist — nicht erst am Schluss die ganze Datei leeren; ein
  "Später:"-Abschnitt sowie noch offene Zeilen bleiben dabei unverändert
  stehen), dann committen.
- **Nie pushen ohne frisches, explizites "ja"/"push mal" in genau dieser
  Runde** — eine frühere Zustimmung gilt nicht automatisch für die nächste.
  Nach dem Commit immer aktiv nachfragen.
- Commits: neue Commits statt amend, Message auf Deutsch, endet mit
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Bei grösseren, riskanten Umbauten (z.B. die Nextcloud-Ordner-Reorg) lohnt
  sich vorher ein Plan, den der Nutzer absegnet, statt direkt loszulegen.
- Bei offenen/konzeptionellen Fragen (z.B. "sollen wir Google Calendar
  syncen?") erst eine kurze Einschätzung mit Haupt-Trade-off geben und auf
  Zustimmung warten, nicht direkt implementieren.

## Testvorgehen

- Lokaler Server: `python3 -m http.server <port> --directory <repo-root>`,
  danach über Playwright ansteuern (Skripte im Scratchpad-Verzeichnis dieser
  Session ablegen, nicht im Repo).
- `browser.newContext({ serviceWorkers: "block" })`, damit der echte Service
  Worker beim Testen nicht dazwischenfunkt.
- Alle Nextcloud/Worker-Calls über `page.route("**://zeit-proxy.haldejonas.workers.dev/**", ...)`
  mocken (inkl. `Buero/.../App/config.json` und `.../App/projekte.txt`,
  siehe unten).
- Vor jedem Testlauf `node --check <datei>.js` auf alle geänderten
  JS-Dateien.
- Nach Änderungen an einer GEMEINSAMEN Datei (`shared/common.js` oder
  `css/style.css`): **CACHE_NAME in JEDEM `service-worker.js` bumpen**, das
  sie cached (aktuell alle Module + Root, ausser dem Redirect-Stub
  `zeitplanung/`) — sonst bekommen bestehende Installationen die Änderung
  nicht automatisch mit.
- Server danach beenden: `lsof -ti:<port> -sTCP:LISTEN | xargs -r kill`.

## Architektur-Eckpunkte

- **Module**: `zeiterfassung/`, `quittung/`, `wettbewerbsprogramme/`,
  `offerten/`, `adressliste/`, `pendenzen/`, `protokoll/`, `timeline/`
  (hiess früher "Zeitplanung"/`zeitplanung/` — unter der alten Adresse liegt
  bewusst ein Redirect-Stub, damit alte Lesezeichen/Home-Icons nicht ins
  Leere laufen), `finanzplanung/` (Liquiditätsplanung pro Kalenderjahr, ein
  File pro Jahr statt einer gemeinsamen Datei — siehe README),
  `baukosten/` (Kostenschätzung nach BKP, ein File pro Schätzung; der
  BKP-Katalog ist für alle Schätzungen gleich und liegt auf Nextcloud,
  siehe unten -- die Datei enthält nur das tatsächlich Erfasste).
- **Bearbeitungsfenster `baukosten/` ist ein Overlay** (`#detailPanel`,
  `renderPanel()`), kein Fenster rechts mehr: in der Kapitelansicht gäbe es
  dafür keinen Platz. Es öffnet nur ABSICHTLICH -- über "⋯" in der
  Tabellenzeile oder einen Klick auf eine Position in der Kapitelansicht;
  der Fokus in ein Feld öffnet es bewusst nicht mehr (das störte beim
  schnellen Erfassen). "+ Zeile" öffnet es NUR in der Kapitelansicht (dort
  gibt es keine Eingabefelder in der Liste); in der Tabelle würde es die
  neue Zeile zudecken, in die man gerade tippt. Geschlossen wird mit ✕/Esc/Klick daneben, gespeichert
  dabei automatisch (`schliessePanel()` ruft `uebernimmOffeneEingabe()`).
  z-index 70, also über Kopfblock (30) und Dialogen (60). Es ist modal:
  solange es offen ist, ist die Toolbar nicht bedienbar -- Tests müssen es
  vorher schliessen.
- **Dialoge `baukosten/`**: dieses Modul hat als einziges klebende Ebenen
  (Kopfblock `z-index: 30`, Spaltentitel und Gesamttotal `20`). Die lagen
  über den Dialogen (`.overlay` in `css/style.css` hat 20) und verdeckten
  deren oberen Rand samt Schliessen-Knopf — deshalb hebt `baukosten/`
  `.overlay` lokal auf `z-index: 60`. Bei neuen klebenden Ebenen daran
  denken.
- **Durchgeh-Status `baukosten/`** färbt NUR das Kästchen vor der Nummer,
  nie die ganze Zeile (das überdeckte die Ebenenfarben und machte die
  Tabelle unruhig). Der letzte Stand trägt deshalb zusätzlich einen
  Doppelhaken -- hell- gegen dunkelgrün allein ist auf 19 x 15 Pixeln zu
  fein. In den Dateien heisst er `verifiziert`, in der Oberfläche
  "Vieraugenprinzip" (`STATUS_LABEL`) -- der Schlüssel bleibt, sonst müsste
  jede bestehende Schätzung umgeschrieben werden.
- **Startsicht `baukosten/`**: eine Schätzung öffnet IMMER auf Ebene 1 (nur
  die zehn Hauptgruppen), `oeffne()` setzt das fest. Die Ebene wird also
  bewusst nicht gemerkt, die übrigen Ansichtseinstellungen schon. Tests,
  die an tiefere Zeilen wollen, müssen vorher `setzeEbene(4)` aufrufen.
- **Ansicht "Kapitel" `baukosten/`** (`ansichtModus`/`kapitelKnoten` in
  `app.js`, `renderKapitel()`): zeigt eine Ebene des Baums auf einmal, wie
  ein Steuerformular. Links der Pfad als Knöpfe, in der Mitte die direkten
  Kinder UND (falls vorhanden) die eigenen Positionen des Knotens, unten
  Weiter/Zurück durch die BLÄTTER des Baums. Sie hat den früheren Modus
  "Schritt für Schritt" (`wizard`) ersetzt. Alles rechnet über
  `alleKnoten()`/`kinderMap()`, NICHT über feste Ebenen -- Modus und
  offener Knoten werden wie die Ebene bewusst nicht gemerkt.
- **Der BKP-Katalog liegt auf NEXTCLOUD, nicht im Repo**: die vollständige
  Norm SN 506 500:2017 (920 Nummern) ist urheberrechtlich geschützt (CRB)
  und steht als `_bkp_katalog.json` in `Buero/Admin/App/Baukosten`, neben
  den Kostenschätzungen. `ladeKatalog()` holt sie nach dem Anmelden und
  legt sie im `localStorage` ab (Offline). Sie darf NIE ins Repo --
  `.gitignore` fängt eine Arbeitskopie ab. Format: `{ norm, ..., katalog:
  [[nr, titel], ...] }`, also dieselbe flache Liste wie `BKP_KATALOG`.
  Dateien mit `_` am Anfang werden in diesem Ordner nicht als Schätzung
  aufgelistet (`listFilenames()`), wie `_optionen.json`/`_absender.json`.
- **`baukosten/bkp.js` ist nur der GRUNDKATALOG** (876 Nummern, Ausgabe
  2017, aus öffentlichen Quellen zusammengesetzt -- sein Dateikopf sagt
  woher und was bereinigt wurde). Er gilt im Demomodus (dort bewusst, die
  Demodaten passen dazu) und beim allerersten Start ohne Netz; dann warnt
  die Sync-Zeile. Er ist nachweislich ungenauer als die Norm (ihm fehlen
  57/58/59 und rund 60 Gattungen, dafür hat er die Luzerner 415.1-416.7,
  die es gar nicht gibt). Änderungen am Katalog gehören auf Nextcloud.
- **Ohne die Norm wird NICHT migriert** (`katalogIstVollstaendig()`):
  `migriereAuf2017()` würde sonst Zeilen in eigene Unterkapitel umhängen,
  bloss weil die Datei gerade fehlt. Sichtbar bleiben sie trotzdem --
  `unbekannteKnoten()` hängt jede Nummer mit Zeilen in den Baum, notfalls
  mit Ersatztitel. Dieses Sicherheitsnetz speichert nichts.
- **Ebene 4, die Gattung** ("211.5 Beton- und Stahlbetonarbeiten"), gehört
  zum Katalog und ist nicht mehr Büro-Eigenes (seit November 2026, davor
  lief alles auf der Ausgabe 1991).
- **Bestehende Schätzungen fängt `migriereAuf2017()` auf** (app.js, läuft
  aus `migriere()` bei jedem Öffnen, idempotent): Zeilen unter 2017
  gestrichenen Nummern werden zu eigenen Unterkapiteln mit ihrem alten
  Titel, eigene Unterteilungen, deren Nummer der Katalog heute selbst führt
  ("211.1"), rücken auf eine freie Kennung. `BKP_ENTFALLEN_1991` in bkp.js
  liefert die alten Titel. Nicht erkennbar und deshalb nur in der README
  dokumentiert: die sechs Nummern mit anderer BEDEUTUNG (113, 245, 248,
  257, 196/296, 298).
- **Eigene Unterkapitel `baukosten/` tragen KEINE Nummer**: unterhalb der
  Gattung hört die Norm auf, dort gliedert das Büro frei ("Wände" >
  "Innenwände", wie im Architool-Printscreen). "+ Unterkapitel" fragt nur
  nach dem Namen, die Kennung vergibt `naechsteUnterteilung()` -- ab **10**
  aufwärts, damit sie nie mit einer Gattung (`.0`-`.9`) kollidiert, auch
  wenn der Katalog wächst. Angezeigt wird sie nirgends: `knotenLabel()` ist
  die einzige Stelle, die entscheidet, ob eine Nummer vor dem Titel steht
  (`istEigen()`). Neue Anzeigeorte müssen darüber laufen.
- **Nummern NICHT lexikografisch vergleichen** (`nummerVergleich()`): der
  Stamm ist Text ("2" < "21" < "211"), die Abschnitte hinter den Punkten
  sind ZAHLEN -- sonst landet ".10" vor ".2", und genau dort beginnt die
  eigene Nummerierung.
- **Baumtiefe `baukosten/` ist offen**: `knotenEbene()` ist drei Stellen
  plus eine Ebene je Punkt ("211.5.10" = Ebene 5), `elterNummer()` schneidet
  entsprechend. "+ Zeile" UND "+ Unterkapitel" gibt es auf JEDER Ebene ab
  der dreistelligen Position -- in der Tabelle wie in der Kapitelansicht
  (`kapitelAktionen()`); ein Knoten darf eigene Zeilen und Unterkapitel
  gleichzeitig haben. Ein neues Unterkapitel entsteht OHNE erste Zeile (nur
  Gliederung), Löschen nimmt alles darunter mit. Die Einrückung in der
  Tabelle setzt app.js als Stil statt über feste `bk-indent-*`-Klassen (ab
  Ebene 6 gedeckelt, sonst läuft die 112px-Spalte über). Nichts darf wieder
  gegen eine feste maximale Ebene programmiert werden.
- **Ebenen-Umschalter `baukosten/` ist 1/2/3/4/Alles**, wobei "Alles" den
  Wert **9** trägt (nicht 4): 4 ist die tiefste Ebene des Katalogs, 9 heisst
  "auch die eigenen Unterkapitel".
- **Druck `baukosten/` unterscheidet nach `eigenstaendig()`**, nicht nach
  Ebene: Katalogknoten (inkl. Gattung) werden immer eigenständig gedruckt,
  eigene Unterkapitel nur mit der Option. `zeilenDavon()` zieht deshalb nur
  die Zeilen von Nachfahren hoch, die NICHT selber gedruckt werden -- sonst
  stünde dieselbe Zeile zweimal da.
- **Keine Spaltentitel am Bildschirm `baukosten/`**: die Breiten tragen
  `<col>`-Elemente (`#bkCols`), und die Tabelle braucht dafür zwingend
  `table-layout: fixed` -- ohne Kopfzeile sind `<col>`-Breiten sonst nur
  Vorschläge und die `colspan`-Gruppenzeilen ziehen die Spalten krumm.
  Was in ein Feld gehört, steht als Platzhalter darin (`label` in
  `spalten()` ist der Platzhaltertext). Der AUSDRUCK behält seine Titel.
  Achtung bei neuen Zellen: `css/style.css` setzt `td { white-space:
  nowrap }` -- Text, der umbrechen soll, braucht `white-space: normal`
  (siehe `.bk-bem-zusammen`).
- **Layout-Ausnahme `baukosten/`**: als einziges Modul bewusst NICHT im
  Karten-Layout der übrigen Apps, sondern Kennzahlen oben + dichte Tabelle
  (nur feine horizontale Trennlinien) + einblendbares Detailfenster rechts
  — eine Kostenschätzung ist eine sehr lange, zahlenlastige Liste. Die
  SCHRIFTEN bleiben die gemeinsamen aus `css/style.css`, die Farben
  stammen aus derselben Palette, werden hier aber kräftiger eingesetzt
  (Akzentblau für Hauptgruppen, weisse Eingabefelder) — bei 500+ Zeilen
  gibt durchgehendes Beige zu wenig Struktur. Dort scrollt die SEITE
  (nicht ein innerer Container): Seitenkopf + Sync-Zeile scrollen weg,
  der Block darunter klebt oben; seine gemessene Höhe steht in der
  CSS-Variable `--bk-sticky-h`, an der die Spaltentitel einrasten.
- **Druckansicht `baukosten/`**: wird als eigene Tabelle nach `#printView`
  gerendert statt die Bildschirmansicht zu drucken — die Druckregeln (alle
  Hauptgruppen, aber nur verwendete Positionen; Unterpositionen
  zusammengefasst) sind bewusst unabhängig von der eingestellten Ansicht.
  `druckSeite(opt, modul)` rendert eine Seite: ohne Modul die ganze
  Schätzung, mit Modul dieselbe Tabelle nur mit dessen Zeilen (Option "Je
  Modul eine eigene Seite"). Der Filter läuft über `summenMit()` und
  `verwendeteKnoten(filter)` — keine zweite Rendering-Logik.
- **Umbenennen auf Nextcloud**: der Worker-Proxy lässt nur
  GET/PUT/MKCOL/PROPFIND/DELETE durch (kein MOVE, kein Destination-Header).
  Eine Datei umbenennen heisst deshalb überall: erst die neue schreiben,
  dann die alte löschen (`planeUmbenennen()` in `baukosten/app.js`) — in
  dieser Reihenfolge, damit ein Abbruch höchstens eine Kopie hinterlässt.
- **Kilometer-Quittung `quittung/km.js`** nutzt OpenStreetMap (Nominatim,
  OSRM, OSM-Kacheln), NICHT Google Maps: die Google-APIs brauchen einen
  Schlüssel (der hier im öffentlichen Repo stünde) plus Billing, und vor
  allem käme von einem eingebetteten Google-Fenster gar kein Bild ins PDF.
  Die drei OSM-Dienste schicken CORS-Header -- nur deshalb lässt sich das
  Canvas mit `crossOrigin="anonymous"`-Kacheln auslesen (`toDataURL`). Die
  Karte wird selbst gezeichnet statt über eine Kartenbibliothek, damit genau
  das Bildschirmbild ins PDF wandert. Die Quellenangabe gehört aufs Bild
  (Lizenz). Fahrzeuge/Ansätze kommen aus `config.json` (`fahrzeuge`), mit
  eingebautem Fallback. Tests mocken die drei Dienste -- die Mocks MÜSSEN
  CORS-Header mitschicken, sonst ist das Canvas tainted und der PDF-Teil
  schlägt fehl; zusätzlich gibt es einen Lauf gegen die echten Dienste.
- **Exportdateien für fremde Programme mit BOM**: `quittung/buchungen.txt`
  (Banana-Import) wird als UTF-8 **mit** BOM geschrieben, sonst rät Banana
  beim Import auf ANSI/UTF-16 und zerlegt die Umlaute. Beim Anhängen wird
  ein vorhandenes BOM zuerst entfernt (`stripBom()`), damit es genau einmal
  am Dateianfang steht. Gleiches gilt, falls je weitere Dateien für externe
  Buchhaltungs-/Tabellenprogramme erzeugt werden.
- **Kein öffentlicher Freigabelink mehr**: ALLE Module (seit neuem auch
  `zeiterfassung/dashboard/`, die Auswertung) lesen und schreiben
  ausschliesslich über den angemeldeten Zugang. Die Auswertung war die
  letzte Ausnahme und hatte einen Share-Token im öffentlichen Repo stehen.
  Falls je wieder ein Freigabelink erwogen wird: nicht ins Repo.
- **Prozent-Zeilen `baukosten/`**: eine Unterposition kann statt
  "Ausmass × Kennwert" ein Prozentsatz der Baukosten sein (fürs
  Architektenhonorar). Es gibt bewusst nur EINE Bemessungsgrundlage
  (`BASIS_ART`): BKP 1–9 ohne die Honorargruppen x9x. Prozent-Zeilen zählen
  NIE in ihre eigene Grundlage — BKP 291 liegt selbst in Hauptgruppe 2,
  sonst gäbe es einen Zirkelschluss (`basisBetrag()`). Ebenfalls draussen:
  Hauptgruppe 0.
- **MwSt `baukosten/`**: Kennwerte werden exklusive erfasst, die
  Kostenspalte und alle Summen zeigen inklusive. Der Zuschlag sitzt an
  GENAU einer Stelle (`zeilenKosten()`) — alles darunter (`einfacheKosten`,
  `basisBetrag`) rechnet netto, alles darüber ist inklusive. Der Satz steht
  pro Schätzung in den Kopfdaten (`data.mwst`, neue Schätzungen 8.1);
  Dateien ohne das Feld bekommen 0, weil dort die Kennwerte noch inklusive
  erfasst waren.
- **Module `baukosten/` werden separat ausgewiesen**: ein Modul ist ein
  separat zu ENTSCHEIDENDER Teilbereich ("Küche ersetzen"), nicht eine
  Aufteilung der ganzen Schätzung -- der Hauptteil der Kosten trägt kein
  Modul. Unter der Tabelle steht deshalb das Total der Positionen OHNE
  Modul, darunter je Modul eine Zeile, zuletzt das Gesamttotal; die
  Kennzahl-Kacheln stehen in derselben Reihenfolge. Die Beträge im Baum (Positions- und
  Gruppenzeilen) bleiben dagegen vollständig — die Aufteilung passiert nur
  im Fuss, in den Kacheln und in den optionalen Modulspalten. Die frühere
  Unterscheidung "Im Total"/"Zusätzlich" samt violettem "+" ist entfernt;
  alle Module sind gleich.
- **Bemerkungen `adressliste/` sind ein Verlauf**: `bemerkungen` ist ein
  Array `[{ at, von, text }]`, neueste zuoberst -- kein Freitextfeld mehr.
  Gelesen wird über `bemerkungenListe()`, das den FRÜHEREN Freitext-String
  weiterhin akzeptiert und als einen Eintrag liefert (Datum/Person aus
  `updatedAt`/`updatedBy`); bestehende Dateien wandern beim nächsten
  Speichern von selbst ins neue Format, es muss keine angefasst werden.
  Tabelle, Filter und CSV-Export gehen über `bemerkungenText()`.
- **Demomodus**: ohne gespeicherte Zugangsdaten antwortet statt des
  Worker-Proxys eine Attrappe (`demoFetch()` in `shared/common.js`, Daten
  aus `demo/seed.json`), Änderungen landen im `localStorage`. Der
  Einstiegspunkt sitzt bewusst auf Höhe von `proxyFetch()` — kein Modul
  kennt den Demomodus, alle zehn funktionieren unverändert. `isConfigured()`
  ist deshalb im Demomodus `true`. Siehe README.
- **Gemeinsamer Code**: `shared/common.js` (Nextcloud-Login/WebDAV,
  Einstellungen-Dialog, zentrale Konfiguration, Service-Worker-Registrierung
  mit Auto-Update). `localStorage` ist Origin-weit gültig — einmal
  eingeloggt gilt es in allen Modulen.
- **CORS-Proxy**: `worker.js` (separat auf Cloudflare deployt, kein Teil des
  Repo-Builds) reicht Requests an die Nextcloud durch. `PROXY_URL` in
  `shared/common.js` zeigt darauf.
- **Nextcloud-Ordnerstruktur**: alle Modul-Daten zentral unter
  `Buero/Admin/App/<Modul>` (`appModuleFolderPath()` in `shared/common.js`).
  Ausnahme: die eigentlichen Quittungs-Belege bleiben unter
  `Buero/Admin/Finanzen` (nur die vertraulichen Stammdaten liegen in
  `App/Finanzen`), Unterschriften-Bilder bleiben unter `Buero/Admin/KLG und
  Rechtliches/Unterschriften`.
- **Zentrale Konfiguration**: Mitarbeitende + Büro-Name in
  `Buero/Admin/App/config.json` (`{ bueroName, mitarbeitende: [{key, name,
  datei}] }`), Projekte bewusst separat als Klartext in
  `Buero/Admin/App/projekte.txt` (ein Projekt pro Zeile, optional "NNN
  Titel") — wird oft von Hand bearbeitet, dafür ist JSON unpraktisch. Beide
  werden unabhängig geladen (`refreshAppConfig()`/`appConfig` in
  `shared/common.js`); schlägt eine Datei fehl, bleibt für die andere Hälfte
  der letzte bekannte Stand erhalten. Beides erfordert Login, kein
  öffentlicher Freigabelink mehr.
- **Auto-Update**: `registerServiceWorkerWithAutoUpdate()` in
  `shared/common.js` lädt die Seite automatisch neu, sobald im Hintergrund
  eine neue Service-Worker-Version aktiv wird (wichtig, damit niemand
  nach einem Nextcloud-Pfad-Umzug versehentlich mit einer alten, gegen
  nicht mehr existierende Pfade laufenden Version weiterarbeitet).
- **`cache: "reload"` beim Install JEDES Service Workers** (nicht
  wegoptimieren): `cache.addAll()` holt die Dateien sonst durch den
  HTTP-Cache, und GitHub Pages liefert alles mit
  `Cache-Control: max-age=600`. Ein frisch deployter Worker legte dadurch
  bis zu zehn Minuten alte Dateien in seinen eigenen, neuen Cache und
  servierte sie anschliessend cache-first weiter -- eine neue Version kam
  trotz Reload und trotz Auto-Update nicht an (genau so gemessen, siehe
  unten). Mit `new Request(pfad, { cache: "reload" })` kommt sie sofort.
  Getestet wird das mit einem kleinen Server, der die GitHub-Pages-Header
  nachstellt: Seite laden, Dateien auf dem Server ändern, neu laden, prüfen
  ob die neue Fassung läuft. Ohne `cache: "reload"` schlägt dieser Test
  fehl, obwohl der neue Worker aktiv ist und der alte Cache gelöscht wurde.
  (`updateViaCache: "none"` bei `register()` wurde ebenfalls probiert und
  wieder verworfen -- es betrifft nur die Worker-Datei selbst und änderte
  im Test nichts.)

## Bekannte offene Ideen (noch nicht umgesetzt)

- Im Demomodus fehlen noch Beispieldaten für **Wettbewerbsprogramme** und
  **Quittung** (dort nur Kontenplan/Kategorien, keine Belege) — die Module
  starten leer, man kann aber Einträge anlegen.
- Google-Kalender-Sync für Ferien/Abwesenheiten in der Timeline (Vorschlag:
  privater iCal-Link pro Person statt volle Calendar-API/OAuth, über den
  Worker proxyen) — besprochen, aber bewusst zurückgestellt.
