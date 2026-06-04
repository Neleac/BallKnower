from __future__ import annotations

import json
import mimetypes
import re
from json import JSONDecodeError
from datetime import datetime, timedelta, timezone, tzinfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import parse_qs, urlparse
try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - Python runtime compatibility guard
    ZoneInfo = None

try:
    from nba_api.live.nba.endpoints import scoreboard
    scoreboard_import_error = None
except Exception as exc:  # pragma: no cover - reported through /api/scoreboard
    scoreboard = None
    scoreboard_import_error = exc

try:
    from nba_api.live.nba.endpoints import playbyplay
    playbyplay_import_error = None
except Exception as exc:  # pragma: no cover - reported through /api/playbyplay
    playbyplay = None
    playbyplay_import_error = exc

try:
    from nba_api.stats.endpoints import scheduleleaguev2
    scheduleleaguev2_import_error = None
except Exception as exc:  # pragma: no cover - schedule enrichment is optional
    scheduleleaguev2 = None
    scheduleleaguev2_import_error = exc


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8000
NBA_CDN_SCOREBOARD_URL = "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"
NBA_S3_SCOREBOARD_URL = "https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA/liveData/scoreboard/todaysScoreboard_00.json"
NBA_CDN_PLAYBYPLAY_URL = "https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{game_id}.json"
NBA_S3_PLAYBYPLAY_URL = "https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA/liveData/playbyplay/playbyplay_{game_id}.json"
NBA_REQUEST_HEADERS = {
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
}
SCHEDULE_CACHE_TTL = timedelta(minutes=15)
SCHEDULE_METADATA_FIELDS = (
    "seriesGameNumber",
    "seriesText",
    "gameLabel",
    "gameSubLabel",
    "gameSubtype",
    "ifNecessary",
)
_schedule_metadata_cache: dict[str, tuple[datetime, dict[str, dict[str, Any]]]] = {}


def _pacific_timezone() -> tzinfo:
    if ZoneInfo is not None:
        try:
            return ZoneInfo("America/Los_Angeles")
        except Exception:
            pass
    return timezone(timedelta(hours=-8), "PST")


PACIFIC_TZ = _pacific_timezone()


def _value(data: dict[str, Any], *keys: str, default: Any = "") -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return default


def _team(data: dict[str, Any]) -> dict[str, Any]:
    city = _value(data, "teamCity", "city")
    name = _value(data, "teamName", "name")
    code = _value(data, "teamTricode", "tricode", "teamCode", default="NBA")
    return {
        "id": _value(data, "teamId", "id"),
        "code": str(code).upper(),
        "name": name or code,
        "fullName": f"{city} {name}".strip() or code,
        "score": int(_value(data, "score", default=0) or 0),
        "wins": _value(data, "wins", default=None),
        "losses": _value(data, "losses", default=None),
    }


def _format_clock(clock: Any) -> str:
    if not clock:
        return ""

    text = str(clock).strip()
    match = re.fullmatch(r"PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", text)
    if not match:
        return text

    minutes = int(match.group(1) or 0)
    seconds = int(float(match.group(2) or 0))
    return f"{minutes}:{seconds:02d}"


def _start_time(game: dict[str, Any]) -> str:
    raw = _value(game, "gameTimeUTC", "gameTimeLocal", "gameEt")
    if not raw:
        return "TBD"
    try:
        cleaned = str(raw).replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        pacific = dt.astimezone(PACIFIC_TZ)
        return pacific.strftime("%I:%M %p").lstrip("0") + " PST"
    except Exception:
        return str(raw)


def _season_for_game_date(game_date: Any) -> str:
    parsed = None
    if game_date:
        text = str(game_date).strip().replace("Z", "+00:00")
        for candidate in (text, text[:10]):
            try:
                parsed = datetime.fromisoformat(candidate)
                break
            except ValueError:
                pass

    if parsed is None:
        parsed = datetime.now(PACIFIC_TZ)

    start_year = parsed.year - 1 if parsed.month <= 9 else parsed.year
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def _dataset_rows(data_set: Any) -> list[dict[str, Any]]:
    data = data_set.get_dict() if hasattr(data_set, "get_dict") else data_set
    if not isinstance(data, dict):
        return []

    headers = data.get("headers") or []
    rows = data.get("data") or []
    normalized = []
    for row in rows:
        if isinstance(row, dict):
            normalized.append(row)
        elif isinstance(row, list) and headers:
            normalized.append({header: row[index] if index < len(row) else "" for index, header in enumerate(headers)})
    return normalized


