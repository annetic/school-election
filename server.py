#!/usr/bin/env python3
"""Small LAN election server for supervised school elections.

The application intentionally uses only Python's standard library and SQLite.
Voting stations are ordinary web browsers; the administration console is only
available from the server computer itself.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
CANDIDATE_UPLOAD_DIR = UPLOAD_DIR / "candidates"
DB_PATH = DATA_DIR / "election.db"

HOST = "0.0.0.0"
PORT = int(os.environ.get("ELECTION_PORT", "8080"))
MAX_REQUEST_BODY = 24 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # photographs are resized in the admin browser
DB_LOCK = threading.RLock()
DATA_URL_RE = re.compile(r"^data:([^;,]+);base64,(.+)$", re.DOTALL)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def database():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        with conn:
            yield conn
    finally:
        conn.close()


def log_event(conn: sqlite3.Connection, kind: str, detail: str) -> None:
    conn.execute(
        "INSERT INTO events(kind, detail, created_at) VALUES (?, ?, ?)",
        (kind, detail, utc_now()),
    )


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def init_database() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    CANDIDATE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    with DB_LOCK, database() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                school_name TEXT NOT NULL,
                election_name TEXT NOT NULL,
                panel_a_title TEXT NOT NULL,
                panel_a_runnerup TEXT NOT NULL,
                panel_b_title TEXT NOT NULL,
                panel_b_runnerup TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('setup', 'open', 'paused', 'closed')),
                results_revealed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS candidates (
                id TEXT PRIMARY KEY,
                panel TEXT NOT NULL CHECK (panel IN ('a', 'b')),
                name TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                photo TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS votes (
                id TEXT PRIMARY KEY,
                panel TEXT NOT NULL CHECK (panel IN ('a', 'b')),
                candidate_id TEXT NOT NULL,
                station_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(candidate_id) REFERENCES candidates(id)
            );

            CREATE TABLE IF NOT EXISTS stations (
                id TEXT PRIMARY KEY,
                panel TEXT NOT NULL DEFAULT '',
                label TEXT NOT NULL DEFAULT '',
                last_seen TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_votes_panel_candidate
                ON votes(panel, candidate_id);
            """
        )

        # Migration support for a database created by an earlier build.
        station_columns = table_columns(conn, "stations")
        if "panel" not in station_columns:
            conn.execute("ALTER TABLE stations ADD COLUMN panel TEXT NOT NULL DEFAULT ''")
        if "election_id" not in table_columns(conn, "settings"):
            conn.execute("ALTER TABLE settings ADD COLUMN election_id TEXT NOT NULL DEFAULT ''")

        if not conn.execute("SELECT 1 FROM settings WHERE id = 1").fetchone():
            conn.execute(
                """
                INSERT INTO settings(
                    id, school_name, election_name,
                    panel_a_title, panel_a_runnerup,
                    panel_b_title, panel_b_runnerup,
                    state, results_revealed, updated_at
                ) VALUES (1, ?, ?, ?, ?, ?, ?, 'setup', 0, ?)
                """,
                (
                    "School Name",
                    "School Election",
                    "Head Boy",
                    "Assistant Head Boy",
                    "Head Girl",
                    "Assistant Head Girl",
                    utc_now(),
                ),
            )
            log_event(conn, "system", "Election created")

        conn.execute(
            "UPDATE settings SET election_id = ? WHERE election_id = ''",
            (uuid.uuid4().hex,),
        )

        # Never silently reopen a live election after restarting the server.
        current_state = conn.execute("SELECT state FROM settings WHERE id = 1").fetchone()["state"]
        if current_state == "open":
            conn.execute(
                "UPDATE settings SET state = 'paused', updated_at = ? WHERE id = 1",
                (utc_now(),),
            )
            log_event(conn, "poll", "Voting paused automatically after server restart")

        conn.commit()


def clean_text(value: object, limit: int = 100) -> str:
    text = str(value or "").strip()
    text = "".join(ch for ch in text if ch >= " " and ch != "\x7f")
    return text[:limit]


def is_local_client(client_address: tuple[str, int]) -> bool:
    host = client_address[0]
    return host in {"127.0.0.1", "::1"} or host.startswith("127.")


def settings_dict(conn: sqlite3.Connection) -> dict:
    return dict(conn.execute("SELECT * FROM settings WHERE id = 1").fetchone())


