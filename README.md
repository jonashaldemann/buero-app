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

## Wichtig: CORS

Die App läuft im Browser und macht Cross-Origin-Requests an eure
Nextcloud-Domain. Damit das funktioniert, muss der Server bei einer
`OPTIONS`-Preflight-Anfrage korrekte CORS-Header zurückgeben.

**Vor dem produktiven Einsatz testen:**
Öffnet die App, tragt die Zugangsdaten ein und klickt "Verbindung testen".
Falls ihr eine Fehlermeldung mit "Failed to fetch" o.ä. seht, blockiert der
Server vermutlich CORS. Da ihr eine **managed** Nextcloud bei hosting.de habt,
könnt ihr die Server-Konfiguration evtl. nicht selbst anpassen. Optionen:

- Support von hosting.de fragen, ob CORS-Header für WebDAV aktiviert werden
  können.
- Alternative: ein kleines PHP-Proxy-Script auf eurem eigenen Webspace bei
  hosting.de, das die WebDAV-Requests serverseitig weiterleitet (kein
  CORS-Problem, da Server-zu-Server). Das können wir bei Bedarf nachrüsten,
  ohne die App selbst gross umzubauen — nur die `davBaseUrl()`-Funktion in
  `js/app.js` müsste dann auf den Proxy zeigen statt direkt auf Nextcloud.

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
