from __future__ import annotations

import asyncio
import json
import math
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import quote

import httpx

from app.memory import chunk_text


WIKIPEDIA_SOURCES = {
    "wikipedia_en": {"name": "Wikipedia (English)", "language": "en", "license": "CC BY-SA 4.0"},
    "wikipedia_ta": {"name": "Wikipedia (Tamil)", "language": "ta", "license": "CC BY-SA 4.0"},
    "wikipedia_hi": {"name": "Wikipedia (Hindi)", "language": "hi", "license": "CC BY-SA 4.0"},
}
INJECTION_SENTENCE = re.compile(
    r"\b(ignore|disregard|override)\b.*\b(previous|above|system|developer)\b.*\b(instruction|prompt)s?\b"
    r"|\b(reveal|print|expose)\b.*\b(system|hidden)\b.*\b(prompt|instruction)s?\b",
    re.IGNORECASE,
)


def filter_instruction_text(text: str) -> str:
    sentences = re.split(r"(?<=[.!?।])\s+", text)
    return " ".join(sentence for sentence in sentences if not INJECTION_SENTENCE.search(sentence)).strip()


class KnowledgeStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS knowledge_sources (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    language TEXT NOT NULL,
                    license TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    last_updated TEXT,
                    retrieval_count INTEGER NOT NULL DEFAULT 0
                )"""
            )
            connection.execute(
                """CREATE TABLE IF NOT EXISTS knowledge_chunks (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    embedding TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(source_id, url, chunk_index)
                )"""
            )
            connection.execute("CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(source_id)")
            connection.executemany(
                """INSERT OR IGNORE INTO knowledge_sources (id, name, language, license)
                   VALUES (?, ?, ?, ?)""",
                [
                    (source_id, source["name"], source["language"], source["license"])
                    for source_id, source in WIKIPEDIA_SOURCES.items()
                ],
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def list_sources(self) -> list[dict[str, object]]:
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT s.id, s.name, s.language, s.license, s.enabled, s.last_updated,
                          s.retrieval_count, COUNT(c.id) AS indexed_chunks,
                          COALESCE(SUM(length(c.content) + length(c.embedding)), 0) AS indexed_bytes
                   FROM knowledge_sources AS s LEFT JOIN knowledge_chunks AS c ON c.source_id = s.id
                   GROUP BY s.id ORDER BY s.name"""
            ).fetchall()
        return [dict(row) for row in rows]

    def set_enabled(self, source_id: str, enabled: bool) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE knowledge_sources SET enabled = ? WHERE id = ?",
                (int(enabled), source_id),
            )
            return cursor.rowcount > 0

    def add_pages(
        self,
        source_id: str,
        pages: list[dict[str, object]],
        embed: Callable[[list[str]], list[list[float]]],
    ) -> int:
        if source_id not in WIKIPEDIA_SOURCES:
            raise ValueError("Unknown knowledge source")
        source = WIKIPEDIA_SOURCES[source_id]
        records = []
        texts = []
        updated_at = datetime.now(timezone.utc).isoformat()
        for page in pages:
            title = str(page.get("title", "")).strip()
            content = filter_instruction_text(str(page.get("extract", "")))
            if not title or not content:
                continue
            url = f"https://{source['language']}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"
            for index, chunk in enumerate(chunk_text(content, max_chars=1000, overlap=120)):
                records.append((title, url, index, chunk, updated_at))
                texts.append(chunk)

        if not records:
            self.mark_updated(source_id, updated_at)
            return 0
        vectors = embed(texts)
        if len(vectors) != len(records):
            raise ValueError("Each knowledge chunk must have one embedding")

        with self._connect() as connection:
            for url in {record[1] for record in records}:
                connection.execute(
                    "DELETE FROM knowledge_chunks WHERE source_id = ? AND url = ?",
                    (source_id, url),
                )
            for record, vector in zip(records, vectors):
                title, url, index, content, timestamp = record
                connection.execute(
                    """INSERT INTO knowledge_chunks
                       (id, source_id, title, url, chunk_index, content, embedding, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(source_id, url, chunk_index) DO UPDATE SET
                           title = excluded.title, content = excluded.content,
                           embedding = excluded.embedding, updated_at = excluded.updated_at""",
                    (f"{source_id}:{url}:{index}", source_id, title, url, index, content, json.dumps(vector), timestamp),
                )
            connection.execute(
                "UPDATE knowledge_sources SET last_updated = ? WHERE id = ?",
                (updated_at, source_id),
            )
        return len(records)

    def mark_updated(self, source_id: str, timestamp: str | None = None) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE knowledge_sources SET last_updated = ? WHERE id = ?",
                (timestamp or datetime.now(timezone.utc).isoformat(), source_id),
            )

    def count_enabled_chunks(self) -> int:
        with self._connect() as connection:
            return int(
                connection.execute(
                    """SELECT COUNT(*) FROM knowledge_chunks AS c
                       JOIN knowledge_sources AS s ON s.id = c.source_id WHERE s.enabled = 1"""
                ).fetchone()[0]
            )

    def search(self, embedding: list[float], limit: int = 4) -> list[dict[str, object]]:
        if not embedding or limit <= 0:
            return []
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT c.id, c.title, c.url, c.content, c.embedding, c.updated_at, s.id AS source_id,
                          s.name AS source, s.language, s.license
                   FROM knowledge_chunks AS c JOIN knowledge_sources AS s ON s.id = c.source_id
                   WHERE s.enabled = 1"""
            ).fetchall()
            ranked = []
            for row in rows:
                score = self._cosine_similarity(embedding, json.loads(row["embedding"]))
                ranked.append(
                    {
                        "id": row["id"],
                        "kind": "knowledge",
                        "source_id": row["source_id"],
                        "source": row["source"],
                        "title": row["title"],
                        "url": row["url"],
                        "license": row["license"],
                        "language": row["language"],
                        "content": row["content"],
                        "updated_at": row["updated_at"],
                        "score": score,
                    }
                )
            ranked.sort(key=lambda item: float(item["score"]), reverse=True)
            matches = ranked[:limit]
            for source_id in {str(match["source_id"]) for match in matches}:
                connection.execute(
                    "UPDATE knowledge_sources SET retrieval_count = retrieval_count + 1 WHERE id = ?",
                    (source_id,),
                )
        return matches

    def _cosine_similarity(self, left: list[float], right: list[float]) -> float:
        if len(left) != len(right):
            return 0.0
        left_norm = math.sqrt(sum(value * value for value in left))
        right_norm = math.sqrt(sum(value * value for value in right))
        if left_norm == 0 or right_norm == 0:
            return 0.0
        return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


class WikipediaIngestor:
    def __init__(
        self,
        store: KnowledgeStore,
        embedding_provider: object,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.store = store
        self.embedding_provider = embedding_provider
        self.transport = transport
        self._request_lock = asyncio.Lock()
        self._last_request = 0.0

    async def ingest(self, query: str, language: str, limit: int = 3) -> dict[str, object]:
        source_id = f"wikipedia_{language}"
        if source_id not in WIKIPEDIA_SOURCES:
            raise ValueError("Choose English, Tamil, or Hindi")
        source = next(item for item in self.store.list_sources() if item["id"] == source_id)
        if not source["enabled"]:
            raise ValueError("Enable this source before indexing it")
        pages = await self._search_pages(query, language, min(max(limit, 1), 5))
        valid_pages = [page for page in pages if str(page.get("extract", "")).strip()]
        chunks = []
        for page in valid_pages:
            chunks.extend(chunk_text(str(page["extract"]), max_chars=1000, overlap=120))
        try:
            vectors = await self.embedding_provider.embed(chunks)
        except Exception as exc:
            raise RuntimeError("The configured embedding provider is unavailable") from exc
        if chunks:
            count = self.store.add_pages(source_id, valid_pages, lambda _: vectors)
        else:
            self.store.mark_updated(source_id)
            count = 0
        return {"source": source["name"], "pages": len(valid_pages), "chunks": count}

    async def _search_pages(self, query: str, language: str, limit: int) -> list[dict[str, object]]:
        url = f"https://{language}.wikipedia.org/w/api.php"
        headers = {"User-Agent": "CHITTI-AI/0.3 (personal open-knowledge assistant)"}
        params = {
            "action": "query",
            "generator": "search",
            "gsrsearch": query,
            "gsrnamespace": 0,
            "gsrlimit": limit,
            "prop": "extracts",
            "explaintext": 1,
            "exchars": 6000,
            "format": "json",
            "formatversion": 2,
        }
        async with self._request_lock:
            wait_seconds = 1.0 - (time.monotonic() - self._last_request)
            if self._last_request and wait_seconds > 0:
                await asyncio.sleep(wait_seconds)
            async with httpx.AsyncClient(timeout=20.0, headers=headers, transport=self.transport) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()
            self._last_request = time.monotonic()
        pages = payload.get("query", {}).get("pages", [])
        if not isinstance(pages, list):
            raise ValueError("Wikipedia returned an unexpected page list")
        normalized = []
        for page in pages[:limit]:
            title = str(page.get("title", "")).strip()
            extract = filter_instruction_text(str(page.get("extract", "")))
            if title and extract:
                normalized.append({"title": title, "extract": extract})
        return normalized