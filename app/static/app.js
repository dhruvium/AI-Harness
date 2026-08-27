const $ = (id) => document.getElementById(id);

const state = {
  providers: [],
  sessions: [],
  current: null,
  providerId: null,
  effort: "none",
  system: "",
  attachments: [],
  streaming: false,
  abort: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function fmtNum(n) {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}

/* ---------- Providers ---------- */

async function loadProviders() {
  state.providers = await api("/api/providers");
  renderProviderSelect();
  renderProviderList();
}

function renderProviderSelect() {
  const sel = $("providerSelect");
  sel.innerHTML = "";
  if (!state.providers.length) {
    const o = document.createElement("option");
    o.textContent = "No providers configured";
    o.value = "";
    sel.appendChild(o);
    sel.disabled = true;
    state.providerId = null;
  } else {
    sel.disabled = false;
    for (const p of state.providers) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.name} — ${p.model}`;
      sel.appendChild(o);
    }
    if (!state.providers.find((p) => p.id === state.providerId)) {
      state.providerId = state.providers[0].id;
    }
    sel.value = state.providerId;
  }
  updateEffortAvail();
  updateContextMeter();
}

function currentProvider() {
  return state.providers.find((p) => p.id === state.providerId) || null;
}

function updateEffortAvail() {
  const p = currentProvider();
  const wrap = $("effortWrap");
  const sel = $("effortSelect");
  sel.disabled = !p;
  wrap.title = p
    ? "Reasoning effort — only supported by reasoning models"
    : "Select a provider first";
}

/* ---------- Context meter ---------- */

function conversationText() {
  if (!state.current) return "";
  let sys = state.system ? estimateTokens(state.system) : 0;
  let total = sys;
  for (const m of state.current.messages) {
    for (const part of m.parts) {
      if (part.type === "text") total += estimateTokens(part.text);
      else if (part.type === "image") total += 1200;
      else if (part.type === "pdf") total += 2000;
      else total += estimateTokens(JSON.stringify(part));
    }
    total += 4;
  }
  return total;
}

function updateContextMeter(usage) {
  const p = currentProvider();
  const bar = $("ctxBar");
  const label = $("ctxLabel");
  const meter = $("ctxMeter");
  if (!p) {
    label.textContent = "no provider";
    bar.style.width = "0%";
    bar.className = "";
    meter.title = "";
    return;
  }
  let used = conversationText();
  if (usage && usage.input != null) used = Math.max(used, usage.input + (usage.output || 0));
  const pct = Math.min(100, (used / p.contextWindow) * 100);
  bar.style.width = pct + "%";
  bar.className = pct > 90 ? "danger" : pct > 70 ? "warn" : "";
  label.textContent = `${fmtNum(used)} / ${fmtNum(p.contextWindow)} tok (${Math.round(pct)}%)`;
  meter.title = `${used.toLocaleString()} of ${p.contextWindow.toLocaleString()} tokens estimated`;
}

/* ---------- Sessions ---------- */

async function loadSessions() {
  state.sessions = await api("/api/conversations");
  renderSessions();
}

function renderSessions() {
  const list = $("sessionList");
  list.innerHTML = "";
  for (const s of state.sessions) {
    const div = document.createElement("div");
    div.className = "session" + (state.current && state.current.id === s.id ? " active" : "");
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = s.title || "Untitled";
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/conversations/${s.id}`, { method: "DELETE" });
      if (state.current && state.current.id === s.id) state.current = null;
      await loadSessions();
      renderMessages();
    };
    div.append(t, del);
    div.onclick = () => openSession(s.id);
    list.appendChild(div);
  }
}

async function openSession(id) {
  state.current = await api(`/api/conversations/${id}`);
  state.system = state.current.system || "";
  state.effort = state.current.effort || "none";
  $("systemPrompt").value = state.system;
  $("effortSelect").value = state.effort;
  if (state.current.providerId && state.providers.find((p) => p.id === state.current.providerId)) {
    state.providerId = state.current.providerId;
  }
  renderProviderSelect();
  renderSessions();
  renderMessages();
}

