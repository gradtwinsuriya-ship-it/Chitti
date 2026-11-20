from __future__ import annotations

import ast
import json
import math
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

import httpx


class ToolService:
    SEARCHABLE_SUFFIXES = {".txt", ".md", ".markdown", ".py", ".json", ".csv", ".html", ".css", ".js"}
    BINARY_SIZE_LIMIT = 512_000
    MATH_OPERATORS = {
        ast.Add: lambda left, right: left + right,
        ast.Sub: lambda left, right: left - right,
        ast.Mult: lambda left, right: left * right,
        ast.Div: lambda left, right: left / right,
        ast.FloorDiv: lambda left, right: left // right,
        ast.Mod: lambda left, right: left % right,
        ast.Pow: lambda left, right: left**right,
    }

    def __init__(
        self,
        db_path: str | Path,
        file_root: str | Path,
        weather_transport: httpx.AsyncBaseTransport | None = None,
        web_search_transport: httpx.AsyncBaseTransport | None = None,
        web_search_url: str = "",
        home_assistant_url: str = "",
        home_assistant_token: str = "",
        allowed_home_entities: set[str] | None = None,
        home_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.file_root = Path(file_root).expanduser().resolve()
        self.file_root.mkdir(parents=True, exist_ok=True)
        self.weather_transport = weather_transport
        self.web_search_transport = web_search_transport
        self.web_search_url = web_search_url.strip().rstrip("/")
        self.home_assistant_url = home_assistant_url.strip().rstrip("/")
        self.home_assistant_token = home_assistant_token
        self.allowed_home_entities = allowed_home_entities or set()
        self.home_transport = home_transport
        self.pending_home_actions: dict[str, tuple[str, str, datetime]] = {}
        with self._connect() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS reminders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task TEXT NOT NULL,
                    due_at TEXT NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )"""
            )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS email_drafts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recipient TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )"""
            )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS tool_activity (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )"""
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def calculate(self, expression: str) -> int | float:
        try:
            tree = ast.parse(expression, mode="eval")
        except SyntaxError as exc:
            raise ValueError("Enter a valid arithmetic expression.") from exc
        if sum(1 for _ in ast.walk(tree)) > 64:
            raise ValueError("Expression is too complex.")
        result = self._evaluate_node(tree.body)
        if not math.isfinite(float(result)) or abs(result) > 1e100:
            raise ValueError("Result is outside the supported range.")
        return result

    def _evaluate_node(self, node: ast.AST) -> int | float:
        if isinstance(node, ast.Constant) and type(node.value) in {int, float}:
            if abs(node.value) > 1e12:
                raise ValueError("Number is outside the supported range.")
            return node.value
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = self._evaluate_node(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and type(node.op) in self.MATH_OPERATORS:
            left = self._evaluate_node(node.left)
            right = self._evaluate_node(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > 12:
                raise ValueError("Exponent is outside the supported range.")
            try:
                result = self.MATH_OPERATORS[type(node.op)](left, right)
                if type(result) not in {int, float} or abs(float(result)) > 1e100:
                    raise ValueError("Result is outside the supported range.")
                return result
            except (ArithmeticError, OverflowError, TypeError) as exc:
                raise ValueError("Expression could not be evaluated.") from exc
        raise ValueError("Only numeric literals and basic arithmetic are supported.")

    def search_files(self, query: str, limit: int = 20) -> list[dict[str, object]]:
        term = query.strip().casefold()
        if len(term) < 2:
            raise ValueError("File search needs at least two characters.")
        matches = []
        for directory, child_dirs, filenames in os.walk(self.file_root, followlinks=False):
            child_dirs[:] = [name for name in child_dirs if not name.startswith(".")]
            for filename in filenames:
                path = Path(directory) / filename
                if path.is_symlink() or path.suffix.lower() not in self.SEARCHABLE_SUFFIXES:
                    continue
                relative_path = path.relative_to(self.file_root).as_posix()
                if term in filename.casefold():
                    matches.append({"path": relative_path, "line": 0, "snippet": "Filename match"})
                try:
                    if path.stat().st_size > self.BINARY_SIZE_LIMIT:
                        continue
                    content = path.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                for line_number, line in enumerate(content.splitlines(), 1):
                    if term in line.casefold():
                        matches.append(
                            {"path": relative_path, "line": line_number, "snippet": line.strip()[:240]}
                        )
                        if len(matches) >= limit:
                            return matches
        return matches[:limit]

    def create_reminder(self, task: str, due_at: str) -> dict[str, object]:
        task = task.strip()
        if not task:
            raise ValueError("Reminder text is required.")
        try:
            due = datetime.fromisoformat(due_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Use an ISO date and time for the reminder.") from exc
        if due.tzinfo is None:
            due = due.astimezone()
        now = datetime.now(timezone.utc)
        if due.astimezone(timezone.utc) <= now:
            raise ValueError("Reminder time must be in the future.")
        if due.astimezone(timezone.utc) > now + timedelta(days=365 * 5):
            raise ValueError("Reminder time must be within five years.")
        timestamp = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO reminders (task, due_at, created_at) VALUES (?, ?, ?)",
                (task[:500], due.isoformat(), timestamp),
            )
            reminder_id = int(cursor.lastrowid)
        return {"id": reminder_id, "task": task[:500], "due_at": due.isoformat(), "completed": False}

    def list_reminders(self) -> list[dict[str, object]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, task, due_at, completed FROM reminders ORDER BY completed, due_at"
            ).fetchall()
        return [dict(row) for row in rows]

    def complete_reminder(self, reminder_id: int) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("UPDATE reminders SET completed = 1 WHERE id = ?", (reminder_id,))
            return cursor.rowcount > 0

    def create_email_draft(self, recipient: str, subject: str, body: str) -> dict[str, object]:
        recipient = recipient.strip()
        subject = subject.strip()
        body = body.strip()
        if not recipient or not subject or not body:
            raise ValueError("Recipient, subject, and body are required.")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", recipient):
            raise ValueError("Enter a valid recipient email address.")
        if len(recipient) > 320 or len(subject) > 300 or len(body) > 20_000:
            raise ValueError("Email draft exceeds supported length limits.")
        timestamp = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO email_drafts (recipient, subject, body, created_at) VALUES (?, ?, ?, ?)",
                (recipient, subject, body, timestamp),
            )
            draft_id = int(cursor.lastrowid)
        return {"id": draft_id, "recipient": recipient, "subject": subject, "body": body, "created_at": timestamp}

    def list_email_drafts(self) -> list[dict[str, object]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, recipient, subject, body, created_at FROM email_drafts ORDER BY created_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def log_activity(self, tool: str, status: str, summary: str) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO tool_activity (tool, status, summary, created_at) VALUES (?, ?, ?, ?)",
                (tool, status, summary[:500], timestamp),
            )

    def list_activity(self, limit: int = 50) -> list[dict[str, object]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, tool, status, summary, created_at FROM tool_activity ORDER BY id DESC LIMIT ?",
                (min(max(limit, 1), 100),),
            ).fetchall()
        return [dict(row) for row in rows]

    async def weather(self, place: str) -> dict[str, object]:
        place = place.strip()
        if not place:
            raise ValueError("Enter a city or place name.")
        async with httpx.AsyncClient(timeout=15.0, transport=self.weather_transport) as client:
            geocode_response = await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": place[:100], "count": 1, "language": "en", "format": "json"},
            )
            geocode_response.raise_for_status()
            locations = geocode_response.json().get("results", [])
            if not locations:
                raise ValueError("No matching place was found.")
            location = locations[0]
            forecast_response = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": location["latitude"],
                    "longitude": location["longitude"],
                    "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
                },
            )
            forecast_response.raise_for_status()
            current = forecast_response.json().get("current", {})
        return {
            "place": ", ".join(value for value in (location.get("name"), location.get("admin1"), location.get("country")) if value),
            "temperature_c": current.get("temperature_2m"),
            "humidity_percent": current.get("relative_humidity_2m"),
            "weather_code": current.get("weather_code"),
            "wind_speed_kmh": current.get("wind_speed_10m"),
            "observed_at": current.get("time"),
            "provider": "Open-Meteo",
        }

    async def web_search(self, query: str, limit: int = 5) -> list[dict[str, str]]:
        if not self.web_search_url:
            raise RuntimeError("Configure WEB_SEARCH_URL with a SearXNG JSON search endpoint.")
        if not query.strip():
            raise ValueError("Search query is required.")
        search_url = urljoin(f"{self.web_search_url}/", "search")
        async with httpx.AsyncClient(timeout=15.0, transport=self.web_search_transport) as client:
            response = await client.get(search_url, params={"q": query[:300], "format": "json"})
            response.raise_for_status()
            results = response.json().get("results", [])
        safe_results = []
        for item in results:
            url = str(item.get("url", ""))
            if not url.startswith("https://"):
                continue
            safe_results.append(
                {
                    "title": str(item.get("title", ""))[:300],
                    "url": url[:2000],
                    "snippet": str(item.get("content", ""))[:1000],
                }
            )
            if len(safe_results) >= min(max(limit, 1), 5):
                break
        return safe_results

    def preview_home_action(self, entity_id: str, action: str) -> dict[str, object]:
        if not self.home_assistant_url or not self.home_assistant_token:
            raise RuntimeError("Home Assistant is not configured.")
        if entity_id not in self.allowed_home_entities:
            raise ValueError("That entity is not on the configured Home Assistant allowlist.")
        if action not in {"turn_on", "turn_off"} or not re.fullmatch(r"(?:light|switch)\.[a-zA-Z0-9_]+", entity_id):
            raise ValueError("Only turn_on/turn_off on allowlisted lights and switches is supported.")
        token = secrets.token_urlsafe(24)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=90)
        self.pending_home_actions[token] = (entity_id, action, expires_at)
        return {"confirmation_token": token, "entity_id": entity_id, "action": action, "expires_in_seconds": 90}

    async def execute_home_action(self, confirmation_token: str) -> dict[str, object]:
        action = self.pending_home_actions.pop(confirmation_token, None)
        if action is None:
            raise ValueError("Confirmation is invalid, expired, or already used.")
        entity_id, service, expires_at = action
        if datetime.now(timezone.utc) >= expires_at:
            raise ValueError("Confirmation has expired. Preview the action again.")
        domain = entity_id.split(".", 1)[0]
        async with httpx.AsyncClient(timeout=10.0, transport=self.home_transport) as client:
            response = await client.post(
                f"{self.home_assistant_url}/api/services/{domain}/{service}",
                headers={"Authorization": f"Bearer {self.home_assistant_token}"},
                json={"entity_id": entity_id},
            )
            response.raise_for_status()
        return {"entity_id": entity_id, "action": service, "completed": True}