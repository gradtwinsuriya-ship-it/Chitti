from __future__ import annotations

import asyncio
import json
import os
import logging
import re
import time
from importlib.util import find_spec
from pathlib import Path
from contextlib import asynccontextmanager
from typing import AsyncIterator, Awaitable, Callable, Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.knowledge import KnowledgeStore, WikipediaIngestor
from app.daily import get_today
from app.memory import EmbeddingProvider, MemoryStore, chunk_text
from app.orchestrator import ChatOrchestrator, ChatProvider, ProviderConfig
from app.tools import ToolService
from app.voice import LocalWhisperTranscriber, MAX_AUDIO_BYTES, SUPPORTED_AUDIO_TYPES
from app.vision import MAX_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES, VisionService


load_dotenv()
logger = logging.getLogger(__name__)
SMART_ROUTING_ENABLED = os.getenv("SMART_ROUTING", "").strip().lower() in {"1", "true", "yes", "on"}
AUTO_SUMMARY_ENABLED = os.getenv("AUTO_SUMMARY", "").strip().lower() in {"1", "true", "yes", "on"}
AUTO_SUMMARY_PREFIX = "__CHITTI_AUTO_SUMMARY_V1__"


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    yield
    provider = getattr(application.state.orchestrator, "provider", None)
    close = getattr(provider, "close", None)
    if callable(close):
        await close()
    fast_provider = getattr(application.state.orchestrator, "fast_provider", None)
    close_fast = getattr(fast_provider, "close", None)
    if callable(close_fast):
        await close_fast()
    embedding_provider = getattr(application.state, "embedding_provider", None)
    close_embedding = getattr(embedding_provider, "close", None)
    if callable(close_embedding):
        await close_embedding()


app = FastAPI(title="CHITTI-AI", version="0.6.0", lifespan=lifespan)
main_provider = ChatProvider(
    ProviderConfig(
        base_url=os.getenv("MODEL_BASE_URL", "http://localhost:11434/v1"),
        model=os.getenv("MODEL_NAME", "qwen2.5:3b"),
        api_key=os.getenv("MODEL_API_KEY", ""),
        timeout_seconds=float(os.getenv("MODEL_TIMEOUT_SECONDS", "45")),
    )
)
fast_provider = None
if SMART_ROUTING_ENABLED or AUTO_SUMMARY_ENABLED:
    fast_provider = ChatProvider(
        ProviderConfig(
            base_url=os.getenv("FAST_MODEL_BASE_URL", "http://localhost:11434/v1"),
            model=os.getenv("FAST_MODEL_NAME", "gemma3:1b"),
            api_key=os.getenv("FAST_MODEL_API_KEY", ""),
            timeout_seconds=float(os.getenv("FAST_MODEL_TIMEOUT_SECONDS", "45")),
            keep_alive=os.getenv("FAST_MODEL_KEEP_ALIVE", "10m"),
        )
    )
app.state.orchestrator = ChatOrchestrator(
    main_provider,
    fast_provider=fast_provider,
    smart_routing=SMART_ROUTING_ENABLED,
    auto_summary=AUTO_SUMMARY_ENABLED,
)
memory_db_path = os.getenv("MEMORY_DB_PATH", "./data/memory.sqlite3")
app.state.memory_store = MemoryStore(memory_db_path)
app.state.knowledge_store = KnowledgeStore(memory_db_path)
app.state.embedding_provider = EmbeddingProvider(
    base_url=os.getenv("EMBEDDING_BASE_URL", os.getenv("MODEL_BASE_URL", "http://localhost:11434/v1")),
    model=os.getenv("EMBEDDING_MODEL_NAME", "bge-m3"),
    api_key=os.getenv("EMBEDDING_API_KEY", os.getenv("MODEL_API_KEY", "")),
    timeout_seconds=float(os.getenv("MODEL_TIMEOUT_SECONDS", "45")),
)
app.state.knowledge_ingestor = WikipediaIngestor(app.state.knowledge_store, app.state.embedding_provider)
app.state.tool_service = ToolService(
    db_path=memory_db_path,
    file_root=os.getenv("FILE_SEARCH_ROOT", "./data/documents"),
    web_search_url=os.getenv("WEB_SEARCH_URL", ""),
    home_assistant_url=os.getenv("HOME_ASSISTANT_URL", ""),
    home_assistant_token=os.getenv("HOME_ASSISTANT_TOKEN", ""),
    allowed_home_entities={
        entity.strip()
        for entity in os.getenv("HOME_ALLOWED_ENTITIES", "").split(",")
        if entity.strip()
    },
)
app.state.voice_transcriber = LocalWhisperTranscriber(
    model_size=os.getenv("WHISPER_MODEL", "base"),
    device=os.getenv("WHISPER_DEVICE", "cpu"),
    compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"),
)
app.state.vision_service = VisionService(
    yolo_model=os.getenv("VISION_YOLO_MODEL", "yolo11n.pt"),
    caption_base_url=os.getenv("VISION_BASE_URL", ""),
    caption_model=os.getenv("VISION_MODEL", ""),
    caption_api_key=os.getenv("VISION_API_KEY", ""),
    timeout_seconds=float(os.getenv("VISION_TIMEOUT_SECONDS", "60")),
)


