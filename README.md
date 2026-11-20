# CHITTI-AI

Phase 2.5 / Phase 7: bounded text reasoning loop and responsive dashboard. Reflex answers directly; Deliberate adds a brief plan and critique; Deep Research asks for cross-checks and citations when multiple sources are available. The per-answer “Why?” disclosure shows a safe plan summary, tools, sources, estimated confidence, bounded risk/time estimate, and any revision count, never hidden chain-of-thought. The React dashboard includes chat, memory, sources, tools, voice, vision, and Settings. UI preferences are browser-local; Reset preferences does not delete notes/documents.

## Folder structure

```text
app/
  main.py                FastAPI routes and configuration
  knowledge.py           Licensed source catalog, Wikipedia fetch, knowledge vectors
  ingest_wikipedia.py    Standalone bounded Wikipedia ingestion command
  memory.py              SQLite vector store, embeddings, chunking
  tools.py               Math, file search, reminders, drafts, external integrations
  voice.py               Lazy local Whisper transcription service
  vision.py              Bounded image validation, YOLO, OCR, optional scene description
  orchestrator.py        Persona, response modes, model provider and RAG prompt
  static/dist/           Generated production front end served by FastAPI
  static_legacy/         Preserved pre-migration browser UI
frontend/                 React, TypeScript, Vite, and Tailwind source
tests/                   API, tools, knowledge, memory-store, and orchestration tests
requirements.txt         Python dependencies
Dockerfile               API container
docker-compose.yml       Local container runner
data/                    Local memory database (created at runtime; ignored by git)
```

## Local setup

Requires Python 3.10+, Node.js 20+, and Ollama if using the default provider. Install Ollama, then fetch the chat and multilingual embedding models:

```sh
ollama pull qwen2.5:3b
ollama pull bge-m3
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
cd frontend
npm install
npm run build
cd ..
uvicorn app.main:app --reload
```

The production app serves the landing page at `/`, the chat at `/chat`, and the compiled assets from `/assets`. For front-end development, start the FastAPI server as above, then in a second terminal run `cd frontend && npm run dev`; Vite proxies `/api` requests to `http://127.0.0.1:8000`.

Voice is an optional extra. To install local transcription, run `pip install -r requirements-voice.txt`. The Faster-Whisper `base` model downloads on the first transcription request (roughly 150 MB); budget around 1 GB or more of runtime RAM on CPU, with GPU acceleration optional. No speech model downloads when the app starts. Browser speech synthesis uses system-installed voices and has no extra model download.

Vision is a separate optional extra. Before downloading, note that `pip install -r requirements-vision.txt` installs Pillow, Ultralytics, and pytesseract; the PyTorch/Ultralytics stack can consume several GB of disk and needs several GB of RAM for CPU inference. The default `yolo11n.pt` weights are only several MB and download lazily on first detection. Install the Tesseract system binary separately if OCR is needed. For scene descriptions, configure a local compatible model, for example `VISION_BASE_URL=http://localhost:11434/v1` and `VISION_MODEL=llava:7b`; that model is several GB on disk and may need around 8 GB system RAM depending on quantization. These are rough planning figures; no vision package or model is downloaded automatically. Ultralytics licensing is AGPL-3.0; review its terms before commercial deployment.

Open http://localhost:8000. Health check: `curl http://localhost:8000/health` should return `{"status":"ok"}`. `qwen2.5:3b` handles chat; `bge-m3` embeds memories and queries for multilingual retrieval. To use another OpenAI-compatible service, configure `MODEL_BASE_URL`, `MODEL_NAME`, and (if required) `MODEL_API_KEY`; configure embedding endpoint/model separately with `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL_NAME`, and `EMBEDDING_API_KEY`. Keep `.env` private; never commit credentials.

### Local resource estimate

