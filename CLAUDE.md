# Hinweise für Claude Code in diesem Repo

Büro-Apps für ein Architekturbüro — elf kleine statische PWAs ohne
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
- **Gearbeitet wird auf `main`** (Stand November 2026, ausdrücklich so
  gewünscht) — ein anderer Branch nur, wenn der Nutzer ihn in genau diesem
  Auftrag verlangt. `development` existiert weiterhin, liegt aber brach.
- **Pushen macht der Nutzer selbst** (seit November 2026, ausdrücklich so
  gewünscht — von Hand geht es schneller): also committen und fertig, nicht
  pushen und auch nicht danach fragen. Nur wenn der Nutzer in genau dieser
  Runde "push mal"/"ja" sagt, wird gepusht — eine frühere Zustimmung gilt
  nicht automatisch für die nächste.
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
  JS-Dateien. Für die ES-Module in `modellviewer/` stattdessen
  `node --input-type=module --check < <datei>.js` -- `node --check` kennt
  `import` nicht und meldet dort immer einen Fehler.
- **3D-Viewer testen**: Chromium braucht `args: ["--enable-unsafe-swiftshader"]`,
  sonst gibt es kein WebGL. Geprüft wird nicht per Screenshot-Vergleich,
  sondern mit `gl.readPixels()` über die ganze Leinwand: DECKENDE Pixel
  (Alpha > 200) sind das Modell, teildeckende das Raster (0.55) und die
  eingeblendete Schnittfläche (0.1) -- mit einer Schwelle von 10 misst man
  die mit und sieht den Schnitt nicht mehr. Für HELLIGKEIT taugt der
  Mittelwert nicht: das Demomodell ist fast weiss und liegt im oberen,
  flachen Teil der ACES-Kurve, da bewegt selbst die ganze Sonne nur ein paar
  Stufen. Perzentile über die deckenden Pixel nehmen (p25 = Innenraum und
  Schattenseite, p90 = besonnte Flächen) und für Innenraum-Fragen ein
  eigenes OBJ+MTL-Testmodell bauen -- die Phong-Materialien sind genau der
  dunkle Fall. Damit lässt sich exakt prüfen,
  dass ein Schnitt am Rand das Modell auf 0 bringt und "umkehren" es
  zurückholt. Texturen sind erst nach `warteAufBeidateien()` da (siehe
  unten) -- misst man zu früh, ist das Modell schwarz.
- Nach Änderungen an einer GEMEINSAMEN Datei (`shared/common.js` oder
  `css/style.css`): **CACHE_NAME in JEDEM `service-worker.js` bumpen**, das
  sie cached (aktuell alle Module + Root, ausser dem Redirect-Stub
  `zeitplanung/`) — sonst bekommen bestehende Installationen die Änderung
  nicht automatisch mit.
- Server danach beenden: `lsof -ti:<port> -sTCP:LISTEN | xargs -r kill`.
- **Echte Büro-Daten zum Testen liegen in `.temp/`** (von `.gitignore`
  erfasst, gehören NIE ins Repo): der Export der Preisliste und echte
  Projektdateien wie "018 Bönigen Vorstudie P2 Bönigen Opti.json". Gegen
  die lässt sich wirklichkeitsnah testen -- über `page.route` als
  Nextcloud-Antwort ausliefern. Die Norm `_bkp_katalog.json` liegt nicht
  dabei; für einen Lauf mit vollständigem Katalog lässt sie sich aus den
  BKP-Knoten des Preislisten-Baums nachbilden (923 Nummern gegenüber 920 der
  Norm).

## Architektur-Eckpunkte

