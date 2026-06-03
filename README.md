# BallKnower

Meta Ray-Ban Display web app for live NBA scores. The 600x600 frontend is plain HTML/CSS/JS for the glasses display, and `src/server.py` bridges the browser app to `swar/nba_api`.

## Run

Requires Python 3.10 or newer.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python src/server.py
```

Open `http://127.0.0.1:8000`.

## Controls

- D-pad left: previous game
- D-pad right: next game
- Enter/tap: refresh scores

The app refreshes scores every 30 seconds and caches the last successful scoreboard in local storage for offline fallback.

## Troubleshooting

If `/api/scoreboard` returns `503` with `Expecting value: line 1 column 1 (char 0)`, `nba_api` received an empty or non-JSON response from the NBA live scoreboard feed. The server tries the `nba_api` CDN endpoint first, then falls back to the NBA S3 mirror used in the scoreboard payload metadata.

Open these URLs from the same machine to verify the upstream feeds are reachable:

```text
https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json
https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA/liveData/scoreboard/todaysScoreboard_00.json
```

If neither returns JSON, check your network, VPN, proxy, or retry after a short wait. If the S3 URL returns JSON, restart `python server.py` from the virtualenv where `requirements.txt` was installed.
