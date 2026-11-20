"""Gemeinsamer Code der Abruf-Skripte: Einstellungen, API-Zugriff, JSON schreiben.

Einstellungen kommen aus Umgebungsvariablen. Lokal können sie in einer `.env`
im Projektverzeichnis stehen (Vorlage: `.env.example`); bereits gesetzte
Umgebungsvariablen haben Vorrang.

Pflicht:
  ICEHL_EMAIL, ICEHL_PASSWORD  Login eines Fantasy-Accounts
  ICEHL_API_KEY                statischer App-Schlüssel für den Login-Request

Optional:
  ICEHL_SEASON    Startjahr der Saison (Standard: aktuelle Saison, Wechsel im Juli)
  ICEHL_LEAGUE    Liga-ID (Standard: 1)
  ICEHL_BASE_URL  API-Basis-URL (nur für Tests)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
DATA_DIR = ROOT / "site" / "data"
DEFAULT_BASE_URL = "https://icehl.hokejovyzapis.cz/api/v1"
PAGE_SIZE = 50
MAX_PAGES = 200
PAUSE_SECONDS = 0.3
RETRIES = 3
USER_AGENT = "ice-fantasy-standings/1.0"


def load_env_file(path):
    """Liest KEY=WERT-Zeilen in os.environ. Bereits gesetzte Variablen bleiben.

    Unterstützt Kommentarzeilen (#), optionales `export` und Werte in
    Anführungszeichen. Kommentare hinter dem Wert gibt es bewusst nicht, weil
    ein Passwort ein # enthalten kann.
    """
    if not path.is_file():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    for number, line in enumerate(lines, start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.removeprefix("export ").partition("=")
        key, value = key.strip(), value.strip()
        if not separator or not key.isidentifier():
            sys.exit(f"{path.name}, Zeile {number}: erwartet KEY=WERT")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def current_season(today=None):
    """Startjahr der laufenden Saison; die Saison beginnt im Herbst."""
    today = today or date.today()
    return today.year if today.month >= 7 else today.year - 1


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    temp.replace(path)


class Api:
    def __init__(self, base_url, league, season):
        self.base_url = base_url.rstrip("/")
        self.league = league
        self.season = season
        self.token = None

    def call(self, method, path, token=None, body=None, params=None):
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token or self.token}",
            "User-Agent": USER_AGENT,
        }
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            url, data=data, headers=headers, method=method
        )

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

    def login(self, email, password, api_key):
        data = self.call(
            "POST", "/auth/login", api_key, {"email": email, "password": password}
        )
        token = data.get("access_token") if isinstance(data, dict) else None
        if not token:
            sys.exit("Login: Antwort enthält keinen access_token")
        self.token = token

    def paged(self, path, params):
        """Alle Seiten eines Listen-Endpunkts mit start/count."""
        for page in range(MAX_PAGES):
            rows = self.call(
                "GET",
                path,
                params={**params, "start": page * PAGE_SIZE, "count": PAGE_SIZE},
            )
            if not isinstance(rows, list):
                sys.exit(f"{path}, Seite {page}: Liste erwartet")
            yield from rows
            if len(rows) < PAGE_SIZE:
                return
            time.sleep(PAUSE_SECONDS)
        sys.exit(f"{path}: mehr als {MAX_PAGES} Seiten, Abbruch")

    def season_params(self):
        return {"league": self.league, "season": self.season}

    def fetch_teams(self):
        teams, seen = [], set()
        for row in self.paged("/fantasy/results", self.season_params()):
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
        return teams

    def fetch_rounds(self):
        rows = self.call("GET", "/leagues/part-round", params=self.season_params())
        if not isinstance(rows, list):
            sys.exit("/leagues/part-round: Liste erwartet")
        rounds = [
            {
                "round": row["round"],
                "startDate": row["startDate"],
                "endDate": row["endDate"],
            }
            for row in rows
        ]
        return sorted(rounds, key=lambda r: r["startDate"])

    def fetch_fantasy_players(self, position):
        params = {**self.season_params(), "position": position}
        return list(self.paged("/players/fantasy", params))

    def fetch_player_detail(self, player_id):
        return self.call(
            "GET",
            "/players/detail",
            params={"id": player_id, "season": self.season},
        )


@dataclass
class Settings:
    league: int
    season: int
    base_url: str


def connect():
    """Liest die Einstellungen, loggt ein und liefert die API."""
    load_env_file(ENV_FILE)

    credentials = {
        name: os.environ.get(name, "")
        for name in ("ICEHL_EMAIL", "ICEHL_PASSWORD", "ICEHL_API_KEY")
    }
    missing = [name for name, value in credentials.items() if not value]
    if missing:
        sys.exit(
            f"Fehlende Einstellungen: {', '.join(missing)} "
            f"(als Umgebungsvariable oder in {ENV_FILE.name}, siehe .env.example)"
        )

    settings = Settings(
        league=int(os.environ.get("ICEHL_LEAGUE") or 1),
        season=int(os.environ.get("ICEHL_SEASON") or current_season()),
        base_url=os.environ.get("ICEHL_BASE_URL") or DEFAULT_BASE_URL,
    )
    api = Api(settings.base_url, settings.league, settings.season)
    api.login(
        credentials["ICEHL_EMAIL"],
        credentials["ICEHL_PASSWORD"],
        credentials["ICEHL_API_KEY"],
    )
    return api


def season_label(season):
    return f"{season}/{(season + 1) % 100:02d}"