Before downloading: the Ollama `bge-m3` embedding model is roughly 1.2 GB on disk and typically needs a few GB of RAM while loaded; CPU works but may be slower, and a GPU is optional. The small `qwen2.5:3b` chat model adds roughly 2 GB of model files and several GB of runtime memory depending on quantization. Plan for around 4 GB of model storage plus application/database overhead and preferably 8 GB or more system RAM when running both locally. These are estimates, not guarantees; actual Ollama quantization and platform affect usage.

No knowledge content is fetched until you submit an indexing search in the Sources panel or call the ingestion API/CLI. Each request is capped at five page extracts, each up to about 6,000 characters before chunking, and Wikimedia requests are spaced by at least one second. A maximum-size request is roughly 30,000 characters and around 30 chunks; with 1,024-dimensional JSON embeddings, budget approximately 0.5-1 MB of SQLite storage per full request, plus indexes/overhead. The source catalog shows estimated indexed bytes per language. Typical results are smaller. There is no full dump, Common Crawl, or bulk corpus download in this phase.

Run focused tests:

```sh
pytest -q
```

To restore the pre-character-kit frontend files, remove the character-kit avatar assets, and rebuild the frontend in one step, run:

```sh
bash scripts/revert_character_kit.sh
```

## Container

Start Ollama on the host, create `.env` from `.env.example`, then run:

```sh
docker compose up --build
```

The compose configuration points chat and embedding requests at host Ollama and persists `./data` (memory, reminders, drafts, activity log, and documents) as `/app/data`. Models remain on the host and are not downloaded into the API image. For production, configure encrypted persistent storage and authentication before deployment.

## API

`GET /health` reports API process health; it does not verify model connectivity.

`POST /api/chat` accepts `message`, optional recent `history` (user/assistant roles only), and `mode` (`reflex`, `deliberate`, or `deep_research`; legacy `speed`/`deep` aliases remain supported). Example:

```sh
curl -s http://localhost:8000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Say hello in Tamil","mode":"speed"}'
```

The response contains `reply`, `mode`, `sources`, and a safe `reasoning` summary. Provider errors return HTTP 502. Chat history currently lives only in the browser tab and is sent to the configured model endpoint with each request; retrieved excerpts are also sent to that model endpoint, so use a trusted endpoint.

The text loop uses separate Planner, Executor, and Critic prompts in Deliberate/Deep Research. Guardrails cap work at 75 seconds, 6 model calls, 2 tool rounds, 4 tool calls, 12,000 history characters, 10,000 retrieved-context characters, 2,000 characters per tool argument, 8,000 total argument characters, 6,000 characters per tool result, 12,000 total result characters, 900 completion tokens per model call, and 1 critique-driven revision. The Planner's tool selection narrows the Executor allowlist. Reflex skips planner/critic calls for simple requests to minimize latency. Confidence, risk, and time are rough model estimates, not calibrated measurements or guarantees; cost is unknown until provider pricing is configured. Per-chat outcomes are logged as aggregate tool activity without storing the prompt text. This phase does not self-edit code, permissions, safety rules, or prompts; any adaptation proposals require human review.

### Optional routing and conversation summaries

Both features are disabled by default and do not change the chat request or JSON response shapes:

- Set `SMART_ROUTING=true` to route eligible, short Reflex messages to `FAST_MODEL_NAME` (default `gemma3:1b` at `FAST_MODEL_BASE_URL`, default local Ollama). Deliberate/Research, requests needing memory or sources, tool requests, and complex or longer prompts keep using `MODEL_NAME`. An empty or failed fast reply is retried once with the main model. The fast model uses `FAST_MODEL_KEEP_ALIVE` so Ollama can keep it resident. The fast model is intended for simple exchanges, not difficult reasoning, code, or reliable tool use.
- Set `AUTO_SUMMARY=true` on the server and enable **Summarize older conversation** in Settings to summarize older chat turns in a background request. The summary is capped at 150 words, kept separately in this browser tab's session storage, and sent alongside the six newest verbatim messages. The complete visible conversation remains unchanged. Missing or stale summaries are rebuilt when enough history is available. Memory retrieval continues independently and is not included in the summary.
- **Show model used on replies** in Settings reveals the model label. Routing, elapsed time, and an approximate prompt-size estimate are logged by the API process. The stream event format and response JSON remain unchanged; model metadata is exposed through response headers.

