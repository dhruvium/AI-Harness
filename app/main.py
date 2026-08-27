import asyncio
import base64
import json
import os
import shutil
import time
import uuid

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .adapters import build_request, stream_upstream, complete_upstream, ProviderError
from .models import (
    Provider, ProviderIn, ChatRequest, Conversation, UploadOut,
    AppSettings, MemoryItem,
)

app = FastAPI(title="Personal AI Harness")
config.ensure_dirs()

MEMORY_PROMPT_SYSTEM = (
    "You maintain long-term memory for a personal AI assistant. "
    "Extract durable facts about the user, their preferences, goals, or ongoing projects "
    "that would be useful in future conversations. Reply with at most 3 short lines, "
    "one memory per line. Each line must be a standalone statement. "
    "If there is nothing worth remembering long-term, reply with exactly: NONE"
)
MEMORY_CAP = 200
EXTRACT_MIN_CHARS = 60

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".py", ".js", ".ts", ".tsx", ".jsx", ".json",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".sh", ".bat", ".ps1", ".css",
    ".html", ".xml", ".csv", ".sql", ".rs", ".go", ".java", ".c", ".h", ".cpp",
    ".rb", ".php", ".log", ".env", ".gitignore",
}
IMAGE_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

MAX_UPLOAD = 20 * 1024 * 1024


@app.get("/api/providers")
def list_providers():
    return [
        {**p, "apiKey": ("•" * 8) if p["apiKey"] else ""}
        for p in config.load_providers()
    ]


@app.post("/api/providers", response_model=Provider)
def create_provider(data: ProviderIn):
    providers = config.load_providers()
    provider = Provider(id=uuid.uuid4().hex[:12], **data.model_dump())
    providers.append(provider.model_dump())
    config.save_providers(providers)
    return provider


@app.put("/api/providers/{pid}", response_model=Provider)
def update_provider(pid: str, data: ProviderIn):
    providers = config.load_providers()
    for i, p in enumerate(providers):
        if p["id"] == pid:
            new = data.model_dump()
            if new["apiKey"] == "":
                new["apiKey"] = p["apiKey"]
            elif set(new["apiKey"]) == {"•"}:
                new["apiKey"] = p["apiKey"]
            merged = {**p, **new}
            providers[i] = merged
            config.save_providers(providers)
            return merged
    raise HTTPException(404, "provider not found")


@app.delete("/api/providers/{pid}")
def delete_provider(pid: str):
    providers = [p for p in config.load_providers() if p["id"] != pid]
    config.save_providers(providers)
    return {"ok": True}


@app.post("/api/upload", response_model=UploadOut)
async def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    mime = file.content_type or "application/octet-stream"
    if ext in IMAGE_MIMES:
        kind = "image"
        mime = IMAGE_MIMES[ext]
    elif ext == ".pdf" or mime == "application/pdf":
        kind = "pdf"
    elif ext in TEXT_EXTS or mime.startswith("text/"):
        kind = "text"
    else:
        kind = "text"

    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "file too large (max 20 MB)")

    uid = uuid.uuid4().hex[:12]
    safe_name = f"{uid}_{os.path.basename(file.filename or 'file')}"
    path = os.path.join(config.UPLOADS_DIR, safe_name)
    with open(path, "wb") as f:
        f.write(data)

    return UploadOut(id=uid, name=os.path.basename(file.filename or "file"),
                     size=len(data), mime=mime, kind=kind)


def _resolve_ref(upload_id: str) -> dict:
    target = None
    for name in os.listdir(config.UPLOADS_DIR):
        if name.startswith(upload_id + "_"):
            target = os.path.join(config.UPLOADS_DIR, name)
            break
    if not target:
        raise HTTPException(404, f"upload {upload_id} not found")
    ext = os.path.splitext(target)[1].lower()
    filename = os.path.basename(target).split("_", 1)[1] or target
    with open(target, "rb") as f:
        raw = f.read()
    if ext in IMAGE_MIMES:
        return {"type": "image", "media_type": IMAGE_MIMES[ext],
                "data": base64.b64encode(raw).decode()}
    if ext == ".pdf":
        return {"type": "pdf", "data": base64.b64encode(raw).decode()}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    return {"type": "text", "text": f"[file: {filename}]\n```\n{text}\n```"}


def _last_user_text(messages: list) -> str:
    for m in reversed(messages):
        if m["role"] == "user":
            return "\n".join(
                p.get("text", "") for p in m["parts"] if p.get("type") == "text"
            ).strip()
    return ""


def _memory_block() -> str:
    items = config.load_memory()
    if not items:
        return ""
    lines = "\n".join(f"- {i['text']}" for i in items[-MEMORY_CAP:])
    return (
        "\n\n## Long-term memory\n"
        "Facts remembered from previous sessions:\n" + lines
    )


