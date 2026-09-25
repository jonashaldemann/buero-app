# Büro-Apps

Sechs kleine PWAs für den Büroalltag, alle im gleichen Repo, alle einzeln als
App auf dem Homescreen installierbar:

- **[Zeiterfassung](zeiterfassung/)** — Zeit pro Projekt erfassen, Sync auf Nextcloud.
- **[Quittung](quittung/)** — Belege fotografieren/hochladen, für Nextcloud + Banana aufbereiten.
- **[Wettbewerbsprogramme](wettbewerbsprogramme/)** — Architekturwettbewerbe (JSON) hochladen und vergleichen.
- **[Offerten](offerten/)** — Offerten aus Modulen zusammenstellen, Kosten berechnen, auf Nextcloud sichern.
- **[Adressliste](adressliste/)** — Adressen filtern, Ansichten speichern, auf Nextcloud sichern.
- **[Pendenzen](pendenzen/)** — To-do-Liste nach Projekt und Person filterbar, auf Nextcloud sichern.

Die **Startseite** (`index.html` im Repo-Root) ist nur ein Launcher: ein
App-Icon-Raster wie auf dem Smartphone-Homescreen (3 Spalten, Icon + kurzes
Label, Beschreibung nur noch als Tooltip) statt einer langen Liste mit
Beschreibungstext — mit sieben Kacheln (sechs Apps plus die Zeiterfassungs-
Auswertung als eigenes Icon) passte Letzteres auf dem Handy nicht mehr ohne
Scrollen auf eine Seite. Jede der sechs Apps hat ihr eigenes `manifest.json`
und ihren eigenen `service-worker.js` — man kann also entweder die
Startseite installieren (Icon-Raster) **oder** direkt auf einer Unterseite
"Zum Home-Bildschirm hinzufügen" tippen, dann landet nur diese eine App als
eigenes Icon auf dem Homescreen.

Gemeinsamer Code (Nextcloud-Login, WebDAV-Zugriff, Einstellungen-Dialog) liegt
in `shared/common.js` und wird von allen sechs Apps eingebunden.
`localStorage` ist pro Domain (nicht pro Unterordner) gültig — einmal in
**irgendeiner** der sechs Apps unter dem Zahnrad-Symbol eingerichtet, gelten
Benutzername/App-Passwort automatisch auch in den anderen fünfen.

## Ersteinrichtung (einmalig, für alle sechs Apps zusammen)

1. In Nextcloud: **Einstellungen → Sicherheit → App-Passwörter** → neues
   App-Passwort erstellen (z.B. Name "Büro-App").
2. In einer der sechs Apps (egal welche) auf das Zahnrad-Symbol tippen:
   - **Benutzername**: euer Nextcloud-Login
   - **App-Passwort**: das eben erstellte
3. "Verbindung testen" klicken, bei Erfolg "Speichern". Ab jetzt sind die
   Zugangsdaten in allen sechs Apps auf diesem Gerät nutzbar.

Kein eigenes Anzeigename-Feld (mehr) — der Name, der z.B. in der
Zeiterfassungs-CSV als "Person" erscheint, wird automatisch aus dem
Benutzernamen abgeleitet (`deriveDisplayName()` in `shared/common.js`): bei
einer E-Mail-Adresse der Teil vor dem "@", sonst der ganze Benutzername,
erster Buchstabe gross (z.B. `jonas` → "Jonas", `jonas@firma.ch` → "Jonas").

**Sicherheitshinweis:** Das App-Passwort wird ausschliesslich lokal im
Browser gespeichert (localStorage) und niemals ins Repo committet.

Jede Person macht das auf ihrem eigenen Gerät mit ihrem eigenen Login — jeder
Account hat seinen eigenen, komplett getrennten Nextcloud-Dateibereich.

## CORS-Proxy (Cloudflare Worker)

