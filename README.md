# Büro-Apps

Zehn kleine PWAs für den Büroalltag, alle im gleichen Repo, alle einzeln als
App auf dem Homescreen installierbar:

- **[Zeiterfassung](zeiterfassung/)** — Zeit pro Projekt erfassen, Sync auf Nextcloud.
- **[Quittung](quittung/)** — Belege fotografieren/hochladen, für Nextcloud + Banana aufbereiten.
- **[Wettbewerbsprogramme](wettbewerbsprogramme/)** — Architekturwettbewerbe (JSON) hochladen und vergleichen.
- **[Offerten](offerten/)** — Offerten aus Modulen zusammenstellen, Kosten berechnen, auf Nextcloud sichern.
- **[Adressliste](adressliste/)** — Adressen filtern, Ansichten speichern, auf Nextcloud sichern.
- **[Pendenzen](pendenzen/)** — To-do-Liste nach Projekt und Person filterbar, auf Nextcloud sichern.
- **[Protokoll](protokoll/)** — Sitzungsprotokolle erfassen, PDF-Export, automatische Pendenzen.
- **[Timeline](timeline/)** — Terminplanung als horizontaler Zeitbalken (Gantt-artig).
- **[Finanzplanung](finanzplanung/)** — Liquiditätsplanung pro Kalenderjahr.
- **[Baukosten](baukosten/)** — Kostenschätzung nach BKP, mit Unterpositionen, Ausmassen und zwei Bemerkungsspalten.

Die **Startseite** (`index.html` im Repo-Root) ist nur ein Launcher: ein
App-Icon-Raster wie auf dem Smartphone-Homescreen (Icon + kurzes Label,
Beschreibung nur noch als Tooltip) statt einer langen Liste mit
Beschreibungstext. Jede App hat ihr eigenes `manifest.json` und ihren eigenen
`service-worker.js` — man kann also entweder die Startseite installieren
(Icon-Raster) **oder** direkt auf einer Unterseite "Zum Home-Bildschirm
hinzufügen" tippen, dann landet nur diese eine App als eigenes Icon auf dem
Homescreen.

Gemeinsamer Code (Nextcloud-Login, WebDAV-Zugriff, Einstellungen-Dialog,
zentrale Konfiguration) liegt in `shared/common.js` und wird von allen Apps
eingebunden. `localStorage` ist pro Domain (nicht pro Unterordner) gültig —
einmal in **irgendeiner** App unter dem Zahnrad-Symbol eingerichtet, gelten
Benutzername/App-Passwort automatisch auch in den anderen.

## Demomodus (ohne Login)

Solange **keine Zugangsdaten gespeichert** sind, laufen alle Apps im
Demomodus: statt der Nextcloud antwortet eine kleine Attrappe mit
Beispieldaten eines erfundenen Büros ("Muster Architektur"), und ein
gelbes Band oben weist darauf hin. So lässt sich jedes Modul anschauen und
ausprobieren, ohne echte Bürodaten zu sehen.

