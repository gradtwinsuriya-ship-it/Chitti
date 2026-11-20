import argparse
import asyncio
import json
import os

from dotenv import load_dotenv

from app.knowledge import KnowledgeStore, WikipediaIngestor
from app.memory import EmbeddingProvider


async def ingest(query: str, language: str, limit: int) -> dict[str, object]:
    load_dotenv()
    db_path = os.getenv("MEMORY_DB_PATH", "./data/memory.sqlite3")
    base_url = os.getenv("EMBEDDING_BASE_URL", os.getenv("MODEL_BASE_URL", "http://localhost:11434/v1"))
    embedding_provider = EmbeddingProvider(
        base_url=base_url,
        model=os.getenv("EMBEDDING_MODEL_NAME", "bge-m3"),
        api_key=os.getenv("EMBEDDING_API_KEY", os.getenv("MODEL_API_KEY", "")),
        timeout_seconds=float(os.getenv("MODEL_TIMEOUT_SECONDS", "45")),
    )
    ingestor = WikipediaIngestor(KnowledgeStore(db_path), embedding_provider)
    return await ingestor.ingest(query, language, limit)


def main() -> None:
    parser = argparse.ArgumentParser(description="Index a small explicit search from Wikipedia's official API.")
    parser.add_argument("--query", required=True, help="Topic to search")
    parser.add_argument("--language", choices=("en", "ta", "hi"), default="en")
    parser.add_argument("--limit", type=int, choices=range(1, 6), default=3, metavar="1-5")
    args = parser.parse_args()
    result = asyncio.run(ingest(args.query, args.language, args.limit))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()