Die Managed Nextcloud bei hosting.de schickt bei Cross-Origin-Requests
(Browser → Nextcloud von einer anderen Domain aus) keine
`Access-Control-Allow-Origin`-Header — der Browser blockiert deshalb den
direkten Zugriff. Deshalb sprechen alle sechs Apps nicht direkt mit Nextcloud,
sondern über einen kleinen **Cloudflare Worker** als Proxy (`worker.js`,
gemeinsam für alle sechs Apps). Der Worker läuft server-seitig, hat also kein
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
   Stelle, gilt für alle sechs Apps), committen, pushen.

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

Die Projekte werden zentral von der Büroleitung in einer einfachen
Textdatei auf Nextcloud verwaltet (ein Projekt pro Zeile, optional mit
**dreistelliger Projektnummer, Leerschlag, Projekttitel** — der Titel darf
selbst Leerschläge enthalten; eine Zeile ohne führende Nummer ist ebenso
gültig und besteht dann nur aus dem Titel). Alle Geräte laden die Datei
automatisch (beim Start, danach alle 60 Sekunden sowie beim Zurückkehren in
den Tab).

**Zeiterfassung und Pendenzen** ordnen Einträge, filtern und weisen Farben
**über den Projektnamen** zu, nicht über die Nummer — eine Nummer ist dort
also rein kosmetisch (wird beim Anzeigen aus der Zeile herausgeparst, taucht
aber nirgends in der App auf) und darf durchaus mehrfach vergeben sein, z.B.
für mehrere interne/nicht-projektbezogene Kategorien:
```
000 Büro Allgemein
000 Akquisition
021 Neubau Werkhof
014 Umbau Altstetten
```
"Büro Allgemein" und "Akquisition" bekommen hier trotz identischer Nummer
"000" unterschiedliche Farben und werden beim Filtern korrekt auseinander-
gehalten (Farbe = String-Hash des Namens, siehe `stringHash()` in
`zeiterfassung/app.js`/`pendenzen/app.js`/`zeiterfassung/dashboard/js/
dashboard.js`). Einzige Einschränkung: der **Name** muss eindeutig sein — zwei
Zeilen mit demselben Namen wären für Zeiterfassung/Pendenzen nicht
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

1. In Nextcloud eine Textdatei anlegen, z.B.
   `Buero/Admin/Zeiterfassung/projekte.txt`:
   ```
   021 Neubau Werkhof
   014 Umbau Altstetten
   003 Verwaltung
   ```
2. Datei in Nextcloud anklicken → **Teilen** → **Link erstellen** (öffentlicher
   Freigabelink, keine Zugangsdaten nötig zum Lesen). Nextcloud zeigt einen
   Link wie `https://.../s/AbCdEfGh123`.

   **Sicherheitshinweis:** Wer diesen Link kennt, kann die Projektnamen
   lesen (nicht aber eure Zeiterfassungsdaten). Der Link lässt sich jederzeit
   in Nextcloud widerrufen.
3. Den Teil nach `/s/` (den Token) in `zeiterfassung/app.js`, `pendenzen/
   app.js`, `protokoll/app.js` **und** `offerten/app.js` bei
   `PROJECTS_SHARE_TOKEN` eintragen, committen, pushen (jedes Modul führt
   bewusst eine eigene Kopie der Projektliste — siehe Kommentar in
   `pendenzen/app.js`).
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
- `Person` kommt aus dem Anzeigename, der automatisch aus dem Benutzernamen
  abgeleitet wird (siehe "Ersteinrichtung" oben).
- Klicks unter 5 Sekunden werden ignoriert (Schutz vor Versehen-Klicks).

### Auswertung (zeiterfassung/dashboard/)

Eine separate, schreibgeschützte Auswertungsseite (Charts + Tabelle nach
Projekt/Person) liegt unter `zeiterfassung/dashboard/` — liest die CSVs über
öffentliche Nextcloud-Freigabelinks (`PERSON_SOURCES` in
`dashboard/js/dashboard.js`), kein Login nötig. Von der Startseite aus über
ein eigenes Icon ("Auswertung") erreichbar.