- **Wie realistisch die Daten sind**: die Beispiel-Kostenschätzung ist
  einmal ganz durchgegangen (siehe "Durchgehen zu zweit"): erfasste und
  geprüfte Positionen stehen auf "verifiziert" (dunkelgrün, Doppelhaken),
  für das Projekt nicht relevante leere Positionen auf "erledigt"
  (hellgrün), und gelb bleibt, was noch offen ist — Elektro, Heizung,
  Sanitär, ein paar Ausbaupositionen, das Geländer und der Honorarsatz. Die
  Kachel "Durchgegangen" zeigt dadurch einen plausiblen Stand statt 6 von
  461. Auch die **Module** sind so gesetzt, wie sie gemeint sind: rund 80%
  der Kosten tragen keines, und die beiden Module ("Dachterrasse", "Ersatz
  Küche") sind separat zu entscheidende Teilbereiche.
- **Woher die Daten kommen**: `demo/seed.json` im Repo — ein Objekt
  `{ "<Nextcloud-Pfad>": <Inhalt> }`. JSON-Dateien stehen dort als echte
  Objekte (lesbar), Textdateien wie `projekte.txt` als String. Neue
  Beispieldaten ergänzt man einfach als weiteren Schlüssel.
- **Wo das sitzt**: in `shared/common.js` auf Höhe von `proxyFetch()` —
  also ganz unten in der Schicht, genau dort, wo sonst der Worker-Proxy
  angesprochen wird (`demoFetch()`). GET, PUT, DELETE, MKCOL und PROPFIND
  werden nachgebildet. **Kein Modul kennt den Demomodus**: Laden,
  Speichern, Ordner auflisten und Löschen funktionieren unverändert.
- **Änderungen** landen ausschliesslich im `localStorage` dieses Browsers
  (Schlüssel `demo_overlay`) und überleben einen Reload. "Beispieldaten
  zurücksetzen" im Band verwirft sie. Hochgeladene Bilder/PDFs
  (Quittungs-Belege) werden bewusst nicht gespeichert — nur der Dateiname
  erscheint in der Ordnerliste, damit die Belegnummern weiterzählen.
- **Beim Anmelden** wird der `localStorage` komplett geleert (Demo-Daten
  und Modul-Caches) und die Seite neu geladen. Danach sind die
  Beispieldaten nicht mehr erreichbar: sie liegen unter einem eigenen
  Benutzer `demo` und einem eigenen Schlüssel, und die bereits gerenderte
  Demo-Ansicht ist durch den Reload weg.
- **Abschaltbar**: `DEMO_ENABLED = false` in `shared/common.js` stellt das
  frühere Verhalten wieder her ("Nextcloud noch nicht eingerichtet").

---

## Ersteinrichtung (einmalig, für alle Apps zusammen)

1. In Nextcloud: **Einstellungen → Sicherheit → App-Passwörter** → neues
   App-Passwort erstellen (z.B. Name "Büro-App").
2. In einer der Apps (egal welche) auf das Zahnrad-Symbol tippen:
   - **Benutzername**: euer Nextcloud-Login
   - **App-Passwort**: das eben erstellte
3. "Verbindung testen" klicken, bei Erfolg "Speichern". Ab jetzt sind die
   Zugangsdaten in allen Apps auf diesem Gerät nutzbar.

Kein eigenes Anzeigename-Feld (mehr) — der Name, der z.B. in der
Zeiterfassungs-CSV als "Person" erscheint, wird automatisch aus dem
Benutzernamen abgeleitet (`deriveDisplayName()` in `shared/common.js`): bei
einer E-Mail-Adresse der Teil vor dem "@", sonst der ganze Benutzername,
erster Buchstabe gross (z.B. `max` → "Max", `max@firma.ch` → "Max").

**Sicherheitshinweis:** Das App-Passwort wird ausschliesslich lokal im
Browser gespeichert (localStorage) und niemals ins Repo committet.

Jede Person macht das auf ihrem eigenen Gerät mit ihrem eigenen Login — jeder
Account hat seinen eigenen, komplett getrennten Nextcloud-Dateibereich.

## CORS-Proxy (Cloudflare Worker)

Die Managed Nextcloud bei hosting.de schickt bei Cross-Origin-Requests
(Browser → Nextcloud von einer anderen Domain aus) keine
`Access-Control-Allow-Origin`-Header — der Browser blockiert deshalb den
direkten Zugriff. Deshalb sprechen alle Apps nicht direkt mit Nextcloud,
sondern über einen kleinen **Cloudflare Worker** als Proxy (`worker.js`,
gemeinsam für alle Apps). Der Worker läuft server-seitig, hat also kein
CORS-Problem beim Weiterleiten, und ergänzt in der Antwort die fehlenden
Header. Er speichert nichts — die Daten liegen weiterhin ausschliesslich auf
eurer eigenen Nextcloud.

### Worker deployen (einmalig, ca. 10 Minuten)

1. Kostenloses Konto auf [dash.cloudflare.com](https://dash.cloudflare.com)
   erstellen (Free Plan reicht völlig, keine Kreditkarte nötig).
2. Im Dashboard: **Workers & Pages → Create → Create Worker**.
3. Einen Namen vergeben (z.B. `zeit-proxy`) → **Deploy** (legt erstmal einen
   Platzhalter an).
4. Auf **Edit Code** klicken, den kompletten Inhalt von `worker.js` einfügen,
   **Deploy** klicken.
5. Cloudflare zeigt euch jetzt eure Worker-URL, z.B.
   `https://zeit-proxy.euer-name.workers.dev`.
6. Diese URL bei `PROXY_URL` in `shared/common.js` eintragen (eine einzige
   Stelle, gilt für alle Apps), committen, pushen.

**Falls der Worker schon läuft:** Bei jeder Erweiterung der App (neue
HTTP-Methode, neuer Header) muss der Code in `worker.js` erneut im
Cloudflare-Dashboard eingefügt und deployed werden — Copy-Paste, kein
CLI-Tool nötig. Aktuell braucht der Worker `GET`, `PUT`, `MKCOL`, `PROPFIND`
und `DELETE`.

### Falls hosting.de doch noch CORS aktiviert

Falls der Support meldet, dass CORS-Header für die Nextcloud-Instanz
aktiviert wurden, könnten die Apps auch direkt gegen Nextcloud laufen (ohne
Worker) — das wäre ein kleiner Rückbau in `shared/common.js`. Bis dahin ist
der Worker die zuverlässigere Lösung.

## Nextcloud-Ordnerstruktur

Alle App-Daten liegen zentral gebündelt unter `Buero/Admin/App/`, ein
Unterordner pro Modul (`appModuleFolderPath()` in `shared/common.js`):

| Modul | Ordner |
|---|---|
| Adressliste | `Buero/Admin/App/Adressen` (Ansichten in `.../Adressen/Ansichten`) |
| Offerten | `Buero/Admin/App/Offerten und Rechnungen` |
| Pendenzen | `Buero/Admin/App/Pendenzen` |
| Protokoll | `Buero/Admin/App/Protokolle` |
| Zeiterfassung | `Buero/Admin/App/Zeiterfassung` |
| Wettbewerbsprogramme | `Buero/Admin/App/Wettbewerbe` |
| Timeline | `Buero/Admin/App/Timeline` |
| Finanzplanung | `Buero/Admin/App/Finanzplanung` (ein File pro Jahr) |
| Baukosten | `Buero/Admin/App/Baukosten` (ein File pro Kostenschätzung) |
| Finanzen-Stammdaten (Kontenplan/Kategorien/MwSt, vertraulich) | `Buero/Admin/App/Finanzen` |
| Zentrale Konfiguration: Mitarbeitende + Büro-Name | `Buero/Admin/App/config.json` |
| Zentrale Konfiguration: Projekte | `Buero/Admin/App/projekte.txt` |

**Ausnahme:** die eigentlichen Quittungen/Rechnungsbelege (Fotos/PDFs) bleiben
unter `Buero/Admin/Finanzen` (ausserhalb von `App/`) — nur die vertraulichen
Stammdaten (Kontenplan/Kategorien/MwSt-Codes) liegen in `App/Finanzen`, siehe
Abschnitt "Quittung" unten. Die Unterschriften-Bilder für den PDF-Export
bleiben ebenfalls an ihrem bisherigen Ort (`Buero/Admin/KLG und Rechtliches/
Unterschriften`), da sie auch von anderen Workflows verwendet werden.

Mitarbeitende kommen zentral aus `Buero/Admin/App/config.json`, Projekte aus
`Buero/Admin/App/projekte.txt`, siehe Abschnitt "Zentrale Konfiguration"
unter "Zeiterfassung" unten.

---

## Zeiterfassung

Zeit per Knopfdruck erfassen (ein Knopf pro Projekt, Stop, Nachtragen), Einträge werden
automatisch als CSV auf Nextcloud synchronisiert. Läuft offline und
synchronisiert, sobald wieder Netz da ist.

### Funktionsweise

- Klick auf **P1/P2/P3** beendet den aktuell laufenden Zähler (falls einer
  läuft) und startet sofort einen neuen für das geklickte Projekt.
- Klick auf **Stop** beendet den aktuellen Zähler, startet aber keinen neuen
  (Pause wie Tagesende). Einen separaten "Pause"-Knopf gab es früher, er tat
  exakt dasselbe wie "Stop" und ist deshalb entfallen.
- **Nachtragen**: Zeit für ein beliebiges (auch vergangenes) Datum manuell
  eintragen, falls mal vergessen wurde zu starten/stoppen.
- In der "Heute"-Liste lässt sich jeder Eintrag über das Stift-Symbol (✎)
  bearbeiten: Dauer und Kommentar für diesen Tag/dieses Projekt anpassen
  (überschreibt die bisherige Summe) oder über "Löschen" komplett entfernen
  (inkl. Kommentar, mit Rückfrage).
- Jeder abgeschlossene Zeitabschnitt wird als eine Zeile in eine CSV-Datei
  auf eurer Nextcloud geschrieben — pro Person eine eigene Datei.
- Alles läuft lokal im Browser (localStorage), auch offline. Nicht
  synchronisierte Einträge werden automatisch nachgeliefert, sobald Internet
  verfügbar ist (Retry alle 30s + sofort bei "online"-Event).

Zielordner: `TARGET_FOLDER_PATH` in `zeiterfassung/app.js` (Standard
`Buero/Admin/App/Zeiterfassung`, siehe Abschnitt "Nextcloud-Ordnerstruktur"
oben), wird bei Bedarf automatisch angelegt.

### Zentrale Konfiguration (`config.json` + `projekte.txt`)

Mitarbeitende und Projekte werden zentral von der Büroleitung verwaltet, in
**zwei getrennten** Dateien auf Nextcloud — bewusst nicht in einer
gemeinsamen JSON-Datei, weil die Projektliste von beiden Personen oft
bearbeitet wird und eine reine Textdatei dafür praktischer ist (kein
JSON-Syntaxrisiko durch Kommas/Anführungszeichen). Alle Module laden beide
über dieselbe Funktion (`refreshAppConfig()` in `shared/common.js`) — beim
Start (nach dem Login), nach dem Speichern der Einstellungen sowie danach
alle 60 Sekunden/beim Zurückkehren in den Tab. Ein Login (Benutzer +
App-Passwort) ist dafür zwingend nötig — es gibt keinen öffentlichen,
zugangsdatenfreien Lesezugriff mehr. Beide Dateien werden unabhängig
voneinander geladen: ist eine (noch) nicht erreichbar, bleibt für die
jeweils andere trotzdem der letzte bekannte Stand erhalten.

**`Buero/Admin/App/config.json`** — Mitarbeitende + Büro-Name:
```json
{
  "bueroName": "Muster Architekten AG",
  "mitarbeitende": [
    { "key": "max", "name": "Max Muster", "datei": "Unterschrift_Max_Muster.png" },
    { "key": "erika", "name": "Erika Muster", "datei": "Unterschrift_Erika_Muster.png" }
  ]
}
```
`bueroName` erscheint als Titel auf der Startseite (Dashboard) sowie im
Browser-Tab, anstelle des sonst fest hinterlegten "Büro" — fehlt das Feld
(oder ist noch nicht eingeloggt), bleibt es beim generischen "Büro" als
Fallback. `key` (interner Schlüssel, z.B. für Kürzel/Zuordnung), `name`
(Anzeigename), `datei` (Dateiname der Unterschrift auf Nextcloud, siehe
Abschnitt "Unterschriften" bei den Offerten — nur dort gebraucht, kann bei
anderen Einträgen weggelassen werden).

**`Buero/Admin/App/projekte.txt`** — Projekte, ein Eintrag pro Zeile,
optional mit **dreistelliger Projektnummer, Leerschlag, Projekttitel** (der
Titel darf selbst Leerschläge enthalten; eine Zeile ohne führende Nummer ist
ebenso gültig und besteht dann nur aus dem Titel):
```
021 Neubau Werkhof
014 Umbau Altstetten
003 Verwaltung
```

**Zeiterfassung, Pendenzen und Timeline** ordnen Einträge, filtern und
weisen Farben **über den Projektnamen** zu, nicht über die Nummer — eine
Nummer ist dort rein kosmetisch (wird beim Anzeigen aus der Zeile
herausgeparst, taucht aber nirgends in der App auf) und darf durchaus
mehrfach vergeben sein, z.B. für mehrere interne/nicht-projektbezogene
Kategorien:
```
000 Büro Allgemein
000 Akquisition
```
"Büro Allgemein" und "Akquisition" bekommen hier trotz identischer Nummer
"000" unterschiedliche Farben und werden beim Filtern korrekt auseinander-
gehalten (Farbe = String-Hash des Namens, siehe `stringHash()` in
`zeiterfassung/app.js`/`pendenzen/app.js`/`zeiterfassung/dashboard/js/
dashboard.js`). Einzige Einschränkung: der **Name** muss eindeutig sein — zwei
Zeilen mit demselben Namen wären für Zeiterfassung/Pendenzen/Timeline nicht
unterscheidbar. Ein Projekt umzubenennen trennt bestehende Einträge vom
"neuen" Namen (kein stabiler ID-Bezug wie bei einer reinen Nummer) — dafür
sind Nummern-Dopplungen (s.o.) unproblematisch, was in der Praxis öfter
vorkommt als eine Umbenennung.

**Protokoll und Rechnungen** (bei den Offerten) hingegen wählen ein Projekt
über ein Dropdown mit **Nummer UND Name gemeinsam** (siehe jeweiliger
Abschnitt unten). Auch hier ist eine mehrfach vergebene Nummer unproblematisch:
die Dropdown-Optionen selbst sind intern über ihre Position in der Liste
(nicht über die Nummer) eindeutig identifizierbar, sodass sich zwei
gleichnummerierte Projekte trotzdem sauber auseinanderhalten lassen —
sowohl beim Auswählen als auch beim späteren Wiederöffnen eines
gespeicherten Protokolls/einer Rechnung (die richtige Option bleibt
vorausgewählt, nicht z.B. die erste mit derselben Nummer).

Später ändern: einfach die jeweilige Datei in Nextcloud bearbeiten und
speichern — alle Geräte übernehmen die Änderung automatisch (spätestens
nach 60s bzw. beim nächsten Tab-Wechsel), kein Code-Update nötig.

### Datenformat

Pro Person und Jahr eine Datei (im jeweils eigenen Nextcloud-Account):
```
/Buero/Admin/Zeiterfassung/zeiterfassung_2026.csv
```

Spalten:
```
Datum,Projekt,Dauer_Min,Kommentar,Person
2026-08-13,Projekt Nord,105.30,Vormittag Konzept, Nachmittag Umsetzung,Max
2026-08-13,Projekt Süd,12.45,Kurzes Telefonat,Max
```

Es gibt **eine Zeile pro Tag und Projekt**, nicht eine Zeile pro
Start/Stop-Wechsel — mehrere Wechsel zum selben Projekt am selben Tag werden
zu einer Summe zusammengefasst. Beim Sync wird die passende Zeile gesucht und
aktualisiert; nur wirklich neue Tag/Projekt-Kombinationen werden angehängt.

- `Dauer_Min` ist auf 2 Nachkommastellen genau.
- `Kommentar` lässt sich in der App unter "Heute" pro Projekt eintragen,
  bezieht sich auf die Tagessumme, nur für den **heutigen** Tag editierbar.
- `Person` kommt aus dem Anzeigename, der automatisch aus dem Benutzernamen
  abgeleitet wird (siehe "Ersteinrichtung" oben).
- Klicks unter 5 Sekunden werden ignoriert (Schutz vor Versehen-Klicks).

### Auswertung (zeiterfassung/dashboard/)

Filterbare Auswertung der erfassten Zeiten (nach Jahr, Zeitraum, Projekt,
Person) mit Summe, Balken pro Projekt und pro Tag sowie der Einzelliste.

- **Datenquelle**: die Jahres-CSVs im Nextcloud-Ordner der angemeldeten
  Person (`Buero/Admin/App/Zeiterfassung/`), gelesen über dieselbe Schicht
  wie alle anderen Module (`shared/common.js`). Der Ordner wird per PROPFIND
  aufgelistet und alle passenden `.csv` werden zusammengeführt — die
  Spalte "Person" hält die Leute auseinander.
- **Ohne Login** zeigt die Auswertung wie alle Module **Demo-Beispieldaten**
  (siehe Abschnitt "Demomodus"), nicht die echten Zahlen. Die Statuszeile
  sagt dann "Beispieldaten" statt "Stand".
- **Früher** las dieses Dashboard als einziges Modul über einen
  **öffentlichen Nextcloud-Freigabelink**, dessen Token im (öffentlichen)
  Repo stand — jeder, der das Repo fand, konnte die Zeitdaten lesen. Das ist
  entfernt; der Freigabelink selbst muss in Nextcloud zusätzlich
  **widerrufen** werden, da der alte Token in der Git-Historie bleibt.

---

## Quittung

Belege (Foto oder PDF) erfassen, nach Nextcloud hochladen und als Buchung für
Banana vorbereiten. Die kurze Bedienungsanleitung steht nicht mehr fest auf
der Seite, sondern hinter dem ?-Symbol ("Hilfe") neben Startseite/
Einstellungen oben rechts.

1. Foto aufnehmen oder Datei (Bild/PDF) auswählen.
2. Datum, Einnahme/Ausgabe, Betrag, MwSt/USt-Code, Konto und Kategorie sowie
   einen Verwendungszweck eingeben. Die MwSt/USt-Code-Auswahl passt sich
   automatisch an Einnahme/Ausgabe an (Umsatzsteuer-Codes `V*` bei Einnahme,
   Vorsteuer-Codes `M*`/`I*` bei Ausgabe), ebenso die Kategorie-Auswahl (nur
   Erlöse bei Einnahme, nur Aufwände bei Ausgabe).
3. Beim Speichern:
   - Zielordner ist `RECEIPT_TARGET_FOLDER_PATH` (Standard
     `Buero/Admin/Finanzen` in `quittung/app.js`) **plus automatisch das
     aktuelle Jahr** als letzte Ebene, z.B. `Buero/Admin/Finanzen/2026`.
   - **Belegnummer-Schema:** `[JJ]-[A|E][NNN]`, z.B. `26-A003` — `JJ` =
     aktuelles Jahr (2-stellig), `A`/`E` = Ausgabe/Einnahme, `NNN` =
     dreistellig fortlaufend, **getrennt gezählt pro Jahr und Typ**. Die App
     liest den Zielordner per WebDAV (`PROPFIND`) und zählt weiter.
   - **Fotos werden automatisch in ein PDF umgewandelt** (echte PDF-Uploads
     bleiben unverändert) — damit landen im Ordner einheitlich nur PDFs. Die
     Umwandlung passiert komplett im Browser, ohne externe Bibliothek: das
     Foto wird auf ein `<canvas>` gezeichnet, als JPEG re-encodiert und roh
     (`DCTDecode`) in ein von Hand zusammengesetztes Ein-Seiten-PDF
     eingebettet (A4, Bild zentriert/eingepasst, Hoch- oder Querformat je
     nach Seitenverhältnis) — siehe `imageFileToPdfBlob()`/
     `buildSingleImagePdf()` in `quittung/app.js`.
   - Die Datei wird als `[Belegnummer] [Verwendungszweck, max. 60
     Zeichen].pdf` in diesen Ordner hochgeladen, z.B.
     `26-A003 KUARIO Quittung.pdf`.
   - Zusätzlich wird die Buchung als Zeile an `buchungen.txt` im selben
     (Jahres-)Ordner angehängt.

**Wichtig:** Diese Funktion braucht zwingend eine Internetverbindung (die
nächste Belegnummer wird live aus dem Ordnerinhalt ermittelt) — kein
Offline-Modus.

Unter dem Button zeigen zwei Listen ("Letzte Ausgaben"/"Letzte Einnahmen",
je Nummer/Bezeichnung) die letzten 5 bzw. 2 Belege — anhand der
tatsächlich im Zielordner liegenden Belegdateien ermittelt (Dateiname
`[Belegnummer] [Bezeichnung].ext`), nicht aus `buchungen.txt` (die kann
z.B. nach einem Banana-Import geleert werden, während die Beleg-PDFs
bleiben), neueste zuerst. **Bewusst ohne Betragsspalte**: der Betrag steht
nur in `buchungen.txt` und wäre gerade für ältere Belege oft nicht (mehr)
auffindbar — Nummer und Bezeichnung reichen als schneller Überblick.
Aktualisiert sich nach jedem gespeicherten Beleg sowie beim Zurückkehren in
die App.

### Banana-Import-Format (buchungen.txt)

Banana Buchhaltung importiert kein CSV, sondern nur sein eigenes generisches
Tab-getrenntes TXT-Format "Bewegungen Einnahmen-Ausgaben". Die
[offizielle Doku](https://www.banana.ch/doc/en/node/9946) nennt die Spalten
"DocInvoice"/"ContraAccount" — im tatsächlichen Import-Dialog von Banana
heissen sie aber **"Doc"/"Category"** (im Test bestätigt, die Doku ist an der
Stelle ungenau):

```
Date	Description	Income	Expenses	Doc	Category	Account	VatCode
2026-01-15	KUARIO Quittung		45.90	26-A003	4000	6500	M81
```

(`Date` im Format `yyyy-mm-dd`, Beträge mit Punkt als Dezimaltrennzeichen,
kein Tausendertrennzeichen.) Die Spalten werden so befüllt:

| Datei-Spalte | Quelle |
|---|---|
| `Date` | Datum aus dem Formular |
| `Description` | Verwendungszweck (voller Text, nicht gekürzt) |
| `Income` / `Expenses` | Betrag, je nachdem ob Einnahme oder Ausgabe |
| `Doc` | Belegnummer, z.B. `26-A003` |
| `Category` | Kategorie/Gegenkonto |
| `Account` | Konto |
| `VatCode` | MwSt/USt-Code |

Die Datei wird als **UTF-8 mit BOM** geschrieben (die drei Bytes `EF BB BF`
am Dateianfang). Banana erwartet laut Doku UTF-8, erkennt das ohne BOM aber
nicht zuverlässig und liest die Datei dann je nach System als ANSI oder
UTF-16 — aus `ä/ö/ü` werden dabei Kauderwelsch-Zeichen. Das BOM ist die
Kennzeichnung in der Datei selbst; Banana (wie auch Excel oder Notepad)
entfernt es beim Lesen wieder, es taucht also nirgends als Text auf.

`buchungen.txt` ist bewusst **nicht** direkt die Banana-Buchhaltungsdatei
(deren `.ac2`/natives Format ist proprietär), sondern eine Warteschlange zum
Import: in Banana über **Datei → Import → Bewegungen importieren** einlesen.

### Kontenplan, Kategorien und MwSt/USt-Codes pflegen

Kontenplan, Kategorien und MwSt/USt-Codes werden **nicht** in `quittung/app.js`
hart hinterlegt, sondern zur Laufzeit aus drei Textdateien geladen —
**unterschiedlich abgelegt**, je nachdem ob sie Projekt-/Kundennamen
enthalten:

- **`mwst.txt`**: reine, nicht auftragsbezogene Banana-Referenzliste der
  MwSt/USt-Codes — liegt im `quittung/`-Ordner im Repo, vom gleichen Origin
  wie die App selbst ausgeliefert (GitHub Pages), reicht ein einfacher
  `fetch()` (kein Nextcloud-Proxy nötig, kein CORS-Thema).
- **`konten.txt`/`kategorien.txt`**: die Kategorien enthalten Kontonummern
  mit Projekt-/Kundenbezug (z.B. Adressen laufender Aufträge als
  Kategorie-Bezeichnung) — liegen deshalb **vertraulich auf Nextcloud** unter
  `Buero/Admin/App/Finanzen/` statt im (öffentlichen!) Repo, per
  Nextcloud-Proxy geladen (braucht deshalb ein Login, siehe unten). Lokal
  bei dir bleiben sie trotzdem als Arbeitskopie in `quittung/konten.txt`/
  `kategorien.txt` bestehen (in `.gitignore` eingetragen, damit sie nicht
  versehentlich wieder committet werden).

**Format** (beide Fälle gleich): Tab-getrennte Zeilen `Code<TAB>Bezeichnung`,
ein Eintrag pro Zeile — exakt der Export aus Banana (**Datei → Export →
Daten für Excel/Open Office/…**, Tabellen "Accounts"/"Categories"/
"VatCodes", dort die Beträge-Spalten weglassen/löschen). Zeilen ohne Code
(Leerzeilen, Abschnittsüberschriften, Total-Zeilen) werden beim Einlesen
automatisch übersprungen; bei `kategorien.txt` werden die Überschriften
"ERLÖSE" und "AUFWÄNDE" als Gruppen erkannt.

**Ändert sich der Kontenplan in Banana:**
- `mwst.txt`: Datei in Banana neu exportieren, Beträge-Spalten entfernen,
  `quittung/mwst.txt` ersetzen, committen und pushen — die App übernimmt die
  Änderung automatisch (alle 60s sowie beim Öffnen des Beleg-Formulars),
  **ohne Code-Update**.
- `konten.txt`/`kategorien.txt`: Datei in Banana neu exportieren,
  Beträge-Spalten entfernen, die lokale `quittung/konten.txt`/
  `kategorien.txt` ersetzen (nur als eigene Arbeitskopie/Referenz) und die
  aktualisierte Datei direkt in Nextcloud unter
  `Buero/Admin/App/Finanzen/` hochladen (ersetzen) — **kein
  Commit/Push nötig**, die App lädt beim nächsten Öffnen/alle 60s die
  Nextcloud-Version neu.

`MWST_EINNAHME_CODES`/`MWST_AUSGABE_CODES` in `quittung/app.js` legen fest,
welche Codes aus `mwst.txt` überhaupt zur Auswahl stehen (aktuell nur die
gültigen Sätze 0/2.6/3.8/8.1%) — das ändert sich praktisch nie und bleibt
deshalb hart hinterlegt; nur die Beschreibungstexte kommen live aus
`mwst.txt`.

Für den allerersten Start ohne Internet/Login gibt es zusätzlich
`FALLBACK_KONTEN`/`FALLBACK_KATEGORIEN`/`FALLBACK_MWST_CODES` in
`quittung/app.js` als Fallback (danach übernimmt der localStorage-Cache der
zuletzt erfolgreich geladenen Dateien diese Rolle) — bewusst **ohne** die
auftragsspezifischen Kategorien-Zeilen, da dieser Fallback im (öffentlichen)
Quellcode steht.

**Sicherheitshinweis:** Ein roher Banana-Export (mit Beträgen) enthält reale
Umsatz-/Aufwandszahlen pro Konto — **so eine Datei niemals ins Repo
committen**, da dieses Repo öffentlich auf GitHub liegt (GitHub Pages braucht
ein öffentliches Repo). `*.jcsv`-Dateien sind deshalb in `.gitignore`
eingetragen — vor jedem Export sicherstellen, dass in
`konten.txt`/`kategorien.txt`/`mwst.txt` wirklich nur Code und Bezeichnung
stehen, keine Beträge-Spalten.

---

## Wettbewerbsprogramme

Mehrere strukturierte JSON-Zusammenfassungen von
Architekturwettbewerbs-Ausschreibungen hochladen, auf Nextcloud sichern
(geräteübergreifend verfügbar) und tabellarisch vergleichen.

- **JSON hochladen**: eine oder mehrere `.json`-Dateien auswählen. Jede muss
  mindestens ein Feld `projektname` haben, sonst wird sie mit Fehlermeldung
  übersprungen. Erwartetes Schema: Felder wie `auftraggeber`, `bausumme`,
  `groesse`, `termine`, `preisgeld`, `sachjury`, `fachjury`,
  `verfahrenssekretariat`, …
- **Tabelle**: eine Zeile pro Wettbewerb (Projekt, Auftraggeber, Bausumme,
  HNF/GF, Preisgeld, Abgabetermin, Anzahl Preise). Klick auf eine Zeile öffnet
  die Detailansicht mit allen weiteren Feldern (Jury, Verfahrenssekretariat,
  Aufgabe, Experten) sowie einem Löschen-Button.
- **Speicherort**: Zielordner `WETTBEWERB_TARGET_FOLDER_PATH` (Standard
  `Buero/Admin/App/Wettbewerbe` in `wettbewerbsprogramme/app.js`), kein
  Jahresordner (Wettbewerbe sind nicht zwingend jahresgebunden). Jede Datei
  wird unter ihrem (bereinigten) Originaldateinamen abgelegt; erneutes
  Hochladen derselben Datei überschreibt die bestehende Version.
- Lokaler `localStorage`-Cache des zuletzt geladenen Datensatzes als
  Offline-Fallback; Refresh automatisch alle 60s sowie beim Zurückkehren in
  den Tab, oder manuell über "Aktualisieren".

Diese Funktion braucht (wie Quittung) `DELETE` als erlaubte HTTP-Methode im
Cloudflare Worker — siehe Abschnitt "Worker deployen" oben.

---

## Offerten

Offerten **und Rechnungen** (gleiches Formular/Datenmodell, unterschieden
durch das Feld "Typ") aus einzelnen Positionen (Phasen-Überschriften und
Module) zusammenstellen, beliebig hoch-/runterschieben, Zwischentotal / MWST
/ Total automatisch berechnen, auf Nextcloud sichern und als PDF exportieren.
Offerten/Rechnungen lassen sich duplizieren, um für ähnliche Aufträge nicht
alles neu erfassen zu müssen.

- **Liste**: alle gespeicherten Offerten/Rechnungen (Nr., Datum, Typ,
  Projekt, Empfänger, Total, Status), neueste zuerst, mit PDF- (📄) und
  Duplizieren-Button (⧉) pro Zeile. "+ Neu" öffnet den Editor leer (Typ
  "Offerte" vorausgewählt, im Editor umschaltbar), Klick auf eine Zeile
  öffnet ihn zum Bearbeiten. Die **Status**-Spalte ganz rechts ist als
  einziges Feld direkt in der Liste editierbar (Dropdown, ohne den Editor zu
  öffnen) und speichert die Änderung sofort auf Nextcloud.
- **Status**: rein interner Vermerk, taucht **nicht** im PDF auf — nur zur
  eigenen Übersicht, editierbar im Editor (vierte Spalte neben Typ/Nr./
  Datum) oder direkt in der Liste. Rechnungen kennen alle drei Werte (In
  Bearbeitung / Versendet / Bezahlt, siehe `STATUS_LABELS`/
  `statusKeysForTyp()` in `offerten/app.js`) — Offerten dagegen bewusst nur
  zwei (In Bearbeitung / Versendet, kein "Bezahlt": man bezahlt kein
  Angebot). Da "Versendet" bei einer Offerte damit bereits der Endzustand
  ist, erscheint es dort grün (wie "Bezahlt" bei Rechnungen), während es bei
  Rechnungen weiterhin neutral-blau bleibt (dort ist ja erst "Bezahlt" der
  Abschluss). Beim Umschalten des Typs im Editor bleibt eine gültige
  Status-Auswahl erhalten, eine bei Rechnung gesetzte "Bezahlt"-Auswahl
  fällt beim Wechsel zu Offerte auf "In Bearbeitung" zurück.
- **Typ**: Offerte oder Rechnung, jederzeit im Editor umschaltbar (gleiches
  Formular für beide) — "Offert-Nr." heisst dann "Rechnungs-Nr.", und im PDF
  erscheint unterhalb der Summen zusätzlich fix der Satz
  "Zahlbar innert 30 Tagen" (bewusst kein eigenes Feld dafür, kein Datum und
  kein IBAN/QR-Zahlteil — der wird separat übers E-Banking erstellt). Eine
  bestehende Offerte per Typ-Wechsel + Speichern direkt in eine Rechnung
  umzuwandeln, überschreibt dieselbe Datei (kein automatisches "Original
  behalten + neue Rechnung erzeugen") — dafür zuerst **Duplizieren**, dann
  am Duplikat den Typ auf Rechnung stellen.
- **Sprache**: bei **Rechnungen** zusätzlich ein Dropdown Deutsch/
  Französisch — übersetzt alle fixen Textbausteine im PDF (Spaltenköpfe,
  "Zwischentotal"/"MWST"/"Total", "Zahlbar innert 30 Tagen", Datum
  ausgeschrieben, Seitentitel usw., siehe `PDF_I18N` in `offerten/pdf.js`).
  Betreff und Brieftext bleiben freier Text und werden **nicht** automatisch
  übersetzt — bei einer französischen Rechnung selbst auf Französisch
  verfassen. Offerten bleiben immer Deutsch (kein Feld dafür).
- **Editor** — Kopfdaten: Typ, Offert-/Rechnungs-Nr. (optional, frei), Datum
  und Status nebeneinander in der ersten Zeile, darunter Projekt, Empfänger,
  Adresse, dann Stundensatz (Fr./h) und MWST-Satz (%) nebeneinander (beide
  ohne Zähler-Pfeile, reine Eingabefelder) — alles für **diese** Offerte/
  Rechnung. Dazu Betreff und ein freier Brieftext fürs PDF-Anschreiben auf
  der ersten Seite. Der Absender-Ort fürs "Ort, Datum" in der
  Brief-Datumszeile kommt zentral aus `absender.json` (siehe unten), kein
  eigenes Feld pro Offerte/Rechnung. Darunter die **Unterschrift(en)**
  (siehe eigener Abschnitt unten).
- **Projekt**: bei **Offerten** zwei frei eingebbare Felder, Projektnummer
  (optional) und Projekt(-name) — beide unabhängig von der zentral
  verwalteten Projektliste, weil aus einer Offerte nicht immer ein Projekt
  mit eigener Nummer entsteht. Bei **Rechnungen** stattdessen ein Dropdown
  mit derselben zentral verwalteten Projektliste wie Zeiterfassung/
  Pendenzen/Protokoll (siehe Abschnitt "Zentrale Konfiguration"
  oben) — eine Rechnung betrifft praktisch immer ein bereits laufendes,
  nummeriertes Projekt; Auswahl übernimmt Nummer und Name automatisch in
  dieselben (bei Rechnungen nur versteckten) Felder. Liste und PDF zeigen
  "Nummer – Name", sofern eine Projektnummer gesetzt ist. Letzte Option im
  Dropdown ist immer "✎ Eigenes/altes Projekt eingeben…" — blendet dieselben
  Freitextfelder wie bei Offerten ein, für ein altes/abgeschlossenes Projekt,
  das nicht (mehr) in der zentralen Liste steht. Verschwindet ein Projekt
  später aus der zentralen Liste, bleiben bereits gespeicherte Rechnungen
  davon unberührt (Nummer/Name sind beim Speichern als reiner Text
  übernommen worden, keine Live-Verknüpfung) — beim erneuten Öffnen einer
  solchen Rechnung öffnet sich automatisch der Freitext-Modus mit der alten
  Nummer/dem alten Namen vorausgefüllt, damit es nicht aussieht, als sei das
  Projekt verloren gegangen, und eine unabsichtliche Neuauswahl die alten
  Werte nicht überschreibt.
- **Automatische Nummerierung**: Checkbox oberhalb der Positionsliste, pro
  Offerte/Rechnung. Aus wirkt sofort (auch ohne zu speichern) und blendet
  die `1)`/`2)`/… vor den Modultiteln aus — im Web-Formular wie im PDF.
- **Phasen**: freie Zwischenüberschrift innerhalb der Positionsliste (z.B.
  "Vorprojekt", "Bauprojekt"), über "+ Phase hinzufügen". Zählt nicht in die
  Modul-Nummerierung und hat keine Stunden/Kosten.
- **Module**: pro Modul ein Titel (automatische Nummerierung `1)`, `2)`, …
  nach Position unter den Modulen, nicht Teil der Daten, abschaltbar siehe
  oben) mit Kurzbeschrieb darunter — **ein Punkt pro Zeile** im Textfeld,
  gespeichert als Liste für eine Bulletpoint-Darstellung im PDF —, Stunden
  (Zahlenfeld ohne Zähler-Pfeile, Einheit "Std." direkt daneben) und daraus
  berechnete Kosten = Stunden × Stundensatz. Über "+ Modul hinzufügen"
  ergänzen. Die Spaltenbeschriftung ("Modul"/"Stunden"/"Kosten") ist im
  Web-Formular bewusst weggelassen (selbsterklärend); im PDF steht sie
  weiterhin da.
- **Pauschal** (pro Modul, Checkbox neben Stunden): rechnet dieses Modul mit
  einem fest eingegebenen Betrag statt Stunden × Stundensatz ab — im
  Web-Formular wie im PDF erscheint dort "Pauschal" statt einer Stundenzahl.
  Sind in einer Offerte/Rechnung **alle** Module pauschal (keines nach
  Stunden), verschwindet im PDF zusätzlich die ganze Stunden-Spalte
  (Modul/Kosten bleiben zweispaltig), die Zeile "Stundentotal" sowie der
  Hinweissatz "Der mittlere Stundensatz beträgt …" — sinnlos, wenn gar keine
  Stunden verrechnet werden. Enthält die Liste auch nur ein einziges
  Stunden-Modul, bleibt alles wie gewohnt sichtbar. Siehe
  `allePositionenPauschal()`/`ctx.hideStunden` in `offerten/pdf.js`.
- **Bemerkung** (pro Modul, Checkbox "Bemerkung" unter dem Kurzbeschrieb):
  blendet ein zusätzliches Textfeld ein. Erscheint im PDF kursiv, **ohne**
  Bulletpoint, direkt nach den Stichpunkten — z.B. "Besprechungen vor Ort,
  4 Std." als Modul mit Bemerkung "Wegstrecken werden nicht verrechnet".
  Das Häkchen steuert nur, ob das Feld gedruckt wird (`bemerkungAktiv`);
  der Text selbst (`bemerkung`) bleibt beim Abwählen erhalten, falls man
  ihn später wieder einblenden will.
- **Modul-Suche**: Suchfeld unter der Positionsliste durchsucht live Titel
  und Kurzbeschrieb aller bereits geladenen Offerten (Titel, Herkunfts-
  projekt/-datum als Treffer angezeigt) und übernimmt einen Treffer per
  Klick als neues Modul (Stunden danach anpassbar). Bewusst **keine**
  separate Modul-Library — die Offerten sind für die Liste ohnehin schon
  geladen, das spart eine zweite, separat zu pflegende Datenquelle. Siehe
  `allKnownModules()`/`searchModules()` in `offerten/app.js`.
- Phasen und Module liegen in einer gemeinsamen, beliebig sortierbaren Liste
  — am Griff-Symbol (☰) per Drag & Drop frei an eine beliebige Position
  ziehen, mit dem Papierkorb-Symbol entfernen. Eine Phase lässt sich also
  zwischen beliebige Module schieben. Beim Ziehen wird die Zeile live an die
  neue Stelle verschoben (nicht nur ein Rahmen/Schatten als Vorschau) —
  direktes visuelles Feedback wie in üblichen Reorder-Listen; die
  eigentlichen Daten werden erst beim Loslassen aus der finalen Reihenfolge
  übernommen. Siehe `renderPositionen()` in `offerten/app.js`.
- **Summen** unten: Nebenkostenpauschale (fixer, frei eingegebener Betrag,
  "Fr." direkt daneben — nur wenn ungleich null, zählt in Zwischentotal und
  damit auch in die MWST-Berechnung mit hinein), Zwischentotal exkl. MWST
  (Summe aller Modul-Kosten + Nebenkostenpauschale, Phasen zählen nicht
  mit), MWST-Betrag (Zwischentotal × Satz), Total inkl. MWST. Ab
  Zwischentotal werden alle Beträge auf 5 Rappen gerundet (übliche
  Schweizer Rundung) und immer mit 2 Nachkommastellen angezeigt (z.B.
  "10.75 Fr.") — einzelne Modul-Kosten bleiben unverändert/ungerundet.
  Siehe `chFrRounded()`/`chFrRoundedPdf()`.
- **Duplizieren**: im Editor (nur bei einer bereits gespeicherten Offerte)
  oder direkt per ⧉-Button in der Liste. Übernimmt alle Kopf- und
  Positionsdaten in eine neue, noch nicht gespeicherte Offerte; Datum wird
  auf heute gesetzt, Offert-Nr. geleert (bewusst nicht automatisch neu
  vergeben, da frei/optional).
- **Stundensatz-Vorgabe**: Feld auf der Listen-Seite (lokal in
  `localStorage`, `offerten_stundensatz`), wird nur als Vorschlag für
  **neue** Offerten verwendet. Der tatsächlich verwendete Satz wird pro
  Offerte mitgespeichert — ändert sich später die Vorgabe, bleiben bereits
  gespeicherte Offerten unverändert (keine rückwirkende Neuberechnung).
- **Speicherort**: Zielordner `OFFERTEN_TARGET_FOLDER_PATH` (Standard
  `Buero/Admin/App/Offerten und Rechnungen` in `offerten/app.js`), kein
  Jahresordner. Neue Offerten werden als `[Datum] [Projekt].json` abgelegt;
  beim Bearbeiten einer bestehenden Offerte bleibt der Dateiname unverändert
  (Überschreiben statt Duplikat), auch wenn sich Datum/Projekt ändern.

Diese Funktion braucht (wie Quittung und Wettbewerbsprogramme) `DELETE` als
erlaubte HTTP-Methode im Cloudflare Worker — siehe Abschnitt
"Worker deployen" oben.

### Absenderadresse

Enthält echte Geschäftsdaten (Name, Adresse, PLZ/Ort, Ort fürs "Ort, Datum"
in der Brief-Datumszeile, Telefon, E-Mail, Website) — liegt deshalb
**vertraulich auf Nextcloud** statt im (öffentlichen!) Repo, analog zu
`konten.txt`/`kategorien.txt` bei Quittung. Bewusst **nicht** pro
Offerte/Rechnung erfasst, da praktisch immer gleich.

**`Buero/Admin/App/Offerten und Rechnungen/_absender.json`** anlegen (im
selben Ordner wie die Offerten-Dateien selbst, aber kein eigener
Offerten-Datensatz — wird beim Auflisten der Offerten ausdrücklich
ausgeschlossen, siehe `ABSENDER_FILENAME`):
```json
{
  "name": "Muster Architekten AG",
  "adresse": "Musterstrasse 12",
  "plz_ort": "8000 Zürich",
  "ort": "Zürich",
  "telefon": "+41 44 000 00 00",
  "email": "office@muster-architekten.ch",
  "website": "www.muster-architekten.ch",
  "iban": "CH93 0076 2011 6238 5295 7"
}
```
Die App lädt die Datei zur Laufzeit per Login (`proxyFetch`, siehe
`loadAbsender()` in `offerten/app.js`) und hält den zuletzt geladenen Stand
zusätzlich in `localStorage` als Offline-Fallback. Fehlt die Datei (noch)
auf Nextcloud, bleibt der Briefkopf im PDF einfach leer, statt dass der
Export fehlschlägt. Wird für den PDF-Briefkopf verwendet (`absender` in
`offerten/app.js`). `iban` ist optional und wird ausschliesslich für die
QR-Rechnung gebraucht (siehe nächster Abschnitt) — ohne dieses Feld
entstehen Offerten/Rechnungen weiterhin normal, nur eben ohne QR-Rechnung-
Seite.

Der Absender erscheint im PDF als Block oben rechts auf der ersten Seite
(Name/Adresse/Telefon/E-Mail/Website), kein zusätzlicher Absender über dem
Empfänger.

### QR-Rechnung

Bei **Rechnungen** wird dem PDF automatisch eine zusätzliche, eigene Seite
mit der Schweizer QR-Rechnung (Empfangsschein + Zahlteil, 210×105mm,
flächenbündig am unteren Seitenrand) angehängt — vorausgesetzt, `iban` ist
in der `_absender.json` gesetzt (siehe oben); fehlt sie, erscheint beim
Export eine Warnung statt eines stillen Fehlens, der Rest des PDFs entsteht
trotzdem normal. Offerten bekommen nie eine QR-Rechnung-Seite.

- **Betrag**: identisch zur gedruckten Summenzeile "Rechnungsbetrag inkl.
  MWST" (`computeTotals()` in `offerten/pdf.js`, von beiden Stellen
  gemeinsam verwendet, damit sie nie auseinanderlaufen können).
- **Referenznummer**: bewusst immer "ohne Referenz" (reine IBAN-Zahlung,
  Typ "NON") — entspricht der bisher vom Büro genutzten Vorlage. Als
  Mitteilung wird stattdessen automatisch "Rechnung \<Nr.\>" (oder der
  Projektname, falls keine Nummer gesetzt ist) mitgegeben.
- **"Zahlbar durch"**: bleibt bewusst immer leer (Feld inkl. Beschriftung
  "Zahlbar durch (Name/Adresse)" zum Selbst-ausfüllen) — Empfänger/Adresse
  der Rechnung sind freier Text ohne Längenbeschränkung und liefen bei
  langen Adressen im Empfangsschein/Zahlteil (feste Spaltenbreite, kein
  Zeilenumbruch) bis in die QR-Code-Fläche hinein.
- **Sprache**: folgt der Sprache der Rechnung (siehe Abschnitt "Sprache"
  oben) — auf Französisch erscheinen auch die Beschriftungen der
  QR-Rechnung französisch (die amtlich vorgeschriebenen SIX-Begriffe, nicht
  frei übersetzt).
- Verwendet aus technischen/rechtlichen Gründen (von SIX für die
  QR-Rechnung vorgeschriebene Standardschrift) bewusst **nicht** die
  Hausschrift Nudica, sondern Helvetica (in pdf-lib fest eingebaut).
- QR-Code-Erzeugung über `qrcode-generator` (CDN, siehe `offerten/index.html`),
  das reine Zahlungs-Textformat ("Swiss Payments Code") wird in
  `buildSpcPayload()` in `offerten/pdf.js` zusammengestellt.

### Unterschriften

Wählbare Unterzeichner (Checkboxen im Editor, nach dem Brieftext, Mehrfach-
auswahl möglich) kommen aus `mitarbeitende` in der zentralen
`Buero/Admin/App/config.json` (siehe Abschnitt "Zentrale Konfiguration" oben)
— dieselbe Liste, die auch bei den Pendenzen fürs Zuordnen/Filtern verwendet
wird (eine Person einmal pflegen statt pro Modul zu duplizieren).

`datei` (die Unterschrift-PNG) wird nur von den Offerten verwendet, alle
anderen Module ignorieren dieses Feld einfach.

Beim PDF-Export werden die PNGs der ausgewählten Personen live von Nextcloud
geladen (Ordner `SIGNATURE_FOLDER_PATH` in `offerten/pdf.js`, Standard
`Buero/Admin/KLG und Rechtliches/Unterschriften`, **im Nextcloud-Konto der
gerade angemeldeten Person**) und auf Seite 1 unter dem Brieftext eingefügt
— Bild und Name nebeneinander, an der Unterkante ausgerichtet. Damit eine
Person auch die Unterschrift der anderen einfügen kann, muss die
entsprechende Datei unter demselben Pfad in **beide** Nextcloud-Konten
gelegt werden (jedes Konto ist ja komplett getrennt, siehe oben) — das ist
manuell zu pflegen, es gibt keinen automatischen Abgleich. Schlägt der
Abruf einer einzelnen Datei fehl (falscher Dateiname, Datei fehlt), wird
das nur als Warnung nach dem Erstellen angezeigt; das PDF entsteht trotzdem,
einfach ohne diese Unterschrift.

**Sicherheitsüberlegung:** Der Abruf läuft über denselben authentifizierten
Kanal (App-Passwort) wie alle anderen Dokumente dieser App, ist also nicht
unsicherer als der Rest. Das eigentliche Risiko liegt woanders: Ein Bild
einer Unterschrift lässt sich, sobald es in einem verschickten PDF steckt,
von praktisch jedem Empfänger wieder herauskopieren und auf andere
Dokumente einfügen — das gilt für jede Stempel-/Bild-Unterschrift,
unabhängig von Nextcloud oder dieser App. Für Offerten/Rechnungen ist das
gängige Praxis, ersetzt aber keine rechtsverbindliche Unterschrift für
Dokumente mit höheren Formanforderungen (z.B. Verträge).

### PDF-Export

"PDF erstellen" (im Editor, oder 📄 pro Zeile in der Liste) erzeugt ein
zweiseitiges (bzw. mehrseitiges, je nach Länge) PDF und lädt es direkt im
Browser herunter:

- **Seite 1 — Anschreiben**: Absenderblock oben rechts, Empfänger-Adressblock
  links (kein wiederholter Absender darüber), Ort/Datum rechtsbündig (z.B.
  "Zürich, 7. September 2026", Ort kommt aus `absender.json`), Betreff,
  Brieftext (mit Zeilenumbruch = Absatz, automatischem Zeilenumbruch bei
  langen Zeilen), danach optional die gewählten Unterschriften (Bild + Name
  nebeneinander, siehe Abschnitt "Unterschriften" oben).
- **Seite 2 (garantiert eigene Seite, auch bei kurzem Brief) — Offerte/
  Rechnung**: Titel ("OFFERTE"/"RECHNUNG"), Projekt, Empfänger, Offert-/
  Rechnungs-Nr., Datum, dann die Positionsliste (Phasen als
  Zwischenüberschrift, Module mit Kurzbeschrieb als Bulletpoints und
  optionaler kursiver Bemerkung danach, Stunden/Kosten-Spalten, Nummerierung
  je nach Einstellung). Vor den Summen ein fixer Hinweis mit dem tatsächlich
  verwendeten Stundensatz dieser Offerte/Rechnung — bei Offerte "Der
  mittlere Stundensatz beträgt [Stundensatz] Fr. Das Honorar wird nach
  effektivem Zeitaufwand abgerechnet, dabei gilt der total geschätzte
  Stundenaufwand als Kostendach.", bei Rechnung nur der erste Satz ("Der
  mittlere Stundensatz beträgt [Stundensatz] Fr.", ohne Kostendach-Klausel,
  da bei der Rechnung bereits abgerechnet wird) — dann die Summen; bei
  Rechnung zusätzlich fix der Satz "Zahlbar innert 30 Tagen" darunter (kein
  eigenes Feld, kein IBAN/QR-Zahlteil — siehe oben). Läuft die
  Positionsliste über eine Seite hinaus, folgen weitere Seiten automatisch
  (mit wiederholtem Spaltenkopf).
- Schrift: die echten Nudica-Schnitte (`fonts/Nudica-Light.otf` /
  `Nudica-Medium.otf` / `Nudica-LightItalic.otf` für Bemerkungen, **nicht**
  die woff/woff2 fürs Web-UI), eingebettet ohne Subsetting — mit Subsetting
  erzeugt die verwendete Bibliothek (pdf-lib + fontkit) mit diesen
  Schriften eine von manchen PDF-Readern abgelehnte Einbettung.
- Technik: `offerten/pdf.js` (nutzt nichts aus `app.js` selbst — die
  Unterzeichner-Konfiguration wird als Parameter übergeben statt dort
  geladen — aber wie `app.js` proxyFetch/davPath/ncSegments/authHeader aus
  `../shared/common.js` fürs Laden der Unterschriften-PNGs), gebaut mit
  [pdf-lib](https://pdf-lib.js.org/) + `@pdf-lib/fontkit` (siehe
  `<script>`-Tags in `index.html`, Version dort gepinnt). Läuft komplett im
  Browser, kein Server/Backend nötig.
- **Bewusst nicht umgesetzt**: die offizielle Schweizer QR-Rechnung
  (Zahlteil mit Swiss-QR-Code, IBAN/Referenznummer-Validierung nach den
  Financial-Standards) — die wird separat übers E-Banking erstellt. Falls
  eine bank-/Postfinance-konforme QR-Rechnung direkt aus der App gebraucht
  wird, ist das ein eigenes, deutlich grösseres Vorhaben.
- **Offline**: Liste/Bearbeiten/Speichern funktionieren wie gewohnt offline;
  "PDF erstellen" braucht (zumindest beim ersten Mal pro Browser-Cache)
  Internet, da pdf-lib/fontkit von einem CDN geladen werden und bewusst
  nicht im Service-Worker vorgecacht sind (siehe Kommentar in
  `offerten/service-worker.js`) — ein einzelner fehlgeschlagener
  Cross-Origin-Fetch soll nicht die ganze App-Shell offline unbrauchbar
  machen.

---

## Adressliste

Firmen- und Personenadressen filtern, in benannten Ansichten speichern und auf
Nextcloud sichern. Nur für den Desktop-Browser gedacht (keine mobile
Breitenbeschränkung wie bei den anderen Apps) — die Tabelle ist so breit wie
das Browserfenster.

- **Speicherort**: jeder Kontakt ist eine eigene JSON-Datei im
  Nextcloud-Ordner `Buero/Admin/App/Adressen` (wie bei den Offerten: ein File pro
  Datensatz statt einer grossen Liste). Diese Funktion braucht deshalb PUT,
  GET, PROPFIND, MKCOL und DELETE — siehe `ALLOWED_METHODS` in `worker.js`.
- **Filtern**: jede Spalte hat ihr eigenes Filterfeld direkt unter dem
  Spaltentitel (Freitext, Gross-/Kleinschreibung egal; bei Weihnachtskarte
  ein Alle/Ja/Nein-Dropdown). Es lässt sich also nach jeder beliebigen
  Kombination von Spalten gleichzeitig filtern. Kopf- und Filter-Zeile
  bleiben beim Scrollen sichtbar (die Tabelle hat eine eigene, auf ca. 62%
  der Fensterhöhe begrenzte Scroll-Fläche).
- **Sortieren**: auf einen Spaltentitel klicken sortiert danach (nochmals
  klicken kehrt die Richtung um) — funktioniert für jede Spalte.
- **Spalten**: welche Spalten sichtbar sind, lässt sich über die Checkboxen
  oberhalb der Tabelle einstellen. Die Reihenfolge der sichtbaren Spalten
  lässt sich direkt in der Tabelle per Drag & Drop am Spaltentitel ändern.
- **Distanz-Spalte**: eine reine 4-stellige Schweizer PLZ (z.B. "8000") ins
  Filterfeld der Spalte "Ort" eingegeben wird als Distanz-Referenz
  verstanden statt als Text-Suche (dort als Textfilter ohnehin nutzlos —
  würde nur Zeilen zeigen, deren "Ort"-Feld diese PLZ wörtlich enthält).
  Die Spalte "Distanz" blendet sich dadurch automatisch ein (falls noch
  nicht sichtbar) und zeigt für jeden Kontakt die Luftlinien-Distanz ab
  dieser PLZ (`adressliste/plz-data.js`, Koordinaten pro PLZ-Zentrum von
  GeoNames, CC BY 4.0); die Liste sortiert sich gleich danach (nicht
  auflösbare Einträge bleiben dabei immer am Ende, unabhängig von der
  Sortierrichtung). Die Spalte "Distanz" hat zusätzlich ihr eigenes
  Eingabefeld für dieselbe Referenz-PLZ — beide schreiben denselben Wert
  (`currentView.filters.distanz`, landet darum automatisch mit in
  gespeicherten Ansichten), blenden aber bewusst keine Zeilen aus: die
  Liste wird sortiert, nicht eingeschränkt. Einmal gesetzt, bleibt die
  Referenz-PLZ bestehen, auch wenn im "Ort"-Filter danach wieder normal
  nach einem Ortsnamen gesucht wird (z.B. "nur Kontakte mit 'Muster AG' im
  Ort, sortiert nach Distanz ab 8000") — zum Ändern/Löschen ist danach die
  Distanz-Spalte selbst die massgebliche Stelle. Das Feld "Ort" wird als
  "PLZ Ortsname" gelesen; fehlt die PLZ (ältere Einträge haben teils nur
  den Ortsnamen), wird der Ortsname gegen dieselbe Liste nachgeschlagen —
  bei mehrdeutigen Ortsnamen (z.B. gleichnamige Orte in verschiedenen
  Kantonen) nicht zwingend der richtige Treffer, ein bewusst in Kauf
  genommenes Limit dieser Heuristik. Nicht auflösbare Einträge (leeres oder
  unbekanntes "Ort"-Feld) zeigen "?" statt einer Distanz.
- **Kategorie, Status**: kommen aus einem gemeinsam verwalteten Optionen-Set
  (`_optionen.json`, im selben Nextcloud-Ordner) statt aus freiem Text —
  Dropdowns statt Textfelder, sowohl im Editor als auch direkt in der
  Tabelle (zusammen mit Kontaktperson und Weihnachtskarte lassen sich diese
  vier Felder ändern, ohne den Editor zu öffnen). Neue Werte lassen sich
  über "+ neu…" in jedem Dropdown oder über den Button "⚙ Optionen"
  hinzufügen; Entfernen über "⚙ Optionen" löscht nur aus der Auswahlliste,
  nicht aus bereits gespeicherten Kontakten mit diesem Wert. Beim
  allerersten Start werden die Listen automatisch aus den schon
  vorhandenen Kontakten befüllt. `_optionen.json` liegt im selben Ordner wie
  die Kontakt-Dateien und wird beim Laden der Kontaktliste ausdrücklich
  ausgeschlossen (`OPTIONS_FILENAME`-Filter in `refreshContacts()`) — sonst
  würde sie selbst als leerer Phantom-Kontakt mit allen Status-Werten
  angezeigt.
- **Kontaktperson**: dagegen KEIN frei verwaltetes Optionen-Set, sondern ein
  Dropdown direkt aus den Mitarbeitenden der zentralen `config.json` (siehe
  Abschnitt "Zentrale Konfiguration" oben) — kein "+ neu…", keine Verwaltung
  über "⚙ Optionen". Ein gespeicherter Wert, der zu niemandem in der
  aktuellen Mitarbeitenden-Liste mehr passt (z.B. nach einem Namenswechsel),
  bleibt trotzdem als Option erhalten statt zu verschwinden.
- **Ansichten speichern**: die aktuelle Kombination aus Spalten (inkl.
  Reihenfolge), Filtern und Sortierung lässt sich unter einem Namen speichern
  (z.B. "Weihnachtskarten" = nur Firma/Vorname/Name/Weihnachtskarte, gefiltert
  auf Weihnachtskarte = Ja). Jede Ansicht ist — wie die Kontakte selbst —
  eine eigene JSON-Datei, im Unterordner `Buero/Admin/App/Adressen/Ansichten`,
  also für alle Personen mit Zugriff auf diesen Ordner gleich sichtbar. Ist
  gerade eine gespeicherte Ansicht aktiv und man klickt "Ansicht speichern"
  mit demselben Namen, wird diese Ansicht überschrieben; gibt man dagegen
  einen anderen, noch nicht vergebenen Namen ein, entsteht eine **neue**
  Ansicht (die ursprüngliche bleibt unverändert erhalten) — nur bei einem
  Namen, der bereits einer anderen Ansicht gehört, fragt die App vor dem
  Überschreiben nach.
- **Gleichzeitige Bearbeitung**: weil jeder Kontakt eine eigene Datei ist,
  können zwei Personen problemlos gleichzeitig verschiedene Einträge
  bearbeiten. Für den selteneren Fall, dass zwei Personen genau denselben
  Eintrag gleichzeitig öffnen, trägt jeder Kontakt `updatedAt`/`updatedBy`
  (Zeitstempel + Anzeigename der zuletzt speichernden Person, sichtbar im
  Editor und optional als Spalte "Zuletzt geändert"). Vor dem Speichern eines
  bestehenden Kontakts wird der Stand auf Nextcloud nochmals frisch geladen
  und mit dem Stand beim Öffnen verglichen — weicht er ab, warnt die App
  (wer hat wann geändert) und lässt die Wahl zwischen Überschreiben und
  neu laden. Das ist kein echtes Locking (dafür bräuchte es einen Server),
  verhindert aber, dass eine fremde Änderung stillschweigend verloren geht.
- **CSV-Import**: am Ende der Seite lässt sich eine CSV-Datei importieren
  (Spalten Kategorie, Status, Kontaktperson, Vorname, Name, Firma, Strasse,
  Ort, Tel, Mail, Website, Bemerkungen, Projekte, Weihnachtskarte). Jede
  Zeile wird als **neuer** Kontakt angelegt, ohne Abgleich mit bestehenden
  Einträgen — für den einmaligen Start mit einer bestehenden Liste gedacht,
  nicht für wiederholte Abgleiche.
- **CSV-Export**: daneben exportiert "Aktuelle Ansicht als CSV exportieren"
  — anders als der Import — genau das, was die Tabelle gerade zeigt:
  sichtbare Spalten in ihrer aktuellen Reihenfolge, gefiltert und sortiert
  wie die aktuelle Ansicht (z.B. nur die Weihnachtskarten-Liste, oder nur
  Landschaftsarchitekten sortiert nach Status).
- **Etiketten-PDF**: "Aktuelle Ansicht als Etiketten-PDF" legt genau wie der
  CSV-Export für jeden gerade sichtbaren (gefilterten) Kontakt ein
  Adressetikett an (`adressliste/etiketten.js`, nutzt pdf-lib wie die
  PDF-Exporte bei Offerten/Protokoll) — pro Etikett Firma, Vorname/Name,
  Strasse, Ort, jeweils nur falls vorhanden; Kontakte ganz ohne eine dieser
  Angaben werden übersprungen (Hinweis danach, wie viele). A4-Bogen mit 3
  Spalten × 7 Zeilen (21 Etiketten, je ca. 6.3×3.7cm) — ein generisches,
  selbst berechnetes Raster statt eines bestimmten Etiketten-Produkts; bei
  bereits vorgeschnittenen Bögen vorher einen Probedruck gegenprüfen.

---

## Pendenzen

Einfache To-do-Liste, nach Projekt und Person filterbar.

- **Speicherort**: anders als Offerten/Adressliste (eine Datei pro
  Datensatz) liegen alle Pendenzen in **einer** gemeinsamen Datei
  `Buero/Admin/App/Pendenzen/pendenzen.json` — bei kurzen, oft schnell
  angehakten/ergänzten Texten wäre eine Datei pro Pendenz nur Overhead.
- **Gleichzeitige Bearbeitung**: da alle Pendenzen eine Datei teilen, würde
  ein einfaches Überschreiben Änderungen einer anderen Person verlieren.
  Beim Speichern wird deshalb der aktuelle Serverstand nochmals geholt und
  pro Pendenz (per id) gemergt — die jeweils neuere `updatedAt` gewinnt, nur
  lokal oder nur serverseitig bekannte Pendenzen bleiben in jedem Fall
  erhalten. Anders als bei den Offerten (Feld-Merge) ist das ein Merge auf
  Ebene ganzer Listeneinträge, ohne Nachfrage-Dialog. Endgültiges Löschen
  (siehe unten) markiert deshalb nur `geloescht:true` statt den Eintrag
  sofort aus der Liste zu entfernen — ein Gerät mit veraltetem lokalem Stand
  (z.B. ein lange nicht geöffneter Tab) kennt eine echte Entfernung sonst
  nicht und würde die längst gelöschte Pendenz beim nächsten Speichern über
  die "nur lokal bekannt bleibt erhalten"-Regel wieder zurückschreiben —
  genau das sorgte vor der Umstellung auf Tombstones gelegentlich dafür,
  dass alte erledigte Pendenzen plötzlich wieder auftauchten. Als
  `geloescht` markierte Pendenzen werden überall ausgeblendet und nach 30
  Tagen beim nächsten Sync endgültig aus der Datei entfernt, damit sie nicht
  für immer Spuren hinterlassen.
- **Projekte & Farben**: kommen aus derselben zentralen `projekte.txt` wie die
  Zeiterfassung, damit ein Projekt überall gleich heisst und gleich aussieht
  — Zuordnung/Filter/Farbe erfolgen dabei über den **Projektnamen** (siehe
  Abschnitt "Zentrale Konfiguration" oben), eine Pendenz speichert im Feld
  `projekt` also den Namen,
  nicht eine Nummer. Ein Klick auf einen Projekt-Button
  filtert die Liste; eine neue Pendenz wird automatisch dem gerade
  ausgewählten Projekt zugeordnet ("Alle" → Pendenz ohne Projekt). Die ganze
  Zeile nimmt die Projektfarbe als Hintergrund an (nicht nur ein schmaler
  Rand) — der Projektname steht bewusst nicht zusätzlich als Text daneben,
  die Farbe reicht zum Erkennen, Platzgründe. Text/Icons wechseln je nach
  Helligkeit der Farbe automatisch zwischen Weiss und der normalen
  Textfarbe (`isDarkColor()` in `pendenzen/app.js`, grobe Luma-Schwelle,
  keine volle WCAG-Kontrastprüfung).
- **Personen**: die (aktuell 2) Personen für die Personen-Filterknöpfe
  kommen aus `mitarbeitende` in derselben `config.json` (gemeinsam mit den
  Offerten, siehe Abschnitt "Unterschriften" dort — eine Person einmal
  pflegen statt pro Modul zu duplizieren). Ein eigenes Personen-Dropdown beim
  Erfassen gibt es
  bewusst nicht (mehr): wie beim Projekt kommt die Person rein aus dem
  aktiven Personen-Filter, das deckt den Bedarf schon ab. In der Zeile
  selbst erscheint nur das Kürzel (Initialen), der volle Name als Tooltip
  bzw. im Bearbeiten-Modus.
- **Erfassen**: Enter im Textfeld erfasst direkt -- ein `<form>` mit
  submit-Event deckt Klick auf "+" und Enter am Desktop ab, zusätzlich ein
  eigener keydown-Handler ausschliesslich fürs Textfeld: in als
  Home-Bildschirm-App installierten PWAs auf iOS löst die Eingabetaste/das
  Häkchen der virtuellen Tastatur das native Form-Submit bekanntermassen
  nicht zuverlässig aus (WebKit-Eigenheit nur im Standalone-Modus, in einem
  normalen Safari-Tab funktioniert es). Zusätzlich `type="search"` statt
  `"text"` fürs Eingabefeld (ein weiterer bekannter, risikoarmer Kniff dafür
  -- Suchfelder haben in Safari eine eigene, verlässlichere native
  Tastatur-Behandlung). **Unverifiziert auf echtem iPhone** (im Entwicklungs-
  Setup nicht testbar) -- falls es dort immer noch nicht zuverlässig
  funktioniert, ist "+" antippen die verlässliche Alternative, dafür bleibt
  der Button bewusst bestehen.
- **Erledigen & Löschen**: Abhaken verschiebt eine Pendenz optisch in den
  Abschnitt "Erledigt" weiter unten (durchgestrichen), lässt sich dort
  jederzeit wieder zurückholen (Häkchen entfernen). "🗑 erledigte löschen"
  löscht endgültig nur die erledigten Pendenzen, die im **aktuell aktiven**
  Projekt-/Personen-Filter sichtbar sind — nicht alle erledigten überhaupt.
- **Nachträglich ändern**: eine offene Pendenz anklicken (der Text, nicht
  die Checkbox) aktiviert den Bearbeiten-Modus für Text, Projekt und Person
  (Projekt/Person auch wieder entfernbar) — kein separates Symbol nötig, die
  Checkbox schaltet unabhängig davon nur ab/an. Die Auswahllisten speichern
  sofort, der Text beim Verlassen des Feldes bzw. mit Enter (ein leeres
  Textfeld wird ignoriert, der bisherige Text bleibt erhalten).
- **Reihenfolge**: der Ziehgriff (☰) an einer offenen Pendenz verschiebt sie
  per Drag & Drop frei innerhalb der aktuell sichtbaren (gefilterten)
  Liste — über Pointer Events verdrahtet (nicht die HTML5-Drag&Drop-API,
  die auf Touchscreens praktisch nicht funktioniert), deckt also Maus,
  Touch und Stift einheitlich ab; die Anwählfläche des Griffs ist bewusst
  grosszügiger als das sichtbare Symbol. Die Reihenfolge bleibt über
  Filter- und Geräte-Wechsel hinweg erhalten. Neue Pendenzen landen immer
  zuoberst. Der Erledigt-Bereich hat keine manuelle Reihenfolge (sortiert
  nach Erledigt-Zeitpunkt).
- **Sync-Warteschlange**: mehrere Änderungen (z.B. der allererste
  Ladevorgang beim Öffnen der App und direkt danach eine neu erfasste
  Pendenz) laufen serialisiert nacheinander statt parallel überlappend --
  sonst könnte ein noch laufender älterer Ladevorgang eine zwischenzeitlich
  bereits gespeicherte neue Pendenz beim Zurückschreiben wieder verlieren.

---

## Protokoll

Sitzungsprotokolle (Aktennotizen) erfassen: Header (Sitzungstitel, Projekt,
Datum/Zeit, Ort), Teilnehmende mit optionalem Kürzel, Hauptteil als einfache
Liste aus Zwischentiteln und Stichpunkten (Struktur analog zu Phasen/Modulen
bei den Offerten), PDF-Export, auf Nextcloud gesichert (ein File pro
Protokoll, wie bei den Offerten).

- **Speicherort**: `Buero/Admin/App/Protokolle`, ein JSON pro Protokoll.
- **Datum/Zeit vorausgefüllt**: ein neues Protokoll schlägt automatisch das
  heutige Datum sowie "Zeit von" als aktuelle Uhrzeit vor, auf die
  nächstgelegenen 15 Minuten gerundet (`roundedTimeNow()` in
  `protokoll/app.js`) — beides lässt sich wie gewohnt anpassen.
- **Projekt**: Dropdown aus derselben zentralen `projekte.txt` wie
  Zeiterfassung/Pendenzen (siehe Abschnitt "Zentrale Konfiguration" oben).
  Anders als bei Zeiterfassung/Pendenzen (nur der Name) zeigen Auswahl,
  Liste und PDF hier **Projektnummer UND Name** ("021 – Neubau Werkhof").
- **Teilnehmende & Kürzel**: Büro-Personen (aus `mitarbeitende` in derselben
  `config.json`) lassen sich per "+ Name"-Knopf hinzufügen und bekommen ihr Kürzel
  automatisch (Initialen, nicht änderbar); externe Teilnehmende werden über
  "+ Teilnehmer/in" als freie Zeile angelegt.
- **Vorschläge beim Eintippen**: im Namensfeld einer neu angelegten externen
  Person erscheinen live Vorschläge aus den schon geladenen, früheren
  Protokollen (analog zur Modul-Suche bei den Offerten, bewusst keine
  separate Personen-Liste oder ein zusätzliches Suchfeld — Eintippen und
  Auswählen sind derselbe Schritt). **Enter** oder **Tab** übernimmt direkt
  den bestpassenden Vorschlag samt zuletzt verwendetem Kürzel; ohne Treffer
  bleibt der eingetippte Name einfach als neue, freie Person stehen. Bereits
  im aktuellen Protokoll vorhandene sowie Büro-Personen (die eigene
  "+ Name"-Knöpfe haben) erscheinen nicht als Vorschlag.
- **Hauptteil**: Zwischentitel und Stichpunkte lassen sich wie die
  Phasen/Module bei den Offerten per Ziehgriff neu anordnen. Ein Stichpunkt
  kann optional ein Kürzel einer Teilnehmerin/eines Teilnehmers zugewiesen
  bekommen — das markiert ihn zugleich als Pendenz (kein separates Häkchen
  nötig).
- **Automatische Pendenzen**: ist das zugewiesene Kürzel das einer
  **Büro**-Person (externe Teilnehmende lösen nichts aus), wird beim
  Speichern automatisch ein Eintrag in
  `Buero/Admin/App/Pendenzen/pendenzen.json` angelegt/aktualisiert (Person und
  Text aus dem Protokoll; als Projekt wird der reine **Name** des im Protokoll
  gewählten Projekts übernommen, nicht die Nummer — Pendenzen ordnet Projekte
  namensbasiert zu, siehe Abschnitt "Zentrale Konfiguration" oben). Die
  Pendenz-ID ist über Protokoll- und Stichpunkt-ID stabil: ein erneutes
  Speichern aktualisiert denselben Eintrag (Textänderungen werden
  übernommen), statt zu duplizieren, und ein in der Pendenzen-App bereits
  gesetztes Häkchen bzw. eine manuell geänderte Reihenfolge bleiben dabei
  erhalten. Wird das Kürzel wieder entfernt oder der Stichpunkt gelöscht,
  verschwindet die zugehörige, vom Protokoll selbst angelegte Pendenz auch
  wieder. Kein Merge mit gleichzeitigen Änderungen aus der Pendenzen-App
  selbst (anders als deren eigener Sync) — Protokolle werden dafür deutlich
  seltener gespeichert als einzelne Pendenzen bearbeitet.
- **Gleichzeitige Bearbeitung**: wie bei der Adressliste — vor dem Speichern
  eines bestehenden Protokolls wird der Serverstand nochmals verglichen,
  bei einer Abweichung warnt die App und lässt die Wahl zwischen
  Überschreiben und neu laden.
- **PDF-Export**: eine durchgehende Seite (kein Brief/Positionen-Split wie
  bei den Offerten) mit Absenderblock, Titel, Meta-Infos, Teilnehmenden und
  dem Hauptteil; rechts neben jedem Stichpunkt bleibt eine schmale Spalte
  frei, in der — falls gesetzt — das Kürzel der zuständigen Person steht.
  Nutzt dieselbe pdf-lib-Infrastruktur wie die Offerten (`protokoll/pdf.js`,
  eigenständig gehalten).

---

## Timeline

Terminplanung als horizontaler Zeitbalken (Gantt-artig), rein browserbasiert
(kein PDF-Export). Der Ordner heisst `timeline/` (das Modul hiess früher
"Zeitplanung"/`zeitplanung/`). Unter der alten Adresse `.../zeitplanung/`
liegt bewusst ein minimaler Redirect-Stub (`zeitplanung/index.html` +
eigener `service-worker.js`), damit bestehende Lesezeichen/Home-Bildschirm-
Icons nicht ins Leere laufen, sondern automatisch nach `../timeline/`
weitergeleitet werden — inkl. eigener Service-Worker-Aktualisierung, damit
das auch für bereits offene alte Tabs zuverlässig funktioniert (siehe
Abschnitt "Bekannte Grenzen"/`registerServiceWorkerWithAutoUpdate()` in
`shared/common.js`). Die ausführliche Bedienungsanleitung steht nicht mehr
fest auf der Seite, sondern hinter dem ?-Symbol ("Hilfe") neben Startseite/
Einstellungen oben rechts. Das Zeitfenster ist immer "heute bis in 2 Jahre" —
rollend, kein festes Kalenderjahr; beim erneuten Öffnen verschiebt es sich
also automatisch mit.

- **Speicherort**: EINE gemeinsame Datei
  `Buero/Admin/App/Timeline/zeitplanung.json` (wie bei den Pendenzen) statt
  einer Datei pro Projekt/Aufgabe.
- **Zeilen von oben nach unten**:
  - **Mitarbeitende** (aus `mitarbeitende` in der zentralen `config.json`,
    siehe Abschnitt "Zentrale Konfiguration" oben) — hier Ferien/Frei
    eintragen (Balken immer grau). Frei/Ferien-Balken entstehen bewusst nur
    durch **Ziehen** (immer mehrtägig, kein Meilenstein per Klick wie bei
    Aufgaben). Jeder Tag, an dem mindestens eine Person einen Balken hat,
    dessen Titel **"ferien"**, **"frei"**, **"weg"** oder **"abwesend"**
    enthält (als Teilstring, nicht nur exakt — erkennt also auch z.B.
    "Weihnachtsferien"), bekommt einen hellgrauen Streifen über **alle**
    Zeilen hinweg — je mehr Personen an diesem Tag frei haben, desto dunkler
    der Streifen (`isFreiTitle()`/`renderVacationOverlay()` in
    `timeline/app.js`).

    Über das 🗓-Symbol neben dem Namen lässt sich pro Person ein
    **Wochenschema** hinterlegen (an welchen Wochentagen sie regulär da ist,
    wahlweise "jede Woche" oder "jede 2. Woche" ab einem gewählten
    Ankerdatum) — die zutreffenden Tage werden in der jeweiligen Zeile
    grünlich markiert, gelten automatisch fürs ganze (rollende) Jahr und
    blenden sich an Tagen mit einem Ferien/Frei-Balken von selbst aus.
    Samstage/Sonntage ohne Anwesenheit sind stattdessen grau hinterlegt (ein
    Tag ist also immer entweder grünlich oder grau, nie beides). Ein
    einfacher Klick auf einen Tag in der Mitarbeiter-Zeile schaltet dessen
    Anwesenheit einzeln um: ein grünlich markierter Tag wird zur
    **Ausnahme** (z.B. ein einzelner freier Montag ohne eigenen
    Ferien-Eintrag), ein nicht markierter Tag (z.B. ein Sonntag) wird zum
    einzelnen **Zusatztag** (ein ausserordentlicher Einsatz ausserhalb des
    Schemas) — nochmaliges Anklicken macht das jeweils rückgängig.
  - **Projekte** — entweder per Dropdown aus derselben zentralen `projekte.txt`
    wie Zeiterfassung/Pendenzen (siehe Abschnitt "Zentrale Konfiguration"
    oben; Zuordnung/Farbe über den Namen, nicht die Nummer) oder frei benannt
    über das Textfeld daneben — für Vorhaben, die
    (noch) nicht in der offiziellen Liste stehen. Auf Klick auf den
    Projekttitel lässt er sich frei umbenennen (unabhängig davon, ob der neue
    Name in der zentralen Liste vorkommt); die Pfeile ▲▼ (erscheinen beim
    Überfahren der Zeile) verschieben ein Projekt in der Liste nach oben/
    unten. Auf-/zuklappbar; die Projektzeile selbst zeigt dabei immer (auch zugeklappt) alle Balken/
    Meilensteine ihrer Aufgaben zusammen als **halbtransparente** Übersicht,
    bewusst ohne Titeltext (reine "Strichcode"-Ansicht) — laufen mehrere
    Aufgaben gleichzeitig, zeichnet sich das durch die Überlagerung als
    dunklere Fläche ab.
    - **Aufgaben** — frei benannt (Klick auf "+ Aufgabe"/auf den Titel zum
      Umbenennen), je Aufgabe eine eigene Zeile. Eine Aufgabe kann beliebig
      viele Balken (Start–Ende) und/oder Meilensteine (ein einzelnes Datum,
      als Raute dargestellt) enthalten, jeweils mit eigenem Titel. Jede
      Raute zeigt den Tag des Monats direkt in der Raute, in der
      halbtransparenten Projekt-Übersichtszeile ausgeblendet (reine
      "Strichcode"-Ansicht). Im Bearbeiten-Dialog lässt sich zusätzlich pro
      Person ein **Pensum in %** eintragen (ein Meilenstein zählt dabei als
      eintägiger Balken) — daraus wird automatisch die Gesamtstundenzahl
      errechnet (Anwesenheitstage der Person im Zeitraum laut Wochenschema
      × 8h × Pensum, auf ganze Stunden gerundet) und direkt am Balken bzw.
      neben der Raute angezeigt. Eine Live-Vorschau der Stunden erscheint
      schon im Dialog, während Daten/Pensum angepasst werden. Zusätzlich
      steht die **Gesamtstundenzahl** rechtsbündig neben dem Zeilentitel:
      pro Aufgabe die Summe all ihrer Balken/Meilensteine, pro Projekt die
      Summe über alle Aufgaben — bleibt weg, wo nirgends ein Pensum
      zugewiesen ist.

      Das **Restpensum** (100% minus die Summe aller an diesem Tag über
      alle Projekte/Aufgaben hinweg zugewiesenen Pensen) zeigt sich direkt
      in der Mitarbeiter-Zeile: ein unverplanter Anwesenheitstag bleibt im
      normalen Grün, mit zunehmender Buchung wird der Tag dunkler eingefärbt
      und bei Überbuchung (Restpensum <0) rötlich. Die genaue Zahl steht
      immer als Tooltip zur Verfügung, ab einer gewissen Zoomstufe auch
      direkt sichtbar im Streifen (`restpensumPercent()`/
      `attendanceStripesHtml()` in `timeline/app.js`).
- **Wochenspalten**: der Kopfbereich zeigt zusätzlich zu den Monaten eine
  zweite, feinere Zeile mit einer Spalte pro Woche (Montag als Wochenbeginn,
  beschriftet mit dessen Datum), samt durchgehenden vertikalen Trennlinien
  über alle Zeilen. Samstage/Sonntage sind nur in den Mitarbeiter-Zeilen
  markiert (grau ohne, grünlich mit Anwesenheit laut Wochenschema — siehe
  oben), nicht mehr pauschal über alle Zeilen hinweg.
- **Zoom**: **Strg/Cmd + Scrollrad** (bzw. Zwei-Finger-Pinch am Trackpad) auf
  dem Zeitplan zoomt rein/raus, um den Tag unter dem Mauszeiger herum —
  normales Scrollen bzw. Umschalt+Scrollen bleibt dem Browser fürs native
  seitliche Verschieben überlassen. Weit genug hineingezoomt erscheint eine
  dritte Kopfzeile mit dem Datum jedes einzelnen Tages
  (`DAY_HEADER_MIN_WIDTH` in `timeline/app.js`).
- Beginnt ein Balken vor "heute" (im rollenden Fenster kann das mit der Zeit
  passieren), bleibt sein Titel am linken Rand des sichtbaren Bereichs
  stehen, statt vor dessen Anfang zu verschwinden — die linke Kante wird
  dafür bei der Darstellung auf den Fensteranfang geklemmt, das rechte Ende
  (echtes Enddatum) bleibt unverändert (`visibleBarRect()`).
- **Neue Balken/Meilensteine anlegen**: direkt auf der leeren Fläche einer
  Mitarbeiter-/Aufgabe-Zeile (nicht der Projekt-Übersichtszeile) — **ziehen**
  legt einen neuen Balken an (Start/Ende = Anfang/Ende der Ziehbewegung), ein
  **Klick ohne Ziehen** einen neuen Meilenstein am angeklickten Tag. Beides
  öffnet danach den Bearbeiten-Dialog zur Titel-Eingabe/Kontrolle, statt
  sofort zu speichern. Kein "+"-Knopf mehr nötig. Der Cursor steht dabei
  direkt im Titelfeld (markiert vorausgewählt), damit man ohne Extra-Klick
  lostippen kann — beim Bearbeiten eines bestehenden Eintrags nicht, um den
  vorhandenen Titel nicht versehentlich zu überschreiben.
- **Bearbeiten**: ein bestehender Balken/Meilenstein lässt sich direkt mit
  der Maus verschieben (ganzen Balken ziehen) bzw. an den Enden ziehen
  (Start/Ende einzeln anpassen, auf ganze Tage gerundet) — ein Klick **ohne**
  Ziehen öffnet stattdessen den Bearbeiten-Dialog mit Datumsfeldern (Titel,
  Typ, Start, Ende). Balken lassen sich nicht über das sichtbare
  Jahresfenster hinaus ziehen.
- **Speichern**: bewusst **kein** Feld-/Item-Merge wie bei Offerten/
  Pendenzen — letzter Speicherstand gewinnt (bei zwei Personen, die
  gleichzeitig arbeiten, könnte eine die Änderung der anderen überschreiben,
  siehe "Bekannte Grenzen" unten). Wird erst am Ende einer Aktion
  synchronisiert (z.B. beim Loslassen nach dem Ziehen), nicht bei jeder
  Zwischenposition.
- **Erster Wurf**: Projekt-/Aufgaben-Verwaltung ist bewusst einfach gehalten
  (u.a. "+ Aufgabe"/Aufgabe-umbenennen über ein simples `prompt()`-Fenster
  statt eines eigenen Dialogs) — gedacht zum Ausprobieren, danach gezielt
  verfeinern.

---

## Finanzplanung

Liquiditätsplanung pro Kalenderjahr (fest, nicht rollend wie die Timeline) —
Anfangssaldo, monatlich wiederkehrende und einmalige Ausgaben, Einnahmen,
Auszahlungen (Gewinnausschüttungen an die Gesellschafter), daraus laufend
berechnet der Saldo pro Monat.

- **Speicherort**: ein Jahr = eine eigene JSON-Datei auf Nextcloud
  (`Buero/Admin/App/Finanzplanung/<Jahr>.json`) — ein Jahr ist in sich
  geschlossen, beim Jahreswechsel wird ohnehin komplett neu geladen, keine
  Merge-Logik über Jahre hinweg nötig (anders als bei den Pendenzen).
- **Jahres-Navigation**: `‹ Jahr ›` oben, freie Navigation in beide
  Richtungen ohne Begrenzung.
- **Drei Abschnitte** (von oben nach unten): Ausgaben, Einnahmen,
  Auszahlungen (Gewinnausschüttungen). Beträge werden immer **positiv**
  eingegeben — ob ein Betrag den Saldo erhöht oder verringert, ergibt sich
  allein aus dem Abschnitt, nicht aus einem Vorzeichen (`SECTIONS` in
  `finanzplanung/app.js`).
  - **Ausgaben** und **Auszahlungen** fassen beide Zeilentypen bewusst in
    EINER Liste mit einer einzigen Summe zusammen (übersichtlicher als zwei
    getrennte Abschnitte), unterscheidbar am Icon vor der Bezeichnung:
    - 🔁 **monatlich** ("+ monatlich"): ein Betrag pro Zeile, gilt für alle
      12 Monate gleich — Klick auf eine beliebige Monatszelle öffnet ein
      Eingabefeld, das den Betrag für die ganze Zeile ändert.
    - 📌 **einmalig** ("+ einmalig"): Betrag an einzelnen Monaten. Klick
      auf eine Monatszelle öffnet direkt ein Eingabefeld für genau diesen
      einen Monat (0 oder leer entfernt den Eintrag) — kein Markieren
      mehrerer Zellen nötig.
  - **Einnahmen** sind immer vom Typ "einmalig" (bei einem Architekturbüro
    erfahrungsgemäss nie monatlich wiederkehrend) — eigener "+ Zeile"-Knopf
    statt der beiden Knöpfe bei Ausgaben/Auszahlungen. Zusätzlich lässt sich
    zu jedem Monatsbetrag eine kurze Info hinterlegen (z.B. "Bauprojekt",
    "Vorprojekt", um z.B. mehrere Phasen desselben Projekts auseinanderzuhalten)
    — nach Eingabe des Betrags fragt ein zweites `prompt()`-Fenster danach
    (leer lassen = keine Info). Erscheint als Tooltip beim Überfahren der
    Zahl, zusätzlich per gepunkteter Unterstreichung auch ohne Hover
    erkennbar.
  - Titel UND Summe (Monats-Subtotale sowie "Total"-Spalte mit der
    Jahressumme) stehen gemeinsam in der OBERSTEN Zeile jedes Abschnitts —
    keine separate Summen-Zeile am Ende, man sieht die Zahlen sofort ohne
    an den Zeilen vorbeizuscrollen. Darunter die einzelnen Zeilen, danach
    die "+"-Knöpfe.
  - **Zeilen bearbeiten**: auf die Bezeichnung klicken benennt sie um; ▲▼
    verschieben eine Zeile innerhalb ihres Abschnitts nach oben/unten
    (am Rand deaktiviert); × löscht sie (mit Rückfrage).
- **Saldo-Zeile** ganz unten: wird laufend für jeden Monat berechnet
  (`berechneSalden()`), rötlich eingefärbt bei negativem Saldo.
- **Jahres-Übertrag**: öffnet man ein Jahr, für das noch keine Datei
  existiert, wird der Anfangssaldo mit dem berechneten Endsaldo des
  Vorjahres vorbefüllt (nur falls dessen Datei existiert) — bleibt aber ein
  ganz normales editierbares Feld, falls die effektiven Finanzen leicht von
  der Prognose abweichen.
- **Speichern**: wie bei den Offerten (`updateOfferStatus()` in
  `offerten/app.js`) wird jede Änderung als reine Funktion sowohl sofort
  lokal (optimistisch) als auch, seriell in einer Warteschlange, auf einen
  frisch vom Server geholten Stand angewendet — kein Vergleichs-/
  Konflikt-Dialog nötig, da die Teiländerung gezielt nachgetragen wird statt
  den ganzen Stand zu überschreiben. Jahr und Anfangssaldo-Vorschlag werden
  dabei beim Auslösen der Änderung eingefroren (nicht erst beim
  tatsächlichen Schreiben gelesen) — sonst würde ein noch hängender
  Speichervorgang beim schnellen Weiterklicken aufs nächste Jahr versehentlich
  dort landen.

---

## Baukosten

Kostenschätzung nach **BKP** (Baukostenplan, Ausgabe 1991) — der Ersatz für
die bisherige Excel-Vorlage des Büros. Die Gliederung ist dreistufig:
1-stellig Hauptgruppe ("2 Gebäude"), 2-stellig Elementgruppe ("22 Rohbau 2"),
3-stellig Position ("224 Bedachungsarbeiten").

- **Speicherort**: eine Kostenschätzung = eine JSON-Datei auf Nextcloud
  (`Buero/Admin/App/Baukosten/<Projekt> <Titel>.json`), Liste + Editor wie
  bei den Offerten/Protokollen.
- **Der BKP-Katalog selbst steht im Repo** (`baukosten/bkp.js`, 541
  Nummern, davon 461 dreistellige Positionen) und ist für alle Schätzungen
  identisch; die Datei einer Schätzung enthält nur, was tatsächlich erfasst
  wurde. Dadurch bleiben die Dateien klein, und eine Korrektur am Katalog
  gilt sofort für alle bestehenden Schätzungen. (Der Katalog stammt aus der
  alten Excel-Vorlage, deren Sortier-Artefakte — "1411" statt "141" — und
  Tippfehler sind dabei korrigiert, die Reservegruppen 7 und 8 ergänzt.)
- **Eigenes Layout**: Dieses Modul weicht bewusst vom Karten-Layout der
  übrigen Apps ab — Kennzahlen oben, darunter eine dichte Tabelle mit nur
  feinen horizontalen Trennlinien, rechts ein einblendbares Detailfenster.
  Eine Kostenschätzung ist eine sehr lange, sehr zahlenlastige Liste, bei
  der die sonst verwendeten abgerundeten Karten die Lesbarkeit eher stören.
  Farbpalette und Schriften bleiben dieselben wie überall
  (`css/style.css`).

### Startsicht und Ansicht

- **Beim Öffnen ist absichtlich der ganze Katalog sichtbar**, auch die
  leeren Nummern und auf allen Ebenen: Beim Erstellen einer Schätzung geht
  man den BKP einmal ganz durch, und was man nicht sieht, vergisst man.
  Leere Gruppen sind grau abgesetzt. Erst wenn die Schätzung Form annimmt,
  lohnt sich das Ausdünnen — diese Wahl wird dann pro Gerät gemerkt
  (`localStorage`, nicht in der Datei: zwei Leute dürfen dieselbe Schätzung
  gleichzeitig unterschiedlich tief aufgeklappt anschauen).
- **Ebene 1 / 2 / 3 / Alles** klappt den ganzen Baum auf diese Tiefe auf.
  "3" zeigt die Positionen, aber noch keine Unterpositionen; "Alles" auch
  diese. Zusätzlich klappt ein **Klick irgendwo auf eine Gruppen- oder
  Positionszeile** genau diese auf und zu — in der Zeile selbst gibt es
  sonst nichts anzuklicken, deshalb braucht es keine eigenen
  Klapp-Dreiecke. Die Ebenen-Knöpfe sind nur eine Ausgangslage, die ein
  einzelner Klick für diese eine Zeile wieder aufhebt.
- **"Nur verwendete"** blendet alles aus, worin noch nichts erfasst ist.
- **Dichte** "Komfortabel"/"Kompakt" verdichtet die Zeilenhöhe.
- Die **Suche** (<kbd>⌘K</kbd> bzw. <kbd>Ctrl K</kbd>; BKP-Nummer oder
  Stichwort, auch im Beschrieb und in den Bemerkungen) setzt Filter und
  Ein-/Ausklappen bewusst aus und zeigt auch noch leere Positionen — genau
  so wird eine Position gefunden und in Gebrauch genommen.
- **Kennzahlen oben**: Total, Bandbreite (aus der Prozentangabe im Feld
  "Genauigkeit" gerechnet, z.B. ±25% → von/bis), Anzahl erfasster
  Positionen und je Modul eine Kachel.
- **Beim Scrollen bleiben stehen**: der Block aus Titelzeile, Kennzahlen
  und Werkzeugleiste, direkt darunter die Spaltentitel, und unten das
  Gesamttotal. Der Seitenkopf (App-Titel, Icons, Sync-Zeile) scrollt
  dagegen bewusst weg — er wird beim Arbeiten nicht gebraucht und kostet
  sonst dauerhaft Höhe. Die Höhe des klebenden Blocks ändert sich mit der
  Fensterbreite und der Zahl der Modul-Kacheln; sie wird deshalb gemessen
  und als CSS-Variable `--bk-sticky-h` gesetzt (`messeSticky()`), damit die
  Spaltentitel exakt darunter einrasten.
- **Farbgebung**: Hauptgruppen stehen auf dem Akzentblau der Palette (weisse
  Schrift), Elementgruppen auf einer stark aufgehellten Variante davon,
  Positionen auf dem normalen Hintergrund. Bei 500+ Zeilen gibt das
  durchgehende Beige der übrigen Apps zu wenig Struktur. Eingabefelder sind
  weiss mit feinem Rand — man sieht also, was sich bearbeiten lässt.
- **"+ Zeile"** erscheint erst, wenn die Maus auf einer Positionszeile
  steht — bei über 400 sichtbaren Positionen wäre ein dauerhafter Knopf auf
  jeder davon das Auffälligste auf dem Bildschirm. Solange noch nichts
  erfasst ist, erklärt stattdessen ein Hinweis unter der Werkzeugleiste den
  Einstieg.

### Durchgehen zu zweit (Status)

Damit beim gemeinsamen Durchgehen nichts vergessen geht, trägt jede
BKP-Nummer links ein Kästchen, das sich durchklicken lässt:

| Stand | Kästchen |
|---|---|
| offen (Start) | weiss, leer |
| pendent | gelb, leer |
| erledigt | hellgrün mit einem Haken ✓ |
| verifiziert | dunkelgrün mit Doppelhaken ✓✓ |

Der Stand färbt **nur das Kästchen, nie die ganze Zeile**. Ganze Zeilen in
Gelb/Grün haben die Tabelle bei 500 Zeilen unruhig gemacht und die
Ebenenfarben (Haupt-/Elementgruppe) überdeckt — die Struktur ging verloren,
und das ist beim Durchgehen das Wichtigere. Dass "verifiziert" zusätzlich
einen **Doppelhaken** trägt, hat denselben Grund: hell- gegen dunkelgrün
allein wäre ein zu feiner Unterschied, wenn nur noch ein 19 × 15 Pixel
grosses Kästchen den Stand zeigt.

Nach "verifiziert" geht es wieder auf "offen". Gespeichert wird der Stand
nur an den **Blättern** (dreistellige Positionen, eigene Unterteilungen und
jene Reservegruppen ohne Positionen). Eine **Gruppe rechnet ihren Stand aus
den Kindern**: sie nimmt den Stand an, den *alle* ihre Kinder mindestens
erreicht haben (`statusBerechnen()`). Das Kästchen einer Elementgruppe wird
also erst grün, wenn jede ihrer Positionen grün ist, und das einer
Hauptgruppe erst, wenn all ihre Elementgruppen so weit sind — genau das
macht sichtbar, wo noch niemand war.

Das **Kästchen einer Gruppe lässt sich trotzdem anklicken**: es schaltet vom
angezeigten (abgeleiteten) Stand aus weiter und setzt den neuen Stand auf
**alle Positionen darunter** — eine fertig besprochene Elementgruppe ist so
mit einem Klick abgehakt statt Zeile für Zeile. Weil der Gruppenstand aus
den Kindern gerechnet wird, zeigt die Gruppe danach genau diesen Stand.
Einzeln gesetzte Stände darunter werden dabei überschrieben; ein weiterer
Durchlauf bis "offen" löscht sie wieder. Der **restliche Teil der Zeile
klappt weiterhin auf und zu** — nur das Kästchen selbst setzt den Status.
Eine Kennzahl-Kachel
"Durchgegangen" zeigt, wie viele der 461 Positionen mindestens "erledigt"
sind (erscheint, sobald etwas abgehakt wurde).

### Unterpositionen, Ausmass, Kennwert

- Eine Position kann **beliebig viele Unterpositionen** haben, die
  automatisch zur Positionssumme zusammengezählt werden; die Summen laufen
  weiter auf Element-, Hauptgruppe und Gesamttotal hoch.
- **Ausmass und Kennwert dürfen gerechnet werden**: "2x4x2" ergibt 16,
  "105*1.15+30*0.8" ergibt 144.75. Angezeigt wird das Resultat; die eingetippte Rechnung erscheint wieder
  im Feld, sobald man hineinklickt, und hängt zusätzlich als Tooltip daran —
  so bleibt nachvollziehbar, woher eine Zahl kommt. Gespeichert wird deshalb
  der eingetippte Text, nicht das Resultat. (Eine Zeit lang stand die Rechnung
  zusätzlich klein unter dem Feld; bei hunderten Zeilen war das zu unruhig.)
  Erlaubt sind die vier Grundrechenarten mit Klammern; "x"/"×" gelten als Mal,
  Komma als Dezimaltrennzeichen, Apostrophe (Tausender) werden ignoriert.
  Lässt sich eine Eingabe nicht rechnen, bleibt sie stehen und wird rot
  markiert statt kommentarlos verworfen.
- **Kosten = Ausmass × Kennwert.** Ein leeres Ausmass zählt als 1 — eine
  Pauschale/Budgetposition braucht also nur den Kennwert und z.B. die
  Einheit "Pausch." (in der Excel stand dafür immer ein Pseudo-Ausmass
  "1 Pl").
- **Einheit** ist ein freies Feld mit Vorschlagsliste (Stk, m², m³, m, lfm,
  kg, t, h, Tag, Pausch., %).

#### MwSt: Kennwerte exklusive, Kosten inklusive

Kennwerte kommen aus Richtofferten und Kennwert-Sammlungen und werden
deshalb **exklusive MwSt** erfasst. Die Spalte **"Kosten inkl."** und alle
Summen darüber (Positions-, Gruppen- und Gesamttotal, Kennzahl-Kacheln,
Modulsummen, Ausdruck) zeigen dagegen den Betrag **inklusive** — der
Bauherr will wissen, was er am Schluss zahlt. Die Spaltentitel sagen das
("Kennwert exkl." / "Kosten inkl."), ebenso die Total-Zeile ("Total ±25%
inkl. 8.1% MwSt") und der Kopf des Ausdrucks.

Der **Satz steht in den Kopfdaten** und gehört damit zur einzelnen
Schätzung, nicht zum Programm — er gehört zum Kostenstand und ändert sich
über die Jahre. Neue Schätzungen starten mit **8.1%**; **0** lässt die
Schätzung durchgehend exklusive MwSt (dann heissen die Spalten wieder
schlicht "Kennwert"/"Kosten" und die Total-Zeile sagt "exkl. MwSt").

Der Zuschlag sitzt an genau einer Stelle (`zeilenKosten()` in
`baukosten/app.js`): alles darunter rechnet netto, alles darüber ist
inklusive. Das ist auch der Grund, warum die **Bemessungsgrundlage der
Prozent-Zeilen netto bleibt** — das Architektenhonorar wird auf die
Netto-Baukosten gerechnet und dann selbst versteuert, nicht auf einen
Betrag, in dem die MwSt schon steckt.

**Bestehende Dateien** (vor dieser Änderung) bekommen beim Öffnen **0%**,
nicht 8.1%: dort waren die Kennwerte inklusive erfasst, ein automatischer
Zuschlag würde die Schätzung still um 8.1% aufblähen. Wer eine solche
Schätzung umstellt, setzt den Satz in den Kopfdaten und prüft die
Kennwerte.

#### Honorar als Prozentsatz der Baukosten

Im Detailfenster lässt sich die **Berechnung** einer Unterposition von
"Ausmass × Kennwert" auf einen **Prozentsatz der Baukosten** umstellen —
gedacht fürs Architektenhonorar (BKP 291), das sich damit automatisch
mitbewegt, wenn sich die Schätzung ändert. Die übrigen Honorare
(Bauingenieur, Spezialisten) werden weiterhin pauschal erfasst.

Die Zeile hält dann den **Prozentsatz** im Ausmass-Feld, die Einheit wird
auf "%" gesetzt, und statt eines Kennwerts zeigt die Zeile ihre
**Bemessungsgrundlage** — damit nachvollziehbar bleibt, worauf sich der
Prozentsatz bezieht.

Die Grundlage ist immer dieselbe: die **Baukosten BKP 1–9 ohne Honorare**.
Eine zweite Variante (mit Honoraren) gab es kurz, sie ist aber nicht
gebräuchlich — ein Honorar auf Honorare zu rechnen will niemand, und die
Wahl war nur eine Stolperstelle. Bestehende Zeilen mit der alten Variante
rechnen beim Öffnen auf dieser Grundlage weiter (`migriere()`).

**Nicht** in der Grundlage enthalten sind:

- die **Honorar-Elementgruppen** (09, 19, 29, … 99),
- die **Hauptgruppe 0** (Grundstück ist keine Baukost),
- **alle anderen Prozent-Zeilen**. Das ist kein Detail, sondern notwendig:
  BKP 291 liegt selbst in Hauptgruppe 2 und wäre sonst Teil seiner eigenen
  Bemessungsgrundlage — ein Zirkelschluss. Weil Prozent-Zeilen generell
  draussen bleiben, sehen auch mehrere davon dieselbe Grundlage und
  beeinflussen sich nicht gegenseitig (`basisBetrag()` in
  `baukosten/app.js`).
- **Eigene Unterteilung einer Position**: "+ Unterteilung" auf einer
  dreistelligen Position ergänzt eine Nummer wie "211.1 Gerüste", wenn der
  Standard-BKP zu grob ist. Sie gilt nur für diese eine Kostenschätzung.
  Eine Nummer mit Punkt ist im BKP ein **Teil** der dreistelligen Position,
  nicht deren Nachbar — sie bekommt deshalb eine eigene Ebene 4 und hängt
  unter "211": ihre Kosten zählen in 211 hinein, von dort in 21 und 2
  (`elterNummer()`/`vorfahren()`). Im Katalog selbst kommt keine solche
  Nummer vor; auch die alte Excel hatte nur die von Hand ergänzte 211.1.
  Beim Anlegen wird die nächste freie Nummer vorgeschlagen, und ein
  eingetipptes Komma ("211,1") wird als Punkt gelesen.

### Detailfenster und Bemerkungen

- Sobald der Cursor in einer Unterposition steht, zeigt das **Detailfenster
  rechts** diese Zeile gross: Beschrieb, Ausmass/Einheit/Kennwert, die
  gerechneten Kosten, das Modul und beide Bemerkungsfelder. Dadurch darf die
  Tabelle selbst schmal und ruhig bleiben. Beide Seiten schreiben in
  dieselbe Zeile und werden gegenseitig nachgeführt (`setzeFeld()`).
- Zwei Textfelder pro Unterposition: **Notizen** (Annahmen, offene Fragen,
  Notizen aus Sitzungen — erscheinen **nie** im Ausdruck) und
  **Bemerkungen** (für den Bauherrn, erscheinen im Ausdruck). Ein kleiner
  Punkt in der Beschrieb-Spalte zeigt an, dass etwas hinterlegt ist
  (grau = Notiz, blau = Bemerkung). Intern heissen die Felder weiterhin
  `intern`/`extern` — die Dateien bleiben dadurch unverändert lesbar.
- Wer beides lieber direkt in der Tabelle hat, schaltet
  **"Bemerkungsspalten"** ein — dann erscheinen beide als eigene Spalten.
- **Zusammenzug auf der Positionszeile**: die dreistellige Zeile zeigt in
  der Spalte "Bemerkungen" die Bemerkungen aller ihrer Unterpositionen
  kommagetrennt hintereinander ("Zumauern Türöffnungen, Neue Trennwände,
  Zumauern Fensteröffnungen") — man sieht also auch zugeklappt, was in der
  Position steckt. Die Kosten einer eigenen Unterteilung ("211.1") zählen
  in 211 hinein, ihre Bemerkungen deshalb auch. Nur die **Bemerkungen**
  werden zusammengezogen, nie die Notizen; derselbe Text steht im Ausdruck
  in der zusammengefassten Positionszeile (`bemerkungenZusammen()`).

### Module: Teilbereiche

In der alten Excel wurden Teilbereiche über zusätzliche Spalten
("Einsparpotential", "nur Dach", "UG & Fenster", "nur Wohnung") abgebildet,
in denen der Betrag ein zweites Mal stand. Hier wird nichts kopiert: **jede
Unterposition trägt höchstens eine Modul-Zuordnung**, die Teilsummen ergeben
sich daraus. Soll eine Position auf zwei Module verteilt werden, teilt man
sie in zwei Unterpositionen.

Ein Modul ist ein **separat zu entscheidender Teilbereich** — "Dachterrasse",
"Balkone vergrössern", "Küche ersetzen (die alte ist vielleicht noch gut)".
Der **Hauptteil der Kosten trägt deshalb gar kein Modul**: das ist, was so
oder so gebaut wird.

Module werden in den **Kopfdaten** als Liste gepflegt (nur der Name,
"+ Modul" legt eines an). **Jedes Modul wird separat gerechnet**: unter der
Tabelle steht zuerst das Total der Positionen *ohne* Modulzuordnung
("Total ±25% ohne Module"), darunter je Modul eine eigene Zeile mit "+",
zuletzt das Gesamttotal über alles. Dieselbe Reihenfolge haben die
Kennzahl-Kacheln oben: nach "Durchgegangen" zuerst "Baukosten ohne Module",
dann je Modul eine Kachel mit Betrag und Anteil am Total. Im Ausdruck lässt
sich die Aufstellung ein- und ausschalten, je Modul eine Spalte einblenden
und je Modul eine eigene Seite drucken.

Die Beträge **im Baum bleiben vollständig**: eine Positions- oder
Gruppenzeile zeigt, was diese BKP-Nummer kostet — unabhängig davon, welchem
Modul die einzelnen Zeilen zugeordnet sind. Die Aufteilung passiert in der
Aufstellung unter der Tabelle, in den Kacheln und (optional) in den
Modulspalten. Ohne Modulzuordnungen erscheint die Aufstellung gar nicht,
dann steht wie früher nur eine Total-Zeile da.

Die Zuordnungen hängen an einer **ID**, nicht am Namen — ein Modul
umbenennen behält sie, ein Modul löschen setzt die betroffenen Zuordnungen
zurück (`uebernimmKopfDialog()`).

Früher gab es **zwei Arten** Modul: "Im Total" (eine Aufteilung) und
"Zusätzlich" (eine noch nicht beschlossene Option, deren Positionen nicht
ins Total zählten und überall mit einem violetten "+" standen). Diese
Unterscheidung ist weg — alle Module werden gleich behandelt und separat
ausgewiesen. Bestehende Dateien verlieren das Merkmal beim Öffnen
(`migriere()`).

### Ausdruck

Der Ausdruck ist **unabhängig von der Bildschirmansicht** und hat einen
eigenen Dialog ("Drucken …"); er rendert eine eigene Tabelle (`renderDruck()`
nach `#printView`) statt die Ansicht zu drucken. Nur so lassen sich die
folgenden Regeln unabhängig von der gerade eingestellten Ebene umsetzen.
Die Einstellungen gehören zur Schätzung (nicht zum Gerät) und werden
mitgespeichert.

| Option | Standard | Wirkung |
|---|---|---|
| Nur verwendete Positionen | an | Dreistellige Positionen ohne Eintrag weglassen |
| Alle Hauptgruppen, auch leere | an | Die einstelligen Gruppen 0–9 erscheinen immer, damit die Gliederung vollständig bleibt |
| Eigene Unterteilungen einzeln | **aus** | Aus: "211.1 Gerüste" wird in die Position 211 eingerechnet statt separat ausgewiesen (die Summe steckt dort ohnehin schon) |
| Unterpositionen einzeln | **aus** | Aus: nur die Positionssummen; die Beschriebe der Unterpositionen werden in der Positionszeile zusammengefasst (wie es in der Excel die `TEXTJOIN`-Formel tat). Ausmass/Einheit/Kennwert bleiben dann leer, sobald mehr als eine Unterposition dahintersteckt — eine Summe aus "m²" und "Stk" wäre schlicht falsch |
| Bemerkungen | an | Die Spalte **Notizen** wird nie gedruckt; auf der Positionszeile stehen die Bemerkungen der Unterpositionen zusammengezogen |
| Module als Spalten | aus | Je Modul eine Kostenspalte; die Spalte "Kosten" bleibt die Gesamtsumme |
| Module als Aufstellung über dem Total | an | Unter der Tabelle das Total ohne Module, je Modul eine Zeile, dann das Gesamttotal — dieselbe Aufstellung wie am Bildschirm |
| Je Modul eine eigene Seite | aus | Nach der Gesamtschätzung folgt pro Modul eine **vollständige eigene Berechnung** auf einer neuen Seite |

**Je Modul eine eigene Seite** gibt jedem Modul ein eigenes Blatt: gleiche
Tabelle, gleiche Regeln, aber nur mit den Zeilen dieses Moduls, mit dessen
Summen auf allen Ebenen und einem eigenen Schluss ("Total Modul Dach").
Gedacht für Teilbereiche, über die separat entschieden oder abgerechnet wird
— man kann das Blatt für sich weitergeben. Die Modulspalten und die
Aufstellung über dem Total bleiben dort weg (eine Modulseite *ist* schon die
Aufteilung), und Module ohne eine einzige Zeile bekommen kein Blatt
(`druckSeite()` in `baukosten/app.js`).

Querformat A4, mit Titel, Projekt, Genauigkeit, Kostenstand, dem MwSt-Hinweis
und den "Grundlagen" aus den Kopfdaten als Kopfblock. Die Modulseiten tragen
denselben Kopf mit dem Zusatz "— Modul Dach" (ohne die "Grundlagen", die
stehen einmal auf der Gesamtschätzung).

### Kopfdaten und Varianten

- **Kopfdaten** (Knopf oben): Projekt (aus der zentralen Projektliste),
  Titel, Genauigkeit (z.B. "±25%", erscheint auch in der Total-Zeile und
  steuert die Bandbreiten-Kachel), Kostenstand (z.B. "September 2025"), der
  MwSt-Satz (siehe unten), die Modulliste und ein Freitext "Grundlagen", der
  nur im Ausdruck erscheint. Dort steckt auch das Löschen der ganzen
  Schätzung.
- **Varianten** (z.B. "Mini"/"Maxi" desselben Projekts) über
  **"Duplizieren"** in der Liste — die Kopie bekommt eigene Zeilen-IDs,
  die Ausgangsvariante bleibt unverändert; Module, Zuordnungen und
  Durchgeh-Status werden mitkopiert.
- **Umbenennen**: in der Liste neben der Schätzung ("Umbenennen"), oder in
  den Kopfdaten über Titel und Projekt. Die Datei auf Nextcloud wird
  mitbenannt (`planeUmbenennen()`). Weil der Worker-Proxy nur
  GET/PUT/MKCOL/PROPFIND/DELETE durchlässt, geht das nicht per WebDAV-MOVE,
  sondern als "neue Datei schreiben, dann alte löschen" — in dieser
  Reihenfolge kann ein Abbruch mittendrin höchstens eine Kopie hinterlassen,
  niemals die Schätzung verlieren. Offline wird nicht umbenannt (Hinweis in
  der Statuszeile).

### Speichern

Wie bei Offerten/Finanzplanung: jede Änderung ist eine reine Funktion, die
sofort lokal (optimistisch, fürs UI) und seriell in einer Warteschlange auf
einen frisch vom Server geholten Stand angewendet wird. Zwei Besonderheiten
gegenüber der Finanzplanung:

- Der lokale Stand wird nach dem Schreiben **nicht** durch den Serverstand
  ersetzt. Hier tippt man vier Felder einer Zeile schnell hintereinander;
  der gerade geschriebene Stand basiert auf dem Serverstand von vorhin und
  würde die inzwischen erfassten Felder wieder wegwerfen.
- Vor jedem strukturellen Neuaufbau der Tabelle wird die **offene Eingabe
  übernommen** (`uebernimmOffeneEingabe()`): `change` feuert erst beim
  Verlassen eines Feldes, und wer einen Kennwert tippt und direkt daneben
  das Modul auswählt, löst damit einen Neuaufbau aus — ohne diesen Schritt
  wäre der getippte Wert beim Neuzeichnen wieder weg.
- Eine neu hinzugefügte Zeile wird **einmal vor** der Änderungsfunktion
  erzeugt, nicht darin — die Funktion läuft zweimal (lokal und auf dem
  Serverstand), und mit einem `uid()` im Innern bekäme die Zeile dort eine
  andere ID, womit alle späteren Feldänderungen sie auf dem Server nicht
  mehr fänden.

---

## Bekannte Grenzen

- **Kein Konflikt-Schutz bei Gleichzeitigkeit**: Falls dieselbe Person eine
  App auf zwei Geräten gleichzeitig nutzt, kann beim Sync ein Eintrag
  verloren gehen (read-modify-write ohne Locking). Bei normalem Gebrauch (ein
  Gerät) ist das kein Thema. Ausnahmen: die Adressliste hat eine einfache
  Konflikt-Erkennung pro Kontakt eingebaut (siehe Abschnitt "Adressliste"),
  die Offerten mergen beim Speichern pro Feld (siehe Abschnitt "Offerten"),
  und die Pendenzen mergen ihre gemeinsame Liste pro Eintrag (siehe
  Abschnitt "Pendenzen").
- Läuft die Zeiterfassung über Stunden im Hintergrund/Tab geschlossen, wird
  der Zähler beim nächsten Öffnen korrekt weitergerechnet (kein
  Datenverlust), aber es gibt keine Push-Erinnerung, falls vergessen wird,
  auf Stop zu klicken.
- **App-Icons**: liegen unter `icons/home-*.png`, `icons/zeiterfassung-*.png`,
  `icons/quittung-*.png`, `icons/wettbewerb-*.png`, `icons/offerten-*.png`,
  `icons/adressliste-*.png`, `icons/pendenzen-*.png`, `icons/protokoll-*.png`,
  `icons/timeline-*.png`, `icons/finanzplanung-*.png`, `icons/baukosten-*.png`
  (je 192px + 512px PNG).
  Zum Ändern einfach unter denselben Dateinamen ersetzen — keine
  Code-/Manifest-Änderung nötig.

## Lokal testen

```bash
python3 -m http.server 8080
# im Browser: http://localhost:8080 (Startseite)
# bzw. http://localhost:8080/zeiterfassung/, /quittung/, /wettbewerbsprogramme/,
# /offerten/, /adressliste/, /pendenzen/, /protokoll/, /timeline/,
# /finanzplanung/, /baukosten/
```

## Auf GitHub veröffentlichen (GitHub Pages)

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<dein-user>/zeiterfassung.git
git push -u origin main
```

Danach im Repository unter **Settings → Pages**:
- Source: "Deploy from a branch"
- Branch: `main`, Ordner `/ (root)`

Nach 1–2 Minuten erreichbar unter `https://<dein-user>.github.io/zeiterfassung/`.

**Als eigene Apps installieren:** Auf dem Handy die gewünschte Unterseite
öffnen (`.../zeiterfassung/`, `.../quittung/` oder
`.../wettbewerbsprogramme/`) und dort "Zum Home-Bildschirm hinzufügen" —
jede landet als eigenes Icon mit eigenem Namen. Die Startseite
(`.../` ohne Unterordner) lässt sich zusätzlich/alternativ als
Kachel-Menü installieren.

**Falls vorher schon die alte (kombinierte) Version installiert war:** Das
bestehende Homescreen-Icon zeigt nach diesem Update auf die neue Startseite
statt direkt auf die Zeiterfassung, da Root jetzt der Launcher ist — altes
Icon löschen und die gewünschten Apps wie oben neu hinzufügen.