- **Module**: `zeiterfassung/`, `quittung/`, `wettbewerbsprogramme/`,
  `offerten/`, `adressliste/`, `pendenzen/`, `protokoll/`, `timeline/`
  (hiess früher "Zeitplanung"/`zeitplanung/` — unter der alten Adresse liegt
  bewusst ein Redirect-Stub, damit alte Lesezeichen/Home-Icons nicht ins
  Leere laufen), `finanzplanung/` (Liquiditätsplanung pro Kalenderjahr, ein
  File pro Jahr statt einer gemeinsamen Datei — siehe README),
  `baukosten/` (Kostenschätzung nach BKP, ein File pro Schätzung; der
  BKP-Katalog ist für alle Schätzungen gleich und liegt auf Nextcloud,
  siehe unten -- die Datei enthält nur das tatsächlich Erfasste),
  `modellviewer/` (3D-Modelle für Kunden, ein ORDNER pro Modell).
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
- **Zu zweit an einer Schätzung `baukosten/`**: `persist()` legt jede
  Änderung auf einen frisch geholten Serverstand, verschiedene Zeilen
  überschreiben sich also nicht. Gesehen wird der fremde Stand über
  `holeFremdenStand()` beim `visibilitychange` (wie in `offerten/`) -- und
  der vergleicht den INHALT (`inhaltsKennung()`, ohne updatedAt/updatedBy),
  nicht den Zeitstempel: speichert nach der anderen Person auch diese hier,
  trägt die Datei deren Namen und Zeit, die fremden Zeilen stünden aber
  trotzdem nur auf dem Server (`persist()` ersetzt den lokalen Stand
  bewusst nicht). Vorher laufen `uebernimmOffeneEingabe()` und
  `await syncQueue`; bei gescheitertem Speichern (`letzteSpeicherungOk`)
  wird NICHT nachgeladen, sonst überschriebe der Server das nur lokal
  Vorhandene. Offen bleibt bewusst: dasselbe Feld gleichzeitig (der Letzte
  gewinnt) und das Fenster zwischen Holen und Schreiben -- ein `If-Match`
  bräuchte einen Worker-Deploy, `worker.js` reicht weder `If-Match` hinein
  noch `ETag` heraus.
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
- **Vorlagen aus der Preisliste `baukosten/` liegen ebenfalls auf NEXTCLOUD**
  (`_preisliste.json`, `ladePreislisteBeiBedarf()`): die
  Preisdatenbank des Büros, gehört so wenig ins Repo wie die Norm
  (`.gitignore` fängt eine Arbeitskopie ab). Sie erscheint NUR angemeldet:
  im Demomodus wird sie bewusst nicht geladen -- dort gilt weiter der grobe
  Grundkatalog aus bkp.js mit den Demodaten. FREIWILLIG: fehlt sie,
  verschwindet nur der Vorlage-Block im Bearbeitungsfenster -- jede andere
  Stelle muss ohne sie weiterfunktionieren.
- **Der Export der Preisliste wird ERST beim Öffnen des Bearbeitungsfensters
  geholt und NIE im `localStorage` abgelegt**: der echte Export ist rund
  6 MB (4242 Positionen, 12620 Optionen). Beim Start wäre das bei jedem
  Aufruf ein unnötiger Download, und im `localStorage` würde er den Platz
  sprengen, den die Schätzungen selbst fürs Offline-Arbeiten brauchen
  (`LS_KEYS.cache`). Offline gibt es deshalb keine Vorlagen -- bereits
  übernommene Optionen stehen in der Schätzung und rechnen weiter. Während
  des Ladens steht im Fenster ein Hinweis; fertig geladen zieht NUR
  `#panelVorlage` nach, nicht das ganze Fenster (sonst wäre der Fokus aus
  dem Beschrieb weg).
- **Rund 600 der 4242 Positionen der Preisliste haben GAR KEINE Optionen**
  (reine Platzhalter wie "Machbarkeitsstudien"). Eine solche Vorlage setzt
  den Kennwert NICHT auf 0, sondern lässt ihn stehen und räumt nur die
  Felder der vorherigen Vorlage weg; in der Liste steht "ohne Preis" statt
  einer Zahl. Ebenso überschreibt eine leere Einheit der Vorlage keine
  vorhandene. Beim Übernehmen werden Einheit, Beschrieb und
  Optionen als KOPIE in die Zeile geschrieben, danach hängt die Schätzung
  nicht mehr an der Datei. Der passende Knoten wird über die tiefste
  BKP-Nummer gesucht, die der Baum führt, und von dort über die
  BEZEICHNUNG weiter (`preislisteKnotenFuer()`) -- unterhalb der Gattung hat
  Preisliste Ordner mit denselben Titeln wie der Katalog. Das Suchfeld sucht
  dagegen im ganzen Baum, bewusst: wer tippt, sucht etwas Bestimmtes.