Filterbar nach Jahr, Projekt, Person sowie zusätzlich nach Zeitraum: "Ganzes
Jahr" (Standard), "Heute", "Diese Woche", "Dieser Monat" oder "Frei
wählbar" (zwei Datumsfelder). Die Jahres-CSV wird weiterhin komplett geladen,
der Zeitraum-Filter schränkt die schon geladenen Zeilen per Datumsvergleich
zusätzlich ein. "Heute"/"Diese Woche"/"Dieser Monat" beziehen sich immer auf
das echte heutige Datum — weicht das vom gerade gewählten Jahr ab, wechselt
die Jahresauswahl automatisch mit (sonst gäbe es scheinbar keine Treffer).
Ein frei gewählter Zeitraum, der über einen Jahreswechsel hinausgeht, wird
nicht unterstützt — gezeigt wird dann nur der Teil im gerade geladenen Jahr.

Charts: "Nach Projekt" (horizontale Balken, ein Balken pro Projekt) und "Nach
Tag" (vertikale Balken nebeneinander, ein Balken pro Kalendertag im aktuell
gefilterten Zeitraum, ohne Einzelbeschriftung — bei langen Zeiträumen also
viele schmale Balken; Datum + Dauer als Tooltip beim Hovern/Antippen).

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
  `Buero/Admin/Finanzen/_buero-app/` statt im (öffentlichen!) Repo, per
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
  `Buero/Admin/Finanzen/_buero-app/` hochladen (ersetzen) — **kein
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

- **Liste**: alle gespeicherten Offerten/Rechnungen (Nr., Datum, Typ,
  Projekt, Empfänger, Total, Status), neueste zuerst, mit PDF- (📄) und
  Duplizieren-Button (⧉) pro Zeile. "+ Neu" öffnet den Editor leer (Typ
  "Offerte" vorausgewählt, im Editor umschaltbar), Klick auf eine Zeile
  öffnet ihn zum Bearbeiten. Die **Status**-Spalte ganz rechts ist als
  einziges Feld direkt in der Liste editierbar (Dropdown, ohne den Editor zu
  öffnen) und speichert die Änderung sofort auf Nextcloud.
- **Status**: rein interner Vermerk (In Bearbeitung / Versendet / Bezahlt,
  siehe `STATUS_LABELS` in `offerten/app.js`), taucht **nicht** im PDF auf —
  nur zur eigenen Übersicht, editierbar im Editor (vierte Spalte neben Typ/
  Nr./Datum) oder direkt in der Liste.
- **Typ**: Offerte oder Rechnung, jederzeit im Editor umschaltbar (gleiches
  Formular für beide) — "Offert-Nr." heisst dann "Rechnungs-Nr.", und im PDF
  erscheint unterhalb der Summen zusätzlich fix der Satz
  "Zahlbar innert 30 Tagen" (bewusst kein eigenes Feld dafür, kein Datum und
  kein IBAN/QR-Zahlteil — der wird separat übers E-Banking erstellt). Eine
  bestehende Offerte per Typ-Wechsel + Speichern direkt in eine Rechnung
  umzuwandeln, überschreibt dieselbe Datei (kein automatisches "Original
  behalten + neue Rechnung erzeugen") — dafür zuerst **Duplizieren**, dann
  am Duplikat den Typ auf Rechnung stellen.
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
  Pendenzen/Protokoll (siehe Abschnitt "Projektnamen zentral verwalten"
  oben) — eine Rechnung betrifft praktisch immer ein bereits laufendes,
  nummeriertes Projekt; Auswahl übernimmt Nummer und Name automatisch in
  dieselben (bei Rechnungen nur versteckten) Felder. Liste und PDF zeigen
  "Nummer – Name", sofern eine Projektnummer gesetzt ist. Verschwindet ein
  Projekt später aus der zentralen Liste (z.B. abgeschlossen/archiviert),
  bleiben bereits gespeicherte Rechnungen davon unberührt (Nummer/Name sind
  beim Speichern als reiner Text übernommen worden, keine Live-Verknüpfung)
  — beim erneuten Öffnen einer solchen Rechnung erscheint die nicht mehr
  aktive Nummer trotzdem als eigene, vorausgewählte Dropdown-Option
  ("… (nicht mehr in der Liste)"), damit es nicht aussieht, als sei das
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
  `Buero/Admin/Offerten und Rechnungen` in `offerten/app.js`), kein
  Jahresordner. Neue Offerten werden als `[Datum] [Projekt].json` abgelegt;
  beim Bearbeiten einer bestehenden Offerte bleibt der Dateiname unverändert
  (Überschreiben statt Duplikat), auch wenn sich Datum/Projekt ändern.

