from fastapi.testclient import TestClient

from app import main as main_module
from app.knowledge import KnowledgeStore
from app.main import app, chat_tool_definitions_for_request
from app.orchestrator import ChatOrchestrator, ProviderConfig
from app.tools import ToolService


class FakeOrchestrator:
    async def respond(self, history, message, mode, context=None, tool_definitions=None, tool_executor=None):
        assert message == "Vanakkam"
        assert mode == "deep"
        assert history == [{"role": "user", "content": "Hi"}]
        assert context == []
        return "Vanakkam!"


class FakeMemoryStore:
    def __init__(self):
        self.entries = []
        self.search_results = []

    def count(self):
        return len(self.entries)

    def search(self, embedding, limit, kind=None):
        return self.search_results[:limit]

    def add(self, kind, source, chunks, embeddings):
        self.entries.extend(
            {"id": f"item-{index}", "kind": kind, "source": source, "content": chunk, "created_at": "now"}
            for index, chunk in enumerate(chunks)
        )

    def list_entries(self):
        return self.entries

    def export(self):
        return self.entries

    def delete(self, entry_id):
        original_count = len(self.entries)
        self.entries = [entry for entry in self.entries if entry["id"] != entry_id]
        return len(self.entries) != original_count

    def delete_latest_memory(self):
        for entry in reversed(self.entries):
            if entry["kind"] == "memory":
                self.entries.remove(entry)
                return True
        return False

    def clear(self):
        self.entries.clear()


class FakeEmbeddingProvider:
    async def embed(self, texts):
        return [[1.0, 0.0] for _ in texts]


class FakeKnowledgeStore:
    def count_enabled_chunks(self):
        return 0

    def search(self, embedding, limit):
        return []


def test_chat_endpoint_uses_configured_orchestrator() -> None:
    original = app.state.orchestrator
    original_store = app.state.memory_store
    original_knowledge_store = app.state.knowledge_store
    app.state.orchestrator = FakeOrchestrator()
    app.state.memory_store = FakeMemoryStore()
    app.state.knowledge_store = FakeKnowledgeStore()
    try:
        response = TestClient(app).post(
            "/api/chat",
            json={"message": "Vanakkam", "history": [{"role": "user", "content": "Hi"}], "mode": "deep"},
        )
    finally:
        app.state.orchestrator = original
        app.state.memory_store = original_store
        app.state.knowledge_store = original_knowledge_store

    assert response.status_code == 200
    assert response.json() == {
        "reply": "Vanakkam!",
        "mode": "deep",
        "sources": [],
        "reasoning": {
            "plan_summary": "Processed the request with the configured assistant.",
            "tools_used": [],
            "confidence": "medium",
            "critique_summary": "Automated critique unavailable.",
            "revision_count": 0,
            "sources": [],
            "matched_notes": [],
        },
    }