- **Optionen `baukosten/` kennen drei Arten** (`OPTION_ARTEN`: variante /
  bestandteil / zuschlag), Preisliste nur "aktiv ja/nein". Die Art wird beim
  Übernehmen aus dem Muster abgeleitet (`mitVorbelegtenArten()`) und ist
  danach pro Option umstellbar. Der Kennwert ist die Summe Preis × Menge
  über alles, was `optionZaehlt()` -- und wird NUR nachgeführt, solange
  `kennwertManuell` falsch ist. Ein von Hand getippter Kennwert setzt das
  Flag (auch aus der TABELLE, siehe `setzeFeld()`), sonst wäre er beim
  nächsten Klick auf eine Option wieder weg. Die Option-Felder laufen
  bewusst NICHT über `setzeFeld()`/`data-feld`, sondern über
  `data-opt-feld`/`aendereOption()`: sie hängen an keiner Tabellenzeile.
  `uebernimmOffeneEingabe()` kennt sie trotzdem, sonst ginge ein offenes
  Preisfeld beim Schliessen verloren.
- **Das Bearbeitungsfenster wird beim Tippen in Optionen NICHT neu gebaut**
  (`aktualisierePanelZahlen()` führt nur Zahlen, Klassen und den
  Vorlagepreis-Hinweis nach): `renderPanel()` würde den Fokus mitten im
  Preisfeld wegnehmen. Neu gebaut wird nur der Optionen-Block und nur bei
  einem Wechsel der ART (`zeichneOptionenNeu()`, die Option wandert in eine
  andere Gruppe) -- danach bekommt dasselbe Auswahlfeld den Fokus zurück.
  Deshalb muss alles, was sich beim Tippen ändern kann, IMMER im Baum
  stehen und nur ein-/ausgeblendet werden.
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
  "Innenwände", wie im Printscreen der Preisliste). "+ Unterkapitel" fragt nur
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
- **`modellviewer/` hat ZWEI Seiten mit verschiedenem Zugang**:
  `index.html`+`app.js` ist Büro-Seite mit Nextcloud-Login wie jedes andere
  Modul; `ansicht.html`+`ansicht.js` ist die Kundenseite und lädt
  `shared/common.js` BEWUSST NICHT (sonst hätte ein Kunde den
  Einstellungen-Dialog und im Demofall das gelbe Demo-Band vor sich).
  Deshalb steht `PROXY_URL` dort ein zweites Mal -- ändert sich die Adresse
  des Proxys, muss sie an beiden Stellen nach. Gemeinsam sind nur
  `viewer.js` (rendert, baut die Bedienleiste, holt NICHTS aus dem Netz --
  `ladeModell()` bekommt eine fertige Map Dateiname -> ArrayBuffer) und
  `dateien.js` (PROPFIND/GET über eine INJIZIERTE Hole-Funktion). Diese
  Trennung ist der Grund, warum beide Seiten identisch aussehen.
- **Kundenzugang über passwortgeschützten Freigabelink** (November 2026):
  pro Modell ein Nextcloud-Freigabelink mit Passwort auf den Modellordner;
  gelesen wird mit `Authorization: Basic base64(<token>:<freigabepasswort>)`
  gegen `public.php/dav/files/<token>/`, `public.php/webdav/` und
  `remote.php/dav/public-files/<token>/` (`oeffneFreigabe()` in
  `dateien.js`). Durchprobiert werden sie AUCH NACH EINEM 401 -- `public.php`
  ist ein Front-Controller und antwortet auf einen Pfad, den diese Version
  nicht kennt, mit 401 statt 404. Genau daran scheiterte die erste Fassung
  gegen die echte Nextcloud: richtiges Passwort, Meldung "Passwort stimmt
  nicht". "Passwort falsch" gilt erst, wenn irgendwo ein 401 steht und sonst
  nur 404 (`FreigabeFehler.passwortFalsch`). Basic Auth muss UTF-8 kodieren
  (`btoa()` allein wirft bei einem Passwort mit Umlaut). Nirgends liegen
  dafür Zugangsdaten.