CHAT_TOOL_DEFINITIONS: list[dict[str, object]] = [
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a basic arithmetic expression using the safe expression evaluator.",
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string", "maxLength": 500}},
                "required": ["expression"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Search text files only within the configured personal documents folder.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "minLength": 2, "maxLength": 200}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city or place using Open-Meteo.",
            "parameters": {
                "type": "object",
                "properties": {"place": {"type": "string", "maxLength": 100}},
                "required": ["place"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the configured SearXNG instance; disabled until configured.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "minLength": 2, "maxLength": 300}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_reminder",
            "description": "Save a local reminder when the user explicitly asks. It does not send notifications.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "maxLength": 500},
                    "due_at": {"type": "string", "description": "ISO 8601 date/time with timezone"},
                },
                "required": ["task", "due_at"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_email_draft",
            "description": "Save an email draft when the user explicitly asks. This never sends email.",
            "parameters": {
                "type": "object",
                "properties": {
                    "recipient": {"type": "string", "maxLength": 320},
                    "subject": {"type": "string", "maxLength": 300},
                    "body": {"type": "string", "maxLength": 20000},
                },
                "required": ["recipient", "subject", "body"],
                "additionalProperties": False,
            },
        },
    },
]


REFLEX_MEMORY_TERMS = re.compile(r"\b(?:my|i|me|today|tomorrow|meeting|remind|schedule|note)\b", re.IGNORECASE)
REFLEX_GREETING = re.compile(r"\s*(?:hi|hello|hey|good morning|good afternoon|good evening)(?:\s+there)?[.!?]*\s*", re.IGNORECASE)
SIMPLE_CHAT_MESSAGE = re.compile(
    r"\s*(?:reply in (?:tamil|hindi):\s*)?(?:hi|hello|hey|good morning|good afternoon|good evening|thanks?|thank you(?: so much)?|ok(?:ay)?|cool|nice|how are you|what's up)[.!?]*\s*",
    re.IGNORECASE,
)


def should_lookup_reflex_memory(message: str) -> bool:
    if REFLEX_GREETING.fullmatch(message):
        return False
    if REFLEX_MEMORY_TERMS.search(message):
        return True
    return bool(
        re.search(
            r"\b(?:what|which|when)\b.*\b(?:i|you|user)\b.*\b(?:say|said|tell|told|mention|mentioned|ask|asked|share|shared)\b.*\b(?:earlier|before|previously|last time)\b",
            message,
            re.IGNORECASE,
        )
    )


def chat_tool_definitions_for_request(mode: str, message: str, web_search_enabled: bool) -> list[dict[str, object]]:
    available = [
        definition
        for definition in CHAT_TOOL_DEFINITIONS
        if definition["function"]["name"] != "web_search" or web_search_enabled
    ]
    if mode not in {"speed", "reflex"}:
        return available

    text = message.casefold()
    selected = set()
    if re.search(r"\b(calculate|compute)\b", text):
        selected.add("calculate")
    if re.search(r"\b(search|find|look up)\b", text):
        selected.update({"search_files", "web_search"})
    if re.search(r"\b(email|e-mail)\b", text):
        selected.add("create_email_draft")
    if re.search(r"\bremind\b", text):
        selected.add("create_reminder")
    if re.search(r"\bopen\b", text):
        selected.add("search_files")
    if re.search(r"\bweather\b", text):
        selected.add("get_weather")
    return [definition for definition in available if definition["function"]["name"] in selected]


def _fast_route_reason(
    message: str,
    mode: str,
    tool_definitions: list[dict[str, object]],
) -> str | None:
    route = getattr(app.state.orchestrator, "fast_route_reason", None)
    if not callable(route):
        return None
    return route(message, mode, context=None, tool_definitions=tool_definitions)


static_dir = Path(__file__).parent / "static"
dist_dir = static_dir / "dist"
app.mount("/static", StaticFiles(directory=static_dir), name="static")
app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")


class HistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    history: list[HistoryMessage] = Field(default_factory=list, max_length=20)
    mode: Literal["speed", "deep", "reflex", "deliberate", "deep_research"] = "reflex"
    voice: bool = False


class ChatResponse(BaseModel):
    reply: str
    mode: Literal["speed", "deep", "reflex", "deliberate", "deep_research"]
    sources: list[dict[str, object]] = Field(default_factory=list)
    reasoning: Optional[dict[str, object]] = None


