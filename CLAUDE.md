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
  BKP-Katalog selbst liegt als `baukosten/bkp.js` im Repo und ist für alle
  Schätzungen gleich, die Datei enthält nur das tatsächlich Erfasste).
- **Dialoge `baukosten/`**: dieses Modul hat als einziges klebende Ebenen
  (Kopfblock `z-index: 30`, Spaltentitel und Gesamttotal `20`). Die lagen
  über den Dialogen (`.overlay` in `css/style.css` hat 20) und verdeckten
  deren oberen Rand samt Schliessen-Knopf — deshalb hebt `baukosten/`
  `.overlay` lokal auf `z-index: 60`. Bei neuen klebenden Ebenen daran
  denken.
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
  Architektenhonorar). Prozent-Zeilen zählen NIE in ihre eigene
  Bemessungsgrundlage — BKP 291 liegt selbst in Hauptgruppe 2, sonst gäbe
  es einen Zirkelschluss (`basisBetrag()`). Ebenfalls draussen: Hauptgruppe
  0.
- **MwSt `baukosten/`**: Kennwerte werden exklusive erfasst, die
  Kostenspalte und alle Summen zeigen inklusive. Der Zuschlag sitzt an
  GENAU einer Stelle (`zeilenKosten()`) — alles darunter (`einfacheKosten`,
  `basisBetrag`) rechnet netto, alles darüber ist inklusive. Der Satz steht
  pro Schätzung in den Kopfdaten (`data.mwst`, neue Schätzungen 8.1);
  Dateien ohne das Feld bekommen 0, weil dort die Kennwerte noch inklusive
  erfasst waren.
- **Module `baukosten/` werden separat ausgewiesen**: unter der Tabelle
  steht das Total der Positionen OHNE Modul, darunter je Modul eine Zeile,
  zuletzt das Gesamttotal. Die Beträge im Baum (Positions- und
  Gruppenzeilen) bleiben dagegen vollständig — die Aufteilung passiert nur
  im Fuss, in den Kacheln und in den optionalen Modulspalten. Die frühere
  Unterscheidung "Im Total"/"Zusätzlich" samt violettem "+" ist entfernt;
  alle Module sind gleich.
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

## Bekannte offene Ideen (noch nicht umgesetzt)

- Im Demomodus fehlen noch Beispieldaten für **Wettbewerbsprogramme** und
  **Quittung** (dort nur Kontenplan/Kategorien, keine Belege) — die Module
  starten leer, man kann aber Einträge anlegen.
- Google-Kalender-Sync für Ferien/Abwesenheiten in der Timeline (Vorschlag:
  privater iCal-Link pro Person statt volle Calendar-API/OAuth, über den
  Worker proxyen) — besprochen, aber bewusst zurückgestellt.