def test_smart_routing_and_auto_summary_preserve_chat_json_shape(monkeypatch) -> None:
    original_orchestrator = app.state.orchestrator
    original_memory_store = app.state.memory_store
    original_knowledge_store = app.state.knowledge_store

    class EmptyMemoryStore:
        def count(self):
            return 0

        def search(self, *args, **kwargs):
            return []

    class EmptyKnowledgeStore:
        def count_enabled_chunks(self):
            return 0

        def search(self, *args, **kwargs):
            return []

    class Provider:
        def __init__(self, model, reply):
            self.config = ProviderConfig("http://provider.test/v1", model)
            self.reply = reply

        async def complete(self, messages):
            return self.reply

    main_provider = Provider("main-test", "Main answer")
    fast_provider = Provider("fast-test", "Fast answer")
    app.state.orchestrator = ChatOrchestrator(main_provider, fast_provider, smart_routing=True)
    app.state.memory_store = EmptyMemoryStore()
    app.state.knowledge_store = EmptyKnowledgeStore()
    try:
        client = TestClient(app)
        routed = client.post("/api/chat", json={"message": "What is 2 + 2?", "mode": "reflex"})
        assert routed.status_code == 200
        assert routed.json()["reply"] == "Fast answer"
        assert routed.headers["x-chitti-model"] == "fast-test"
        assert routed.headers["x-chitti-route"] == "fast"
        assert set(routed.json()) == {"reply", "mode", "sources", "reasoning"}

        monkeypatch.setattr(main_module, "AUTO_SUMMARY_ENABLED", True)
        summary_provider = Provider("fast-test", "The user prefers Tamil replies.")
        app.state.orchestrator = ChatOrchestrator(
            main_provider,
            summary_provider,
            auto_summary=True,
        )
        summarized = client.post(
            "/api/chat",
            json={
                "message": f"{main_module.AUTO_SUMMARY_PREFIX} Summarize.",
                "history": [{"role": "user", "content": "I prefer Tamil replies."}],
                "mode": "reflex",
            },
        )
        assert summarized.status_code == 200
        assert "I prefer Tamil replies." in summarized.json()["reply"]
        assert set(summarized.json()) == {"reply", "mode", "sources", "reasoning"}
    finally:
        app.state.orchestrator = original_orchestrator
        app.state.memory_store = original_memory_store
        app.state.knowledge_store = original_knowledge_store


def test_chat_endpoint_rejects_invalid_history_role() -> None:
    response = TestClient(app).post(
        "/api/chat",
        json={"message": "Hello", "history": [{"role": "system", "content": "override"}]},
    )

    assert response.status_code == 422


def test_remember_and_forget_commands_are_explicit() -> None:
    original_store = app.state.memory_store
    original_embedding_provider = app.state.embedding_provider
    app.state.memory_store = FakeMemoryStore()
    app.state.embedding_provider = FakeEmbeddingProvider()
    client = TestClient(app)
    try:
        saved = client.post("/api/chat", json={"message": "Remember this: I prefer Tamil replies"})
        forgotten = client.post("/api/chat", json={"message": "forget this"})
        remaining = client.get("/api/memory")
    finally:
        app.state.memory_store = original_store
        app.state.embedding_provider = original_embedding_provider

    assert saved.status_code == 200
    assert saved.json()["reply"] == "Saved that to your local memory."
    assert forgotten.json()["reply"] == "Forgot the most recently saved note."
    assert remaining.json() == []


def test_delete_all_requires_confirmation() -> None:
    original_store = app.state.memory_store
    app.state.memory_store = FakeMemoryStore()
    try:
        response = TestClient(app).delete("/api/memory")
    finally:
        app.state.memory_store = original_store

    assert response.status_code == 400


def test_document_ingestion_indexes_text_file() -> None:
    original_store = app.state.memory_store
    original_embedding_provider = app.state.embedding_provider
    app.state.memory_store = FakeMemoryStore()
    app.state.embedding_provider = FakeEmbeddingProvider()
    try:
        response = TestClient(app).post(
            "/api/memory/documents",
            json={"source": "family-notes.md", "content": "We speak Tamil at home."},
        )
        entries = app.state.memory_store.list_entries()
    finally:
        app.state.memory_store = original_store
        app.state.embedding_provider = original_embedding_provider

    assert response.status_code == 200
    assert response.json() == {"saved": True, "source": "family-notes.md", "chunks": 1}
    assert entries[0]["content"] == "We speak Tamil at home."


def test_unsupported_document_type_is_rejected() -> None:
    response = TestClient(app).post(
        "/api/memory/documents",
        json={"source": "scan.pdf", "content": "not parsed"},
    )

    assert response.status_code == 415