class MemoryRequest(BaseModel):
    content: str = Field(min_length=1, max_length=8000)


class DocumentRequest(BaseModel):
    source: str = Field(min_length=1, max_length=255)
    content: str = Field(min_length=1, max_length=200000)


class KnowledgeIngestRequest(BaseModel):
    query: str = Field(min_length=2, max_length=300)
    language: Literal["en", "ta", "hi"] = "en"
    limit: int = Field(default=3, ge=1, le=5)


class SourceToggleRequest(BaseModel):
    enabled: bool


class CalculateRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=500)


class FileSearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=200)


class WeatherRequest(BaseModel):
    place: str = Field(min_length=1, max_length=100)


class WebSearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=300)


class ReminderRequest(BaseModel):
    task: str = Field(min_length=1, max_length=500)
    due_at: str = Field(min_length=10, max_length=64)


class EmailDraftRequest(BaseModel):
    recipient: str = Field(min_length=3, max_length=320)
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=20000)


class HomeActionPreviewRequest(BaseModel):
    entity_id: str = Field(min_length=3, max_length=255)
    action: Literal["turn_on", "turn_off"]


class HomeActionConfirmRequest(BaseModel):
    confirmation_token: str = Field(min_length=20, max_length=100)


class VoiceTranscriptionResponse(BaseModel):
    text: str
    language: str
    language_probability: Optional[float] = None
    duration_seconds: Optional[float] = None
    engine: str
    model: str