- **Die Kundenseite fragt NICHT auf Verdacht nach dem Passwort**
  (`starte()` in `ansicht.js`): sie versucht es immer zuerst mit leerem
  Passwort. Nur wenn das mit `GRUND.passwort` scheitert, erscheint die
  Abfrage -- eine Freigabe ohne Passwort öffnet so direkt, und eine
  unbekannte Kennung meldet sich sofort, statt den Kunden erst tippen zu
  lassen.
- **Drei Gründe statt "Passwort falsch"** (`GRUND` in `dateien.js`): bevor
  die Kundenseite etwas behauptet, fragt sie ohne Zugangsdaten `s/<token>`
  ab -- 404 heisst "diese Kennung gibt es nicht" (häufigster Fall: im Feld
  steht nicht die echte Kennung). Antwortet Nextcloud mit `MaxDelayReached`
  (als HTTP 500, Ausnahme-Name steht nur im ANTWORTKÖRPER, deshalb trägt
  `HttpFehler` ihn mit), greift die Bremse gegen Passwortraten -- und die
  zählt die IP des WORKER-PROXYS, nicht die des Kunden: ein paar
  Fehlversuche bremsen also kurz alle. Erst wenn beides ausscheidet, ist es
  wirklich das Passwort.
- **"Prüfen" im Freigabe-Dialog** geht bewusst denselben Weg wie die
  Kundenseite (`oeffneFreigabe()` mit `PROXY_URL`, ohne Login) und meldet im
  Fehlerfall die Statuscodes aller Versuche. Alles andere im Modul läuft
  über den angemeldeten Zugang und kann funktionieren, während der
  Kundenweg scheitert -- eine Prüfung darüber wäre wertlos. Die Alternative
  (Worker bekommt ein eigenes App-Passwort und prüft selbst) wurde
  verworfen: Nextcloud-App-Passwörter lassen sich nicht auf einen Ordner
  einschränken, ein Worker-Fehler wäre Vollzugriff gewesen. Das weicht
  bewusst von "kein öffentlicher Freigabelink mehr" ab -- der Unterschied:
  dort stand ein Token IM REPO, hier steht die Kennung nur im Link an den
  Kunden und ist ohne Passwort wertlos. Tokens gehören weiterhin NIE ins
  Repo.
- **Freigaben legt das Modul selbst an** (OCS, `modellviewer/app.js`): die
  einzige Stelle im Repo, die nicht WebDAV spricht
  (`ocs/v2.php/apps/files_sharing/api/v1/shares`, `?format=json`, Erfolg ist
  `ocs.meta.statuscode` 100 ODER 200). Dafür musste `worker.js` POST und den
  Header `OCS-APIRequest` zulassen -- ohne den Header lehnt Nextcloud jeden
  OCS-Aufruf ab. **`worker.js` wird von Hand deployt**: läuft noch die alte
  Fassung, kommt beim Freigeben ein 405 zurück, und `freigabeFehlerText()`
  erklärt genau das. Der Pfad für `path=` ist der Pfad AB dem persönlichen
  Dateibereich (`/Buero/Admin/App/...`), nicht der DAV-Pfad -- `ncSegments()`
  mit dem Benutzernamen wäre hier falsch.
- **Freigabepasswörter stehen in `_passwoerter.json`** im MODULORDNER, also
  eine Ebene über den Modellordnern und damit ausserhalb jeder Freigabe --
  ein Kunde kann sie nicht lesen. Das ist nötig, weil Nextcloud
  Freigabepasswörter nur als Hash hält und nie wieder herausgibt; ohne diese
  Datei könnte das Büro ein einmal gesetztes Passwort nirgends nachschlagen.
  Beim Löschen eines Modells muss der Eintrag mit weg (die Freigabe selbst
  verschwindet mit dem Ordner von allein). Das Passwort ist FREIWILLIG (seit
  November 2026, ausdrücklich so gewünscht): leeres Feld = Freigabe ohne
  Passwort, `freigabeAnlegen()` lässt das Feld dann ganz weg. Gewürfelt wird
  nichts mehr. Eine Änderung wirkt beim `change`-Ereignis wie das
  Ablaufdatum; das Feld zu LEEREN entfernt den Schutz und fragt deshalb
  vorher nach (`confirm()` in `passwortUebernehmen()`). Die Statuszeile
  benennt den Zustand ausdrücklich ("Freigegeben OHNE Passwort ..."), weil
  man ihn der Freigabe sonst nicht ansieht -- Nextcloud gibt das Feld
  `password` nicht in jeder Version zurück, deshalb zählt dort auch das
  gemerkte Passwort; verlässlich ist nur "Prüfen".