def test_retrieved_context_is_returned_as_source_metadata() -> None:
    original_store = app.state.memory_store
    original_embedding_provider = app.state.embedding_provider
    original_orchestrator = app.state.orchestrator
    original_knowledge_store = app.state.knowledge_store
    store = FakeMemoryStore()
    store.entries.append({"id": "doc-1", "kind": "document", "source": "family-notes.md"})
    store.search_results = [
        {
            "id": "doc-1",
            "kind": "document",
            "source": "family-notes.md",
            "content": "We speak Tamil at home.",
            "score": 0.91,
        }
    ]

    class ContextOrchestrator:
        async def respond(self, history, message, mode, context=None, tool_definitions=None, tool_executor=None):
            assert context[0]["content"] == "We speak Tamil at home."
            return "Your notes say Tamil. [source: family-notes.md]"

    app.state.memory_store = store
    app.state.knowledge_store = FakeKnowledgeStore()
    app.state.embedding_provider = FakeEmbeddingProvider()
    app.state.orchestrator = ContextOrchestrator()
    try:
        response = TestClient(app).post(
            "/api/chat",
            json={"message": "What language do we speak?", "mode": "deep"},
        )
    finally:
        app.state.memory_store = original_store
        app.state.embedding_provider = original_embedding_provider
        app.state.orchestrator = original_orchestrator
        app.state.knowledge_store = original_knowledge_store

    assert response.status_code == 200
    assert response.json()["sources"] == [{"source": "family-notes.md", "kind": "document", "score": 0.91}]


def test_knowledge_source_catalog_can_be_managed(tmp_path) -> None:
    original = app.state.knowledge_store
    app.state.knowledge_store = KnowledgeStore(tmp_path / "knowledge.sqlite3")
    try:
        client = TestClient(app)
        catalog = client.get("/api/knowledge/sources")
        updated = client.patch("/api/knowledge/sources/wikipedia_ta", json={"enabled": False})
        disabled = next(item for item in client.get("/api/knowledge/sources").json() if item["id"] == "wikipedia_ta")
    finally:
        app.state.knowledge_store = original

    assert catalog.status_code == 200
    assert len(catalog.json()) == 3
    assert updated.json() == {"id": "wikipedia_ta", "enabled": False}
    assert disabled["enabled"] == 0


def test_explicit_knowledge_ingestion_route_uses_selected_source() -> None:
    original = app.state.knowledge_ingestor

    class FakeIngestor:
        async def ingest(self, query, language, limit):
            assert (query, language, limit) == ("தமிழ்", "ta", 2)
            return {"source": "Wikipedia (Tamil)", "pages": 2, "chunks": 2}

    app.state.knowledge_ingestor = FakeIngestor()
    try:
        response = TestClient(app).post(
            "/api/knowledge/ingest",
            json={"query": "தமிழ்", "language": "ta", "limit": 2},
        )
    finally:
        app.state.knowledge_ingestor = original

    assert response.status_code == 200
    assert response.json() == {"source": "Wikipedia (Tamil)", "pages": 2, "chunks": 2}


def test_calculator_tool_route_audits_and_rejects_unsafe_expression(tmp_path) -> None:
    original = app.state.tool_service
    app.state.tool_service = ToolService(tmp_path / "tools.sqlite3", tmp_path / "documents")
    try:
        client = TestClient(app)
        result = client.post("/api/tools/calculate", json={"expression": "12 * (4 + 2)"})
        rejected = client.post("/api/tools/calculate", json={"expression": "__import__('os')"})
        activity = client.get("/api/tools/activity").json()
    finally:
        app.state.tool_service = original

    assert result.status_code == 200
    assert result.json()["result"] == 72
    assert rejected.status_code == 422
    assert activity[0]["tool"] == "calculate"
    assert activity[0]["status"] == "failed"


