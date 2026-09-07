# Büro-Apps

Vier kleine PWAs für den Büroalltag, alle im gleichen Repo, alle einzeln als
App auf dem Homescreen installierbar:

- **[Zeiterfassung](zeiterfassung/)** — Zeit pro Projekt erfassen, Sync auf Nextcloud.
- **[Quittung](quittung/)** — Belege fotografieren/hochladen, für Nextcloud + Banana aufbereiten.
- **[Wettbewerbsprogramme](wettbewerbsprogramme/)** — Architekturwettbewerbe (JSON) hochladen und vergleichen.
- **[Offerten](offerten/)** — Offerten aus Modulen zusammenstellen, Kosten berechnen, auf Nextcloud sichern.

Die **Startseite** (`index.html` im Repo-Root) ist nur ein Launcher mit vier
Kacheln, die auf die vier Unterordner verlinken. Jede der vier Apps hat ihr
eigenes `manifest.json` und ihren eigenen `service-worker.js` — man kann also
entweder die Startseite installieren (Kachel-Menü) **oder** direkt auf einer
Unterseite "Zum Home-Bildschirm hinzufügen" tippen, dann landet nur diese eine
App als eigenes Icon auf dem Homescreen.

Gemeinsamer Code (Nextcloud-Login, WebDAV-Zugriff, Einstellungen-Dialog) liegt
in `shared/common.js` und wird von allen vier Apps eingebunden.
`localStorage` ist pro Domain (nicht pro Unterordner) gültig — einmal in
**irgendeiner** der vier Apps unter dem Zahnrad-Symbol eingerichtet, gelten
Benutzername/App-Passwort automatisch auch in den anderen dreien.

## Ersteinrichtung (einmalig, für alle vier Apps zusammen)

1. In Nextcloud: **Einstellungen → Sicherheit → App-Passwörter** → neues
   App-Passwort erstellen (z.B. Name "Büro-App").
2. In einer der vier Apps (egal welche) auf das Zahnrad-Symbol tippen:
   - **Benutzername**: euer Nextcloud-Login
   - **App-Passwort**: das eben erstellte
   - **Anzeigename**: erscheint z.B. in der Zeiterfassungs-CSV als "Person"
3. "Verbindung testen" klicken, bei Erfolg "Speichern". Ab jetzt sind die
   Zugangsdaten in allen vier Apps auf diesem Gerät nutzbar.

**Sicherheitshinweis:** Das App-Passwort wird ausschliesslich lokal im
Browser gespeichert (localStorage) und niemals ins Repo committet.

Jede Person macht das auf ihrem eigenen Gerät mit ihrem eigenen Login — jeder
Account hat seinen eigenen, komplett getrennten Nextcloud-Dateibereich.

## CORS-Proxy (Cloudflare Worker)

Die Managed Nextcloud bei hosting.de schickt bei Cross-Origin-Requests
(Browser → Nextcloud von einer anderen Domain aus) keine
`Access-Control-Allow-Origin`-Header — der Browser blockiert deshalb den
direkten Zugriff. Deshalb sprechen alle vier Apps nicht direkt mit Nextcloud,
sondern über einen kleinen **Cloudflare Worker** als Proxy (`worker.js`,
gemeinsam für alle vier Apps). Der Worker läuft server-seitig, hat also kein
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
   Stelle, gilt für alle vier Apps), committen, pushen.

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

---

## Zeiterfassung

Zeit per Knopfdruck erfassen (P1 / P2 / P3 / Pause / Stop), Einträge werden
automatisch als CSV auf Nextcloud synchronisiert. Läuft offline und
synchronisiert, sobald wieder Netz da ist.

### Funktionsweise

- Klick auf **P1/P2/P3** beendet den aktuell laufenden Zähler (falls einer
  läuft) und startet sofort einen neuen für das geklickte Projekt.
- Klick auf **Pause** beendet den aktuellen Zähler, startet aber keinen neuen.
- Klick auf **Stop** ist identisch zu Pause (Tagesende).
- **Nachtragen**: Zeit für ein beliebiges (auch vergangenes) Datum manuell
  eintragen, falls mal vergessen wurde zu starten/stoppen.