@app.get("/chat", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(dist_dir / "index.html")


@app.get("/", include_in_schema=False)
async def landing_page() -> FileResponse:
    return FileResponse(dist_dir / "index.html")


@app.get("/hero", include_in_schema=False)
async def hero() -> FileResponse:
    return FileResponse(static_dir / "hero.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/today")
async def today() -> dict[str, object]:
    return await get_today()


@app.get("/api/settings/status")
async def settings_status() -> dict[str, object]:
    tools = await list_tools()
    sources = app.state.knowledge_store.list_sources()
    return {
        "model": {
            "provider": "OpenAI-compatible",
            "name": os.getenv("MODEL_NAME", "qwen2.5:3b"),
            "endpoint_configured": bool(os.getenv("MODEL_BASE_URL", "http://localhost:11434/v1")),
        },
        "knowledge": {
            "enabled_sources": sum(bool(source["enabled"]) for source in sources),
            "indexed_chunks": sum(int(source["indexed_chunks"]) for source in sources),
        },
        "tools": tools["tools"],
        "voice": {
            "engine": "local-whisper",
            "model": app.state.voice_transcriber.model_size,
            "installed": find_spec("faster_whisper") is not None,
        },
        "vision": app.state.vision_service.status(),
        "storage": {"type": "SQLite", "location": "local", "encrypted": False},
        "authentication": False,
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, response: Response) -> ChatResponse:
    message = request.message.strip()
    request_started = time.perf_counter()
    if message.startswith(AUTO_SUMMARY_PREFIX):
        if not AUTO_SUMMARY_ENABLED:
            return ChatResponse(reply="", mode=request.mode)
        try:
            summary = await app.state.orchestrator.summarize_history(
                [item.model_dump() for item in request.history]
            )
        except Exception as exc:
            logger.exception("Background conversation summary failed: %s", exc)
            raise HTTPException(status_code=502, detail="The conversation summary could not be created.") from exc
        summary_model = getattr(
            getattr(getattr(app.state.orchestrator, "fast_provider", None), "config", None),
            "model",
            os.getenv("FAST_MODEL_NAME", "gemma3:1b"),
        )
        prompt_chars = sum(len(item.content) for item in request.history)
        logger.info(
            "chat model route=summary model=%s elapsed_ms=%d prompt_chars=%d prompt_tokens_estimate=%d",
            summary_model,
            round((time.perf_counter() - request_started) * 1000),
            prompt_chars,
            (prompt_chars + 3) // 4,
        )
        return ChatResponse(reply=summary, mode=request.mode)

    normalized_message = re.sub(r"[.!?\s]+$", "", message.lower())
    if normalized_message.startswith("remember this:"):
        note = message.split(":", 1)[1].strip()
        if not note:
            raise HTTPException(status_code=422, detail="Add the note after 'Remember this:'.")
        await save_memory("note", note)
        return ChatResponse(reply="Saved that to your local memory.", mode=request.mode)
    if normalized_message in {"forget this", "forget that"}:
        if not app.state.memory_store.delete_latest_memory():
            return ChatResponse(reply="There is no saved note to forget.", mode=request.mode)
        return ChatResponse(reply="Forgot the most recently saved note.", mode=request.mode)

    relevant_context: list[dict[str, object]] = []
    has_personal_context = app.state.memory_store.count() > 0
    has_knowledge_context = app.state.knowledge_store.count_enabled_chunks() > 0
    simple_greeting = bool(SIMPLE_CHAT_MESSAGE.fullmatch(message))
    tool_definitions = [] if simple_greeting else chat_tool_definitions_for_request(
        request.mode,
        message,
        bool(app.state.tool_service.web_search_url),
    )
    route_reason = _fast_route_reason(message, request.mode, tool_definitions)
    reflex_memory_lookup = request.mode == "reflex" and should_lookup_reflex_memory(message)
    lookup_personal_memory = has_personal_context and not route_reason and not simple_greeting and (
        request.mode != "reflex" or reflex_memory_lookup
    )
    lookup_knowledge_context = has_knowledge_context and not route_reason and not simple_greeting
    personal_context: list[dict[str, object]] = []
    if lookup_personal_memory or lookup_knowledge_context:
        try:
            query_embedding = (await app.state.embedding_provider.embed([message]))[0]
            if lookup_personal_memory:
                memory_limit = 3 if request.mode == "reflex" else 4
                personal_context = [
                    result
                    for result in app.state.memory_store.search(
                        query_embedding,
                        limit=memory_limit,
                        kind="memory" if request.mode == "reflex" else None,
                    )
                    if float(result["score"]) >= 0.2
                    and (request.mode != "reflex" or result.get("kind") == "memory")
                ]
            knowledge_context = [
                result
                for result in app.state.knowledge_store.search(query_embedding, limit=4)
                if float(result["score"]) >= 0.2
            ] if lookup_knowledge_context else []
            relevant_context = personal_context + knowledge_context
        except Exception as exc:
            raise HTTPException(status_code=503, detail="The configured embedding provider is unavailable.") from exc

    reasoning = None
    try:
        orchestrator_args = (
            [item.model_dump() for item in request.history],
            message,
            request.mode,
        )
        orchestrator_kwargs = {
            "context": relevant_context,
            "tool_definitions": tool_definitions,
            "tool_executor": execute_chat_tool,
            "voice": request.voice,
        }
        if hasattr(app.state.orchestrator, "respond_with_report"):
            report = await app.state.orchestrator.respond_with_report(*orchestrator_args, **orchestrator_kwargs)
            reply = report.reply
            reasoning = report.public_dict()
            model_used = str(
                getattr(
                    report,
                    "model_used",
                    getattr(getattr(app.state.orchestrator, "provider", None), "config", None).model
                    if getattr(getattr(app.state.orchestrator, "provider", None), "config", None)
                    else os.getenv("MODEL_NAME", "qwen2.5:3b"),
                )
            )
            route = str(getattr(report, "route", "main"))
            prompt_chars = int(getattr(report, "prompt_chars", 0))
            response.headers["X-CHITTI-Model"] = model_used
            response.headers["X-CHITTI-Route"] = route
            response.headers["X-CHITTI-Latency-Ms"] = str(round((time.perf_counter() - request_started) * 1000))
            logger.info(
                "chat model route=%s model=%s elapsed_ms=%d prompt_chars=%d prompt_tokens_estimate=%d",
                route,
                model_used,
                round((time.perf_counter() - request_started) * 1000),
                prompt_chars,
                (prompt_chars + 3) // 4,
            )
        else:
            reply = await app.state.orchestrator.respond(*orchestrator_args, **orchestrator_kwargs)
    except Exception as exc:
        logger.exception("Chat orchestration failed: %s", exc)
        app.state.tool_service.log_activity("chat", "failed", "Chat orchestration failed")
        raise HTTPException(status_code=502, detail="The configured model provider could not complete the request.") from exc
    sources = [
        {
            key: item[key]
            for key in ("source", "kind", "score", "title", "url", "license", "language", "updated_at")
            if key in item
        }
        for item in relevant_context
    ]
    if reasoning is None:
        reasoning = {
            "plan_summary": "Processed the request with the configured assistant.",
            "tools_used": [],
            "confidence": "medium",
            "critique_summary": "Automated critique unavailable.",
            "revision_count": 0,
        }
    reasoning["sources"] = [
        str(item.get("title") or item.get("source"))
        for item in sources
        if item.get("title") or item.get("source")
    ]
    reasoning["matched_notes"] = [
        str(item["content"])
        for item in personal_context
        if item.get("kind") == "memory" and item.get("content")
    ]
    app.state.tool_service.log_activity(
        "chat",
        "success",
        f"{request.mode} response; confidence={reasoning.get('confidence', 'medium')}; "
        f"tools={len(reasoning.get('tools_used', []))}; revisions={reasoning.get('revision_count', 0)}",
    )
    return ChatResponse(reply=reply, mode=request.mode, sources=sources, reasoning=reasoning)


async def stream_chat_response(
    request: ChatRequest,
    on_token: Callable[[str], Awaitable[None]],
) -> ChatResponse:
    message = request.message.strip()
    request_started = time.perf_counter()
    if message.startswith(AUTO_SUMMARY_PREFIX):
        if not AUTO_SUMMARY_ENABLED:
            return ChatResponse(reply="", mode=request.mode)
        try:
            summary = await app.state.orchestrator.summarize_history(
                [item.model_dump() for item in request.history]
            )
        except Exception as exc:
            logger.exception("Background conversation summary failed: %s", exc)
            raise HTTPException(status_code=502, detail="The conversation summary could not be created.") from exc
        summary_model = getattr(
            getattr(getattr(app.state.orchestrator, "fast_provider", None), "config", None),
            "model",
            os.getenv("FAST_MODEL_NAME", "gemma3:1b"),
        )
        prompt_chars = sum(len(item.content) for item in request.history)
        logger.info(
            "chat model route=summary model=%s elapsed_ms=%d prompt_chars=%d prompt_tokens_estimate=%d",
            summary_model,
            round((time.perf_counter() - request_started) * 1000),
            prompt_chars,
            (prompt_chars + 3) // 4,
        )
        await on_token(summary)
        return ChatResponse(reply=summary, mode=request.mode)

    normalized_message = re.sub(r"[.!?\s]+$", "", message.lower())
    if normalized_message.startswith("remember this:"):
        note = message.split(":", 1)[1].strip()
        if not note:
            raise HTTPException(status_code=422, detail="Add the note after 'Remember this:'.")
        await save_memory("note", note)
        return ChatResponse(reply="Saved that to your local memory.", mode=request.mode)
    if normalized_message in {"forget this", "forget that"}:
        if not app.state.memory_store.delete_latest_memory():
            return ChatResponse(reply="There is no saved note to forget.", mode=request.mode)
        return ChatResponse(reply="Forgot the most recently saved note.", mode=request.mode)

    relevant_context: list[dict[str, object]] = []
    has_personal_context = app.state.memory_store.count() > 0
    has_knowledge_context = app.state.knowledge_store.count_enabled_chunks() > 0
    simple_greeting = bool(SIMPLE_CHAT_MESSAGE.fullmatch(message))
    tool_definitions = [] if simple_greeting else chat_tool_definitions_for_request(
        request.mode,
        message,
        bool(app.state.tool_service.web_search_url),
    )
    route_reason = _fast_route_reason(message, request.mode, tool_definitions)
    reflex_memory_lookup = request.mode == "reflex" and should_lookup_reflex_memory(message)
    lookup_personal_memory = has_personal_context and not route_reason and not simple_greeting and (
        request.mode != "reflex" or reflex_memory_lookup
    )
    lookup_knowledge_context = has_knowledge_context and not route_reason and not simple_greeting
    personal_context: list[dict[str, object]] = []
    if lookup_personal_memory or lookup_knowledge_context:
        try:
            query_embedding = (await app.state.embedding_provider.embed([message]))[0]
            if lookup_personal_memory:
                memory_limit = 3 if request.mode == "reflex" else 4
                personal_context = [
                    result
                    for result in app.state.memory_store.search(
                        query_embedding,
                        limit=memory_limit,
                        kind="memory" if request.mode == "reflex" else None,
                    )
                    if float(result["score"]) >= 0.2
                    and (request.mode != "reflex" or result.get("kind") == "memory")
                ]
            knowledge_context = [
                result
                for result in app.state.knowledge_store.search(query_embedding, limit=4)
                if float(result["score"]) >= 0.2
            ] if lookup_knowledge_context else []
            relevant_context = personal_context + knowledge_context
        except Exception as exc:
            raise HTTPException(status_code=503, detail="The configured embedding provider is unavailable.") from exc

    orchestrator_args = (
        [item.model_dump() for item in request.history],
        message,
        request.mode,
    )
    orchestrator_kwargs = {
        "context": relevant_context,
        "tool_definitions": tool_definitions,
        "tool_executor": execute_chat_tool,
        "voice": request.voice,
    }
    reasoning = None
    try:
        if hasattr(app.state.orchestrator, "respond_with_report"):
            report = await app.state.orchestrator.respond_with_report(
                *orchestrator_args,
                **orchestrator_kwargs,
                on_token=on_token,
            )
            reply = report.reply
            reasoning = report.public_dict()
            route = str(getattr(report, "route", "main"))
            model_used = str(
                getattr(
                    report,
                    "model_used",
                    getattr(getattr(app.state.orchestrator, "provider", None), "config", None).model
                    if getattr(getattr(app.state.orchestrator, "provider", None), "config", None)
                    else os.getenv("MODEL_NAME", "qwen2.5:3b"),
                )
            )
            prompt_chars = int(getattr(report, "prompt_chars", 0))
            logger.info(
                "chat model route=%s model=%s elapsed_ms=%d prompt_chars=%d prompt_tokens_estimate=%d",
                route,
                model_used,
                round((time.perf_counter() - request_started) * 1000),
                prompt_chars,
                (prompt_chars + 3) // 4,
            )
        else:
            reply = await app.state.orchestrator.respond(*orchestrator_args, **orchestrator_kwargs)
    except Exception as exc:
        logger.exception("Streaming chat orchestration failed: %s", exc)
        app.state.tool_service.log_activity("chat", "failed", "Chat orchestration failed")
        raise HTTPException(status_code=502, detail="The configured model provider could not complete the request.") from exc

    sources = [
        {
            key: item[key]
            for key in ("source", "kind", "score", "title", "url", "license", "language", "updated_at")
            if key in item
        }
        for item in relevant_context
    ]
    if reasoning is None:
        reasoning = {
            "plan_summary": "Processed the request with the configured assistant.",
            "tools_used": [],
            "confidence": "medium",
            "critique_summary": "Automated critique unavailable.",
            "revision_count": 0,
        }
    reasoning["sources"] = [
        str(item.get("title") or item.get("source"))
        for item in sources
        if item.get("title") or item.get("source")
    ]
    reasoning["matched_notes"] = [
        str(item["content"])
        for item in personal_context
        if item.get("kind") == "memory" and item.get("content")
    ]
    app.state.tool_service.log_activity(
        "chat",
        "success",
        f"{request.mode} response; confidence={reasoning.get('confidence', 'medium')}; "
        f"tools={len(reasoning.get('tools_used', []))}; revisions={reasoning.get('revision_count', 0)}",
    )
    return ChatResponse(reply=reply, mode=request.mode, sources=sources, reasoning=reasoning)


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    simple_greeting = bool(SIMPLE_CHAT_MESSAGE.fullmatch(request.message.strip()))
    tools = [] if simple_greeting else chat_tool_definitions_for_request(
        request.mode,
        request.message.strip(),
        bool(app.state.tool_service.web_search_url),
    )
    route_reason = _fast_route_reason(request.message.strip(), request.mode, tools)
    if route_reason:
        route_headers = {
            "X-CHITTI-Model": str(
                getattr(
                    getattr(getattr(app.state.orchestrator, "fast_provider", None), "config", None),
                    "model",
                    os.getenv("FAST_MODEL_NAME", "gemma3:1b"),
                )
            ),
            "X-CHITTI-Route": "fast",
        }
    else:
        route_headers = {
            "X-CHITTI-Model": str(
                getattr(
                    getattr(getattr(app.state.orchestrator, "provider", None), "config", None),
                    "model",
                    os.getenv("MODEL_NAME", "qwen2.5:3b"),
                )
            ),
            "X-CHITTI-Route": "main",
        }

    async def event_stream():
        queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()

        async def send_token(token: str) -> None:
            await queue.put({"type": "token", "token": token})

        async def run_chat() -> None:
            try:
                response = await stream_chat_response(request, send_token)
                await queue.put({"type": "complete", "response": response.model_dump()})
            except HTTPException as exc:
                await queue.put({"type": "error", "detail": str(exc.detail)})
            except Exception:
                logger.exception("Streaming chat request failed.")
                await queue.put({"type": "error", "detail": "The configured model provider could not complete the request."})
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_chat())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", **route_headers},
    )