- **Mindestlänge des Passworts gehört NEXTCLOUD**, nicht der App: die
  Passwortrichtlinie (Verwaltung → Sicherheit) lehnt zu kurze Passwörter mit
  OCS-Status 400/403 ab. Vom Browser aus ist das nicht umgehbar -- die App
  schreibt deshalb KEINE eigene Mindestlänge vor und zeigt stattdessen
  Nextclouds Wortlaut samt Herkunft an (`freigabeFehlerText()`). Wer kürzere
  Passwörter will, ändert die Richtlinie dort.
- **`.form-group[hidden]` braucht eine eigene CSS-Zeile** (modellviewer/,
  wie die `.bk-*[hidden]`-Regeln in baukosten/): `.form-group` aus
  `css/style.css` setzt `display: flex` und schlägt damit die eingebaute
  Browser-Regel `[hidden] { display: none }` -- ein ausgeblendeter Block
  bleibt sonst sichtbar. Gilt für jede neue Klasse mit eigenem `display`.
- **`modellviewer/app.js` ist ein ES-Modul**, läuft aber nach dem klassischen
  `shared/common.js` -- dessen `const`/`function` auf oberster Ebene sind in
  Modulen ganz normal sichtbar. Nur so lassen sich `dateien.js`/`viewer.js`
  importieren, ohne den gemeinsamen Code anzufassen. `viewer.js` (und damit
  three.js, rund 2 MB) wird erst beim Öffnen der Vorschau dynamisch geladen.
- **three.js liegt als Kopie im Repo** (`modellviewer/vendor/`, MIT; dazu der
  Draco-Decoder, Apache 2.0): kein Build-Schritt, offlinefähig, und die
  Kundenseite meldet beim Öffnen nichts an fremde Server. Aufgelöst werden
  die Importe über eine Import-Map in BEIDEN HTML-Dateien. Herkunft und
  Update-Anleitung: `modellviewer/vendor/HERKUNFT.md`. Kommt eine
  Zusatzdatei dazu, muss sie auch in `modellviewer/service-worker.js`.
- **Schnitt `modellviewer/` clippt LOKAL, nicht global**: die Ebenen hängen
  an den Materialien (`renderer.localClippingEnabled`), nicht am Renderer --
  mit globalem Clipping würde die eingeblendete Schnittfläche sich selbst
  wegschneiden, sie liegt ja genau auf der Ebene. Dazu gehört
  `material.clipShadows = true`, sonst wirft ein halbiertes Haus weiter den
  Schatten des ganzen Baukörpers. Das Bodenraster wird mitgeschnitten, der
  Boden ebenso. Die Lage des Schnitts wird in `schnittPos` MITGEFÜHRT und
  nicht aus `plane.constant` zurückgerechnet (Vorzeichenfalle: die Normale
  dreht beim Umkehren mit).
- **Norden ist -Z im `modellviewer/`** (Osten +X, oben +Y): daran hängt der
  gerechnete Sonnenstand (`sonnenstand()` in `viewer.js`, Verfahren der
  NOAA, Ort fest Zürich, Sommerzeit selbst gerechnet statt über die
  Zeitzone des Browsers -- ein Kunde kann anderswo sitzen). Die Konvention
  ist nicht frei gewählt: glTF ist auf Y-oben mit -Z nach vorne festgelegt,
  und die Z-oben-Drehung (-90° um X) macht aus dem in Schweizer Plänen nach
  Norden zeigenden +Y genau -Z. Start ist der 21. Juni, 15 Uhr -- dort steht
  die Sonne fast genau dort, wo sie früher fest eingebaut war (rund 60° hoch
  aus Südwesten); ein festes Datum statt "heute", sonst geht ein Modell im
  Dezember im Streiflicht auf. Die Einstellungen leben nur in der Sitzung,
  nichts davon steht in `modell.json`.
