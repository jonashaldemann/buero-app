# Zeiterfassung

Kleine PWA für Zeiterfassung per Knopfdruck (P1 / P2 / P3 / Pause / Stop),
die Einträge automatisch als CSV auf eine Nextcloud (via WebDAV) synchronisiert.
Läuft offline und synchronisiert, sobald wieder Netz da ist.

## Funktionsweise

- Klick auf **P1/P2/P3** beendet den aktuell laufenden Zähler (falls einer
  läuft) und startet sofort einen neuen für das geklickte Projekt.
- Klick auf **Pause** beendet den aktuellen Zähler, startet aber keinen neuen.
- Klick auf **Stop** ist identisch zu Pause (Tagesende).
- Jeder abgeschlossene Zeitabschnitt wird als eine Zeile in eine CSV-Datei
  auf eurer Nextcloud geschrieben — pro Person eine eigene Datei.
- Alles läuft lokal im Browser (localStorage), auch offline. Nicht
  synchronisierte Einträge werden automatisch nachgeliefert, sobald Internet
  verfügbar ist (Retry alle 30s + sofort bei "online"-Event).

## Ersteinrichtung

1. **Einmalig im Code**: in `js/app.js` ganz oben ist bereits eingetragen:
   - `NEXTCLOUD_SERVER_URL = "https://231121p3noy7vr3b2no.nextcloud.hosting.zone"`
   - `TARGET_FOLDER_PATH = "Buero/Admin/test_zeit"`
   Beides gilt für alle Nutzer gleich und wird committet. Ordner werden beim
   ersten Sync automatisch angelegt, falls sie noch nicht existieren.
2. In Nextcloud (pro Person, auf dem jeweiligen Gerät):
   **Einstellungen → Sicherheit → App-Passwörter** → neues App-Passwort
   erstellen (z.B. Name "Zeiterfassung-App").
3. In der App auf das Zahnrad-Symbol tippen und eintragen:
   - **Benutzername**: euer Nextcloud-Login
   - **App-Passwort**: das eben erstellte
   - Projektnamen könnt ihr hier ebenfalls direkt umbenennen (z.B. echte
     Projektnamen statt P1/P2/P3)
4. "Verbindung testen" klicken. Bei Erfolg "Speichern".

**Sicherheitshinweis:** Das App-Passwort wird ausschliesslich lokal im
Browser gespeichert (localStorage) und niemals ins Repo committet — anders
als die Server-URL ist es geheim und pro Person unterschiedlich.

Jede Person macht das auf ihrem eigenen Gerät mit ihrem eigenen Login —
die App speichert die Zugangsdaten nur lokal auf diesem Gerät.

## CORS-Proxy (Cloudflare Worker)

Die Managed Nextcloud bei hosting.de schickt bei Cross-Origin-Requests
(Browser → Nextcloud von einer anderen Domain aus) keine
`Access-Control-Allow-Origin`-Header — der Browser blockiert deshalb den
direkten Zugriff. Deshalb läuft die App nicht direkt gegen Nextcloud,
sondern über einen kleinen **Cloudflare Worker** als Proxy
(`cloudflare-worker/worker.js`). Der Worker läuft server-seitig, hat also
kein CORS-Problem beim Weiterleiten, und ergänzt in der Antwort die
fehlenden Header. Er speichert nichts — die Zeiterfassungsdaten liegen
weiterhin ausschliesslich auf eurer eigenen Nextcloud.

### Worker deployen (einmalig, ca. 10 Minuten)

