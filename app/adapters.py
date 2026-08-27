import json
from typing import AsyncIterator, Dict, Tuple

import httpx

from .models import Provider

EFFORT_BUDGETS = {"low": 4096, "medium": 16384, "high": 32000}

UNIFY_HEADERS = {"Accept": "text/event-stream", "Connection": "keep-alive"}


class ProviderError(Exception):
    pass


def _endpoint(provider: Provider) -> str:
    base = provider.baseUrl.rstrip("/")
    if provider.format == "anthropic":
        if base.endswith("/v1"):
            return base + "/messages"
        return base + "/v1/messages"
    if base.endswith("/chat/completions"):
        return base
    if "/v1" in base.rsplit("/", 1)[-1] or base.endswith("/v1"):
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def build_request(
    provider: Provider,
    system: str,
    messages: list,
    effort: str,
    stream: bool = True,
) -> Tuple[str, Dict[str, str], dict]:
    url = _endpoint(provider)
    if provider.format == "anthropic":
        headers = {
            "x-api-key": provider.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            **UNIFY_HEADERS,
        }
        payload = _anthropic_payload(provider, system, messages, effort, stream)
    else:
        headers = {
            "Authorization": f"Bearer {provider.apiKey}",
            "Content-Type": "application/json",
            **UNIFY_HEADERS,
        }
        payload = _openai_payload(provider, system, messages, effort, stream)
    return url, headers, payload


def _anthropic_payload(provider: Provider, system: str, messages: list, effort: str, stream: bool) -> dict:
    msgs = []
    for m in messages:
        blocks = []
        for p in m["parts"]:
            if p["type"] == "text":
                if p["text"].strip():
                    blocks.append({"type": "text", "text": p["text"]})
            elif p["type"] == "image":
                blocks.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": p["media_type"], "data": p["data"]},
                })
            elif p["type"] == "pdf":
                blocks.append({
                    "type": "document",
                    "source": {"type": "base64", "media_type": "application/pdf", "data": p["data"]},
                })
        if not blocks:
            blocks = [{"type": "text", "text": "(empty)"}]
        msgs.append({"role": m["role"], "content": blocks})
    payload = {
        "model": provider.model,
        "max_tokens": provider.maxTokens or 8192,
        "stream": stream,
        "messages": msgs,
    }
    if system.strip():
        payload["system"] = system
    if effort != "none":
        budget = EFFORT_BUDGETS[effort]
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
        payload["max_tokens"] = max(payload["max_tokens"], budget + 2048)
    return payload


def _openai_payload(provider: Provider, system: str, messages: list, effort: str, stream: bool) -> dict:
    msgs = []
    if system.strip():
        msgs.append({"role": "system", "content": system})
    for m in messages:
        texts = []
        images = []
        for p in m["parts"]:
            if p["type"] == "text":
                texts.append(p["text"])
            elif p["type"] == "image":
                images.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{p['media_type']};base64,{p['data']}"},
                })
            elif p["type"] == "pdf":
                texts.append(f"[attached PDF could not be sent via OpenAI format; skipped]")
        content = "\n\n".join(texts)
        if images:
            parts = ([{"type": "text", "text": content}] if content else []) + images
            content = parts
        msgs.append({"role": m["role"], "content": content})
    payload = {"model": provider.model, "messages": msgs, "stream": stream}
    if provider.maxTokens:
        payload["max_tokens"] = provider.maxTokens
    if effort != "none":
        payload["reasoning_effort"] = effort
    return payload


def _sse_data_lines(chunk: bytes, buffer: str):
    buffer += chunk.decode("utf-8", errors="replace")
    events = []
    while "\n" in buffer:
        line, buffer = buffer.split("\n", 1)
        line = line.strip()
        if line.startswith("data:"):
            events.append(line[5:].strip())
    return events, buffer


async def stream_upstream(
    url: str, headers: dict, payload: dict, provider_format: str
) -> AsyncIterator[dict]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=15.0)) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", errors="replace")[:2000]
                yield {"type": "error", "message": f"HTTP {resp.status_code}: {body}"}
                return
            buffer = ""
            async for chunk in resp.aiter_bytes():
                events, buffer = _sse_data_lines(chunk, buffer)
                for data in events:
                    if data == "[DONE]":
                        yield {"type": "done"}
                        return
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for ev in _parse_event(obj, provider_format):
                        yield ev
            yield {"type": "done"}


def _parse_event(obj: dict, provider_format: str):
    if provider_format == "anthropic":
        etype = obj.get("type")
        if etype == "content_block_delta":
            delta = obj.get("delta", {})
            if delta.get("type") == "text_delta":
                text = delta.get("text", "")
                if text:
                    yield {"type": "delta", "text": text}
        elif etype == "message_start":
            usage = obj.get("message", {}).get("usage", {}) or {}
            if usage.get("input_tokens") is not None:
                yield {"type": "usage", "input": usage["input_tokens"], "output": 0}
        elif etype == "message_delta":
            usage = obj.get("usage", {}) or {}
            if usage.get("output_tokens") is not None:
                yield {"type": "usage", "output": usage["output_tokens"]}
        elif etype == "error":
            err = obj.get("error", {})
            yield {"type": "error", "message": err.get("message", "unknown error")}
    else:
        choices = obj.get("choices") or []
        if choices:
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                yield {"type": "delta", "text": text}
        usage = obj.get("usage")
        if usage:
            yield {
                "type": "usage",
                "input": usage.get("prompt_tokens", 0),
                "output": usage.get("completion_tokens", 0),
            }


async def complete_upstream(url: str, headers: dict, payload: dict, provider_format: str) -> str:
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
        resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code != 200:
            raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:500]}")
        obj = resp.json()
        if provider_format == "anthropic":
            blocks = obj.get("content") or []
            return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        try:
            return obj["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError):
            return ""