- **Der Schieber "Aufhellung" hängt am HIMMELSLICHT, nicht an
  `scene.environment`**: die Umgebung wirkt in three.js nur auf
  `MeshStandardMaterial` (`material.isMeshStandardMaterial ? scene.environment
  : null` im Renderer), also auf glTF. Ein OBJ bekommt vom `MTLLoader`
  Phong-Material und sieht von ihr nichts -- dort hing alles Licht
  ausserhalb der Sonne am Himmelslicht mit 0.35, und Innenräume waren
  praktisch schwarz (gemessen: Grauwert 37 von 255). Es steht deshalb neu
  bei 1.28. Wer die Helligkeit anders verteilen will, muss diesen
  Unterschied mitdenken, sonst wirkt eine Änderung nur bei der Hälfte der
  Modelle.
- **Z-oben wird NICHT geraten** (`zUp` in `modell.json`): an den blossen
  Abmessungen sind ein hohes Haus und ein liegender Baukörper nicht zu
  unterscheiden. Das Büro setzt das Häkchen beim Hochladen, glTF ist auf
  Y-oben festgelegt, viele CAD-Exporte auf Z.
- **OBJ: auf die Beidateien warten** (`warteAufBeidateien()` in `viewer.js`):
  der OBJLoader meldet "fertig", sobald die Geometrie steht -- die Texturen
  aus der `.mtl` laufen dann noch, und das Modell erscheint so lange SCHWARZ
  (zugewiesener, aber leerer Bildspeicher). Der glTF-Weg wartet selbst.
- **`demoFetch()` kennt Unterordner** (seit dem Modellviewer, der pro Modell
  einen Ordner anlegt): PROPFIND liefert im Demomodus jetzt auch
  Collections und `getcontentlength`. Die übrigen Module filtern ihre
  Ordnerlisten nach Endung und merken davon nichts -- gegen eine echte
  Nextcloud bekamen sie Unterordner ohnehin schon immer zu sehen.
- **Umbenennen auf Nextcloud**: der Worker-Proxy lässt nur
  GET/PUT/MKCOL/PROPFIND/DELETE durch (kein MOVE, kein Destination-Header).
  Eine Datei umbenennen heisst deshalb überall: erst die neue schreiben,
  dann die alte löschen (`planeUmbenennen()` in `baukosten/app.js`) — in
  dieser Reihenfolge, damit ein Abbruch höchstens eine Kopie hinterlässt.
- **Eine Pendenz, mehrere Zuständige**: `person` in `pendenzen.json` ist
  eine LISTE von Keys (ältere Dateien: ein einzelner Key -- `personenListe()`
  in `pendenzen/app.js` akzeptiert beides, geschrieben wird immer eine Liste
  oder `null`). Eine Pendenz wird NIE je Person dupliziert: es gibt einen
  Eintrag und ein Häkchen. `null` heisst "geht alle an" -- sind alle
  aktuellen Mitarbeitenden getaggt, normalisiert `normalisierePersonen()`
  genau darauf, und die Pendenz zeigt dann keinen Kürzel-Tag. `null`
  erscheint deshalb in JEDEM Personenfilter, nicht nur unter "Alle", und im
  Bearbeiten-Modus stehen alle Kürzel als gewählt da (`pendenzPersonen()`).
  "Niemand" und "alle" sind derselbe Zustand -- bewusst, eine leere Auswahl
  gibt es nicht.
- **Pendenzen aus `protokoll/`**: ein Stichpunkt trägt in `kuerzel` eine
  LISTE von Kürzeln (ältere Protokolle einen einzelnen String --
  `kuerzelListe()` akzeptiert beides, geschrieben wird immer das Array).
  Daraus entsteht GENAU EINE Pendenz je Stichpunkt mit allen Zuständigen,
  ID `protokoll:<datei>:<bullet>`. `normalisierePersonen()` ist dafür aus
  `pendenzen/app.js` kopiert (wie der ganze Pendenzen-Zugriff dort).
  `syncInternePendenzen()` führt die kurzlebigen IDs `...:<personKey>` aus
  einer Zwischenfassung wieder zusammen (erledigt nur, wenn alle es waren)
  -- diese Migration darf nicht wegfallen, solange noch `pendenzen.json`
  aus jener Fassung im Umlauf sind. `protokoll/pdf.js` bleibt eigenständig
  und normalisiert die Kürzel-Liste selbst (`kuerzelZeile()`).
