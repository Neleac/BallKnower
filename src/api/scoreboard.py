from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import get_scoreboard


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            body = json.dumps(get_scoreboard()).encode("utf-8")
            self._send(200, body)
        except Exception as exc:
            body = json.dumps({"error": str(exc), "games": []}).encode("utf-8")
            self._send(503, body)

    def _send(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
