# ICEHL Fantasy Gruppentabelle

Statische Webseite (GitHub Pages) mit der Gesamtrangliste der ICEHL Fantasy
League und einem Filter für eigene Gruppen, zum Beispiel für die Teams deiner
Freunde. Inoffizielles Fan-Projekt, nicht mit der ICE Hockey League oder win2day
verbunden.

## Funktionsweise

- Ein GitHub-Workflow holt täglich die Gesamtrangliste ([scripts/fetch_standings.py](scripts/fetch_standings.py))
  und veröffentlicht sie zusammen mit [site/](site/) auf GitHub Pages. Der
  Browser kann die API nicht direkt abfragen (CORS), deshalb der Umweg über das
  Skript.
- Die Seite hat vier Ansichten: **Gruppe** (nur deine Teams, mit
  Gruppenplatz), **Gesamt** (alle Teams, Auswahl per ☆), **Verlauf** (Punkte,
  Punktestand oder Platz deiner Teams nach jeder Spielrunde) und **Spieler**
  (Scorerpunkte bzw. Fangquote jedes Hockeyspielers je Runde, aufklappbar bis
  zum einzelnen Spiel).
- **Verlauf:** Die API kennt nur die aktuellen Gesamtpunkte. Deshalb legt jeder
  Workflow-Lauf einen Schnappschuss der Punkte auf dem Branch `data` ab
  (`<Saison>/<Zeitpunkt>.json`), sofern sich seit dem letzten etwas geändert hat. Als Endstand einer Runde gilt der letzte
  Schnappschuss zwischen ihrem letzten Tag und 12 Uhr am ersten Tag der
  nächsten Runde. Runden ohne passenden Schnappschuss werden mit der folgenden
  zusammengefasst (z. B. „R5–6“). Der Verlauf beginnt also erst mit dem ersten
  Lauf und braucht mindestens einen Lauf zwischen zwei Runden.
- **Spieler:** Die Einsätze kommen aus `/players/detail`
  ([scripts/fetch_players.py](scripts/fetch_players.py)), rund ein Aufruf pro
  Spieler. Fantasy-Punkte pro Spieler liefert die API nicht, deshalb zeigt die
  Seite echte Statistik (Tore, Assists, Plus/Minus, Paraden, Gegentore).
- **Gruppen werden nirgends gespeichert.** Sie stecken ausschließlich im Link.
  Die Adresszeile enthält immer den aktuellen Stand. Wer die Gruppe behalten
  will, setzt ein Lesezeichen oder kopiert den Link.
- Optional merkt sich der Browser die Gruppe über das Häkchen „Diese Gruppe auf
  diesem Gerät merken“ (localStorage). Ein Link hat immer Vorrang und
  überschreibt nichts.

## Gruppen-Links

Alle Parameter sind optional:

| Parameter | Bedeutung                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `name`    | Gruppenname (Standard: „Meine Gruppe“)                                                                    |
| `ids`     | Team-IDs, kommagetrennt und aufsteigend sortiert                                                          |
| `tab`     | `gruppe`, `gesamt`, `verlauf` oder `spieler` (Standard: `gruppe`, sobald Teams drin sind, sonst `gesamt`) |
| `q`       | Suchtext                                                                                                  |
| `ansicht` | Verlauf: `zuwachs` (Standard), `stand` oder `platz`                                                       |
| `pos`     | Spieler: `S` (Feldspieler, Standard), `FW`, `DE` oder `GK`                                                |

Beispiel: `https://abaumg.github.io/ice-fantasy/?name=Freunde&ids=64,259,313`

Die IDs muss niemand von Hand eintragen: Sie landen beim Markieren mit ☆
automatisch im Link. In der Suche findet `#313` das Team mit der ID 313.

## Einrichtung auf GitHub

1. **Pages:** Settings → Pages → Source: **GitHub Actions**.
2. **Secrets:** Settings → Secrets and variables → Actions → Repository secrets:

   | Name             | Inhalt                                            |
   | ---------------- | ------------------------------------------------- |
   | `ICEHL_EMAIL`    | E-Mail eines Fantasy-Accounts (am besten eigener) |
   | `ICEHL_PASSWORD` | Passwort dazu                                     |
   | `ICEHL_API_KEY`  | statischer App-Schlüssel für den Login-Request    |

3. **Starten:** Actions → „Rangliste laden und veröffentlichen“ → Run workflow.

Danach läuft der Workflow täglich um 02:00 UTC (03:00 MEZ / 04:00 MESZ) und bei
Änderungen an `site/`, `scripts/` oder am Workflow. GitHub kann geplante Läufe
verzögern und deaktiviert sie in öffentlichen Repos nach 60 Tagen ohne
Repo-Aktivität. Dann hilft „Enable workflow“ im Actions-Tab.

## Lokal entwickeln

Das Skript braucht nur die Python-Standardbibliothek.

```sh
cp .env.example .env               # Zugangsdaten eintragen (.env ist git-ignoriert)
uv run scripts/fetch_standings.py  # oder: python3 scripts/fetch_standings.py
uv run scripts/fetch_players.py    # dauert einige Minuten
python3 -m http.server -d site     # Seite unter http://localhost:8000
```

Das Skript liest die Einstellungen aus der `.env`. Bereits gesetzte
Umgebungsvariablen haben Vorrang, so funktioniert derselbe Code lokal und im
Workflow. Die Skripte schreiben nach `site/data/` (`standings.json`,
`history.json`, `players.json`), Schnappschüsse lokal nach `snapshots/`
(beides git-ignoriert).

Optional lassen sich `ICEHL_SEASON` (Startjahr, Standard: laufende Saison, Wechsel
im Juli) und `ICEHL_LEAGUE` (Standard: 1) setzen, siehe [.env.example](.env.example).

Formatierung prüfen: `npx prettier --check .` (Konfiguration in
[.prettierrc.yaml](.prettierrc.yaml)).

## Struktur

| Pfad                                                       | Inhalt                               |
| ---------------------------------------------------------- | ------------------------------------ |
| [site/](site/)                                             | Webseite (HTML, CSS, JavaScript)     |
| [scripts/fetch_standings.py](scripts/fetch_standings.py)   | Rangliste, Schnappschuss, Verlauf    |
| [scripts/fetch_players.py](scripts/fetch_players.py)       | Spieler mit Einsätzen laden          |
| [scripts/icehl.py](scripts/icehl.py)                       | Einstellungen und API-Zugriff        |
| [.github/workflows/pages.yml](.github/workflows/pages.yml) | Zeitplan, Abruf und Veröffentlichung |
| [docs/openapi.yaml](docs/openapi.yaml)                     | Beschreibung der genutzten API       |