async def save_memory(source: str, content: str, kind: str = "memory") -> int:
    chunks = chunk_text(content)
    try:
        embeddings = await app.state.embedding_provider.embed(chunks)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="The configured embedding provider is unavailable.") from exc
    app.state.memory_store.add(kind, source, chunks, embeddings)
    return len(chunks)


@app.get("/api/memory")
async def list_memory() -> list[dict[str, str]]:
    return app.state.memory_store.list_entries()


@app.post("/api/memory")
async def add_memory(request: MemoryRequest) -> dict[str, object]:
    count = await save_memory("note", request.content)
    return {"saved": True, "chunks": count}


@app.post("/api/memory/documents")
async def add_document(request: DocumentRequest) -> dict[str, object]:
    source = Path(request.source).name
    if Path(source).suffix.lower() not in {".txt", ".md", ".markdown"}:
        raise HTTPException(status_code=415, detail="Upload a plain text or Markdown document.")
    count = await save_memory(source, request.content, kind="document")
    return {"saved": True, "source": source, "chunks": count}


@app.get("/api/memory/export")
async def export_memory() -> JSONResponse:
    return JSONResponse(
        content=app.state.memory_store.export(),
        headers={"Content-Disposition": "attachment; filename=chitti-memory.json"},
    )


@app.delete("/api/memory/{entry_id}", status_code=204)
async def delete_memory_entry(entry_id: str) -> Response:
    if not app.state.memory_store.delete(entry_id):
        raise HTTPException(status_code=404, detail="Memory entry not found.")
    return Response(status_code=204)