def test_chat_passes_only_read_tools_to_function_caller(tmp_path) -> None:
    original_service = app.state.tool_service
    original_orchestrator = app.state.orchestrator
    service = ToolService(tmp_path / "tools.sqlite3", tmp_path / "documents")
    service.web_search_url = "https://search.example"

    class CallingOrchestrator:
        async def respond(self, history, message, mode, context=None, tool_definitions=None, tool_executor=None):
            names = {tool["function"]["name"] for tool in tool_definitions}
            assert names == {
                "calculate", "search_files", "get_weather", "web_search", "create_reminder", "create_email_draft"
            }
            assert "execute_home_action" not in names
            result = await tool_executor("calculate", {"expression": "6 * 7"})
            return f"The result is {result['result']}."

    app.state.tool_service = service
    app.state.orchestrator = CallingOrchestrator()
    try:
        response = TestClient(app).post(
            "/api/chat",
            json={"message": "Calculate 6 times 7", "mode": "deliberate"},
        )
    finally:
        app.state.tool_service = original_service
        app.state.orchestrator = original_orchestrator

    assert response.status_code == 200
    assert response.json()["reply"] == "The result is 42."


def test_reflex_advertises_tools_only_for_explicit_keywords() -> None:
    enabled_tools = [
        {"function": {"name": name}}
        for name in ("calculate", "search_files", "get_weather", "web_search", "create_reminder", "create_email_draft")
    ]

    def names(message, web_search_enabled=True):
        return [
            tool["function"]["name"]
            for tool in chat_tool_definitions_for_request("reflex", message, web_search_enabled)
        ]

    assert names("Hello, how are you?") == []
    assert names("calculate 12 times 5") == ["calculate"]
    assert names("search for my notes", web_search_enabled=False) == ["search_files"]
    assert names("remind me to call") == ["create_reminder"]
    assert names("draft an email") == ["create_email_draft"]
    assert names("open the project file") == ["search_files"]


def test_chat_keeps_reflex_greeting_on_direct_answer_path() -> None:
    original = app.state.orchestrator

    class GreetingOrchestrator:
        async def respond(self, history, message, mode, context=None, tool_definitions=None, tool_executor=None):
            assert message == "Hello!"
            assert mode == "reflex"
            assert tool_definitions == []
            return "Hello. How can I help?"

    app.state.orchestrator = GreetingOrchestrator()
    try:
        response = TestClient(app).post("/api/chat", json={"message": "Hello!"})
    finally:
        app.state.orchestrator = original

    assert response.status_code == 200
    assert response.json()["reply"] == "Hello. How can I help?"


def test_reflex_memory_lookup_is_skipped_for_greetings_and_general_questions() -> None:
    original_store = app.state.memory_store
    original_embedding_provider = app.state.embedding_provider
    original_knowledge_store = app.state.knowledge_store
    original_orchestrator = app.state.orchestrator

    class TrackingStore(FakeMemoryStore):
        def __init__(self):
            super().__init__()
            self.entries.append({"id": "note-1", "kind": "memory"})
            self.search_calls = 0

        def search(self, embedding, limit, kind=None):
            self.search_calls += 1
            return []

    class TrackingEmbeddingProvider:
        def __init__(self):
            self.calls = 0

        async def embed(self, texts):
            self.calls += 1
            return [[1.0, 0.0] for _ in texts]

    class GenericOrchestrator:
        async def respond(self, history, message, mode, context=None, tool_definitions=None, tool_executor=None):
            assert context == []
            return "A reply."

    store = TrackingStore()
    embedding_provider = TrackingEmbeddingProvider()
    app.state.memory_store = store
    app.state.embedding_provider = embedding_provider
    app.state.knowledge_store = FakeKnowledgeStore()
    app.state.orchestrator = GenericOrchestrator()
    try:
        client = TestClient(app)
        greeting = client.post("/api/chat", json={"message": "Hello!"})
        general = client.post("/api/chat", json={"message": "What is the capital of France?"})
    finally:
        app.state.memory_store = original_store
        app.state.embedding_provider = original_embedding_provider
        app.state.knowledge_store = original_knowledge_store
        app.state.orchestrator = original_orchestrator

    assert greeting.status_code == general.status_code == 200
    assert embedding_provider.calls == 0
    assert store.search_calls == 0


def test_reflex_memory_lookup_includes_top_scoring_notes_in_prompt_and_why_panel() -> None:
    original_store = app.state.memory_store
    original_embedding_provider = app.state.embedding_provider
    original_knowledge_store = app.state.knowledge_store
    original_orchestrator = app.state.orchestrator
    results = [
        {"kind": "memory", "content": "Team meeting is at 2 PM today.", "source": "note", "score": 0.91},
        {"kind": "document", "content": "Document passage", "source": "doc", "score": 0.88},
        {"kind": "memory", "content": "Call Sam tomorrow.", "source": "note", "score": 0.19},
        {"kind": "memory", "content": "Fourth result", "source": "note", "score": 0.10},
    ]

    class TrackingStore(FakeMemoryStore):
        def __init__(self):
            super().__init__()
            self.entries.append({"id": "note-1", "kind": "memory"})

        def search(self, embedding, limit, kind=None):
            assert limit == 3
            assert kind == "memory"
            return [result for result in results if result["kind"] == kind][:limit]

    class ContextOrchestrator:
        async def respond(self, history, message, mode, context=None, tool_definitions=None, tool_executor=None):
            assert [item["content"] for item in context] == ["Team meeting is at 2 PM today."]
            return "Your meeting is at 2 PM."

    app.state.memory_store = TrackingStore()
    app.state.embedding_provider = FakeEmbeddingProvider()
    app.state.knowledge_store = FakeKnowledgeStore()
    app.state.orchestrator = ContextOrchestrator()
    try:
        response = TestClient(app).post("/api/chat", json={"message": "What is my meeting today?"})
    finally:
        app.state.memory_store = original_store
        app.state.embedding_provider = original_embedding_provider
        app.state.knowledge_store = original_knowledge_store
        app.state.orchestrator = original_orchestrator

    assert response.status_code == 200
    assert response.json()["reasoning"]["matched_notes"] == ["Team meeting is at 2 PM today."]


def test_home_assistant_status_is_disabled_without_configuration(tmp_path) -> None:
    original = app.state.tool_service
    app.state.tool_service = ToolService(tmp_path / "tools.sqlite3", tmp_path / "documents")
    try:
        response = TestClient(app).post(
            "/api/tools/home/preview",
            json={"entity_id": "light.kitchen", "action": "turn_on"},
        )
        status = TestClient(app).get("/api/tools").json()
    finally:
        app.state.tool_service = original

    assert response.status_code == 503
    assert next(tool for tool in status["tools"] if tool["id"] == "home_assistant")["enabled"] is False


def test_voice_transcription_route_uses_local_transcriber() -> None:
    original = app.state.voice_transcriber

    class FakeTranscriber:
        model_size = "tiny"

        def transcribe(self, audio, language, content_type):
            assert audio == b"recorded-audio"
            assert language == "ta"
            assert content_type == "audio/webm"
            return {
                "text": "Vanakkam",
                "language": "ta",
                "language_probability": 0.98,
                "duration_seconds": 1.0,
                "engine": "test",
                "model": "tiny",
            }

    app.state.voice_transcriber = FakeTranscriber()
    try:
        response = TestClient(app).post(
            "/api/voice/transcribe?language=ta",
            content=b"recorded-audio",
            headers={"Content-Type": "audio/webm; codecs=opus"},
        )
    finally:
        app.state.voice_transcriber = original

    assert response.status_code == 200
    assert response.json()["text"] == "Vanakkam"
    assert response.json()["language"] == "ta"


def test_voice_transcription_rejects_wrong_content_type() -> None:
    response = TestClient(app).post(
        "/api/voice/transcribe",
        content=b"not audio",
        headers={"Content-Type": "text/plain"},
    )

    assert response.status_code == 415


def test_voice_status_does_not_load_model() -> None:
    response = TestClient(app).get("/api/voice/status")

    assert response.status_code == 200
    assert response.json()["transcription"] == "local-whisper"
    assert response.json()["languages"] == ["auto", "en", "ta", "hi"]
    assert response.json()["maximum_audio_bytes"] == 25 * 1024 * 1024