- Jeder abgeschlossene Zeitabschnitt wird als eine Zeile in eine CSV-Datei
  auf eurer Nextcloud geschrieben — pro Person eine eigene Datei.
- Alles läuft lokal im Browser (localStorage), auch offline. Nicht
  synchronisierte Einträge werden automatisch nachgeliefert, sobald Internet
  verfügbar ist (Retry alle 30s + sofort bei "online"-Event).

Zielordner: `TARGET_FOLDER_PATH` in `zeiterfassung/app.js` (Standard
`Buero/Admin/Zeiterfassung`), wird bei Bedarf automatisch angelegt.

### Projektnamen zentral verwalten

Die Projektnamen (P1/P2/P3) werden zentral von der Büroleitung in einer
einfachen Textdatei auf Nextcloud verwaltet. Alle Geräte laden sie
automatisch (beim Start, danach alle 60 Sekunden sowie beim Zurückkehren in
den Tab).

1. In Nextcloud eine Textdatei anlegen, z.B.
   `Buero/Admin/Zeiterfassung/projekte.txt`, mit **genau 3 Zeilen** (Zeile 1 =
   Name für P1, Zeile 2 = P2, Zeile 3 = P3):
   ```
   Projekt Nord
   Projekt Süd
   Verwaltung
   ```
2. Datei in Nextcloud anklicken → **Teilen** → **Link erstellen** (öffentlicher
   Freigabelink, keine Zugangsdaten nötig zum Lesen). Nextcloud zeigt einen
   Link wie `https://.../s/AbCdEfGh123`.

   **Sicherheitshinweis:** Wer diesen Link kennt, kann die Projektnamen
   lesen (nicht aber eure Zeiterfassungsdaten). Der Link lässt sich jederzeit
   in Nextcloud widerrufen.
3. Den Teil nach `/s/` (den Token) in `zeiterfassung/app.js` bei
   `PROJECTS_SHARE_TOKEN` eintragen, committen, pushen.
4. Später ändern: einfach die Textdatei in Nextcloud bearbeiten und
   speichern — alle Geräte übernehmen die neuen Namen automatisch, kein
   Code-Update nötig.

### Datenformat

Pro Person und Jahr eine Datei (im jeweils eigenen Nextcloud-Account):
```
/Buero/Admin/Zeiterfassung/zeiterfassung_2026.csv
```

Spalten:
```
Datum,Projekt,Dauer_Min,Kommentar,Person
2026-08-13,Projekt Nord,105.30,Vormittag Konzept, Nachmittag Umsetzung,Jonas
2026-08-13,Projekt Süd,12.45,Kurzes Telefonat,Jonas
```

Es gibt **eine Zeile pro Tag und Projekt**, nicht eine Zeile pro
Start/Stop-Wechsel — mehrere Wechsel zum selben Projekt am selben Tag werden
zu einer Summe zusammengefasst. Beim Sync wird die passende Zeile gesucht und
aktualisiert; nur wirklich neue Tag/Projekt-Kombinationen werden angehängt.

- `Dauer_Min` ist auf 2 Nachkommastellen genau.
- `Kommentar` lässt sich in der App unter "Heute" pro Projekt eintragen,
  bezieht sich auf die Tagessumme, nur für den **heutigen** Tag editierbar.
- `Person` kommt aus dem "Anzeigename" in den Einstellungen.
- Klicks unter 5 Sekunden werden ignoriert (Schutz vor Versehen-Klicks).

### Auswertung (zeiterfassung/dashboard/)

Eine separate, schreibgeschützte Auswertungsseite (Charts + Tabelle nach
Projekt/Person, Jahr/Projekt/Person-Filter) liegt unter
`zeiterfassung/dashboard/` — liest die CSVs über öffentliche
Nextcloud-Freigabelinks (`PERSON_SOURCES` in `dashboard/js/dashboard.js`),
kein Login nötig. Aktuell nirgends in der App verlinkt, direkt per URL
aufrufbar.

---

## Quittung

Belege (Foto oder PDF) erfassen, nach Nextcloud hochladen und als Buchung für
Banana vorbereiten.

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
   - Die Datei wird als `[Belegnummer] [Verwendungszweck, max. 15
     Zeichen].pdf` in diesen Ordner hochgeladen, z.B.
     `26-A003 KUARIO Quittung.pdf`.
   - Zusätzlich wird die Buchung als Zeile an `buchungen.txt` im selben
     (Jahres-)Ordner angehängt.

