#!/usr/bin/env python3
"""Lädt die Fantasy-Gesamtrangliste und schreibt sie als JSON für die Webseite.

Zugangsdaten kommen aus Umgebungsvariablen (nie ins Repo schreiben):
  ICEHL_EMAIL, ICEHL_PASSWORD  Login eines Fantasy-Accounts
  ICEHL_API_KEY                statischer App-Schlüssel für den Login-Request

Optional:
  ICEHL_SEASON    Startjahr der Saison (Standard: aktuelle Saison, Wechsel im Juli)
  ICEHL_LEAGUE    Liga-ID (Standard: 1)
  ICEHL_OUTPUT    Zieldatei (Standard: site/data/standings.json)
  ICEHL_BASE_URL  API-Basis-URL (nur für Tests)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

BASE_URL = os.environ.get(
    "ICEHL_BASE_URL", "https://icehl.hokejovyzapis.cz/api/v1"
).rstrip("/")
LEAGUE = int(os.environ.get("ICEHL_LEAGUE", "1"))
OUTPUT = Path(os.environ.get("ICEHL_OUTPUT", "site/data/standings.json"))
PAGE_SIZE = 50
MAX_PAGES = 200
PAUSE_SECONDS = 0.3
RETRIES = 3
USER_AGENT = "ice-fantasy-standings/1.0"


def current_season(today=None):
    """Startjahr der laufenden Saison; die Saison beginnt im Herbst."""
    today = today or date.today()
    return today.year if today.month >= 7 else today.year - 1


def call(method, path, token, body=None, params=None):
    url = BASE_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": USER_AGENT,
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)

    for attempt in range(1, RETRIES + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # 4xx ist endgültig (z. B. falsche Zugangsdaten), nur 5xx wiederholen.
            if error.code < 500 or attempt == RETRIES:
                sys.exit(f"{method} {path}: HTTP {error.code}")
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == RETRIES:
                sys.exit(f"{method} {path}: {error}")
        time.sleep(2**attempt)


def login(email, password, api_key):
    data = call("POST", "/auth/login", api_key, {"email": email, "password": password})
    token = data.get("access_token") if isinstance(data, dict) else None
    if not token:
        sys.exit("Login: Antwort enthält keinen access_token")
    return token


def fetch_teams(token, season):
    teams, seen = [], set()
    for page in range(MAX_PAGES):
        rows = call(
            "GET",
            "/fantasy/results",
            token,
            params={
                "league": LEAGUE,
                "season": season,
                "start": page * PAGE_SIZE,
                "count": PAGE_SIZE,
            },
        )
        if not isinstance(rows, list):
            sys.exit(f"Seite {page}: Liste erwartet")
        for row in rows:
            if row["id"] not in seen:
                seen.add(row["id"])
                teams.append(
                    {
                        "id": row["id"],
                        "name": row["name"],
                        "points": row["points"],
                        "ranking": row["ranking"],
                    }
                )
        if len(rows) < PAGE_SIZE:
            return teams
        time.sleep(PAUSE_SECONDS)
    sys.exit(f"Mehr als {MAX_PAGES} Seiten, Abbruch")


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    temp.replace(path)


def main():
    credentials = {
        name: os.environ.get(name, "")
        for name in ("ICEHL_EMAIL", "ICEHL_PASSWORD", "ICEHL_API_KEY")
    }
    missing = [name for name, value in credentials.items() if not value]
    if missing:
        sys.exit(f"Fehlende Umgebungsvariablen: {', '.join(missing)}")

    season = int(os.environ.get("ICEHL_SEASON") or current_season())
    token = login(
        credentials["ICEHL_EMAIL"],
        credentials["ICEHL_PASSWORD"],
        credentials["ICEHL_API_KEY"],
    )
    teams = fetch_teams(token, season)
    if not teams:
        sys.exit("Rangliste ist leer, bestehende Daten bleiben unverändert")

    teams.sort(key=lambda team: team["ranking"])
    write_json(
        OUTPUT,
        {
            "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "league": LEAGUE,
            "season": season,
            "teams": teams,
        },
    )
    print(f"{len(teams)} Teams, Saison {season}/{(season + 1) % 100:02d} -> {OUTPUT}")


if __name__ == "__main__":
    main()
