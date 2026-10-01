# Hinweise für Claude Code in diesem Repo

Büro-Apps für ein Architekturbüro (Jonas Haldemann, jonasha@ethz.ch, und
Manuel Viecelli) — acht kleine statische PWAs ohne Build-Schritt, gehostet
auf GitHub Pages (Repo `jonashaldemann/buero-app`, Branch `main`). Was die
Apps jeweils tun, steht ausführlich in `README.md` — diese Datei hier ist
bewusst kein Duplikat davon, sondern hält fest, **wie** wir zusammenarbeiten
und ein paar Architektur-Eckpunkte, die man sonst erst mühsam zusammensuchen
müsste.

## Arbeitsablauf mit dem Nutzer

- Der Nutzer sammelt Wünsche/Bugs auf Deutsch in einer **untracked**
  Scratch-Datei `claude_todos.txt` im Repo-Root und sagt dann sinngemäss
  "Nächste Todos?" / "geh die Todos durch".
- Jedes Todo wird umgesetzt **und per Playwright getestet**, bevor es als
  erledigt gilt (siehe Testvorgehen unten).
- Nach erfolgreicher Umsetzung: `README.md` aktualisieren (es ist die
  einzige Quelle der Wahrheit für Nutzerverhalten, immer aktuell halten),
  `claude_todos.txt` leeren (einen eventuell vorhandenen "Später:"-Abschnitt
  dabei unverändert stehen lassen), dann committen.
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
- Nach Änderungen an `shared/common.js`: **CACHE_NAME in JEDEM
  `service-worker.js` bumpen**, das `../shared/common.js` cached (aktuell
  alle Module + Root) — sonst bekommen bestehende Installationen die
  Änderung nicht automatisch mit.
- Server danach beenden: `lsof -ti:<port> -sTCP:LISTEN | xargs -r kill`.

## Architektur-Eckpunkte

- **Module**: `zeiterfassung/`, `quittung/`, `wettbewerbsprogramme/`,
  `offerten/`, `adressliste/`, `pendenzen/`, `protokoll/`, `timeline/`
  (hiess früher "Zeitplanung"/`zeitplanung/` — unter der alten Adresse liegt
  bewusst ein Redirect-Stub, damit alte Lesezeichen/Home-Icons nicht ins
  Leere laufen).
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
  eine neue Service-Worker-Version aktiv wird (wichtig, damit z.B. Manuel
  nach einem Nextcloud-Pfad-Umzug nicht versehentlich mit einer alten,
  gegen nicht mehr existierende Pfade laufenden Version weiterarbeitet).

## Bekannte offene Ideen (noch nicht umgesetzt)

- Google-Kalender-Sync für Ferien/Abwesenheiten in der Timeline (Vorschlag:
  privater iCal-Link pro Person statt volle Calendar-API/OAuth, über den
  Worker proxyen) — besprochen, aber bewusst zurückgestellt.
