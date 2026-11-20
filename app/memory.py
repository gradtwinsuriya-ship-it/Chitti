from __future__ import annotations

import asyncio
import json
import math
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx


class EmbeddingProvider:
    def __init__(self, base_url: str, model: str, api_key: str = "", timeout_seconds: float = 45.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self._client: httpx.AsyncClient | None = None
        self._client_lock = asyncio.Lock()

    async def close(self) -> None:
        async with self._client_lock:
            if self._client is not None:
                await self._client.aclose()
                self._client = None

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        async with self._client_lock:
            if self._client is None or self._client.is_closed:
                self._client = httpx.AsyncClient(timeout=self.timeout_seconds)
            client = self._client
        response = await client.post(
            f"{self.base_url}/embeddings",
            headers=headers,
            json={"model": self.model, "input": texts},
        )
        response.raise_for_status()
        payload = response.json()
        if "embeddings" in payload:
            vectors = payload["embeddings"]
        else:
            vectors = [item["embedding"] for item in payload["data"]]
        if len(vectors) != len(texts) or any(not vector for vector in vectors):
            raise ValueError("The embedding provider returned an unexpected response.")
        return [[float(value) for value in vector] for vector in vectors]


def chunk_text(text: str, max_chars: int = 1200, overlap: int = 160) -> list[str]:
    normalized = "\n".join(line.strip() for line in text.splitlines()).strip()
    if not normalized:
        return []
    if max_chars <= overlap:
        raise ValueError("max_chars must be greater than overlap")

    chunks = []
    start = 0
    while start < len(normalized):
        end = min(start + max_chars, len(normalized))
        if end < len(normalized):
            boundary = normalized.rfind("\n", start + max_chars // 2, end)
            if boundary > start:
                end = boundary
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == len(normalized):
            break
        start = max(end - overlap, start + 1)
    return chunks


class MemoryStore:
    """Small local vector store for personal memories and document chunks."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS entries (
                    id TEXT PRIMARY KEY,
                    group_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('memory', 'document')),
                    source TEXT NOT NULL,
                    content TEXT NOT NULL,
                    embedding TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )"""
            )
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(entries)")}
            if "group_id" not in columns:
                connection.execute("ALTER TABLE entries ADD COLUMN group_id TEXT")
                connection.execute("UPDATE entries SET group_id = id WHERE group_id IS NULL")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def add(
        self,
        kind: str,
        source: str,
        chunks: list[str],
        embeddings: list[list[float]],
    ) -> list[str]:
        if kind not in {"memory", "document"}:
            raise ValueError("Unsupported memory entry type")
        if len(chunks) != len(embeddings):
            raise ValueError("Each chunk must have one embedding")
        created_at = datetime.now(timezone.utc).isoformat()
        group_id = str(uuid.uuid4())
        entries = [
            (str(uuid.uuid4()), group_id, kind, source, chunk, json.dumps(vector), created_at)
            for chunk, vector in zip(chunks, embeddings)
            if chunk.strip() and vector
        ]
        with self._connect() as connection:
            connection.executemany(
                "INSERT INTO entries (id, group_id, kind, source, content, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                entries,
            )
        return [entry[0] for entry in entries]

    def search(
        self,
        embedding: list[float],
        limit: int = 4,
        kind: str | None = None,
    ) -> list[dict[str, object]]:
        if not embedding or limit <= 0:
            return []
        if kind is not None and kind not in {"memory", "document"}:
            raise ValueError("Unsupported memory entry type")
        query = "SELECT id, kind, source, content, embedding, created_at FROM entries"
        parameters: tuple[str, ...] = ()
        if kind is not None:
            query += " WHERE kind = ?"
            parameters = (kind,)
        with self._connect() as connection:
            rows = connection.execute(query, parameters).fetchall()

        matches = []
        for row in rows:
            stored_embedding = json.loads(row["embedding"])
            similarity = self._cosine_similarity(embedding, stored_embedding)
            matches.append(
                {
                    "id": row["id"],
                    "kind": row["kind"],
                    "source": row["source"],
                    "content": row["content"],
                    "created_at": row["created_at"],
                    "score": similarity,
                }
            )
        matches.sort(key=lambda item: float(item["score"]), reverse=True)
        return matches[:limit]

    @staticmethod
    def _cosine_similarity(left: list[float], right: list[float]) -> float:
        if len(left) != len(right):
            return 0.0
        left_norm = math.sqrt(sum(value * value for value in left))
        right_norm = math.sqrt(sum(value * value for value in right))
        if left_norm == 0 or right_norm == 0:
            return 0.0
        return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)

    def list_entries(self) -> list[dict[str, str]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, kind, source, content, created_at FROM entries ORDER BY created_at DESC, id"
            ).fetchall()
        return [dict(row) for row in rows]

    def delete(self, entry_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            return cursor.rowcount > 0

    def delete_latest_memory(self) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT group_id FROM entries WHERE kind = 'memory' ORDER BY created_at DESC, id DESC LIMIT 1"
            ).fetchone()
            if row is None:
                return False
            connection.execute("DELETE FROM entries WHERE group_id = ?", (row["group_id"],))
            return True

    def clear(self) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM entries")

    def count(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM entries").fetchone()[0])

    def export(self) -> list[dict[str, str]]:
        return self.list_entries()