def candidate_rows(conn: sqlite3.Connection) -> list[dict]:
    return [
        dict(row)
        for row in conn.execute(
            "SELECT * FROM candidates ORDER BY panel, sort_order, created_at, name COLLATE NOCASE"
        )
    ]


def public_candidate(candidate: dict) -> dict:
    return {
        "id": candidate["id"],
        "name": candidate["name"],
        "detail": candidate["detail"],
        "photo": candidate["photo"],
    }


def panel_config(settings: dict, panel: str) -> tuple[str, str]:
    if panel == "a":
        return settings["panel_a_title"], settings["panel_a_runnerup"]
    return settings["panel_b_title"], settings["panel_b_runnerup"]


def public_state(conn: sqlite3.Connection, panel: str | None = None) -> dict:
    settings = settings_dict(conn)
    candidates = candidate_rows(conn)

    payload = {
        "schoolName": settings["school_name"],
        "electionName": settings["election_name"],
        "state": settings["state"],
        "electionId": settings["election_id"],
        "voteSoundAvailable": (STATIC_DIR / "vote.mp3").is_file(),
    }

    if panel in {"a", "b"}:
        title, runner_up = panel_config(settings, panel)
        payload["panel"] = {
            "id": panel,
            "title": title,
            "runnerUpTitle": runner_up,
            "candidates": [public_candidate(c) for c in candidates if c["panel"] == panel],
        }
    else:
        payload["panels"] = {
            "a": {
                "title": settings["panel_a_title"],
                "candidates": [public_candidate(c) for c in candidates if c["panel"] == "a"],
            },
            "b": {
                "title": settings["panel_b_title"],
                "candidates": [public_candidate(c) for c in candidates if c["panel"] == "b"],
            },
        }

    return payload


def compute_panel_results(
    conn: sqlite3.Connection, panel: str, title: str, runner_up_title: str
) -> dict:
    rows = conn.execute(
        """
        SELECT
            c.id, c.name, c.detail, c.photo, c.sort_order, c.created_at,
            COUNT(v.id) AS votes
        FROM candidates c
        LEFT JOIN votes v
          ON v.candidate_id = c.id AND v.panel = c.panel
        WHERE c.panel = ?
        GROUP BY c.id
        ORDER BY votes DESC, c.sort_order ASC, c.created_at ASC, c.name COLLATE NOCASE ASC
        """,
        (panel,),
    ).fetchall()

    ranking = [dict(row) for row in rows]
    vote_groups: list[dict] = []
    for item in ranking:
        if not vote_groups or vote_groups[-1]["votes"] != item["votes"]:
            vote_groups.append({"votes": item["votes"], "candidates": []})
        vote_groups[-1]["candidates"].append(item)

    total_votes = sum(item["votes"] for item in ranking)
    winner = vote_groups[0]["candidates"] if vote_groups and total_votes else []
    assistant: list[dict] = []
    if len(winner) == 1 and len(vote_groups) > 1:
        assistant = vote_groups[1]["candidates"]

    return {
        "panel": panel,
        "title": title,
        "runnerUpTitle": runner_up_title,
        "ranking": ranking,
        "winner": winner,
        "assistant": assistant,
        "winnerTie": len(winner) > 1,
        "assistantTie": len(assistant) > 1,
        "totalVotes": total_votes,
        "assistantPending": len(winner) > 1,
    }


def results_payload(conn: sqlite3.Connection) -> dict:
    settings = settings_dict(conn)
    published = settings["state"] == "closed" and bool(settings["results_revealed"])
    payload = {
        "schoolName": settings["school_name"],
        "electionName": settings["election_name"],
        "state": settings["state"],
        "published": published,
    }
    if published:
        payload["panelA"] = compute_panel_results(
            conn, "a", settings["panel_a_title"], settings["panel_a_runnerup"]
        )
        payload["panelB"] = compute_panel_results(
            conn, "b", settings["panel_b_title"], settings["panel_b_runnerup"]
        )
    return payload


def decode_data_url(data_url: str, allowed_types: set[str], max_bytes: int) -> tuple[str, bytes]:
    match = DATA_URL_RE.match(data_url or "")
    if not match:
        raise ValueError("Invalid upload data")

    mime = match.group(1).lower()
    if mime not in allowed_types:
        raise ValueError("Unsupported file type")

    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid base64 upload") from exc

    if not raw or len(raw) > max_bytes:
        raise ValueError("Uploaded file is too large")
    return mime, raw