1. Kostenloses Konto auf [dash.cloudflare.com](https://dash.cloudflare.com)
   erstellen (Free Plan reicht völlig, keine Kreditkarte nötig).
2. Im Dashboard: **Workers & Pages → Create → Create Worker**.
3. Einen Namen vergeben (z.B. `zeit-proxy`) → **Deploy** (legt erstmal einen
   Platzhalter an).
4. Auf **Edit Code** klicken, den kompletten Inhalt von
   `cloudflare-worker/worker.js` einfügen, **Deploy** klicken.
5. Cloudflare zeigt euch jetzt eure Worker-URL, z.B.
   `https://zeit-proxy.euer-name.workers.dev`.
6. Diese URL in `js/app.js` bei `PROXY_URL` eintragen (Zeile ganz oben,
   ersetzt `https://zeit-proxy.DEIN-SUBDOMAIN.workers.dev`), committen und
   pushen.

Falls sich später die Nextcloud-Domain oder der Zielordner ändert, reicht es,
`NEXTCLOUD_BASE` bzw. den Pfad-Aufbau in `worker.js` anzupassen und neu zu
deployen (Copy-Paste im Cloudflare-Dashboard, kein CLI-Tool nötig).

### Falls hosting.de doch noch CORS aktiviert

Falls der Support meldet, dass CORS-Header für die Nextcloud-Instanz
aktiviert wurden, könnte die App auch wieder direkt gegen Nextcloud laufen
(ohne Worker) — das wäre ein kleiner Rückbau in `js/app.js`. Bis dahin ist
der Worker die zuverlässigere Lösung.

## Projektnamen zentral verwalten

Die Projektnamen (P1/P2/P3) werden nicht mehr pro Gerät eingestellt, sondern
zentral von der Büroleitung in einer einfachen Textdatei auf Nextcloud
verwaltet. Alle Geräte laden sie automatisch (beim Start, danach alle 60
Sekunden sowie beim Zurückkehren in den Tab).

### Einmalige Einrichtung (als Admin)

1. In Nextcloud eine Textdatei anlegen, z.B.
   `Buero/Admin/test_zeit/projekte.txt`, mit **genau 3 Zeilen**:
   ```
   Projekt Nord
   Projekt Süd
   Verwaltung
   ```
   Zeile 1 = Name für P1, Zeile 2 = P2, Zeile 3 = P3.
2. Datei in Nextcloud anklicken → **Teilen** → **Link erstellen** (öffentlicher
   Freigabelink, keine Zugangsdaten nötig zum Lesen). Nextcloud zeigt einen
   Link wie `https://.../s/AbCdEfGh123`.

   **Sicherheitshinweis:** Wer diesen Link kennt, kann die Projektnamen
   lesen (nicht aber eure Zeiterfassungsdaten — die liegen woanders und sind
   weiterhin durch Benutzername/App-Passwort geschützt). Für reine
   Projektnamen ist das ein akzeptabler Kompromiss; bei Bedarf lässt sich
   der Link jederzeit in Nextcloud widerrufen oder mit einem Passwort
   versehen (dafür müsste der Worker minimal angepasst werden).
3. Den Teil nach `/s/` (den Token, z.B. `AbCdEfGh123`) in `js/app.js` bei
   `PROJECTS_SHARE_TOKEN` eintragen, committen, pushen.

### Projektnamen später ändern

Einfach die Textdatei direkt in Nextcloud bearbeiten (z.B. über die
Nextcloud-Weboberfläche mit der eingebauten Text-App) und speichern — alle
Geräte übernehmen die neuen Namen automatisch innerhalb von 60 Sekunden,
kein Code-Update nötig.

## Datenformat

Pro Person und Jahr eine Datei:
```
/Buero/Admin/test_zeit/zeiterfassung_2026.csv
```

Spalten:
```
Datum,Start,Ende,Dauer_Min,Projekt,Kommentar
2026-08-13,08:02:15,09:41:03,98.80,Projekt 1,
2026-08-13,09:41:03,09:47:30,6.45,Projekt 2,
```

- `Dauer_Min` ist auf 2 Nachkommastellen genau (aus Sekunden berechnet), damit
  spätere Auswertungs-Scripts exakt aufsummieren können.
- `Kommentar` ist aktuell immer leer — die Spalte ist bewusst schon da, damit
  ihr später ohne Formatänderung Kommentare pro Zeitslot ergänzen könnt.
- Klicks unter 5 Sekunden werden ignoriert (Schutz vor Versehen-Klicks).

## Bekannte Grenzen

- **Kein Konflikt-Schutz bei Gleichzeitigkeit**: Falls dieselbe Person die
  App auf zwei Geräten gleichzeitig nutzt, kann beim Sync ein Eintrag
  verloren gehen (read-modify-write ohne Locking). Bei einer Datei pro
  Person und normalem Gebrauch (ein Gerät) ist das kein Thema.
- Läuft die App über Stunden im Hintergrund/Tab geschlossen, wird der Zähler
  beim nächsten Öffnen aus dem gespeicherten Startzeitpunkt korrekt
  weitergerechnet (kein Datenverlust), aber es gibt keine Push-Erinnerung,
  falls ihr vergesst, auf Stop zu klicken.

## Lokal testen

```bash
cd zeiterfassung
python3 -m http.server 8080
# im Browser: http://localhost:8080
```

## Auf GitHub veröffentlichen (GitHub Pages)

```bash
git init
git add .
git commit -m "Zeiterfassung: Initial commit"
git branch -M main
git remote add origin https://github.com/<dein-user>/zeiterfassung.git
git push -u origin main
```

Danach im Repository unter **Settings → Pages**:
- Source: "Deploy from a branch"
- Branch: `main`, Ordner `/ (root)`

Nach 1–2 Minuten erreichbar unter:
`https://<dein-user>.github.io/zeiterfassung/`

Diese URL kann auf dem iPhone/Android über "Zum Home-Bildschirm hinzufügen"
installiert werden und verhält sich dann wie eine native App.