@app.delete("/api/memory", status_code=204)
async def delete_all_memory(confirm: bool = False) -> Response:
    if not confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true to permanently delete all local memory.")
    app.state.memory_store.clear()
    return Response(status_code=204)


@app.get("/api/knowledge/sources")
async def list_knowledge_sources() -> list[dict[str, object]]:
    return app.state.knowledge_store.list_sources()


@app.patch("/api/knowledge/sources/{source_id}")
async def set_knowledge_source(source_id: str, request: SourceToggleRequest) -> dict[str, object]:
    if not app.state.knowledge_store.set_enabled(source_id, request.enabled):
        raise HTTPException(status_code=404, detail="Knowledge source not found.")
    return {"id": source_id, "enabled": request.enabled}


@app.post("/api/knowledge/ingest")
async def ingest_knowledge(request: KnowledgeIngestRequest) -> dict[str, object]:
    try:
        return await app.state.knowledge_ingestor.ingest(request.query.strip(), request.language, request.limit)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Wikipedia API request failed.") from exc


def audit_tool_error(tool: str, status: int, summary: str, exc: Exception) -> None:
    app.state.tool_service.log_activity(tool, "failed", summary)
    raise HTTPException(status_code=status, detail=str(exc)) from exc


async def run_async_tool(tool: str, summary: str, operation) -> object:
    try:
        result = await operation
    except ValueError as exc:
        audit_tool_error(tool, 422, f"{summary}: invalid request", exc)
    except RuntimeError as exc:
        audit_tool_error(tool, 503, f"{summary}: unavailable", exc)
    except httpx.HTTPError as exc:
        audit_tool_error(tool, 502, f"{summary}: provider request failed", exc)
    app.state.tool_service.log_activity(tool, "success", summary)
    return result