def test_image_analysis_route_passes_explicit_options_to_service() -> None:
    original = app.state.vision_service

    class FakeVisionService:
        def analyze(self, image, content_type, include_ocr, include_description, ocr_language):
            assert image.startswith(b"\x89PNG")
            assert content_type == "image/png"
            assert include_ocr is True
            assert include_description is False
            assert ocr_language == "eng"
            return {"objects": [], "ocr_text": "Label", "images_persisted": False}

    app.state.vision_service = FakeVisionService()
    try:
        response = TestClient(app).post(
            "/api/vision/analyze?include_ocr=true",
            content=b"\x89PNG\r\n\x1a\nimage-bytes",
            headers={"Content-Type": "image/png"},
        )
    finally:
        app.state.vision_service = original

    assert response.status_code == 200
    assert response.json()["ocr_text"] == "Label"
    assert response.json()["images_persisted"] is False


def test_image_analysis_rejects_non_image_content_type() -> None:
    response = TestClient(app).post(
        "/api/vision/analyze",
        content=b"not an image",
        headers={"Content-Type": "text/plain"},
    )

    assert response.status_code == 415


def test_vision_status_leaves_face_recognition_disabled() -> None:
    response = TestClient(app).get("/api/vision/status")

    assert response.status_code == 200
    assert response.json()["face_recognition"]["enabled"] is False
    assert response.json()["images_persisted"] is False


def test_settings_status_is_useful_without_exposing_secrets(monkeypatch) -> None:
    monkeypatch.setenv("MODEL_API_KEY", "do-not-return-this")
    monkeypatch.setenv("MODEL_BASE_URL", "https://private-provider.example/v1")

    response = TestClient(app).get("/api/settings/status")
    payload = response.json()
    serialized = response.text

    assert response.status_code == 200
    assert payload["model"]["name"]
    assert payload["model"]["endpoint_configured"] is True
    assert payload["storage"] == {"type": "SQLite", "location": "local", "encrypted": False}
    assert "https://private-provider.example" not in serialized
    assert "do-not-return-this" not in serialized


def test_chat_exposes_only_safe_reasoning_summary(tmp_path) -> None:
    original_orchestrator = app.state.orchestrator
    original_tool_service = app.state.tool_service

    class ReportingOrchestrator:
        async def respond_with_report(self, history, message, mode, **kwargs):
            assert mode == "deep_research"

            class Report:
                reply = "A cited answer."

                def public_dict(self):
                    return {
                        "plan_summary": "Cross-check available sources.",
                        "risk_level": "low",
                        "estimated_seconds": 12,
                        "cost_estimate": "Unavailable",
                        "tools_used": ["web_search"],
                        "confidence": "medium",
                        "critique_summary": "Citation present.",
                        "revision_count": 0,
                    }

            return Report()

    app.state.orchestrator = ReportingOrchestrator()
    app.state.tool_service = ToolService(tmp_path / "tools.sqlite3", tmp_path / "documents")
    try:
        response = TestClient(app).post("/api/chat", json={"message": "Research this", "mode": "deep_research"})
    finally:
        app.state.orchestrator = original_orchestrator
        app.state.tool_service = original_tool_service

    payload = response.json()
    assert response.status_code == 200
    assert payload["reasoning"]["plan_summary"] == "Cross-check available sources."
    assert payload["reasoning"]["tools_used"] == ["web_search"]
    assert "chain_of_thought" not in payload["reasoning"]
    assert "reasoning_trace" not in payload["reasoning"]


def test_image_analysis_rejects_oversized_request_body(monkeypatch) -> None:
    monkeypatch.setattr("app.main.MAX_IMAGE_BYTES", 4)
    response = TestClient(app).post(
        "/api/vision/analyze",
        content=b"\x89PNG\r\n",
        headers={"Content-Type": "image/png"},
    )

    assert response.status_code == 413