async def _extract_memory(provider, user_text: str, assistant_text: str):
    if not user_text or not assistant_text or len(user_text) + len(assistant_text) < EXTRACT_MIN_CHARS:
        return
    if len(config.load_memory()) >= MEMORY_CAP:
        return
    transcript = f"User: {user_text[:4000]}\nAssistant: {assistant_text[:4000]}"
    messages = [{"role": "user", "parts": [{"type": "text", "text": transcript}]}]
    try:
        url, headers, payload = build_request(
            provider, MEMORY_PROMPT_SYSTEM, messages, "none", stream=False
        )
        text = await complete_upstream(url, headers, payload, provider.format)
    except Exception:
        return
    existing = {i["text"] for i in config.load_memory()}
    new_items = []
    for line in text.splitlines():
        line = line.strip().lstrip("-•* ").strip()
        if not line or line.upper().startswith("NONE") or len(line) < 4:
            continue
        if line[:200] in existing:
            continue
        new_items.append({"id": uuid.uuid4().hex[:12], "text": line[:200]})
        existing.add(line[:200])
        if len(new_items) >= 3:
            break
    if new_items:
        config.save_memory((config.load_memory() + new_items)[-MEMORY_CAP:])


@app.post("/api/chat")
async def chat(req: ChatRequest):
    providers = config.load_providers()
    provider = next((p for p in providers if p["id"] == req.providerId), None)
    if not provider:
        raise HTTPException(404, "provider not found")
    provider = Provider(**provider)

    expanded = []
    for m in req.messages:
        parts = []
        for p in m.parts:
            if p.type == "text":
                parts.append(p.model_dump())
            else:
                parts.append(_resolve_ref(p.uploadId))
        expanded.append({"role": m.role, "parts": parts})

    system = req.system
    if req.useMemory and config.load_settings()["memory"]["enabled"]:
        system += _memory_block()
    user_text = _last_user_text(expanded)

    async def gen():
        url, headers, payload = build_request(provider, system, expanded, req.effort)
        yield f"data: {json.dumps({'type': 'start'})}\n\n"
        queue: asyncio.Queue = asyncio.Queue()

        async def pump():
            try:
                async for ev in stream_upstream(url, headers, payload, provider.format):
                    await queue.put(ev)
            except Exception as e:
                await queue.put({"type": "error", "message": str(e)})
            finally:
                await queue.put(None)

        task = asyncio.create_task(pump())
        collected = []
        completed = False
        try:
            while True:
                ev = await queue.get()
                if ev is None:
                    completed = True
                    break
                if ev.get("type") == "delta":
                    collected.append(ev["text"])
                yield f"data: {json.dumps(ev)}\n\n"
                if ev.get("type") == "error":
                    break
        finally:
            task.cancel()
        if completed and req.useMemory:
            settings = config.load_settings()
            if settings["memory"]["enabled"]:
                asyncio.create_task(
                    _extract_memory(provider, user_text, "".join(collected))
                )

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/conversations")
def list_conversations():
    convs = config.load_conversations()
    convs.sort(key=lambda c: c.get("updatedAt", 0), reverse=True)
    return [{k: c[k] for k in ("id", "title", "providerId", "updatedAt")} for c in convs]


@app.get("/api/conversations/{cid}")
def get_conversation(cid: str):
    for c in config.load_conversations():
        if c["id"] == cid:
            return c
    raise HTTPException(404, "conversation not found")


@app.put("/api/conversations/{cid}")
def save_conversation(cid: str, conv: Conversation):
    convs = config.load_conversations()
    conv.id = cid
    conv.updatedAt = time.time()
    data = conv.model_dump()
    for i, c in enumerate(convs):
        if c["id"] == cid:
            convs[i] = data
            config.save_conversations(convs)
            return {"ok": True}
    convs.append(data)
    config.save_conversations(convs)
    return {"ok": True}


@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: str):
    convs = [c for c in config.load_conversations() if c["id"] != cid]
    config.save_conversations(convs)
    return {"ok": True}


@app.get("/api/settings")
def get_settings():
    return config.load_settings()


@app.put("/api/settings")
def update_settings(data: AppSettings):
    merged = config.load_settings()
    merged["memory"]["enabled"] = data.memory.enabled
    merged["browser"]["enabled"] = data.browser.enabled
    merged["browser"]["ignoreCertErrors"] = data.browser.ignoreCertErrors
    config.save_settings(merged)
    return merged


@app.get("/api/memory")
def list_memory():
    return config.load_memory()


@app.post("/api/memory", response_model=MemoryItem)
def add_memory(item: MemoryItem):
    items = config.load_memory()
    entry = {"id": item.id or uuid.uuid4().hex[:12], "text": item.text.strip()[:200]}
    if not entry["text"]:
        raise HTTPException(422, "memory text is empty")
    config.save_memory((items + [entry])[-MEMORY_CAP:])
    return entry


@app.delete("/api/memory/{mid}")
def delete_memory(mid: str):
    items = [i for i in config.load_memory() if i["id"] != mid]
    config.save_memory(items)
    return {"ok": True}


def _clear_dir(path: str):
    removed = 0
    if os.path.isdir(path):
        for name in os.listdir(path):
            full = os.path.join(path, name)
            if os.path.isdir(full) and not os.path.islink(full):
                shutil.rmtree(full, ignore_errors=True)
            else:
                try:
                    os.remove(full)
                except OSError:
                    pass
            removed += 1
    os.makedirs(path, exist_ok=True)
    return removed


@app.post("/api/browser/clear-cache")
def browser_clear_cache():
    removed = _clear_dir(config.BROWSER_CACHE_DIR)
    return {"ok": True, "removed": removed}


@app.post("/api/browser/clear-data")
def browser_clear_data():
    removed = _clear_dir(config.BROWSER_PROFILE_DIR) + _clear_dir(config.BROWSER_CACHE_DIR)
    return {"ok": True, "removed": removed}


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
