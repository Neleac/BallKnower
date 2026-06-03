from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import get_playbyplay


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        game_id = parse_qs(urlparse(self.path).query).get("gameId", [""])[0]
        try:
            body = json.dumps(get_playbyplay(game_id)).encode("utf-8")
            self._send(200, body)
        except ValueError as exc:
            body = json.dumps({"error": str(exc), "playByPlayText": ""}).encode("utf-8")
            self._send(400, body)
        except Exception as exc:
            body = json.dumps({"error": str(exc), "playByPlayText": ""}).encode("utf-8")
            self._send(503, body)

    def _send(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