**Wichtig:** Diese Funktion braucht zwingend eine Internetverbindung (die
nächste Belegnummer wird live aus dem Ordnerinhalt ermittelt) — kein
Offline-Modus.

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

`buchungen.txt` ist bewusst **nicht** direkt die Banana-Buchhaltungsdatei
(deren `.ac2`/natives Format ist proprietär), sondern eine Warteschlange zum
Import: in Banana über **Datei → Import → Bewegungen importieren** einlesen.

### Kontenplan, Kategorien und MwSt/USt-Codes pflegen

Kontenplan, Kategorien und MwSt/USt-Codes werden **nicht** in `quittung/app.js`
hart hinterlegt, sondern zur Laufzeit aus drei Textdateien im `quittung/`-
Ordner geladen: `konten.txt`, `kategorien.txt`, `mwst.txt`. Da diese Dateien
vom gleichen Origin wie die App selbst ausgeliefert werden (GitHub Pages),
reicht ein einfacher `fetch()` — kein Nextcloud-Proxy nötig, kein CORS-Thema.

**Format:** Tab-getrennte Zeilen `Code<TAB>Bezeichnung`, ein Eintrag pro
Zeile — exakt der Export aus Banana (**Datei → Export → Daten für Excel/Open
Office/…**, Tabellen "Accounts"/"Categories"/"VatCodes", dort die
Beträge-Spalten weglassen/löschen). Zeilen ohne Code (Leerzeilen,
Abschnittsüberschriften, Total-Zeilen) werden beim Einlesen automatisch
übersprungen; bei `kategorien.txt` werden die Überschriften "ERLÖSE" und
"AUFWÄNDE" als Gruppen erkannt.

**Ändert sich der Kontenplan in Banana:** Datei in Banana neu exportieren,
die Beträge-Spalten entfernen, die entsprechende `.txt`-Datei in `quittung/`
ersetzen, committen und pushen — die App übernimmt die Änderung automatisch
(alle 60s sowie beim Öffnen des Beleg-Formulars), **ohne Code-Update**.

`MWST_EINNAHME_CODES`/`MWST_AUSGABE_CODES` in `quittung/app.js` legen fest,
welche Codes aus `mwst.txt` überhaupt zur Auswahl stehen (aktuell nur die
gültigen Sätze 0/2.6/3.8/8.1%) — das ändert sich praktisch nie und bleibt
deshalb hart hinterlegt; nur die Beschreibungstexte kommen live aus
`mwst.txt`.

Für den allerersten Start ohne Internet gibt es zusätzlich
`FALLBACK_KONTEN`/`FALLBACK_KATEGORIEN`/`FALLBACK_MWST_CODES` in
`quittung/app.js` als Offline-Fallback (danach übernimmt der
localStorage-Cache der zuletzt erfolgreich geladenen Dateien diese Rolle).

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
  `Buero/Akquise/Neue Wettbewerbe` in `wettbewerbsprogramme/app.js`), kein
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

- **Liste**: alle gespeicherten Offerten/Rechnungen (Datum, Typ, Projekt,
  Empfänger, Total), neueste zuerst, mit PDF- (📄) und Duplizieren-Button (⧉)
  pro Zeile. "+ Neue Offerte" / "+ Neue Rechnung" öffnet den Editor leer mit
  dem entsprechenden Typ vorausgewählt, Klick auf eine Zeile öffnet ihn zum
  Bearbeiten.