async def execute_chat_tool(name: str, arguments: dict[str, object]) -> object:
    if name == "calculate":
        request = CalculateRequest.model_validate(arguments)
        return run_sync_tool(
            name,
            "Assistant evaluated arithmetic expression",
            lambda: {"result": app.state.tool_service.calculate(request.expression)},
        )
    if name == "search_files":
        request = FileSearchRequest.model_validate(arguments)
        return run_sync_tool(
            name,
            "Assistant searched configured document folder",
            lambda: {"matches": app.state.tool_service.search_files(request.query)},
        )
    if name == "get_weather":
        request = WeatherRequest.model_validate(arguments)
        return await run_async_tool(
            name,
            "Assistant looked up current weather",
            app.state.tool_service.weather(request.place),
        )
    if name == "web_search":
        request = WebSearchRequest.model_validate(arguments)
        return await run_async_tool(
            name,
            "Assistant searched configured SearXNG instance",
            app.state.tool_service.web_search(request.query),
        )
    if name == "create_reminder":
        request = ReminderRequest.model_validate(arguments)
        return run_sync_tool(
            name,
            "Assistant created a local reminder; no notification scheduled",
            lambda: app.state.tool_service.create_reminder(request.task, request.due_at),
        )
    if name == "create_email_draft":
        request = EmailDraftRequest.model_validate(arguments)
        return run_sync_tool(
            name,
            "Assistant saved an email draft; nothing was sent",
            lambda: app.state.tool_service.create_email_draft(request.recipient, request.subject, request.body),
        )
    raise ValueError("This tool is not available to the assistant.")


def run_sync_tool(tool: str, summary: str, operation) -> object:
    try:
        result = operation()
    except ValueError as exc:
        audit_tool_error(tool, 422, f"{summary}: invalid request", exc)
    except RuntimeError as exc:
        audit_tool_error(tool, 503, f"{summary}: unavailable", exc)
    app.state.tool_service.log_activity(tool, "success", summary)
    return result


@app.get("/api/tools")
async def list_tools() -> dict[str, object]:
    service = app.state.tool_service
    return {
        "tools": [
            {"id": "calculate", "enabled": True},
            {"id": "file_search", "enabled": True},
            {"id": "weather", "enabled": True, "provider": "Open-Meteo"},
            {"id": "web_search", "enabled": bool(service.web_search_url), "provider": "SearXNG"},
            {"id": "reminders", "enabled": True, "notifications": False},
            {"id": "email_drafts", "enabled": True, "sends_email": False},
            {
                "id": "home_assistant",
                "enabled": bool(service.home_assistant_url and service.home_assistant_token and service.allowed_home_entities),
                "requires_confirmation": True,
            },
        ]
    }


@app.get("/api/tools/activity")
async def list_tool_activity() -> list[dict[str, object]]:
    return app.state.tool_service.list_activity()