def _schedule_metadata_by_game_id(season: str) -> dict[str, dict[str, Any]]:
    now = datetime.now(timezone.utc)
    cached = _schedule_metadata_cache.get(season)
    if cached and now - cached[0] < SCHEDULE_CACHE_TTL:
        return cached[1]

    if scheduleleaguev2 is None:
        reason = f": {scheduleleaguev2_import_error}" if scheduleleaguev2_import_error else ""
        raise RuntimeError(f"nba_api schedule import failed{reason}")

    schedule = scheduleleaguev2.ScheduleLeagueV2(season=season, timeout=10)
    metadata: dict[str, dict[str, Any]] = {}
    for row in _dataset_rows(schedule.season_games):
        game_id = str(_value(row, "gameId")).strip()
        if not game_id:
            continue
        metadata[game_id] = {
            field: row.get(field, "")
            for field in SCHEDULE_METADATA_FIELDS
            if row.get(field, "") not in (None, "")
        }

    _schedule_metadata_cache[season] = (now, metadata)
    return metadata


def _merge_schedule_metadata(game: dict[str, Any], metadata: dict[str, Any]) -> None:
    if not metadata:
        return

    for field in SCHEDULE_METADATA_FIELDS:
        current = game.get(field, "")
        incoming = metadata.get(field, "")
        if incoming in (None, ""):
            continue
        if field == "seriesGameNumber" and str(incoming).strip() == "0":
            continue
        if current in (None, "", 0, "0"):
            game[field] = incoming


def _enrich_series_metadata(games: list[dict[str, Any]], game_date: Any) -> None:
    if not games:
        return

    try:
        season = _season_for_game_date(game_date)
        schedule_metadata = _schedule_metadata_by_game_id(season)
    except Exception as exc:
        print(f"Schedule metadata unavailable: {exc}")
        return

    for game in games:
        game_id = str(game.get("gameId", "")).strip()
        _merge_schedule_metadata(game, schedule_metadata.get(game_id, {}))


def _normalize_game(game: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    arena = game.get("arena") or {}
    if isinstance(arena, dict):
        arena_name = _value(arena, "arenaName", "name")
    else:
        arena_name = ""

    away = _team(game.get("awayTeam") or {})
    home = _team(game.get("homeTeam") or {})

    return {
        "gameId": _value(game, "gameId", "id"),
        "status": int(_value(game, "gameStatus", default=0) or 0),
        "statusText": _value(game, "gameStatusText", default="Scheduled"),
        "period": int(_value(game, "period", default=0) or 0),
        "clock": _format_clock(_value(game, "gameClock", "clock")),
        "startTime": _start_time(game),
        "seriesGameNumber": _value(game, "seriesGameNumber", default=""),
        "seriesText": _value(game, "seriesText", default=""),
        "gameLabel": _value(game, "gameLabel", default=""),
        "gameSubLabel": _value(game, "gameSubLabel", default=""),
        "gameSubtype": _value(game, "gameSubtype", default=""),
        "ifNecessary": _value(game, "ifNecessary", default=""),
        "arena": arena_name,
        "away": away,
        "home": home,
        "fetchedAt": fetched_at,
    }


def _fetch_json_url(url: str) -> dict[str, Any]:
    request = Request(url, headers=NBA_REQUEST_HEADERS)
    try:
        with urlopen(request, timeout=10) as response:
            status = response.status
            body = response.read()
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:240].strip()
        raise RuntimeError(f"HTTP {exc.code} from {url}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Unable to reach {url}: {exc.reason}") from exc

    text = body.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except JSONDecodeError as exc:
        sample = text[:240].strip()
        raise RuntimeError(f"HTTP {status} from {url}, but response was not JSON: {sample}") from exc


def _load_scoreboard_payload() -> tuple[dict[str, Any], str]:
    try:
        board = scoreboard.ScoreBoard()
        return board.get_dict(), "nba_api.live.nba.endpoints.scoreboard.ScoreBoard"
    except JSONDecodeError as exc:
        print(f"nba_api CDN parse error, trying NBA S3 fallback: {exc}")
        payload = _fetch_json_url(NBA_S3_SCOREBOARD_URL)
        return payload, "nba_api live scoreboard fallback via NBA S3 mirror"


def _load_playbyplay_payload(game_id: str) -> tuple[dict[str, Any], str]:
    try:
        game_playbyplay = playbyplay.PlayByPlay(game_id)
        return game_playbyplay.get_dict(), "nba_api.live.nba.endpoints.playbyplay.PlayByPlay"
    except JSONDecodeError as exc:
        print(f"nba_api play-by-play CDN parse error, trying NBA S3 fallback: {exc}")
        payload = _fetch_json_url(NBA_S3_PLAYBYPLAY_URL.format(game_id=game_id))
        return payload, "nba_api live play-by-play fallback via NBA S3 mirror"


def _normalize_action(action: dict[str, Any]) -> dict[str, Any] | None:
    description = str(_value(action, "description")).strip()
    if not description:
        return None

    try:
        period = int(_value(action, "period", default=0) or 0)
    except (TypeError, ValueError):
        period = 0

    return {
        "actionNumber": _value(action, "actionNumber", default=None),
        "orderNumber": _value(action, "orderNumber", default=None),
        "period": period,
        "clock": _format_clock(_value(action, "clock")),
        "description": description,
        "teamTricode": _value(action, "teamTricode"),
        "scoreAway": _value(action, "scoreAway"),
        "scoreHome": _value(action, "scoreHome"),
        "actionType": _value(action, "actionType"),
        "subType": _value(action, "subType"),
    }