async function persistSession() {
  if (!state.current) return;
  state.current.system = state.system;
  state.current.effort = state.effort;
  state.current.providerId = state.providerId;
  if (state.current.messages.length && !state.current.title) {
    const first = state.current.messages[0].parts.find((p) => p.type === "text");
    state.current.title = (first ? first.text : "chat").slice(0, 40);
  }
  await api(`/api/conversations/${state.current.id}`, {
    method: "PUT",
    body: JSON.stringify(state.current),
  });
  await loadSessions();
}

function newSession() {
  state.current = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    title: "",
    providerId: state.providerId,
    effort: state.effort,
    system: state.system,
    messages: [],
    updatedAt: 0,
  };
  renderMessages();
  renderSessions();
  $("input").focus();
}

/* ---------- Messages ---------- */

function renderMessages() {
  const box = $("messages");
  box.innerHTML = "";
  if (!state.current) {
    box.innerHTML = `<div class="empty"><h2>Personal AI Harness</h2><p>Add a provider and start chatting. Shift+Enter for newline.</p></div>`;
    return;
  }
  for (const m of state.current.messages) {
    box.appendChild(renderMsg(m));
  }
  box.scrollTop = box.scrollHeight;
}

function renderMsg(m) {
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = m.role === "user" ? "you" : "assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(collectText(m.parts));
  div.append(who, bubble);
  return div;
}

function collectText(parts) {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
  let html = esc(text);
  const blocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  html = html
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1<i>$2</i>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  return html;
}

/* ---------- Uploads ---------- */

async function uploadFiles(files) {
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) {
      alert(`Upload failed: ${file.name}`);
      continue;
    }
    const up = await res.json();
    state.attachments.push(up);
  }
  renderAttachTray();
}

function renderAttachTray() {
  const tray = $("attachTray");
  tray.innerHTML = "";
  tray.classList.toggle("hidden", !state.attachments.length);
  for (const a of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const icon = a.kind === "image" ? "🖼" : a.kind === "pdf" ? "📄" : "📃";
    chip.textContent = `${icon} ${a.name} (${fmtNum(a.size)})`;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.onclick = () => {
      state.attachments = state.attachments.filter((t) => t.id !== a.id);
      renderAttachTray();
    };
    chip.appendChild(x);
    tray.appendChild(chip);
  }
}

/* ---------- Chat ---------- */

function buildMessageParts() {
  const text = $("input").value.trim();
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const a of state.attachments) {
    parts.push({ type: "ref", uploadId: a.id });
  }
  return parts;
}

async function send() {
  if (state.streaming) return;
  const parts = buildMessageParts();
  if (!parts.length) return;
  const provider = currentProvider();
  if (!provider) {
    alert("Add a provider first (⚙ Providers)");
    return;
  }
  if (!state.current) newSession();

  state.current.messages.push({ role: "user", parts });
  renderMessages();
  $("input").value = "";
  $("input").style.height = "auto";
  state.attachments = [];
  renderAttachTray();

  const assistantMsg = { role: "assistant", parts: [{ type: "text", text: "" }] };
  state.current.messages.push(assistantMsg);
  const box = $("messages");
  const div = renderMsg(assistantMsg);
  const bubble = div.querySelector(".bubble");
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  state.streaming = true;
  setSendButton();
  state.abort = new AbortController();
  let usage = null;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: state.providerId,
        system: state.system,
        effort: state.effort,
        messages: state.current.messages.slice(0, -1),
      }),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!frame.startsWith("data:")) continue;
        const ev = JSON.parse(frame.slice(5).trim());
        if (ev.type === "delta") {
          assistantMsg.parts[0].text += ev.text;
          bubble.innerHTML = renderMarkdown(assistantMsg.parts[0].text);
          box.scrollTop = box.scrollHeight;
          updateContextMeter();
        } else if (ev.type === "usage") {
          usage = { ...(usage || {}), ...ev };
          delete usage.type;
          updateContextMeter(usage);
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      assistantMsg.parts[0].text = `⚠ ${err.message}`;
      div.className = "msg error";
      bubble.innerHTML = esc(assistantMsg.parts[0].text);
    }
  } finally {
    state.streaming = false;
    state.abort = null;
    setSendButton();
    if (!assistantMsg.parts[0].text) {
      state.current.messages.pop();
      div.remove();
    }
    await persistSession();
  }
}