Diese Funktion braucht (wie Quittung und Wettbewerbsprogramme) `DELETE` als
erlaubte HTTP-Methode im Cloudflare Worker — siehe Abschnitt
"Worker deployen" oben.

### Absenderadresse

Liegt in `offerten/absender.json` (Name, Adresse, PLZ/Ort, Ort fürs
"Ort, Datum" in der Brief-Datumszeile, Telefon, E-Mail, Website) — bewusst
**nicht** pro Offerte/Rechnung erfasst, da praktisch immer gleich. Datei mit
den echten Angaben füllen, committen, pushen; die App lädt sie zur Laufzeit
(`fetch("absender.json")`, kein Nextcloud-Zugriff nötig, da sie mit der App
selbst ausgeliefert wird — analog zu `konten.txt` etc. bei Quittung). Wird
für den PDF-Briefkopf verwendet (`absender` in `offerten/app.js`, siehe
`loadAbsender()`).

### Unterschriften

Wählbare Unterzeichner (Checkboxen im Editor, nach dem Brieftext, Mehrfach-
auswahl möglich) kommen aus `shared/personen.json` — zentral im `shared/`-
Ordner statt in `offerten/` selbst, weil dieselbe Personenliste auch bei den
Pendenzen fürs Zuordnen/Filtern verwendet wird (eine Person einmal pflegen
statt pro Modul zu duplizieren):

```json
[
  { "key": "jonas", "name": "Jonas Haldemann", "datei": "Unterschrift_Jonas_Haldemann.png" },
  { "key": "manuel", "name": "Manuel Viecelli", "datei": "Unterschrift_Manuel_Viecelli.png" }
]
```