def save_candidate_photo(data_url: str) -> str:
    mime, raw = decode_data_url(
        data_url,
        {"image/jpeg", "image/png", "image/webp"},
        MAX_IMAGE_BYTES,
    )
    valid = (
        (mime == "image/jpeg" and raw.startswith(b"\xff\xd8\xff") and raw.endswith(b"\xff\xd9"))
        or (mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n"))
        or (mime == "image/webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
    )
    if not valid:
        raise ValueError("Upload a valid JPEG, PNG or WebP photograph.")
    extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime]
    filename = f"{uuid.uuid4().hex}{extension}"
    path = CANDIDATE_UPLOAD_DIR / filename
    path.write_bytes(raw)
    return f"/uploads/candidates/{filename}"


def delete_candidate_photo(photo: str) -> None:
    if not photo.startswith("/uploads/candidates/"):
        return
    filename = Path(photo).name
    target = CANDIDATE_UPLOAD_DIR / filename
    try:
        target.unlink(missing_ok=True)
    except OSError:
        pass


def local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"
    finally:
        sock.close()


class ElectionHandler(SimpleHTTPRequestHandler):
    server_version = "SchoolElection/4.0"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        parsed = unquote(urlparse(path).path)
        routes = {
            "/": "vote-select.html",
            "/vote": "vote-select.html",
            "/vote/": "vote-select.html",
            "/vote/a": "vote.html",
            "/vote/a/": "vote.html",
            "/vote/b": "vote.html",
            "/vote/b/": "vote.html",
            "/admin": "admin.html",
            "/admin/": "admin.html",
            "/results": "results.html",
            "/results/": "results.html",
        }
        if parsed in routes:
            return str(STATIC_DIR / routes[parsed])

        if parsed.startswith("/uploads/"):
            target = (UPLOAD_DIR / parsed.removeprefix("/uploads/")).resolve()
            if not target.is_relative_to(CANDIDATE_UPLOAD_DIR.resolve()) or not target.is_file():
                return str(STATIC_DIR / "404")
            return str(target)

        relative = parsed.removeprefix("/static/") if parsed.startswith("/static/") else parsed.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
            return str(STATIC_DIR / "404")
        return str(target)

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path)

        if Path(self.translate_path(self.path)) == STATIC_DIR / "admin.html" and not is_local_client(self.client_address):
            self.send_error(HTTPStatus.FORBIDDEN, "Admin console is available only on the server computer.")
            return

        if path == "/api/public/state":
            value = parse_qs(urlparse(self.path).query).get("panel", [None])[0]
            panel = value if value in {"a", "b"} else None
            with database() as conn:
                self.send_json(public_state(conn, panel))
            return

        if path == "/api/public/results":
            with database() as conn:
                self.send_json(results_payload(conn))
            return

        if path == "/api/admin/state":
            if not is_local_client(self.client_address):
                self.send_json_error(HTTPStatus.FORBIDDEN, "Admin access is local only.")
                return
            with database() as conn:
                settings = settings_dict(conn)
                candidates = candidate_rows(conn)
                vote_stats = conn.execute(
                    """
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN panel = 'a' THEN 1 ELSE 0 END) AS panel_a,
                        SUM(CASE WHEN panel = 'b' THEN 1 ELSE 0 END) AS panel_b,
                        MAX(created_at) AS last_vote
                    FROM votes
                    """
                ).fetchone()
                cutoff = datetime.fromtimestamp(time.time() - 15, timezone.utc).isoformat(timespec="seconds")
                active_rows = conn.execute(
                    "SELECT panel, COUNT(*) AS total FROM stations WHERE last_seen >= ? GROUP BY panel",
                    (cutoff,),
                ).fetchall()
                active_by_panel = {"a": 0, "b": 0}
                for row in active_rows:
                    if row["panel"] in active_by_panel:
                        active_by_panel[row["panel"]] = row["total"]
                events = [
                    dict(row)
                    for row in conn.execute(
                        "SELECT * FROM events ORDER BY id DESC LIMIT 30"
                    )
                ]
                self.send_json(
                    {
                        "settings": settings,
                        "candidates": candidates,
                        "voteTotals": {
                            "all": vote_stats["total"] or 0,
                            "a": vote_stats["panel_a"] or 0,
                            "b": vote_stats["panel_b"] or 0,
                            "lastVote": vote_stats["last_vote"],
                        },
                        "activeStations": active_by_panel,
                        "lanIP": local_ip(),
                        "events": events,
                    }
                )
            return

        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        origin = self.headers.get("Origin")
        if (origin and urlparse(origin).netloc != self.headers.get("Host")) or self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_json_error(HTTPStatus.FORBIDDEN, "Requests must come from this election server.")
            return

        if path.startswith("/api/admin/") and not is_local_client(self.client_address):
            self.send_json_error(HTTPStatus.FORBIDDEN, "Admin access is local only.")
            return

        data = self.read_json_body()
        if data is None:
            return

        try:
            handlers = {
                "/api/station/ping": self.station_ping,
                "/api/vote": self.cast_vote,
                "/api/admin/settings": self.admin_update_settings,
                "/api/admin/candidate/add": self.admin_add_candidate,
                "/api/admin/candidate/update": self.admin_update_candidate,
                "/api/admin/candidate/delete": self.admin_delete_candidate,
                "/api/admin/state/change": self.admin_change_state,
                "/api/admin/results/reveal": self.admin_reveal_results,
                "/api/admin/results/hide": self.admin_hide_results,
                "/api/admin/reset": self.admin_reset_votes,
            }
            handler = handlers.get(path)
            if not handler:
                self.send_json_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
                return
            handler(data)
        except ValueError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
        except sqlite3.IntegrityError:
            self.send_json_error(HTTPStatus.CONFLICT, "That request conflicts with the current election data.")
        except Exception as exc:  # defensive boundary around the tiny HTTP server
            print("ERROR:", repr(exc))
            self.send_json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "The server could not complete that request.")

    def read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BODY:
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Invalid request size.")
            return None
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("JSON object required")
            return data
        except (UnicodeDecodeError, ValueError, OSError):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Invalid JSON request.")
            return None

    def station_ping(self, data: dict) -> None:
        station_id = clean_text(data.get("stationId"), 80)
        panel = clean_text(data.get("panel"), 1)
        label = clean_text(data.get("label"), 60)
        if not station_id or panel not in {"a", "b"}:
            raise ValueError("Invalid station")

        with DB_LOCK, database() as conn:
            conn.execute(
                """
                INSERT INTO stations(id, panel, label, last_seen)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    panel = excluded.panel,
                    label = excluded.label,
                    last_seen = excluded.last_seen
                """,
                (station_id, panel, label, utc_now()),
            )
            conn.commit()
        self.send_json({"ok": True})

    def cast_vote(self, data: dict) -> None:
        vote_id = clean_text(data.get("voteId"), 100)
        panel = clean_text(data.get("panel"), 1)
        candidate_id = clean_text(data.get("candidateId"), 80)
        station_id = clean_text(data.get("stationId"), 80)
        election_id = clean_text(data.get("electionId"), 80)
        if not vote_id or panel not in {"a", "b"} or not candidate_id or not election_id:
            raise ValueError("Invalid vote")

        with DB_LOCK, database() as conn:
            settings = settings_dict(conn)
            if election_id != settings["election_id"]:
                self.send_json_error(HTTPStatus.CONFLICT, "The election was reset. This vote was not recorded.")
                return

            # Confirm a committed request even if voting was paused or closed
            # after its first response was lost on the network.
            receipt = conn.execute("SELECT * FROM votes WHERE id = ?", (vote_id,)).fetchone()
            if receipt:
                if (receipt["panel"], receipt["candidate_id"], receipt["station_id"]) != (panel, candidate_id, station_id):
                    self.send_json_error(HTTPStatus.CONFLICT, "This vote reference belongs to another request.")
                    return
                self.send_json({"ok": True, "voteId": vote_id, "duplicate": True})
                return

            state = settings["state"]
            if state != "open":
                self.send_json_error(HTTPStatus.CONFLICT, f"Voting is {state}.")
                return

            candidate = conn.execute(
                "SELECT id, name, panel FROM candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
            if not candidate or candidate["panel"] != panel:
                raise ValueError("Candidate is not on this ballot")

            conn.execute(
                "INSERT INTO votes(id, panel, candidate_id, station_id, created_at) VALUES (?, ?, ?, ?, ?)",
                (vote_id, panel, candidate_id, station_id, utc_now()),
            )
            title, _ = panel_config(settings_dict(conn), panel)
            log_event(conn, "vote", f"Vote recorded on {title} station")
            conn.commit()

        self.send_json({"ok": True, "voteId": vote_id})

    def require_setup(self, conn: sqlite3.Connection) -> None:
        state = settings_dict(conn)["state"]
        if state != "setup":
            raise ValueError("Reset the election before changing ballot setup.")

    def admin_update_settings(self, data: dict) -> None:
        fields = {
            "schoolName": clean_text(data.get("schoolName"), 100),
            "electionName": clean_text(data.get("electionName"), 100),
            "panelATitle": clean_text(data.get("panelATitle"), 60),
            "panelARunnerup": clean_text(data.get("panelARunnerup"), 60),
            "panelBTitle": clean_text(data.get("panelBTitle"), 60),
            "panelBRunnerup": clean_text(data.get("panelBRunnerup"), 60),
        }
        if not all(value for key, value in fields.items() if key != "electionName"):
            raise ValueError("School name and all four role names are required.")

        with DB_LOCK, database() as conn:
            self.require_setup(conn)
            conn.execute(
                """
                UPDATE settings SET
                    school_name = ?, election_name = ?,
                    panel_a_title = ?, panel_a_runnerup = ?,
                    panel_b_title = ?, panel_b_runnerup = ?,
                    updated_at = ?
                WHERE id = 1
                """,
                (
                    fields["schoolName"],
                    fields["electionName"],
                    fields["panelATitle"],
                    fields["panelARunnerup"],
                    fields["panelBTitle"],
                    fields["panelBRunnerup"],
                    utc_now(),
                ),
            )
            log_event(conn, "settings", "School and role names updated")
            conn.commit()
        self.send_json({"ok": True})

    def admin_add_candidate(self, data: dict) -> None:
        panel = clean_text(data.get("panel"), 1)
        name = clean_text(data.get("name"), 80)
        detail = clean_text(data.get("detail"), 60)
        photo_data = str(data.get("photo") or "")
        if panel not in {"a", "b"} or not name:
            raise ValueError("Candidate name and panel are required.")

        photo = save_candidate_photo(photo_data) if photo_data else ""
        candidate_id = uuid.uuid4().hex
        try:
            with DB_LOCK, database() as conn:
                self.require_setup(conn)
                next_order = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM candidates WHERE panel = ?",
                    (panel,),
                ).fetchone()["n"]
                conn.execute(
                    """
                    INSERT INTO candidates(id, panel, name, detail, photo, sort_order, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (candidate_id, panel, name, detail, photo, next_order, utc_now()),
                )
                title, _ = panel_config(settings_dict(conn), panel)
                log_event(conn, "candidate", f"Added {name} to {title}")
                conn.commit()
        except Exception:
            delete_candidate_photo(photo)
            raise
        self.send_json({"ok": True, "id": candidate_id})

    def admin_update_candidate(self, data: dict) -> None:
        candidate_id = clean_text(data.get("id"), 80)
        name = clean_text(data.get("name"), 80)
        detail = clean_text(data.get("detail"), 60)
        new_photo_data = str(data.get("photo") or "")
        panel = clean_text(data.get("panel"), 1)
        remove_photo = data.get("removePhoto") is True
        if not candidate_id or not name:
            raise ValueError("Candidate name is required.")

        new_photo = save_candidate_photo(new_photo_data) if new_photo_data else None
        old_photo = ""
        try:
            with DB_LOCK, database() as conn:
                self.require_setup(conn)
                row = conn.execute("SELECT * FROM candidates WHERE id = ?", (candidate_id,)).fetchone()
                if not row:
                    raise ValueError("Candidate not found.")
                old_photo = row["photo"]
                panel_to_store = panel or row["panel"]
                if panel_to_store not in {"a", "b"}:
                    raise ValueError("Select Panel A or Panel B.")
                photo_to_store = new_photo if new_photo is not None else ("" if remove_photo else old_photo)
                sort_order = row["sort_order"]
                if panel_to_store != row["panel"]:
                    sort_order = conn.execute(
                        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM candidates WHERE panel = ?",
                        (panel_to_store,),
                    ).fetchone()["n"]
                conn.execute(
                    "UPDATE candidates SET panel = ?, name = ?, detail = ?, photo = ?, sort_order = ? WHERE id = ?",
                    (panel_to_store, name, detail, photo_to_store, sort_order, candidate_id),
                )
                log_event(conn, "candidate", f"Updated candidate {name}")
                conn.commit()
        except Exception:
            if new_photo:
                delete_candidate_photo(new_photo)
            raise

        if (new_photo is not None or remove_photo) and old_photo != new_photo:
            delete_candidate_photo(old_photo)
        self.send_json({"ok": True})

    def admin_delete_candidate(self, data: dict) -> None:
        candidate_id = clean_text(data.get("id"), 80)
        if not candidate_id:
            raise ValueError("Candidate id is required.")
        with DB_LOCK, database() as conn:
            self.require_setup(conn)
            row = conn.execute("SELECT * FROM candidates WHERE id = ?", (candidate_id,)).fetchone()
            if not row:
                raise ValueError("Candidate not found.")
            conn.execute("DELETE FROM candidates WHERE id = ?", (candidate_id,))
            log_event(conn, "candidate", f"Deleted candidate {row['name']}")
            conn.commit()
        delete_candidate_photo(row["photo"])
        self.send_json({"ok": True})

    def admin_change_state(self, data: dict) -> None:
        target = clean_text(data.get("state"), 12)
        if target not in {"open", "paused", "closed"}:
            raise ValueError("Invalid election state.")

        with DB_LOCK, database() as conn:
            current = settings_dict(conn)["state"]
            allowed = {
                "setup": {"open"},
                "open": {"paused", "closed"},
                "paused": {"open", "closed"},
                "closed": set(),
            }
            if target not in allowed[current]:
                raise ValueError(f"Cannot change election from {current} to {target}.")

            if current == "setup" and target == "open":
                counts = {
                    row["panel"]: row["total"]
                    for row in conn.execute(
                        "SELECT panel, COUNT(*) AS total FROM candidates GROUP BY panel"
                    )
                }
                if counts.get("a", 0) < 2 or counts.get("b", 0) < 2:
                    raise ValueError("Add at least two candidates to each role before opening voting.")

            conn.execute(
                "UPDATE settings SET state = ?, results_revealed = 0, updated_at = ? WHERE id = 1",
                (target, utc_now()),
            )
            label = {"open": "Voting opened", "paused": "Voting paused", "closed": "Voting closed"}[target]
            log_event(conn, "poll", label)
            conn.commit()
        self.send_json({"ok": True})

    def admin_reveal_results(self, data: dict) -> None:
        self.set_results_visibility(True)

    def admin_hide_results(self, data: dict) -> None:
        self.set_results_visibility(False)

    def set_results_visibility(self, published: bool) -> None:
        with DB_LOCK, database() as conn:
            settings = settings_dict(conn)
            if settings["state"] != "closed":
                raise ValueError("Close voting before publishing results.")
            conn.execute(
                "UPDATE settings SET results_revealed = ?, updated_at = ? WHERE id = 1",
                (int(published), utc_now()),
            )
            log_event(conn, "results", "Results published" if published else "Results unpublished")
            conn.commit()
        self.send_json({"ok": True})

    def admin_reset_votes(self, data: dict) -> None:
        if clean_text(data.get("confirm"), 30) != "RESET VOTES":
            raise ValueError("Type RESET VOTES exactly to continue.")

        with DB_LOCK, database() as conn:
            if settings_dict(conn)["state"] == "open":
                raise ValueError("Pause or close voting before resetting votes.")
            conn.execute("DELETE FROM votes")
            conn.execute("DELETE FROM stations")
            conn.execute(
                "UPDATE settings SET state = 'setup', results_revealed = 0, election_id = ?, updated_at = ? WHERE id = 1",
                (uuid.uuid4().hex, utc_now()),
            )
            log_event(conn, "reset", "All votes were cleared")
            conn.commit()
        self.send_json({"ok": True})

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass  # a disconnected station can confirm its vote by retrying

    def send_json_error(self, status: HTTPStatus, message: str) -> None:
        self.send_json({"error": message}, status)


def main() -> None:
    try:
        server = ThreadingHTTPServer((HOST, PORT), ElectionHandler)
    except OSError as exc:
        print(f"Could not start the server on port {PORT}: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    try:
        init_database()
    except Exception:
        server.server_close()
        raise
    lan = local_ip()
    print("\nSchool Election Web App")
    print("-----------------------")
    print(f"Admin console : http://localhost:{PORT}/admin")
    print(f"Role A ballot : http://{lan}:{PORT}/vote/a")
    print(f"Role B ballot : http://{lan}:{PORT}/vote/b")
    print(f"Results       : http://{lan}:{PORT}/results")
    print("\nPress Ctrl+C to stop the server.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
