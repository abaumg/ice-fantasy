#!/usr/bin/env python3
"""Lädt die Fantasy-Gesamtrangliste und schreibt sie als JSON für die Webseite.

Zusätzlich legt jeder Lauf einen Schnappschuss der Punkte ab und berechnet
daraus den Punktestand jedes Teams nach jeder Spielrunde (Verlauf). Die API
kennt keine Historie, deshalb gibt es den Verlauf nur ab dem ersten
gespeicherten Schnappschuss.

Einstellungen siehe scripts/icehl.py. Zusätzlich optional:
  ICEHL_OUTPUT       Zieldatei Rangliste (Standard: site/data/standings.json)
  ICEHL_HISTORY      Zieldatei Verlauf (Standard: site/data/history.json)
  ICEHL_SNAPSHOTS    Ordner der Schnappschüsse (Standard: snapshots/); im
                     Workflow ein Checkout des Branches `data`
"""

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from icehl import DATA_DIR, ROOT, connect, season_label, write_json

# Spielrunden und Spiele sind österreichische Kalendertage.
try:
    LOCAL_TZ = ZoneInfo("Europe/Vienna")
except ZoneInfoNotFoundError:
    LOCAL_TZ = timezone.utc

# Ein Schnappschuss zählt als Endstand einer Runde, wenn er nach deren letztem
# Tag und vor diesem Zeitpunkt am ersten Tag der nächsten Runde entstand
# (Spiele beginnen frühestens am Nachmittag).
NEXT_ROUND_CUTOFF_HOUR = 12
SNAPSHOT_FORMAT = "%Y-%m-%dT%H%M"


def snapshot_name(moment):
    return moment.astimezone(LOCAL_TZ).strftime(SNAPSHOT_FORMAT) + ".json"


def save_snapshot(directory, season, moment, teams):
    path = directory / str(season) / snapshot_name(moment)
    write_json(path, {str(team["id"]): team["points"] for team in teams})
    return path


def load_snapshots(directory, season):
    """Alle Schnappschüsse der Saison als (Zeitpunkt, {Team-ID: Punkte})."""
    snapshots = []
    for path in sorted((directory / str(season)).glob("*.json")):
        try:
            moment = datetime.strptime(path.stem, SNAPSHOT_FORMAT)
        except ValueError:
            continue
        points = json.loads(path.read_text(encoding="utf-8"))
        snapshots.append((moment.replace(tzinfo=LOCAL_TZ), points))
    return snapshots


def round_end_snapshots(rounds, snapshots):
    """Ordnet jeder abgeschlossenen Runde den passenden Schnappschuss zu.

    Gewählt wird der letzte Schnappschuss zwischen dem Ende der Runde und dem
    Beginn der nächsten. Runden ohne passenden Schnappschuss fehlen; ihre
    Punkte stecken dann in der nächsten Runde mit Schnappschuss.
    """
    result = []
    for index, current in enumerate(rounds):
        end = date.fromisoformat(current["endDate"]) + timedelta(days=1)
        earliest = datetime.combine(end, datetime.min.time(), LOCAL_TZ)
        latest = None
        if index + 1 < len(rounds):
            start = date.fromisoformat(rounds[index + 1]["startDate"])
            latest = datetime.combine(start, datetime.min.time(), LOCAL_TZ)
            latest += timedelta(hours=NEXT_ROUND_CUTOFF_HOUR)
            latest = max(latest, earliest + timedelta(hours=NEXT_ROUND_CUTOFF_HOUR))
        candidates = [
            (moment, points)
            for moment, points in snapshots
            if moment >= earliest and (latest is None or moment < latest)
        ]
        if candidates:
            result.append((current, *candidates[-1]))
    return result


def build_history(teams, rounds, snapshots, now):
    """Punktestand jedes aktuellen Teams nach jeder Runde mit Schnappschuss.

    Ein Team, das in einem Schnappschuss fehlt, hatte noch keine Punkte (0).
    Die laufende Runde kommt als letzter Eintrag mit `live: true` dazu.
    """
    entries = round_end_snapshots(rounds, snapshots)
    columns = [
        {
            "round": current["round"],
            "startDate": current["startDate"],
            "endDate": current["endDate"],
            "snapshot": moment.isoformat(timespec="minutes"),
        }
        for current, moment, _ in entries
    ]
    tables = [points for _, _, points in entries]

    today = now.astimezone(LOCAL_TZ).date().isoformat()
    last_done = columns[-1]["round"] if columns else 0
    running = [r for r in rounds if r["round"] > last_done and r["startDate"] <= today]
    if running:
        current = running[-1]
        columns.append(
            {
                "round": current["round"],
                "startDate": current["startDate"],
                "endDate": current["endDate"],
                "snapshot": now.astimezone(LOCAL_TZ).isoformat(timespec="minutes"),
                "live": True,
            }
        )
        tables.append({str(team["id"]): team["points"] for team in teams})

    points = {
        str(team["id"]): [table.get(str(team["id"]), 0) for table in tables]
        for team in teams
    }
    return {
        "updatedAt": now.isoformat(timespec="seconds"),
        "rounds": columns,
        "points": points,
    }


def main():
    api = connect()
    output = Path(os.environ.get("ICEHL_OUTPUT") or DATA_DIR / "standings.json")
    history_output = Path(
        os.environ.get("ICEHL_HISTORY") or DATA_DIR / "history.json"
    )
    snapshot_dir = Path(os.environ.get("ICEHL_SNAPSHOTS") or ROOT / "snapshots")

    teams = api.fetch_teams()
    if not teams:
        sys.exit("Rangliste ist leer, bestehende Daten bleiben unverändert")
    teams.sort(key=lambda team: team["ranking"])
    rounds = api.fetch_rounds()

    now = datetime.now(timezone.utc)
    write_json(
        output,
        {
            "updatedAt": now.isoformat(timespec="seconds"),
            "league": api.league,
            "season": api.season,
            "teams": teams,
        },
    )
    print(f"{len(teams)} Teams, Saison {season_label(api.season)} -> {output}")

    snapshot = save_snapshot(snapshot_dir, api.season, now, teams)
    snapshots = load_snapshots(snapshot_dir, api.season)
    history = build_history(teams, rounds, snapshots, now)
    write_json(history_output, history)
    print(
        f"Schnappschuss {snapshot.name}, {len(snapshots)} gesamt, "
        f"Verlauf mit {len(history['rounds'])} Runden -> {history_output}"
    )


if __name__ == "__main__":
    main()