`datei` (die Unterschrift-PNG) wird nur von den Offerten verwendet, die
Pendenzen ignorieren dieses Feld einfach.

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
  Nextcloud-Ordner `Buero/Admin/Adressen` (wie bei den Offerten: ein File pro
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
- **Kategorie, Status, Kontaktperson**: kommen aus einem gemeinsam
  verwalteten Optionen-Set (`_optionen.json`, im selben Nextcloud-Ordner)
  statt aus freiem Text — Dropdowns statt Textfelder, sowohl im Editor als
  auch direkt in der Tabelle (zusammen mit Weihnachtskarte lassen sich diese
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
- **Ansichten speichern**: die aktuelle Kombination aus Spalten (inkl.
  Reihenfolge), Filtern und Sortierung lässt sich unter einem Namen speichern
  (z.B. "Weihnachtskarten" = nur Firma/Name/Vorname/Weihnachtskarte, gefiltert
  auf Weihnachtskarte = Ja). Jede Ansicht ist — wie die Kontakte selbst —
  eine eigene JSON-Datei, im Unterordner `Buero/Admin/Adressen/Ansichten`,
  also für alle Personen mit Zugriff auf diesen Ordner gleich sichtbar.
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

---

## Pendenzen

Einfache To-do-Liste, nach Projekt und Person filterbar.

- **Speicherort**: anders als Offerten/Adressliste (eine Datei pro
  Datensatz) liegen alle Pendenzen in **einer** gemeinsamen Datei
  `Buero/Admin/Pendenzen/pendenzen.json` — bei kurzen, oft schnell
  angehakten/ergänzten Texten wäre eine Datei pro Pendenz nur Overhead.
- **Gleichzeitige Bearbeitung**: da alle Pendenzen eine Datei teilen, würde
  ein einfaches Überschreiben Änderungen einer anderen Person verlieren.
  Beim Speichern wird deshalb der aktuelle Serverstand nochmals geholt und
  pro Pendenz (per id) gemergt — die jeweils neuere `updatedAt` gewinnt, nur
  lokal oder nur serverseitig bekannte Pendenzen bleiben in jedem Fall
  erhalten. Anders als bei den Offerten (Feld-Merge) ist das ein Merge auf
  Ebene ganzer Listeneinträge, ohne Nachfrage-Dialog.
- **Projekte & Farben**: kommen aus derselben zentral verwalteten Liste wie
  die Zeiterfassung (`PROJECTS_SHARE_TOKEN`), damit ein Projekt überall
  gleich heisst und gleich aussieht — Zuordnung/Filter/Farbe erfolgen dabei
  über den **Projektnamen** (siehe Abschnitt "Projektnamen zentral
  verwalten" oben), eine Pendenz speichert im Feld `projekt` also den Namen,
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
  kommen aus `shared/personen.json` (gemeinsam mit den Offerten, siehe
  Abschnitt "Unterschriften" dort — eine Person einmal pflegen statt pro
  Modul zu duplizieren). Ein eigenes Personen-Dropdown beim Erfassen gibt es
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

- **Speicherort**: `Buero/Admin/Protokolle`, ein JSON pro Protokoll.
- **Projekt**: Dropdown aus derselben zentral verwalteten Liste wie
  Zeiterfassung/Pendenzen (siehe Abschnitt "Projektnamen zentral verwalten"
  oben) — eigene Kopie in `protokoll/app.js` (`PROJECTS_SHARE_TOKEN`).
  Anders als bei Zeiterfassung/Pendenzen (nur der Name) zeigen Auswahl,
  Liste und PDF hier **Projektnummer UND Name** ("021 – Neubau Werkhof").
- **Teilnehmende & Kürzel**: Büro-Personen (aus `shared/personen.json`)
  lassen sich per "+ Name"-Knopf hinzufügen und bekommen ihr Kürzel
  automatisch (Initialen, nicht änderbar); externe Teilnehmende werden frei
  eingetragen, inkl. einem optional frei wählbaren Kürzel.
- **Hauptteil**: Zwischentitel und Stichpunkte lassen sich wie die
  Phasen/Module bei den Offerten per Ziehgriff neu anordnen. Ein Stichpunkt
  kann optional ein Kürzel einer Teilnehmerin/eines Teilnehmers zugewiesen
  bekommen — das markiert ihn zugleich als Pendenz (kein separates Häkchen
  nötig).
- **Automatische Pendenzen**: ist das zugewiesene Kürzel das einer
  **Büro**-Person (externe Teilnehmende lösen nichts aus), wird beim
  Speichern automatisch ein Eintrag in `Buero/Admin/Pendenzen/pendenzen.json`
  angelegt/aktualisiert (Person und Text aus dem Protokoll; als Projekt wird
  der reine **Name** des im Protokoll gewählten Projekts übernommen, nicht
  die Nummer — Pendenzen ordnet Projekte namensbasiert zu, siehe Abschnitt
  "Projektnamen zentral verwalten" oben). Die
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

## Zeitplanung

Terminplanung als horizontaler Zeitbalken (Gantt-artig), rein browserbasiert
(kein PDF-Export). Das Zeitfenster ist immer "heute bis in 1 Jahr" — rollend,
kein festes Kalenderjahr; beim erneuten Öffnen verschiebt es sich also
automatisch mit.

- **Speicherort**: EINE gemeinsame Datei
  `Buero/Admin/Zeitplanung/zeitplanung.json` (wie bei den Pendenzen) statt
  einer Datei pro Projekt/Aufgabe.
- **Zeilen von oben nach unten**:
  - **Mitarbeitende** (aus `shared/personen.json`) — hier Ferien/Frei
    eintragen (Balken immer grau). Jeder Tag, an dem mindestens eine Person
    einen Balken hat, dessen Titel **"ferien"**, **"frei"**, **"weg"** oder
    **"abwesend"** enthält (als Teilstring, nicht nur exakt — erkennt also
    auch z.B. "Weihnachtsferien"), bekommt einen hellgrauen Streifen über
    **alle** Zeilen hinweg — je mehr Personen an diesem Tag frei haben,
    desto dunkler der Streifen (`isFreiTitle()`/`renderVacationOverlay()` in
    `zeitplanung/app.js`).
  - **Projekte** — entweder per Dropdown aus derselben zentral verwalteten
    Projektliste wie Zeiterfassung/Pendenzen (siehe Abschnitt "Projektnamen
    zentral verwalten" oben; Zuordnung/Farbe über den Namen, nicht die
    Nummer) oder frei benannt über das Textfeld daneben — für Vorhaben, die
    (noch) nicht in der offiziellen Liste stehen. Auf-/zuklappbar; die
    Projektzeile selbst zeigt dabei immer (auch zugeklappt) alle Balken/
    Meilensteine ihrer Aufgaben zusammen als **halbtransparente** Übersicht,
    bewusst ohne Titeltext (reine "Strichcode"-Ansicht) — laufen mehrere
    Aufgaben gleichzeitig, zeichnet sich das durch die Überlagerung als
    dunklere Fläche ab.
    - **Aufgaben** — frei benannt (Klick auf "+ Aufgabe"/auf den Titel zum
      Umbenennen), je Aufgabe eine eigene Zeile. Eine Aufgabe kann beliebig
      viele Balken (Start–Ende) und/oder Meilensteine (ein einzelnes Datum,
      als Raute dargestellt) enthalten, jeweils mit eigenem Titel. Jeder
      Balken zeigt am rechten Rand zusätzlich zum Titel seine Länge (5D,
      2W, 6M je nach Grössenordnung, `formatBarDuration()`), jede Raute den
      Tag des Monats direkt in der Raute. Beides bleibt in der
      halbtransparenten Projekt-Übersichtszeile ausgeblendet (reine
      "Strichcode"-Ansicht).
- **Wochenspalten**: der Kopfbereich zeigt zusätzlich zu den Monaten eine
  zweite, feinere Zeile mit einer Spalte pro Woche (Montag als Wochenbeginn,
  beschriftet mit dessen Datum), samt durchgehenden vertikalen Trennlinien
  über alle Zeilen. Samstage/Sonntage sind im ganzen Zeitplan leicht
  abgesetzt hinterlegt (dezenter als die Ferien-Streifen).
- **Zoom**: **Strg/Cmd + Scrollrad** (bzw. Zwei-Finger-Pinch am Trackpad) auf
  dem Zeitplan zoomt rein/raus, um den Tag unter dem Mauszeiger herum —
  normales Scrollen bzw. Umschalt+Scrollen bleibt dem Browser fürs native
  seitliche Verschieben überlassen. Weit genug hineingezoomt erscheint eine
  dritte Kopfzeile mit dem Datum jedes einzelnen Tages
  (`DAY_HEADER_MIN_WIDTH` in `zeitplanung/app.js`).
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
  `icons/zeitplanung-*.png` (je 192px + 512px PNG).
  Zum Ändern einfach unter denselben Dateinamen ersetzen — keine
  Code-/Manifest-Änderung nötig.

## Lokal testen

```bash
python3 -m http.server 8080
# im Browser: http://localhost:8080 (Startseite)
# bzw. http://localhost:8080/zeiterfassung/, /quittung/, /wettbewerbsprogramme/,
# /offerten/, /adressliste/, /pendenzen/
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