function setSendButton() {
  const btn = $("sendBtn");
  btn.textContent = state.streaming ? "Stop" : "Send";
  btn.onclick = state.streaming ? stopStreaming : send;
}

function stopStreaming() {
  if (state.abort) state.abort.abort();
}

/* ---------- Provider modal ---------- */

function openModal() {
  $("providerModal").classList.remove("hidden");
  renderProviderList();
}

function renderProviderList() {
  const list = $("providerList");
  list.innerHTML = "";
  for (const p of state.providers) {
    const row = document.createElement("div");
    row.className = "provider-row";
    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(p.model)} · ${p.format} · ctx ${fmtNum(p.contextWindow)} · ${esc(p.baseUrl)}</div>`;
    const edit = document.createElement("button");
    edit.className = "btn ghost small";
    edit.textContent = "Edit";
    edit.onclick = () => fillForm(p);
    const del = document.createElement("button");
    del.className = "btn ghost small danger";
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete provider "${p.name}"?`)) return;
      await api(`/api/providers/${p.id}`, { method: "DELETE" });
      if (state.providerId === p.id) state.providerId = null;
      await loadProviders();
    };
    row.append(info, edit, del);
    list.appendChild(row);
  }
}

let editingId = null;

function fillForm(p) {
  editingId = p.id;
  const f = $("providerForm");
  f.name.value = p.name;
  f.model.value = p.model;
  f.baseUrl.value = p.baseUrl;
  f.apiKey.value = "";
  f.apiKey.placeholder = p.apiKey ? "•••••••• (unchanged)" : "sk-…";
  f.format.value = p.format;
  f.contextWindow.value = p.contextWindow;
  f.maxTokens.value = p.maxTokens || "";
  $("formTitle").textContent = `Edit: ${p.name}`;
}

function resetForm() {
  editingId = null;
  $("providerForm").reset();
  $("formTitle").textContent = "Add provider";
}

/* ---------- Events ---------- */

$("providerSelect").onchange = (e) => {
  state.providerId = e.target.value || null;
  updateEffortAvail();
  updateContextMeter();
};
$("effortSelect").onchange = (e) => { state.effort = e.target.value; };
$("sysToggle").onclick = () => $("systemPromptWrap").classList.toggle("hidden");
$("systemPrompt").addEventListener("input", (e) => { state.system = e.target.value; });

$("newChatBtn").onclick = newSession;
$("manageProvidersBtn").onclick = openModal;
$("closeModalBtn").onclick = () => {
  $("providerModal").classList.add("hidden");
  resetForm();
  loadProviders();
};

$("providerForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(),
    model: f.model.value.trim(),
    baseUrl: f.baseUrl.value.trim(),
    apiKey: f.apiKey.value,
    format: f.format.value,
    contextWindow: parseInt(f.contextWindow.value) || 128000,
    maxTokens: f.maxTokens.value ? parseInt(f.maxTokens.value) : null,
  };
  try {
    if (editingId) {
      await api(`/api/providers/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      const created = await api("/api/providers", { method: "POST", body: JSON.stringify(body) });
      state.providerId = created.id;
    }
    resetForm();
    await loadProviders();
  } catch (err) {
    alert(err.message);
  }
};

$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
};

const input = $("input");
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});

["dragover", "dragenter"].forEach((evName) =>
  window.addEventListener(evName, (e) => {
    e.preventDefault();
    if (!document.getElementById("dropOverlay")) {
      const ov = document.createElement("div");
      ov.id = "dropOverlay";
      ov.textContent = "Drop files to attach";
      document.body.appendChild(ov);
    }
  })
);
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) document.getElementById("dropOverlay")?.remove();
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.getElementById("dropOverlay")?.remove();
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});

/* ---------- Init ---------- */

(async function init() {
  await loadProviders();
  await loadSessions();
  if (state.sessions.length) {
    await openSession(state.sessions[0].id);
  } else {
    renderMessages();
  }
  updateContextMeter();
  setSendButton();
})();