- **Kilometer-Quittung `quittung/km.js`** nutzt OpenStreetMap (Nominatim,
  OSRM, OSM-Kacheln), NICHT Google Maps: die Google-APIs brauchen einen
  Schlüssel (der hier im öffentlichen Repo stünde) plus Billing, und vor
  allem käme von einem eingebetteten Google-Fenster gar kein Bild ins PDF.
  Die drei OSM-Dienste schicken CORS-Header -- nur deshalb lässt sich das
  Canvas mit `crossOrigin="anonymous"`-Kacheln auslesen (`toDataURL`). Die
  Karte wird selbst gezeichnet statt über eine Kartenbibliothek, damit genau
  das Bildschirmbild ins PDF wandert. Die Quellenangabe gehört aufs Bild
  (Lizenz). Fahrzeuge/Ansätze kommen aus `config.json` (`fahrzeuge`), mit
  eingebautem Fallback. Die Fahrt ist eine PUNKTFOLGE (`kmOrte`: Start,
  beliebig viele Zwischenstopps, Ziel) -- `routeSuchen()` nimmt die ganze
  Liste. OSRM liefert Alternativen nur bei genau zwei Punkten und auch dann
  nur, wenn es wirklich eine ähnlich gute zweite Strecke gibt (gemessen:
  Zürich -> Bönigen hat auch mit `alternatives=3` genau eine). Eine andere
  Strecke erzwingt man deshalb über einen Zwischenstopp, nicht über mehr
  Alternativen. Kurzadressen für Dateiname/Verwendungszweck kommen aus
  Nominatims `addressdetails=1` (`kurzAdresse()`) -- aus `display_name` zu
  raten geht schief, dessen erster Teil ist die Hausnummer. Tests mocken die drei Dienste -- die Mocks MÜSSEN
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
  kennt den Demomodus, alle elf funktionieren unverändert. `isConfigured()`
  ist deshalb im Demomodus `true`. Siehe README. EINZIGE Ausnahme:
  `zeigeFreigabe()` in `modellviewer/app.js` fragt `istDemo()` ab und
  blendet das Freigeben aus -- eine Nextcloud-Freigabe lässt sich nicht
  nachbilden, und ein Fehlerdialog wäre dort die schlechtere Antwort.
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
  starten leer, man kann aber Einträge anlegen. (Der Modellviewer hat seit
  November 2026 ein Beispielmodell: ein `.gltf` mit eingebetteter Geometrie
  direkt in `demo/seed.json`, also reiner Text wie alle Demodaten.)
- Schnittflächen im `modellviewer/` füllen (Stencil-Verfahren), damit ein
  Schnitt nicht hohl aussieht — bei beliebigen CAD-Exporten fehleranfällig,
  deshalb bewusst zurückgestellt.
- Freigaben im `modellviewer/` nach PROJEKT statt nach Modell bündeln (ein
  Link und ein Passwort je Kunde, Modelle lägen in `Modellviewer/<Projekt>/
  <Modell>`) — besprochen im November 2026, bewusst zurückgestellt: mit dem
  Knopf "Freigeben" ist eine Freigabe je Modell ein Klick, und so behält
  jedes Modell eigenes Passwort, eigenen Ablauf und eigenen Widerruf. Den
  ganzen Modellviewer-Ordner EINMAL freizugeben ist dagegen keine Option:
  eine Nextcloud-Freigabe hat genau ein Passwort, und jeder Kunde sähe die
  Modelle aller anderen.
- Google-Kalender-Sync für Ferien/Abwesenheiten in der Timeline (Vorschlag:
  privater iCal-Link pro Person statt volle Calendar-API/OAuth, über den
  Worker proxyen) — besprochen, aber bewusst zurückgestellt.