@app.post("/api/tools/calculate")
async def calculate(request: CalculateRequest) -> dict[str, object]:
    result = run_sync_tool("calculate", "Evaluated arithmetic expression", lambda: app.state.tool_service.calculate(request.expression))
    return {"expression": request.expression, "result": result}


@app.post("/api/tools/file-search")
async def file_search(request: FileSearchRequest) -> dict[str, object]:
    results = run_sync_tool("file_search", "Searched configured document folder", lambda: app.state.tool_service.search_files(request.query))
    return {"matches": results}


@app.post("/api/tools/weather")
async def get_weather(request: WeatherRequest) -> dict[str, object]:
    return await run_async_tool("weather", "Looked up current weather", app.state.tool_service.weather(request.place))


@app.post("/api/tools/web-search")
async def web_search(request: WebSearchRequest) -> dict[str, object]:
    results = await run_async_tool("web_search", "Searched configured SearXNG instance", app.state.tool_service.web_search(request.query))
    return {"results": results}


@app.post("/api/tools/reminders")
async def create_reminder(request: ReminderRequest) -> dict[str, object]:
    result = run_sync_tool(
        "reminders",
        "Created a local reminder",
        lambda: app.state.tool_service.create_reminder(request.task, request.due_at),
    )
    return result


@app.get("/api/tools/reminders")
async def list_reminders() -> list[dict[str, object]]:
    return app.state.tool_service.list_reminders()


@app.patch("/api/tools/reminders/{reminder_id}/complete")
async def complete_reminder(reminder_id: int) -> dict[str, bool]:
    completed = run_sync_tool(
        "reminders",
        "Completed a local reminder",
        lambda: app.state.tool_service.complete_reminder(reminder_id),
    )
    if not completed:
        raise HTTPException(status_code=404, detail="Reminder not found.")
    return {"completed": True}


@app.post("/api/tools/email-drafts")
async def create_email_draft(request: EmailDraftRequest) -> dict[str, object]:
    return run_sync_tool(
        "email_drafts",
        "Saved an email draft; nothing was sent",
        lambda: app.state.tool_service.create_email_draft(request.recipient, request.subject, request.body),
    )


@app.get("/api/tools/email-drafts")
async def list_email_drafts() -> list[dict[str, object]]:
    return app.state.tool_service.list_email_drafts()


@app.post("/api/tools/home/preview")
async def preview_home_action(request: HomeActionPreviewRequest) -> dict[str, object]:
    result = run_sync_tool(
        "home_assistant",
        f"Previewed {request.action} for {request.entity_id}",
        lambda: app.state.tool_service.preview_home_action(request.entity_id, request.action),
    )
    return result


@app.post("/api/tools/home/execute")
async def execute_home_action(request: HomeActionConfirmRequest) -> dict[str, object]:
    return await run_async_tool(
        "home_assistant",
        "Executed a user-confirmed Home Assistant action",
        app.state.tool_service.execute_home_action(request.confirmation_token),
    )


@app.get("/api/voice/status")
async def voice_status() -> dict[str, object]:
    return {
        "transcription": "local-whisper",
        "model": app.state.voice_transcriber.model_size,
        "languages": ["auto", "en", "ta", "hi"],
        "maximum_audio_bytes": MAX_AUDIO_BYTES,
        "installed": find_spec("faster_whisper") is not None,
        "speech_synthesis": "browser-native",
        "wake_word": "opt-in browser recognition; provider privacy depends on browser",
    }


@app.post("/api/voice/transcribe", response_model=VoiceTranscriptionResponse)
async def transcribe_voice(request: Request, language: Literal["auto", "en", "ta", "hi"] = "auto") -> dict[str, object]:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in SUPPORTED_AUDIO_TYPES:
        raise HTTPException(status_code=415, detail="Use WebM, Ogg, WAV, MP4, or MP3 audio.")
    audio = bytearray()
    async for chunk in request.stream():
        audio.extend(chunk)
        if len(audio) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio exceeds the 25 MB limit.")
    try:
        return await run_in_threadpool(
            app.state.voice_transcriber.transcribe,
            bytes(audio),
            language,
            content_type,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/vision/status")
async def vision_status() -> dict[str, object]:
    return app.state.vision_service.status()


@app.post("/api/vision/analyze")
async def analyze_image(
    request: Request,
    include_ocr: bool = False,
    include_description: bool = False,
    ocr_language: Literal["eng", "tam", "hin"] = "eng",
) -> dict[str, object]:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in SUPPORTED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="Use JPEG, PNG, or WebP images.")
    image = bytearray()
    async for chunk in request.stream():
        image.extend(chunk)
        if len(image) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Image exceeds the 12 MB limit.")
    try:
        return await run_in_threadpool(
            app.state.vision_service.analyze,
            bytes(image),
            content_type,
            include_ocr,
            include_description,
            ocr_language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc