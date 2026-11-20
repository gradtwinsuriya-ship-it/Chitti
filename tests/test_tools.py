from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.tools import ToolService


def test_math_evaluator_supports_basic_operations_without_eval(tmp_path) -> None:
    tools = ToolService(tmp_path / "tools.sqlite3", tmp_path / "documents")

    assert tools.calculate("-(2 + 3) * 4 ** 2") == -80
    with pytest.raises(ValueError, match="Only numeric literals"):
        tools.calculate("__import__('os').getcwd()")
    with pytest.raises(ValueError):
        tools.calculate("(-2) ** 0.5")
    with pytest.raises(ValueError):
        tools.calculate("999999999999 ** 12")


def test_file_search_is_confined_to_its_root(tmp_path) -> None:
    root = tmp_path / "documents"
    root.mkdir()
    (root / "notes.txt").write_text("The secret word is mangosteen.\n", encoding="utf-8")
    tools = ToolService(tmp_path / "tools.sqlite3", root)

    matches = tools.search_files("mangosteen")

    assert matches == [{"path": "notes.txt", "line": 1, "snippet": "The secret word is mangosteen."}]
    with pytest.raises(ValueError, match="at least two characters"):
        tools.search_files("x")


def test_reminders_and_email_drafts_persist_without_send_capability(tmp_path) -> None:
    database = tmp_path / "tools.sqlite3"
    tools = ToolService(database, tmp_path / "documents")
    due = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

    reminder = tools.create_reminder("Call the dentist", due)
    draft = tools.create_email_draft("family@example.com", "Dinner", "Would Saturday work?")
    reopened = ToolService(database, tmp_path / "documents")

    assert reopened.list_reminders()[0]["id"] == reminder["id"]
    assert reopened.list_email_drafts()[0]["id"] == draft["id"]
    assert not hasattr(reopened, "send_email")
    with pytest.raises(ValueError, match="valid recipient"):
        tools.create_email_draft("not-an-address", "Dinner", "Details")


@pytest.mark.asyncio
async def test_home_action_requires_allowlist_preview_and_single_use_confirmation(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/services/light/turn_on"
        assert request.headers["Authorization"] == "Bearer test-token"
        assert request.read() == b'{"entity_id":"light.kitchen"}'
        return httpx.Response(200, json=[{"entity_id": "light.kitchen", "state": "on"}])

    tools = ToolService(
        tmp_path / "tools.sqlite3",
        tmp_path / "documents",
        home_assistant_url="http://homeassistant.local:8123",
        home_assistant_token="test-token",
        allowed_home_entities={"light.kitchen"},
        home_transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ValueError, match="allowlist"):
        tools.preview_home_action("light.bedroom", "turn_on")
    confirmation = tools.preview_home_action("light.kitchen", "turn_on")
    assert confirmation["expires_in_seconds"] == 90
    result = await tools.execute_home_action(confirmation["confirmation_token"])
    assert result["completed"] is True
    with pytest.raises(ValueError, match="invalid, expired, or already used"):
        await tools.execute_home_action(confirmation["confirmation_token"])


@pytest.mark.asyncio
async def test_weather_uses_open_meteo_geocoding_and_forecast(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "geocoding-api.open-meteo.com":
            return httpx.Response(
                200,
                json={"results": [{"name": "Chennai", "admin1": "Tamil Nadu", "country": "India", "latitude": 13.08, "longitude": 80.27}]},
            )
        return httpx.Response(
            200,
            json={"current": {"temperature_2m": 31, "relative_humidity_2m": 68, "weather_code": 2, "wind_speed_10m": 12, "time": "2026-10-01T12:00"}},
        )

    tools = ToolService(
        tmp_path / "tools.sqlite3",
        tmp_path / "documents",
        weather_transport=httpx.MockTransport(handler),
    )

    result = await tools.weather("Chennai")

    assert result["place"] == "Chennai, Tamil Nadu, India"
    assert result["temperature_c"] == 31
    assert result["provider"] == "Open-Meteo"


@pytest.mark.asyncio
async def test_web_search_uses_searxng_and_rejects_non_https_results(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/search"
        assert request.url.params["format"] == "json"
        return httpx.Response(
            200,
            json={"results": [
                {"title": "Unsafe", "url": "http://example.test", "content": "ignored"},
                {"title": "Safe", "url": "https://example.org", "content": "A result"},
            ]},
        )

    tools = ToolService(
        tmp_path / "tools.sqlite3",
        tmp_path / "documents",
        web_search_url="http://searxng.local",
        web_search_transport=httpx.MockTransport(handler),
    )

    results = await tools.web_search("open source")

    assert results == [{"title": "Safe", "url": "https://example.org", "snippet": "A result"}]