- **Typ**: Offerte oder Rechnung, jederzeit im Editor umschaltbar (gleiches
  Formular für beide). Bei Rechnung zusätzlich: "Zahlbar bis" (Datum) und
  "Zahlungshinweis" (kurzer Text, standardmässig "Zahlbar innert 30 Tagen"
  — bewusst kein IBAN/QR-Zahlteil, der wird separat übers E-Banking
  erstellt), und "Offert-Nr." heisst dann "Rechnungs-Nr.". Eine bestehende
  Offerte per Typ-Wechsel + Speichern direkt in eine Rechnung umzuwandeln,
  überschreibt dieselbe Datei (kein automatisches "Original behalten + neue
  Rechnung erzeugen") — dafür zuerst **Duplizieren**, dann am Duplikat den
  Typ auf Rechnung stellen.
- **Editor** — Kopfdaten: Empfänger, Adresse, Projekt, Datum, Offert-/
  Rechnungs-Nr. (optional, frei), Stundensatz (Fr./h) und MWST-Satz (%) für
  **diese** Offerte/Rechnung. Dazu Betreff und ein freier Brieftext fürs
  PDF-Anschreiben auf der ersten Seite. Der Absender-Ort fürs "Ort, Datum" in
  der Brief-Datumszeile kommt zentral aus `absender.json` (siehe unten),
  kein eigenes Feld pro Offerte/Rechnung.
- **Phasen**: freie Zwischenüberschrift innerhalb der Positionsliste (z.B.
  "Vorprojekt", "Bauprojekt"), über "+ Phase hinzufügen". Zählt nicht in die
  Modul-Nummerierung und hat keine Stunden/Kosten.
- **Module**: pro Modul ein Titel (automatische Nummerierung `1)`, `2)`, …
  nach Position unter den Modulen, nicht Teil der Daten) mit Kurzbeschrieb
  darunter — **ein Punkt pro Zeile** im Textfeld, gespeichert als Liste für
  eine spätere Bulletpoint-Darstellung im PDF —, Stunden (zweite Spalte) und
  daraus berechnete Kosten = Stunden × Stundensatz (dritte Spalte). Über
  "+ Modul hinzufügen" ergänzen.
- **Modul-Suche**: Suchfeld unter der Positionsliste durchsucht live Titel
  und Kurzbeschrieb aller bereits geladenen Offerten (Titel, Herkunfts-
  projekt/-datum als Treffer angezeigt) und übernimmt einen Treffer per
  Klick als neues Modul (Stunden danach anpassbar). Bewusst **keine**
  separate Modul-Library — die Offerten sind für die Liste ohnehin schon
  geladen, das spart eine zweite, separat zu pflegende Datenquelle. Siehe
  `allKnownModules()`/`searchModules()` in `offerten/app.js`.
- Phasen und Module liegen in einer gemeinsamen, beliebig sortierbaren Liste
  (mit ▲/▼ neu anordnen, mit ✕ entfernen) — eine Phase lässt sich also
  zwischen beliebige Module schieben.
- **Summen** unten: Nebenkostenpauschale (fixer, frei eingegebener Betrag —
  nur wenn ungleich null, zählt in Zwischentotal und damit auch in die
  MWST-Berechnung mit hinein), Zwischentotal exkl. MWST (Summe aller
  Modul-Kosten + Nebenkostenpauschale, Phasen zählen nicht mit), MWST-Betrag
  (Zwischentotal × Satz), Total inkl. MWST.
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
  `Buero/Admin/Offerten und Rechnungen` in `offerten/app.js`), kein
  Jahresordner. Neue Offerten werden als `[Datum] [Projekt].json` abgelegt;
  beim Bearbeiten einer bestehenden Offerte bleibt der Dateiname unverändert
  (Überschreiben statt Duplikat), auch wenn sich Datum/Projekt ändern.

### Absenderadresse

Liegt in `offerten/absender.json` (Name, Adresse, PLZ/Ort, Ort fürs
"Ort, Datum" in der Brief-Datumszeile, Telefon, E-Mail, Website) — bewusst
**nicht** pro Offerte/Rechnung erfasst, da praktisch immer gleich. Datei mit
den echten Angaben füllen, committen, pushen; die App lädt sie zur Laufzeit
(`fetch("absender.json")`, kein Nextcloud-Zugriff nötig, da sie mit der App
selbst ausgeliefert wird — analog zu `konten.txt` etc. bei Quittung). Wird
für den PDF-Briefkopf verwendet (`absender` in `offerten/app.js`, siehe
`loadAbsender()`).

Diese Funktion braucht (wie Quittung und Wettbewerbsprogramme) `DELETE` als
erlaubte HTTP-Methode im Cloudflare Worker — siehe Abschnitt
"Worker deployen" oben.

### PDF-Export

"PDF erstellen" (im Editor, oder 📄 pro Zeile in der Liste) erzeugt ein
zweiseitiges (bzw. mehrseitiges, je nach Länge) PDF und lädt es direkt im
Browser herunter:

- **Seite 1 — Anschreiben**: Absenderblock oben rechts, kleine
  Rücksendeadresse + Empfänger-Adressblock links, Ort/Datum rechtsbündig
  (z.B. "Zürich, 7. September 2026"), Betreff, Brieftext (mit Zeilenumbruch
  = Absatz, automatischem Zeilenumbruch bei langen Zeilen).
- **Seite 2 (garantiert eigene Seite, auch bei kurzem Brief) — Offerte/
  Rechnung**: Titel ("OFFERTE"/"RECHNUNG"), Projekt, Empfänger, Offert-/
  Rechnungs-Nr., Datum (bei Rechnung zusätzlich "Zahlbar bis"), dann die
  Positionsliste (Phasen als Zwischenüberschrift, Module nummeriert mit
  Kurzbeschrieb als Bulletpoints, Stunden/Kosten-Spalten) und die Summen.
  Bei Rechnung zusätzlich der Zahlungshinweis unter den Summen. Läuft die
  Positionsliste über eine Seite hinaus, folgen weitere Seiten automatisch
  (mit wiederholtem Spaltenkopf).
- Schrift: die echten Nudica-Schnitte (`fonts/Nudica-Light.otf` /
  `Nudica-Medium.otf`, **nicht** die woff/woff2 fürs Web-UI), eingebettet
  ohne Subsetting — mit Subsetting erzeugt die verwendete Bibliothek
  (pdf-lib + fontkit) mit diesen Schriften eine von manchen PDF-Readern
  abgelehnte Einbettung.
- Technik: `offerten/pdf.js` (eigenständig, nutzt nichts aus `app.js`),
  gebaut mit [pdf-lib](https://pdf-lib.js.org/) + `@pdf-lib/fontkit` (siehe
  `<script>`-Tags in `index.html`, Version dort gepinnt). Läuft komplett im
  Browser, kein Server/Backend nötig.
- **Bewusst nicht umgesetzt**: die offizielle Schweizer QR-Rechnung
  (Zahlteil mit Swiss-QR-Code, IBAN/Referenznummer-Validierung nach den
  Financial-Standards). Der "Zahlungshinweis" ist reiner Freitext ohne
  Validierung — falls eine bank-/Postfinance-konforme QR-Rechnung gebraucht
  wird, ist das ein eigenes, deutlich grösseres Vorhaben.
- **Offline**: Liste/Bearbeiten/Speichern funktionieren wie gewohnt offline;
  "PDF erstellen" braucht (zumindest beim ersten Mal pro Browser-Cache)
  Internet, da pdf-lib/fontkit von einem CDN geladen werden und bewusst
  nicht im Service-Worker vorgecacht sind (siehe Kommentar in
  `offerten/service-worker.js`) — ein einzelner fehlgeschlagener
  Cross-Origin-Fetch soll nicht die ganze App-Shell offline unbrauchbar
  machen.

---

## Bekannte Grenzen

- **Kein Konflikt-Schutz bei Gleichzeitigkeit**: Falls dieselbe Person eine
  App auf zwei Geräten gleichzeitig nutzt, kann beim Sync ein Eintrag
  verloren gehen (read-modify-write ohne Locking). Bei normalem Gebrauch (ein
  Gerät) ist das kein Thema.
- Läuft die Zeiterfassung über Stunden im Hintergrund/Tab geschlossen, wird
  der Zähler beim nächsten Öffnen korrekt weitergerechnet (kein
  Datenverlust), aber es gibt keine Push-Erinnerung, falls vergessen wird,
  auf Stop zu klicken.
- **App-Icons**: liegen unter `icons/home-*.png`, `icons/zeiterfassung-*.png`,
  `icons/quittung-*.png`, `icons/wettbewerb-*.png`, `icons/offerten-*.png`
  (je 192px + 512px PNG). Zum Ändern einfach unter denselben Dateinamen
  ersetzen — keine Code-/Manifest-Änderung nötig.

## Lokal testen

```bash
python3 -m http.server 8080
# im Browser: http://localhost:8080 (Startseite)
# bzw. http://localhost:8080/zeiterfassung/, /quittung/, /wettbewerbsprogramme/
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
