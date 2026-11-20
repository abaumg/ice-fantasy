#!/usr/bin/env python3
"""Lädt alle Fantasy-Spieler mit ihren Spielen und schreibt sie als JSON.

Pro Spieler kommen die Einsätze der Saison aus `/players/detail` (Tore,
Assists, Plus/Minus, bei Goalies Paraden und Gegentore). Die Webseite ordnet
sie den Spielrunden zu. Fantasy-Punkte pro Spieler liefert die API nicht.

Einstellungen siehe scripts/icehl.py. Zusätzlich optional:
  ICEHL_PLAYERS  Zieldatei (Standard: site/data/players.json)
"""

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from icehl import DATA_DIR, PAUSE_SECONDS, connect, season_label, write_json

POSITIONS = ("GK", "DE", "FW")


def opponent(match, team_id):
    home, visitor = match.get("home") or {}, match.get("visitor") or {}
    is_home = home.get("id") == team_id
    other = visitor if is_home else home
    return is_home, other.get("shortcut") or other.get("name") or "?"


def compact_match(match, team_id, goalie):
    """Ein Einsatz mit kurzen Schlüsseln, damit die Datei klein bleibt."""
    is_home, opp = opponent(match, team_id)
    own, other = match.get("home_score"), match.get("visitor_score")
    if not is_home:
        own, other = other, own
    row = {
        "d": match["date"],
        "o": opp,
        "h": 1 if is_home else 0,
        "r": f"{own}:{other}" + {"KP": " n.V.", "KN": " n.P."}.get(
            match.get("actual_time"), ""
        ),
        "toi": match.get("time_on_ice") or 0,
        "a": match.get("assist") or 0,
        "pim": match.get("penalty_minutes") or 0,
    }
    if goalie:
        row["ga"] = match.get("goals_against") or 0
        row["sv"] = match.get("saves") or 0
    else:
        row["g"] = match.get("goals") or 0
        row["pm"] = (match.get("positives") or 0) - (match.get("negatives") or 0)
        row["s"] = match.get("shots") or 0
    return row


def played(match, league):
    event = match.get("event") or {}
    if event.get("id") not in (None, league):
        return False
    return match.get("home_score") is not None and match.get("date")


def main():
    api = connect()
    output = Path(os.environ.get("ICEHL_PLAYERS") or DATA_DIR / "players.json")

    roster = {}
    for position in POSITIONS:
        for row in api.fetch_fantasy_players(position):
            roster.setdefault(row["playerId"], row)
    if not roster:
        sys.exit("Keine Spieler gefunden, bestehende Daten bleiben unverändert")

    players = []
    for number, row in enumerate(roster.values(), start=1):
        detail = api.fetch_player_detail(row["playerId"])
        goalie = row["position"] == "GK"
        team_id = detail.get("team_id", row["teamId"]) if detail else row["teamId"]
        matches = (detail or {}).get("matches") or []
        games = [
            compact_match(match, team_id, goalie)
            for match in matches
            if played(match, api.league)
        ]
        games.sort(key=lambda game: game["d"])
        players.append(
            {
                "id": row["playerId"],
                "name": f"{row['firstName']} {row['lastName']}".strip(),
                "team": row["teamShortcut"],
                "pos": row["position"],
                "price": row["fantasyPrice"],
                "games": games,
            }
        )
        if number % 50 == 0:
            print(f"{number}/{len(roster)} Spieler geladen")
        time.sleep(PAUSE_SECONDS)

    write_json(
        output,
        {
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "season": api.season,
            "rounds": api.fetch_rounds(),
            "players": players,
        },
    )
    print(f"{len(players)} Spieler, Saison {season_label(api.season)} -> {output}")


if __name__ == "__main__":
    main()