The retrieved-context cap remains 10,000 characters (approximately 2,500 English tokens, depending on language and content). Prompt-size logs are character-based token estimates, not provider tokenizer counts. No additional packages are required.

Memory routes:

- `GET /api/memory` lists saved memory/document chunks.
- `POST /api/memory` with `{ "content": "..." }` saves an explicit note.
- `POST /api/memory/documents` with `{ "source": "notes.md", "content": "..." }` indexes plain text or Markdown (maximum 200,000 characters per request).
- `DELETE /api/memory/{entry_id}` removes one chunk.
- `GET /api/memory/export` downloads the current memory as JSON.
- `DELETE /api/memory?confirm=true` permanently deletes all indexed memory; confirmation is required.

In chat, `Remember this: ...` saves a note and `forget this` removes the newest saved note. Only these explicit note commands are stored; chat history itself is not persisted. Retrieved personal passages are passed to the configured chat model and shown as source labels. They are marked as untrusted context in the prompt, but prompt-injection defenses are not a security boundary.

Knowledge routes:

- `GET /api/knowledge/sources` lists the English, Tamil, and Hindi Wikipedia sources, enablement, license, indexed chunk count, last indexing time, and retrieval count.
- `PATCH /api/knowledge/sources/{source_id}` with `{ "enabled": false }` disables retrieval (and ingestion) for that language without deleting its index.
- `POST /api/knowledge/ingest` with `{ "query": "Tamil language", "language": "en", "limit": 3 }` searches the official MediaWiki API and indexes up to five pages.

The same operation can be run from a terminal:

```sh
python -m app.ingest_wikipedia --query "தமிழ் மொழி" --language ta --limit 3
```

It uses `.env`, writes into `MEMORY_DB_PATH`, and prints a JSON summary. It does not run a background crawl.

Wikipedia extracts are supplied under `CC BY-SA 4.0`; retrieved results retain a canonical page URL, title, source language, and license for citation. Reuse must comply with attribution and share-alike terms. The ingestion path strips common instruction-like sentences and marks all retrieved passages as untrusted in the model prompt. This is a basic heuristic, not a comprehensive prompt-injection defense or fact verification system. Refresh is user-triggered; there is no scheduler in this phase.

Tool routes:

- `GET /api/tools` reports which optional integrations are configured.
- `GET /api/tools/activity` returns the latest 50 sanitized activity records.
- `POST /api/tools/calculate` with `{ "expression": "(18 * 24) / 3" }` evaluates bounded arithmetic via an AST allowlist; it does not execute Python code.
- `POST /api/tools/file-search` with `{ "query": "project" }` searches text-like files below `FILE_SEARCH_ROOT`.
- `POST /api/tools/weather` with `{ "place": "Chennai" }` uses Open-Meteo geocoding and current conditions.
- `POST /api/tools/web-search` with `{ "query": "..." }` uses a configured SearXNG JSON endpoint.
- `GET/POST /api/tools/reminders` lists or saves local reminders; `PATCH /api/tools/reminders/{id}/complete` marks a reminder complete.
- `GET/POST /api/tools/email-drafts` lists or saves an email draft. There is no email-send route.
- `POST /api/tools/home/preview` previews an allowlisted light/switch action; `POST /api/tools/home/execute` consumes its short-lived, one-use confirmation token.

Model function calling is limited to math, file search, weather, configured web search, local reminders, and unsent email drafts. Home Assistant execution is never model-callable. Tool results are treated as untrusted prompt text; activity summaries omit secrets and draft bodies.

Optional integrations, all configured through `.env`:

