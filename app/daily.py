from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import logging
import os
import time
from typing import Any
from urllib.parse import urlencode
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import httpx


FEEDS = {
    "india": [
        ("The Hindu", "https://www.thehindu.com/news/national/feeder/default.rss"),
        ("Google News India", "https://news.google.com/rss/search?q=India&hl=en-IN&gl=IN&ceid=IN:en"),
    ],
    "world": [
        ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
        ("Google News World", "https://news.google.com/rss/search?q=world&hl=en&gl=US&ceid=US:en"),
    ],
    "tech": [
        ("Google News Technology", "https://news.google.com/rss/search?q=technology&hl=en&gl=US&ceid=US:en"),
        ("The Hindu Technology", "https://www.thehindu.com/sci-tech/feeder/default.rss"),
    ],
}
NEWS_CACHE_SECONDS = 20 * 60
FEED_TIMEOUT_SECONDS = 6.0
NEWS_API_URL = "https://newsapi.org/v2"

_news_cache: dict[str, list[dict[str, str]]] | None = None
_news_error: str | None = None
_news_updated_at: str | None = None
_news_cached_at = 0.0
_news_lock = asyncio.Lock()
logger = logging.getLogger(__name__)


def current_date_time() -> dict[str, str]:
    timezone_name = os.getenv("CHITTI_TIMEZONE", "Asia/Kolkata")
    now = datetime.now(ZoneInfo(timezone_name))
    return {
        "date": now.strftime("%B %-d, %Y"),
        "weekday": now.strftime("%A"),
        "time": now.strftime("%I:%M %p").lstrip("0"),
        "timezone": timezone_name,
    }