def _play_text(action: dict[str, Any] | None) -> str:
    if not action:
        return ""

    prefix = ""
    if action["period"] and action["clock"]:
        prefix = f"Q{action['period']} {action['clock']}"
    elif action["period"]:
        prefix = f"Q{action['period']}"
    elif action["clock"]:
        prefix = action["clock"]

    return f"{prefix} {action['description']}".strip()


def get_scoreboard() -> dict[str, Any]:
    if scoreboard is None:
        reason = f": {scoreboard_import_error}" if scoreboard_import_error else ""
        raise RuntimeError(f"nba_api import failed{reason}. Run: pip install -r requirements.txt")

    fetched_at = datetime.now(timezone.utc).isoformat()
    try:
        payload, source = _load_scoreboard_payload()
    except RuntimeError:
        raise
    except JSONDecodeError as exc:
        raise RuntimeError(
            "nba_api received a non-JSON response from the NBA live scoreboard feed. "
            f"Check that this machine can open {NBA_CDN_SCOREBOARD_URL} or {NBA_S3_SCOREBOARD_URL}. "
            f"Original parse error: {exc}"
        ) from exc

    games = payload.get("scoreboard", {}).get("games", [])

    normalized = [_normalize_game(game, fetched_at) for game in games]
    _enrich_series_metadata(normalized, payload.get("scoreboard", {}).get("gameDate"))
    normalized.sort(key=lambda game: (game["status"] != 2, game["startTime"], game["gameId"]))

    return {
        "source": source,
        "fetchedAt": fetched_at,
        "gameDate": payload.get("scoreboard", {}).get("gameDate"),
        "games": normalized,
    }


def get_playbyplay(game_id: str) -> dict[str, Any]:
    game_id = str(game_id or "").strip()
    if not game_id:
        raise ValueError("gameId is required")

    if playbyplay is None:
        reason = f": {playbyplay_import_error}" if playbyplay_import_error else ""
        raise RuntimeError(f"nba_api play-by-play import failed{reason}. Run: pip install -r requirements.txt")

    fetched_at = datetime.now(timezone.utc).isoformat()
    try:
        payload, source = _load_playbyplay_payload(game_id)
    except RuntimeError:
        raise
    except JSONDecodeError as exc:
        raise RuntimeError(
            "nba_api received a non-JSON response from the NBA live play-by-play feed. "
            f"Check that this machine can open {NBA_CDN_PLAYBYPLAY_URL.format(game_id=game_id)} "
            f"or {NBA_S3_PLAYBYPLAY_URL.format(game_id=game_id)}. "
            f"Original parse error: {exc}"
        ) from exc

    actions = payload.get("game", {}).get("actions", [])
    normalized = [
        normalized_action
        for action in actions
        if isinstance(action, dict)
        for normalized_action in [_normalize_action(action)]
        if normalized_action
    ]
    latest_action = normalized[-1] if normalized else None

    return {
        "source": source,
        "gameId": game_id,
        "fetchedAt": fetched_at,
        "latestAction": latest_action,
        "playByPlayText": _play_text(latest_action),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/scoreboard":
            self._send_scoreboard()
            return
        if parsed.path == "/api/playbyplay":
            self._send_playbyplay(parsed.query)
            return

        self._send_static(parsed.path)

    def _send_scoreboard(self) -> None:
        try:
            body = json.dumps(get_scoreboard()).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
        except Exception as exc:
            print(f"Scoreboard error: {exc}")
            body = json.dumps({"error": str(exc), "games": []}).encode("utf-8")
            self._send(503, body, "application/json; charset=utf-8")

    def _send_playbyplay(self, query: str) -> None:
        game_id = parse_qs(query).get("gameId", [""])[0]
        try:
            body = json.dumps(get_playbyplay(game_id)).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
        except ValueError as exc:
            body = json.dumps({"error": str(exc), "playByPlayText": ""}).encode("utf-8")
            self._send(400, body, "application/json; charset=utf-8")
        except Exception as exc:
            print(f"Play-by-play error: {exc}")
            body = json.dumps({"error": str(exc), "playByPlayText": ""}).encode("utf-8")
            self._send(503, body, "application/json; charset=utf-8")

    def _send_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        target = (ROOT / relative).resolve()
        if ROOT not in target.parents and target != ROOT:
            self._send(403, b"Forbidden", "text/plain; charset=utf-8")
            return
        if not target.is_file():
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), content_type)

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        print("%s - %s" % (self.address_string(), format % args))


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"BallKnower serving on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
