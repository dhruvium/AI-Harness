# Personal AI Harness

A local-first, self-hosted chat interface for working with LLM providers on your own machine. AI Harness gives you a clean web UI plus a FastAPI backend that can talk to **any OpenAI-compatible** or **Anthropic Messages** API endpoint — with streaming, reasoning ("thinking") support, file attachments, long-term memory, project workspaces, and a human-in-the-loop **Agent mode** that can read, write, and run commands inside a project folder.

Everything runs locally: your conversations, memories, API keys, and settings live in plain JSON files under `data/`, and nothing is sent anywhere except to the LLM providers you configure yourself.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Configuration](#configuration)
  - [Providers](#providers)
  - [Settings](#settings)
- [Feature Guides](#feature-guides)
  - [Chat & Streaming](#chat--streaming)
  - [Reasoning / Effort](#reasoning--effort)
  - [File Attachments](#file-attachments)
  - [Long-Term Memory](#long-term-memory)
  - [Projects & Agent Mode](#projects--agent-mode)
  - [Tool Approvals](#tool-approvals)
  - [Prevent Sleep](#prevent-sleep)
- [REST API Reference](#rest-api-reference)
- [Server-Sent Events (SSE) Protocol](#server-sent-events-sse-protocol)
- [Data & Storage](#data--storage)
- [Security Notes](#security-notes)
- [Tech Stack](#tech-stack)
- [Development Notes](#development-notes)

---

## Features

- **Multi-provider chat** — add any number of providers (OpenAI, Anthropic, OpenRouter, LM Studio, Ollama, vLLM, etc.). Switch between them per conversation from a dropdown.
- **Two wire formats** — `openai` (`POST {base}/v1/chat/completions`) and `anthropic` (`POST {base}/v1/messages`). The backend normalizes both into one internal event stream.
- **Real-time streaming** — responses stream token-by-token over Server-Sent Events (SSE), including usage (token counts) surfaced from the provider.
- **Reasoning display** — reasoning/thinking tokens (`thinking_delta` from Anthropic, `reasoning_content` from OpenAI-style APIs) are captured and shown in collapsible "Thinking" blocks.
- **Effort control** — set reasoning effort to `none` / `low` / `medium` / `high`. For Anthropic this maps to an extended-thinking `budget_tokens` (4,096 / 16,384 / 32,000); for OpenAI-style APIs it maps to `reasoning_effort`.
- **File attachments** — upload images (PNG/JPG/WEBP/GIF), PDFs, and text/code files (up to 20 MB). Images and PDFs are inlined as base64; text files are inlined as fenced code blocks.
- **Long-term memory** — with memory enabled, the app silently extracts up to 3 durable facts after each completed exchange and remembers up to 200 items across sessions. Memories are injected into the system prompt and can be reviewed/deleted in Settings.
- **Projects (workspaces)** — bind a chat to a local folder on disk using a native folder picker. Chats are grouped under their project in the sidebar.
- **Agent mode** — with a project folder attached, the model gets real tools: `write_file`, `read_file`, `list_dir`, and `run_command` (PowerShell). Every tool call requires your explicit approval before it executes (human-in-the-loop).
- **Context meter** — a live token-usage estimate for the conversation against the provider's context window, refined by real `usage` values reported by the provider.
- **Conversation management** — rename, delete, and archive/unarchive chats; archived chats are kept out of the main list in a dedicated view.
- **UI persistence** — last selected provider, effort, and system prompt are remembered between sessions.
- **Keep-awake (Windows)** — optionally prevent the machine from sleeping while the harness is running, so long agent tasks aren't interrupted.

---

## Requirements

- **Python 3.11+**
- **Windows** — the [run_command](#projects--agent-mode) agent tool invokes PowerShell and the keep-awake feature uses the Windows API. The chat features work on any OS, but agent mode and prevent-sleep are Windows-specific.
- [tkinter](https://docs.python.org/3/library/tkinter.html) (bundled with the standard Windows Python installer) — needed for the native project folder picker.

## Getting Started

1. **Clone the repository**

   ```powershell
   git clone https://github.com/dhruvium/AI-Harness.git
   cd "AI Harness"
   ```

2. **(Recommended) Create a virtual environment**

   ```powershell
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   ```

3. **Install dependencies**

   ```powershell
   pip install -r requirements.txt
   ```

   Dependencies: `fastapi`, `uvicorn[standard]`, `httpx`, `python-multipart`, `pydantic`.

4. **Run the app**

   ```powershell
   python run.py
   ```

   This starts a Uvicorn server at **http://127.0.0.1:8321** (host/port are defined in `run.py`).

5. **Add a provider** — open the UI, click **⚙ Settings → Providers**, and add your first provider (see [Providers](#providers)).

6. **Chat** — pick the provider in the top bar and start sending messages.

---

## Project Structure

```
AI Harness/
├── run.py                  # Entry point — launches uvicorn on 127.0.0.1:8321
├── requirements.txt        # Python dependencies
├── data/                   # All runtime state (created on first run)
│   ├── providers.json      # Configured LLM providers (incl. API keys)
│   ├── conversations.json  # All chats (active + archived)
│   ├── memory.json         # Long-term memory items
│   ├── projects.json       # Project workspaces (name → folder path)
│   ├── settings.json       # App settings
│   ├── uploads/            # Uploaded files, prefixed with an upload id
│   └── browser/            # Built-in browser profile & cache dirs
│       ├── profile/
│       └── cache/
└── app/
    ├── main.py             # FastAPI app: all REST endpoints, SSE chat/agent loops,
    │                       # memory extraction, uploads, approvals
    ├── adapters.py         # Provider request/response adapters (OpenAI ↔ Anthropic),
    │                       # SSE stream parsing into unified events
    ├── tools.py            # Agent tool definitions & execution
    │                       # (write_file, read_file, list_dir, run_command)
    ├── models.py           # Pydantic models (Provider, ChatRequest, Conversation, …)
    ├── config.py           # JSON persistence layer (atomic writes, thread-locked)
    ├── keepawake.py        # Windows SetThreadExecutionState keep-awake helper
    └── static/
        ├── index.html      # Single-page UI shell
        ├── app.js          # Frontend logic (SSE client, rendering, settings)
        └── style.css       # Styling
```

---

## Architecture

```
┌──────────────────────────────┐
│  Browser (static/ SPA)       │
│  index.html + app.js         │
│  - sessions sidebar          │
│  - SSE chat/agent client     │
│  - settings modal            │
└────────────┬─────────────────┘
             │ fetch / EventSource (SSE)
┌────────────▼─────────────────┐
│  FastAPI (app/main.py)       │
│  REST endpoints + SSE loops  │
│  - /api/chat  (streaming)    │
│  - /api/agent (tools+approvals)│
│  - memory extraction task    │
├──────────────────────────────┤
│  adapters.py                 │  build_request() → per-format URL/headers/payload
│  unified internal events     │  stream_upstream() → parse provider SSE → events
├──────────────────────────────┤
│  config.py                   │  JSON file store (atomic, thread-safe)
│  data/*.json                 │
└────────────┬─────────────────┘
             │ HTTPS (httpx, streaming)
   ┌─────────▼──────────┐   ┌──────────────────┐
   │ OpenAI-compatible  │   │ Anthropic        │
   │ /v1/chat/completions│  │ /v1/messages     │
   └────────────────────┘   └──────────────────┘
```

**Design highlights**

- **One internal message model.** Internally, every message is `{role, parts:[…]}` where parts are text, image, or PDF blocks, plus optional `toolCalls` on assistant messages and `tool` role results. `adapters.py` translates this to/from whichever provider format is selected (`_openai_payload` / `_anthropic_payload`).
- **Unified event stream.** Provider-specific SSE chunks are parsed into a common set of events (`delta`, `reasoning`, `tool_*`, `usage`, `error`, `done`) — see [SSE Protocol](#server-sent-events-sse-protocol). The frontend only knows the unified events.
- **Endpoint auto-resolution** (`_endpoint` in `app/adapters.py`): you supply a base URL like `https://api.openai.com/v1` or `https://api.anthropic.com`, and the correct `/chat/completions` or `/v1/messages` suffix is appended (already-complete URLs are used as-is).
- **Durable local storage.** `config.py` reads/writes JSON files with a thread lock and atomic replace (`*.tmp` → `os.replace`), so concurrent requests can't corrupt a file.

---

## Configuration

### Providers

Providers are managed in **⚙ Settings → Providers** (or via `POST /api/providers`).

| Field | Description |
|---|---|
| **Name** | Display name (e.g. "My OpenAI"). |
| **Model** | Model id sent to the API (e.g. `gpt-5`, `claude-sonnet-4-5`). |
| **Base URL** | API root, e.g. `https://api.openai.com/v1` or `https://api.anthropic.com`. |
| **API key** | Sent as `Authorization: Bearer …` (OpenAI format) or `x-api-key` (Anthropic format). Blank or `••••` on update = keep the existing key. |
| **Format** | `openai` (OpenAI-compatible) or `anthropic` (Anthropic Messages). |
| **Context window** | Token budget used by the UI context meter (default 128,000). |
| **Max output tokens** | Optional `max_tokens` override; defaults to 8,192 for Anthropic-format payloads. |

API keys are stored in plain text in `data/providers.json` (see [Security Notes](#security-notes)) but are always masked in API responses (`••••••••`).

### Settings

Settings live in `data/settings.json` under four sections, editable in **⚙ Settings → General**:

| Section | Keys | Effect |
|---|---|---|
| `memory` | `enabled` | Turns long-term memory extraction/injection on or off. |
| `browser` | `enabled`, `ignoreCertErrors` | Controls for the built-in browser feature. `ignoreCertErrors` disables HTTPS certificate verification (insecure; restart required). Buttons clear the browser cache or all browser data (`data/browser/`). |
| `power` | `preventSleep` | Keeps Windows awake while the app runs (see [Prevent Sleep](#prevent-sleep)). |
| `ui` | `lastProviderId`, `effort`, `systemPrompt` | Restores your last UI state on load. |

---

## Feature Guides

### Chat & Streaming

- Press **Enter** to send, **Shift+Enter** for a newline.
- Responses stream over SSE; text, reasoning, tool activity, and token usage all arrive as typed events.
- A **context meter** in the top bar estimates current token usage (≈ chars/4 for text, ~1,200 tokens per image, ~2,000 per PDF) against the provider's context window, and is corrected whenever the provider reports real usage.
- A per-conversation **System** prompt can be toggled in the top bar.

### Reasoning / Effort

The **Effort** dropdown maps to:

| Effort | Anthropic (`thinking`) | OpenAI-style (`reasoning_effort`) |
|---|---|---|
| `none` | disabled | omitted |
| `low` | `budget_tokens: 4096` | `low` |
| `medium` | `budget_tokens: 16384` | `medium` |
| `high` | `budget_tokens: 32000` | `high` |

When thinking is enabled for an Anthropic provider, `max_tokens` is raised to at least `budget + 2048`. Reasoning output is rendered in a collapsible **Thinking** block above the answer.

### File Attachments

Click **＋** in the composer to attach one or more files (max **20 MB** each):

- **Images** (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) → base64 image blocks. Works with both formats.
- **PDFs** → base64 `document` blocks for Anthropic. OpenAI-format providers currently receive a note that the PDF was skipped (`app/adapters.py`).
- **Text/code** (a broad extension list: `.py`, `.js`, `.md`, `.json`, `.yaml`, `.csv`, …) → inlined into the message as a fenced code block.

Uploads are stored in `data/uploads/` as `{uploadId}_{originalname}` and referenced by id in conversations, so the same file can be re-sent without re-uploading.

### Long-Term Memory

When **Memory** is enabled:

1. After a completed chat exchange (combined user + assistant text ≥ 60 chars), the backend makes a background call to the *same provider* with a memory-extraction system prompt.
2. The model returns up to 3 short standalone statements (`NONE` if nothing is worth keeping).
3. New, non-duplicate statements are appended to `data/memory.json` (capped at 200 items).

On subsequent requests with `useMemory: true`, the last 200 memories are injected into the system prompt under "Long-term memory". You can add or delete memories manually in **⚙ Settings → General → Stored memories**.

### Projects & Agent Mode

A **project** is a named binding to a folder on disk. Create one from the project chip near the composer — the app opens a native **tkinter** folder picker, then asks for a name. Chats assigned to a project appear grouped under it in the sidebar; deleting a project also deletes its chats.

**Agent mode** (the *Agent* toggle in the composer) requires an active project with a valid folder. The model is given four tools, all sandboxed to the project folder (`tools.py` enforces path containment via `os.path.realpath` — path escapes are rejected):

| Tool | Description |
|---|---|
| `write_file` | Create/overwrite a file (relative path + full content). |
| `read_file` | Read a text file (max 200 KB; binary files are rejected). |
| `list_dir` | List a directory (max 500 entries). |
| `run_command` | Run a **PowerShell** command with the project folder as cwd (`powershell -NoProfile -ExecutionPolicy Bypass -Command …`, 180 s timeout). |

The agent loop (`POST /api/agent`) runs up to **15 model turns**: the model streams a reply, may emit tool calls, each tool call goes through an approval gate, results are fed back as tool messages, and the loop continues until the model produces a reply with no tool calls (or the turn cap is hit). Tool outputs are truncated to 8,000 characters.

### Tool Approvals

Agent mode is human-in-the-loop. For every tool call the server emits an `approval_request` SSE event and pauses. The UI shows the tool, its arguments, and an **Allow / Deny** prompt. Your decision is sent to `POST /api/agent/approve` (`{streamId, callId, approved}`). If you don't respond within **300 seconds**, the call is automatically denied with `"DENIED: the user rejected this action."`. Only approved calls are executed (`tool_running` → `tool_result` events follow).

### Prevent Sleep

With **⚙ Settings → General → Power → Prevent sleep** enabled, a background thread calls the Windows API `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` (`app/keepawake.py`), which blocks system sleep (display can still turn off). The setting is applied on app startup and toggled live; disabling it restores normal power policy.

---

## REST API Reference

All endpoints are served from the same origin as the UI (`http://127.0.0.1:8321`). The UI itself is at `GET /`, static assets under `/static`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/providers` | List providers (API keys masked). |
| `POST` | `/api/providers` | Create a provider. |
| `PUT` | `/api/providers/{pid}` | Update a provider (blank/`•` key keeps existing). |
| `DELETE` | `/api/providers/{pid}` | Delete a provider. |
| `POST` | `/api/upload` | Upload a file (`multipart/form-data`, field `file`). Returns `{id, name, size, mime, kind}`. |
| `POST` | `/api/chat` | Non-agent streaming chat. **SSE** response. |
| `POST` | `/api/agent` | Agent-mode streaming chat (requires `projectId` with valid folder). **SSE** response. |
| `POST` | `/api/agent/approve` | Resolve a pending tool approval (`{streamId, callId, approved}`). |
| `GET` | `/api/conversations?archived=false` | List conversation summaries (newest first). |
| `GET` | `/api/conversations/{cid}` | Get one full conversation. |
| `PUT` | `/api/conversations/{cid}` | Create/update a conversation. |
| `DELETE` | `/api/conversations/{cid}` | Delete a conversation. |
| `PATCH` | `/api/conversations/{cid}/archive` | Archive/unarchive (`{"archived": bool}`). |
| `GET` | `/api/settings` | Get effective settings. |
| `PUT` | `/api/settings` | Merge-update settings sections (`memory`, `browser`, `power`, `ui`). |
| `GET` | `/api/memory` | List memory items. |
| `POST` | `/api/memory` | Add a memory item (`{"text": "…"}`). |
| `DELETE` | `/api/memory/{mid}` | Delete a memory item. |
| `GET` | `/api/projects` | List projects (sorted by name). |
| `POST` | `/api/projects` | Create a project (`{"name": "…", "path": "…?"}`). |
| `PUT` | `/api/projects/{pid}` | Rename a project. |
| `DELETE` | `/api/projects/{pid}` | Delete a project **and** all its chats. |
| `POST` | `/api/pick-folder` | Open a native folder-picker dialog; returns `{"path": "…"}`. |
| `POST` | `/api/browser/clear-cache` | Empty `data/browser/cache`. |
| `POST` | `/api/browser/clear-data` | Empty browser profile **and** cache. |

Interactive docs are auto-generated by FastAPI at `/docs` (Swagger UI) while the server runs.

---

## Server-Sent Events (SSE) Protocol

Both `/api/chat` and `/api/agent` respond with `text/event-stream`, one JSON object per `data:` line:

| Event `type` | Fields | Meaning |
|---|---|---|
| `start` | `streamId` (agent only) | Stream opened. `streamId` is needed for approval calls. |
| `delta` | `text` | Assistant text chunk. |
| `reasoning` | `text` | Reasoning/thinking chunk (shown in the Thinking block). |
| `usage` | `input`, `output` | Token counts reported by the provider. |
| `tool_call` | `id`, `tool`, `args`, `summary` | Agent wants to call a tool (informational; approval follows). |
| `approval_request` | `streamId`, `callId`, `tool`, `args`, `summary` | Waiting for your Allow/Deny decision. |
| `tool_running` | `id` | Approved call is executing. |
| `tool_result` | `id`, `ok`, `result` | Tool output (stdout/stderr/exit code, file result, or denial). |
| `error` | `message` | Upstream or processing error; stream ends. |
| `done` | — | Agent loop finished. |

---

## Data & Storage

All state is plain JSON on disk under `data/` — easy to inspect, back up, or reset. Writes are atomic (temp file + `os.replace`) and guarded by a process-wide lock (`app/config.py`). To start fresh, stop the server and delete the relevant file (or the whole `data/` folder; it is recreated on next launch).

| File / dir | Contents |
|---|---|
| `data/providers.json` | Provider configs incl. **API keys in plain text**. |
| `data/conversations.json` | Full message history for every chat (active and archived). |
| `data/memory.json` | Long-term memory items (`{id, text}`), ≤ 200. |
| `data/projects.json` | Projects: `{id, name, path, createdAt}`. |
| `data/settings.json` | `memory`, `browser`, `power`, `ui` sections. |
| `data/uploads/` | Uploaded attachments (`{uploadId}_{filename}`). |
| `data/browser/profile`, `data/browser/cache` | Working dirs reserved for the built-in browser; clearable from Settings. |

---

## Security Notes

- **Bind address.** The server binds to `127.0.0.1` only, so it is not reachable from other machines. There is **no authentication** — do not expose it (e.g. via a reverse proxy) without adding auth yourself.
- **API keys at rest.** Keys are stored unencrypted in `data/providers.json` and masked (`••••••••`) in API responses. Treat `data/` as sensitive.
- **Agent mode is powerful.** `run_command` executes arbitrary PowerShell as your user, gated only by the per-call approval prompt. `write_file`/`read_file`/`list_dir` are confined to the project folder, but `run_command` is not — it can touch anything your account can. Review each approval carefully, especially commands the model proposes.
- **Certificate bypass.** The browser `ignoreCertErrors` setting disables HTTPS verification for the built-in browser. Leave it off unless you're testing.
- **Uploads** are capped at 20 MB and text attachments are decoded leniently (UTF-8, falling back to Latin-1) before being inlined into prompts.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | Python 3.11, FastAPI, Uvicorn, Pydantic v2, httpx (async streaming client) |
| Frontend | Vanilla HTML/CSS/JS single-page app — no build step, no frameworks |
| Storage | Plain JSON files, atomic writes |
| Desktop integration | tkinter (folder picker), Windows `SetThreadExecutionState` (keep-awake), PowerShell (agent commands) |

## Development Notes

- **No build step.** Edit files in `app/static/` and refresh the browser. Backend changes require restarting `python run.py`.
- **Adding a tool** for agent mode: register it in `app/tools.py` (`TOOL_NAMES`, `_SCHEMAS`, `_DESCRIPTIONS`, an `execute_tool` branch, and `args_summary`); the loop, approval gate, and both provider formats pick it up automatically.
- **Adding a provider format**: extend `build_request`/`_parse_event` in `app/adapters.py` and `tool_specs` in `app/tools.py`.
- **Tunables** worth knowing (all in code): upload cap `MAX_UPLOAD = 20 MB`, command timeout `COMMAND_TIMEOUT = 180 s`, agent turn cap `MAX_AGENT_TURNS = 15`, approval timeout `APPROVAL_TIMEOUT = 300 s`, tool output truncation `MAX_OUTPUT = 8000` chars, read cap `MAX_READ = 200 KB`, memory cap `MEMORY_CAP = 200`, memory extraction minimum `EXTRACT_MIN_CHARS = 60`.
- **Data is git-ignored** — `data/`, `venv/`, and `__pycache__/` are excluded in `.gitignore`.