def _parse_published(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _text(element: ElementTree.Element | None) -> str:
    return "".join(element.itertext()).strip() if element is not None else ""


def _parse_feed(content: bytes, default_source: str) -> list[dict[str, str]]:
    root = ElementTree.fromstring(content)
    channel_title = root.find("./channel/title")
    if channel_title is None:
        channel_title = root.find("{http://www.w3.org/2005/Atom}title")
    source_name = _text(channel_title) or default_source
    items = root.findall(".//item")
    if not items:
        items = root.findall(".//{http://www.w3.org/2005/Atom}entry")

    results = []
    for item in items:
        title = _text(item.find("title")) or _text(item.find("{http://www.w3.org/2005/Atom}title"))
        link_element = item.find("link")
        if link_element is None:
            link_element = item.find("{http://www.w3.org/2005/Atom}link")
        link = _text(link_element)
        if link_element is not None and not link and link_element.get("href"):
            link = link_element.get("href", "")
        if not title or not link:
            continue

        published = (
            _text(item.find("pubDate"))
            or _text(item.find("published"))
            or _text(item.find("updated"))
            or _text(item.find("{http://www.w3.org/2005/Atom}published"))
            or _text(item.find("{http://www.w3.org/2005/Atom}updated"))
        )
        item_source = _text(item.find("source")) or _text(item.find("{http://www.w3.org/2005/Atom}source")) or source_name
        parsed_time = _parse_published(published)
        results.append({
            "title": title,
            "source": item_source,
            "link": link,
            "published_at": parsed_time.isoformat() if published else "",
            "_sort_time": parsed_time.isoformat(),
        })
    return results


async def _fetch_feed(
    client: httpx.AsyncClient,
    category: str,
    source: str,
    url: str,
) -> tuple[str, list[dict[str, str]]]:
    response = await client.get(url)
    response.raise_for_status()
    return category, _parse_feed(response.content, source)


async def _fetch_newsapi_category(
    client: httpx.AsyncClient,
    category: str,
    api_key: str,
) -> tuple[str, list[dict[str, str]]]:
    params: dict[str, str | int] = {"pageSize": 50, "apiKey": api_key}
    endpoint = f"{NEWS_API_URL}/top-headlines"
    if category == "world":
        endpoint = f"{NEWS_API_URL}/everything"
        params.update({"q": "world", "sortBy": "publishedAt"})
    else:
        params.update({"country": "in", "category": "technology" if category == "tech" else "general"})
    response = await client.get(f"{endpoint}?{urlencode(params)}")
    response.raise_for_status()
    payload = response.json()
    if payload.get("status") != "ok" or not isinstance(payload.get("articles"), list):
        raise ValueError("News provider returned an invalid response.")
    articles = []
    for article in payload["articles"]:
        if not isinstance(article, dict):
            continue
        title = article.get("title")
        link = article.get("url")
        if not isinstance(title, str) or not isinstance(link, str):
            continue
        published = article.get("publishedAt")
        source = article.get("source")
        source_name = source.get("name") if isinstance(source, dict) else None
        parsed_time = _parse_published(published if isinstance(published, str) else None)
        articles.append({
            "title": title,
            "source": source_name if isinstance(source_name, str) else "NewsAPI",
            "link": link,
            "published_at": parsed_time.isoformat() if published else "",
            "_sort_time": parsed_time.isoformat(),
        })
    return category, articles


def _sort_and_deduplicate(items: list[dict[str, str]]) -> list[dict[str, str]]:
    unique: dict[str, dict[str, str]] = {}
    for item in items:
        key = item["link"].casefold() or item["title"].casefold()
        unique.setdefault(key, item)
    sorted_items = sorted(
        unique.values(),
        key=lambda item: item["_sort_time"],
        reverse=True,
    )[:5]
    return [{key: value for key, value in item.items() if key != "_sort_time"} for item in sorted_items]


async def _fetch_news() -> tuple[dict[str, list[dict[str, str]]], str | None]:
    api_key = os.getenv("NEWS_API_KEY", "").strip()
    async with httpx.AsyncClient(timeout=FEED_TIMEOUT_SECONDS) as client:
        if api_key:
            requests = [
                _fetch_newsapi_category(client, category, api_key)
                for category in FEEDS
            ]
        else:
            requests = [
                _fetch_feed(client, category, source, url)
                for category, feeds in FEEDS.items()
                for source, url in feeds
            ]
        outcomes = await asyncio.gather(*requests, return_exceptions=True)

    grouped = {category: [] for category in FEEDS}
    successful_feeds = 0
    for outcome in outcomes:
        if isinstance(outcome, Exception):
            continue
        if isinstance(outcome, BaseException):
            raise outcome
        category, items = outcome
        grouped[category].extend(items)
        successful_feeds += 1
    if not successful_feeds:
        return grouped, "News is temporarily unavailable because all news feeds failed."
    return {category: _sort_and_deduplicate(items) for category, items in grouped.items()}, None


def _copy_news(news: dict[str, list[dict[str, str]]]) -> dict[str, list[dict[str, str]]]:
    return {category: [dict(item) for item in items] for category, items in news.items()}


async def get_news(force_refresh: bool = False) -> tuple[dict[str, list[dict[str, str]]], str | None, str]:
    global _news_cache, _news_cached_at, _news_error, _news_updated_at
    if not force_refresh and _news_cache is not None and time.monotonic() - _news_cached_at < NEWS_CACHE_SECONDS:
        return _copy_news(_news_cache), _news_error, _news_updated_at or ""

    async with _news_lock:
        if not force_refresh and _news_cache is not None and time.monotonic() - _news_cached_at < NEWS_CACHE_SECONDS:
            return _copy_news(_news_cache), _news_error, _news_updated_at or ""
        try:
            news, error = await _fetch_news()
        except Exception:
            logger.exception("Daily news refresh failed.")
            news = {category: [] for category in FEEDS}
            error = "News is temporarily unavailable because the news service could not be reached."
        _news_cache = news
        _news_error = error
        _news_cached_at = time.monotonic()
        _news_updated_at = datetime.now(ZoneInfo(os.getenv("CHITTI_TIMEZONE", "Asia/Kolkata"))).isoformat()
        return _copy_news(news), error, _news_updated_at


async def get_today(force_refresh: bool = False) -> dict[str, Any]:
    date_time = current_date_time()
    news, error, updated_at = await get_news(force_refresh)
    response: dict[str, Any] = {
        **date_time,
        "news": news,
        "updated_at": updated_at,
    }
    if error:
        response["error"] = error
    return response


async def get_news_for_prompt() -> tuple[dict[str, list[dict[str, str]]], str | None]:
    news, error, _ = await get_news()
    return news, error