- `FILE_SEARCH_ROOT=./data/documents`: put supported text-like files here; supported extensions include `.txt`, `.md`, `.py`, `.json`, `.csv`, `.html`, `.css`, and `.js`.
- `WEB_SEARCH_URL=`: base URL for a trusted SearXNG instance, such as `http://localhost:8080` on the host. In Docker, use a host-reachable URL such as `http://host.docker.internal:8080`. Empty means disabled.
- `HOME_ASSISTANT_URL=`, `HOME_ASSISTANT_TOKEN=`, and `HOME_ALLOWED_ENTITIES=light.kitchen,switch.office_lamp`: only allowlisted lights and switches can use `turn_on` or `turn_off`. Keep the token private and expose Home Assistant only on a trusted network.
- Weather uses Open-Meteo without an API key for this small personal-use integration. Place names, coordinates, and weather requests are sent to Open-Meteo.

Reminders are stored, but no scheduler or notification service runs. Email drafts are stored and never sent. There is no Google/CalDAV calendar integration or MQTT bridge in this phase. The Home Assistant integration is opt-in and confirmation-gated.

Voice routes:

- `GET /api/voice/status` reports whether the optional Faster-Whisper package is installed and the configured model.
- `POST /api/voice/transcribe?language=auto` accepts raw audio bytes with `Content-Type: audio/webm`, `audio/ogg`, `audio/wav`, `audio/mp4`, or `audio/mpeg`; supported explicit language values are `en`, `ta`, and `hi`. Maximum request size is 25 MB.

The browser records only after the user presses Start; Stop submits that utterance to the local API. Transcribed text appears in the composer for review and is not sent automatically. This is per-utterance push-to-talk, not true streaming transcription. Reply speech is disabled until checked; the Stop speaking button interrupts the current utterance. Available speech voices depend on the operating system/browser. “Hey Chitti” is a separate opt-in browser SpeechRecognition feature: browser vendors may process its audio remotely, so it is not represented as private local wake-word detection. Disable it to stop listening.

Dashboard settings:

- `GET /api/settings/status` returns the chat model name, source counts, tool readiness, optional voice/vision readiness, and storage/authentication warnings. It does not return provider URLs or credentials.
- Browser preferences use local storage on this device/browser only; they are not uploaded as account settings. Reset preferences clears those UI choices only and does not delete notes, documents, reminders, or drafts.

Vision routes:

- `GET /api/vision/status` reports optional engines, model configuration, size caps, and whether images persist.
- `POST /api/vision/analyze?include_ocr=false&include_description=false&ocr_language=eng` accepts raw JPEG, PNG, or WebP bytes. Maximum request is 12 MB and 20 megapixels. YOLO object detection is attempted by default; OCR and scene description run only when their flags are true. OCR language values are `eng`, `tam`, and `hin`; install matching Tesseract trained data for Tamil/Hindi.

Camera access begins only after Start camera is pressed. Captures and uploaded images are held in browser memory, sent for analysis on explicit request, and are not stored by this app. When scene description is enabled, image bytes go to `VISION_BASE_URL`; use a local model endpoint if images must stay on-device. Face recognition is disabled because consent-based, encrypted enrollment and deletion are not implemented.

## Limits

This is a local slice, not a deployed or production-secured service. SQLite, documents, reminders, and drafts are **not encrypted**. There is no authentication, TLS termination, rate limiting, or multi-user isolation; do not expose this API publicly as-is. The vector index is an exact cosine scan intended for small collections, not large-scale indexing. The arithmetic tool evaluates only bounded basic math and is not a general-purpose code runner. Deep mode asks for an organized explanation, not hidden chain-of-thought. Retrieved pages have source links, but other claims are not independently fact-checked. No family biometric data is collected. A public deployment needs authentication, HTTPS, encrypted storage, rate limits, and a private credential flow.

The default models run locally without an API fee; hosted model costs depend on the provider. The small Wikipedia API use is subject to Wikimedia's terms and rate policies. Open-Meteo access is subject to its current usage terms. SearXNG is free software but needs a reachable instance and its own hosting/maintenance. Home Assistant requires an existing instance. No deployment or public URL has been configured.
