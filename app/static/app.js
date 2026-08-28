const $ = (id) => document.getElementById(id);

const state = {
  providers: [],
  sessions: [],
  projects: [],
  openProjects: new Set(),
  showOthers: false,
  picking: false,
  current: null,
  providerId: null,
  effort: "none",
  system: "",
  attachments: [],
  streaming: false,
  abort: null,
  agentMode: false,
  settings: {
    memory: { enabled: false },
    browser: { enabled: false, ignoreCertErrors: false },
    power: { preventSleep: false },
    ui: { lastProviderId: null, effort: "none", systemPrompt: "" },
  },
  settingsSnapshot: null,
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

/* ---------- UI state persistence ---------- */

let uiSaveTimer = null;

function persistUi(immediate = false) {
  clearTimeout(uiSaveTimer);
  uiSaveTimer = setTimeout(async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          ui: {
            lastProviderId: state.providerId,
            effort: state.effort,
            systemPrompt: state.system,
          },
        }),
      });
    } catch {}
  }, immediate ? 0 : 500);
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
    if (m.reasoning) total += estimateTokens(m.reasoning);
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

/* ---------- Settings ---------- */

async function loadSettings() {
  state.settings = await api("/api/settings");
  state.settingsSnapshot = JSON.parse(JSON.stringify(state.settings));
}

function syncSettingsUI() {
  $("memoryToggle").checked = state.settings.memory.enabled;
  $("browserToggle").checked = state.settings.browser.enabled;
  $("certToggle").checked = state.settings.browser.ignoreCertErrors;
  $("sleepToggle").checked = state.settings.power.preventSleep;
  updateCertNote();
  updateMemoryVisibility();
}

async function saveSettings() {
  state.settings.memory.enabled = $("memoryToggle").checked;
  state.settings.browser.enabled = $("browserToggle").checked;
  state.settings.browser.ignoreCertErrors = $("certToggle").checked;
  state.settings.power.preventSleep = $("sleepToggle").checked;
  state.settings = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      memory: { enabled: state.settings.memory.enabled },
      browser: {
        enabled: state.settings.browser.enabled,
        ignoreCertErrors: state.settings.browser.ignoreCertErrors,
      },
      power: { preventSleep: state.settings.power.preventSleep },
    }),
  });
  updateCertNote();
  updateMemoryVisibility();
}

function updateCertNote() {
  const changed =
    state.settings.browser.ignoreCertErrors !==
    (state.settingsSnapshot
      ? state.settingsSnapshot.browser.ignoreCertErrors
      : false);
  $("certRestartNote").classList.toggle("hidden", !changed);
}

function updateMemoryVisibility() {
  const on = state.settings.memory.enabled;
  $("memoryManage").classList.toggle("hidden", !on);
  if (on) loadMemoryList();
}

async function loadMemoryList() {
  const items = await api("/api/memory");
  $("memoryCount").textContent = items.length;
  const list = $("memoryList");
  list.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "memory-item";
    row.textContent = item.text;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.onclick = async () => {
      await api(`/api/memory/${item.id}`, { method: "DELETE" });
      loadMemoryList();
    };
    row.appendChild(x);
    list.appendChild(row);
  }
  $("memoryCount").textContent = items.length;
}

/* ---------- Projects data ---------- */

async function loadProjects() {
  state.projects = await api("/api/projects");
}

/* ---------- Sessions ---------- */

async function loadSessions() {
  state.sessions = await api("/api/conversations");
  renderSidebar();
}

function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "now";
  if (d < 3600) return Math.round(d / 60) + "m";
  if (d < 86400) return Math.round(d / 3600) + "h";
  if (d < 86400 * 30) return Math.round(d / 86400) + "d";
  return new Date(ts * 1000).toLocaleDateString();
}

function buildSessionRow(s, nested = false) {
  const div = document.createElement("div");
  div.className =
    "session" + (nested ? " nested" : "") +
    (state.current && state.current.id === s.id ? " active" : "");
  const t = document.createElement("span");
  t.className = "title";
  t.textContent = s.title || "Untitled";
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = relTime(s.updatedAt);
  const dots = document.createElement("button");
  dots.className = "dots";
  dots.textContent = "⋮";
  dots.title = "Session options";
  const menu = document.createElement("div");
  menu.className = "ctx-menu hidden";
  const arch = document.createElement("button");
  arch.textContent = "Archive";
  arch.onclick = async (e) => {
    e.stopPropagation();
    closeAllMenus();
    await api(`/api/conversations/${s.id}/archive`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
    if (state.current && state.current.id === s.id) {
      state.current = null;
      updateProjectChip();
      renderMessages();
    }
    await loadSessions();
  };
  const del = document.createElement("button");
  del.textContent = "Delete";
  del.className = "danger";
  del.onclick = async (e) => {
    e.stopPropagation();
    closeAllMenus();
    if (!confirm(`Delete chat "${s.title || "Untitled"}" permanently?`)) return;
    await api(`/api/conversations/${s.id}`, { method: "DELETE" });
    if (state.current && state.current.id === s.id) {
      state.current = null;
      updateProjectChip();
      renderMessages();
    }
    await loadSessions();
  };
  menu.append(arch, del);
  dots.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = !menu.classList.contains("hidden");
    closeAllMenus();
    if (!wasOpen) menu.classList.remove("hidden");
  };
  div.append(t, time, dots, menu);
  div.onclick = () => openSession(s.id);
  return div;
}

function renderSidebar() {
  const list = $("sessionList");
  list.innerHTML = "";

  const section = document.createElement("div");
  section.className = "projects-head";
  const label = document.createElement("span");
  label.textContent = "Projects";
  const add = document.createElement("button");
  add.className = "proj-add";
  add.textContent = "＋";
  add.title = "New project (pick a folder, then name it)";
  add.onclick = async (e) => {
    e.stopPropagation();
    await createProjectFlow();
  };
  section.append(label, add);
  list.appendChild(section);

  for (const p of state.projects) {
    const convs = state.sessions.filter((s) => s.projectId === p.id);
    const open = state.openProjects.has(p.id);
    const row = document.createElement("div");
    row.className = "project-row" + (open ? " open" : "");
    const folder = document.createElement("span");
    folder.className = "folder";
    folder.textContent = open ? "📂" : "📁";
    const nameWrap = document.createElement("div");
    nameWrap.className = "meta-wrap";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name;
    nameWrap.appendChild(name);
    if (p.path) {
      const pth = document.createElement("div");
      pth.className = "ppath";
      pth.textContent = p.path;
      pth.title = p.path;
      nameWrap.appendChild(pth);
    }
    const dots = document.createElement("button");
    dots.className = "dots";
    dots.textContent = "⋮";
    dots.title = "Project options";
    const menu = document.createElement("div");
    menu.className = "ctx-menu hidden";
    const ren = document.createElement("button");
    ren.textContent = "Rename";
    ren.onclick = async (e) => {
      e.stopPropagation();
      closeAllMenus();
      const newName = prompt("Rename project:", p.name);
      if (!newName || !newName.trim() || newName.trim() === p.name) return;
      await api(`/api/projects/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: newName.trim(), path: p.path || null }),
      });
      await loadProjects();
      updateProjectChip();
      renderSidebar();
    };
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.onclick = async (e) => {
      e.stopPropagation();
      closeAllMenus();
      const count = state.sessions.filter((s) => s.projectId === p.id).length;
      const msg = count
        ? `Delete project "${p.name}" and its ${count} chat(s)? This cannot be undone.`
        : `Delete project "${p.name}"?`;
      if (!confirm(msg)) return;
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      if (state.current && state.current.projectId === p.id) {
        state.current = null;
        renderMessages();
      }
      await loadProjects();
      await loadSessions();
      updateProjectChip();
    };
    menu.append(ren, del);
    dots.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = !menu.classList.contains("hidden");
      closeAllMenus();
      if (!wasOpen) menu.classList.remove("hidden");
    };
    const plus = document.createElement("button");
    plus.className = "proj-add";
    plus.textContent = "＋";
    plus.title = "New chat in this project";
    plus.onclick = (e) => {
      e.stopPropagation();
      newSession(p.id);
    };
    row.append(folder, nameWrap, plus, dots, menu);
    row.onclick = () => {
      if (state.openProjects.has(p.id)) state.openProjects.delete(p.id);
      else state.openProjects.add(p.id);
      renderSidebar();
    };
    list.appendChild(row);

    if (open) {
      const wrap = document.createElement("div");
      wrap.className = "nested-wrap";
      if (!convs.length) {
        const empty = document.createElement("div");
        empty.className = "empty-filter";
        empty.textContent = "No chats yet — use ＋ to start one";
        wrap.appendChild(empty);
      }
      for (const s of convs) wrap.appendChild(buildSessionRow(s, true));
      list.appendChild(wrap);
    }
  }

  const loose = state.sessions.filter((s) => !s.projectId);
  if (loose.length) {
    const othersHead = document.createElement("div");
    othersHead.className = "projects-head others";
    const olabel = document.createElement("span");
    olabel.textContent = "Other chats";
    const chev = document.createElement("button");
    chev.className = "proj-add";
    chev.textContent = state.showOthers ? "▾" : "▸";
    othersHead.append(olabel, chev);
    othersHead.onclick = () => {
      state.showOthers = !state.showOthers;
      renderSidebar();
    };
    list.appendChild(othersHead);
    if (state.showOthers) {
      const wrap = document.createElement("div");
      wrap.className = "nested-wrap";
      for (const s of loose) wrap.appendChild(buildSessionRow(s, true));
      list.appendChild(wrap);
    }
  }

  updateProjectChip();
}

async function createProjectFlow() {
  if (state.picking) return;
  state.picking = true;
  let path = null;
  try {
    const res = await fetch("/api/pick-folder", { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.detail || "Folder picker is not available.");
      return;
    }
    path = (await res.json()).path;
    if (!path) return;
  } catch (err) {
    alert(err.message);
    return;
  } finally {
    state.picking = false;
  }
  openNameProjectModal(path);
}

function openNameProjectModal(path) {
  const suggested = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  $("npmPath").textContent = path;
  $("npmPath").title = path;
  $("npmInput").value = suggested;
  $("nameProjectModal").classList.remove("hidden");
  $("npmInput").focus();
  $("npmInput").select();
}

function closeNameProjectModal() {
  $("nameProjectModal").classList.add("hidden");
  $("npmInput").value = "";
}

async function submitNameProjectModal() {
  const name = $("npmInput").value.trim();
  const path = $("npmPath").textContent;
  if (!name || !path) return;
  const created = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, path }),
  });
  closeNameProjectModal();
  state.openProjects.add(created.id);
  await loadProjects();
  renderSidebar();
}

function defaultProject() {
  if (!state.projects.length) return null;
  return state.projects.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

async function newChatDefault() {
  if (!state.projects.length) {
    await createProjectFlow();
    return;
  }
  newSession(defaultProject().id);
}

function closeAllMenus() {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.classList.add("hidden"));
}

document.addEventListener("click", () => closeAllMenus());

/* ---------- Project chip ---------- */

function updateProjectChip() {
  const row = $("projectChipRow");
  if (!state.current) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  const p = state.projects.find((p) => p.id === state.current.projectId);
  $("projectChipName").textContent = p ? p.name : "No project";
}

$("projectChip").onclick = (e) => {
  e.stopPropagation();
  const menu = $("projectMenu");
  const wasOpen = !menu.classList.contains("hidden");
  closeAllMenus();
  if (wasOpen) return;
  menu.innerHTML = "";
  const none = document.createElement("button");
  none.textContent = "No project";
  none.onclick = async () => {
    closeAllMenus();
    if (state.current.projectId == null) return;
    state.current.projectId = null;
    await persistSession();
    updateProjectChip();
    renderSidebar();
  };
  menu.appendChild(none);
  for (const p of state.projects) {
    const b = document.createElement("button");
    b.textContent = p.name;
    if (state.current.projectId === p.id) b.classList.add("current");
    b.onclick = async () => {
      closeAllMenus();
      if (state.current.projectId === p.id) return;
      state.current.projectId = p.id;
      state.openProjects.add(p.id);
      await persistSession();
      updateProjectChip();
      renderSidebar();
    };
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
};

/* ---------- Archived chats ---------- */

async function openArchived() {
  $("archivedModal").classList.remove("hidden");
  await renderArchivedList();
}

async function renderArchivedList() {
  const items = await api("/api/conversations?archived=true");
  const list = $("archivedList");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<div class="empty-filter">Nothing archived yet.</div>`;
    return;
  }
  for (const s of items) {
    const row = document.createElement("div");
    row.className = "archived-row";
    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name">${esc(s.title || "Untitled")}</div>
      <div class="meta">${new Date((s.updatedAt || 0) * 1000).toLocaleString()}</div>`;
    const restore = document.createElement("button");
    restore.className = "btn ghost small";
    restore.textContent = "Restore";
    restore.onclick = async () => {
      await api(`/api/conversations/${s.id}/archive`, {
        method: "PATCH",
        body: JSON.stringify({ archived: false }),
      });
      await loadSessions();
      await renderArchivedList();
    };
    const del = document.createElement("button");
    del.className = "btn ghost small danger";
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete archived chat "${s.title || "Untitled"}" permanently?`)) return;
      await api(`/api/conversations/${s.id}`, { method: "DELETE" });
      await loadSessions();
      await renderArchivedList();
    };
    row.append(info, restore, del);
    list.appendChild(row);
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
  if (state.current.projectId) state.openProjects.add(state.current.projectId);
  renderProviderSelect();
  renderSidebar();
  renderMessages();
  persistUi();
}

async function persistSession() {
  if (!state.current) return;
  state.current.effort = state.effort;
  state.current.providerId = state.providerId;
  state.current.system = state.system;
  if (state.current.useMemory === null || state.current.useMemory === undefined) {
    state.current.useMemory = false;
  }
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

function newSession(projectId = null) {
  state.current = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    title: "",
    providerId: state.providerId,
    projectId: projectId,
    effort: state.effort,
    system: state.system,
    useMemory: !!state.settings.memory.enabled,
    messages: [],
    updatedAt: 0,
  };
  if (projectId) state.openProjects.add(projectId);
  renderMessages();
  renderSidebar();
  $("input").focus();
}

/* ---------- Messages ---------- */

function renderMessages() {
  const box = $("messages");
  box.innerHTML = "";
  if (!state.current) {
    box.innerHTML = `<div class="empty"><h2>Personal AI Harness</h2><p>Hit <b>＋ New chat</b> to start in your default project, or pick a project in the sidebar. No projects yet? The button will walk you through creating one.</p></div>`;
    return;
  }
  for (const m of state.current.messages) {
    box.appendChild(renderMsg(m));
  }
  box.scrollTop = box.scrollHeight;
}

function renderMsg(m, live = false) {
  const div = document.createElement("div");
  div.className = `msg ${m.role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = m.role === "user" ? "you" : "assistant";
  div.appendChild(who);

  const text = collectText(m.parts);
  const showThinking =
    m.role === "assistant" && ((m.reasoning && m.reasoning.length) || (live && !text));
  let thinkWrap = null;
  if (showThinking) {
    thinkWrap = buildThinkingBlock(m, live);
    div.appendChild(thinkWrap);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (text) {
    bubble.innerHTML = renderMarkdown(text);
    div.appendChild(bubble);
  } else if (!live) {
    bubble.innerHTML = "<span class='dim-inline'>(empty)</span>";
    div.appendChild(bubble);
  } else {
    bubble.classList.add("hidden");
    div.appendChild(bubble);
  }
  return div;
}

function buildThinkingBlock(m, live) {
  const wrap = document.createElement("div");
  wrap.className = "thinking-block";
  const waiting = live && !(m.reasoning && m.reasoning.length) && !collectText(m.parts);
  const head = document.createElement("div");
  head.className = "think-head";
  const toggle = document.createElement("button");
  toggle.className = "think-toggle";
  toggle.textContent = m._open ? "−" : "+";
  toggle.title = "Show reasoning";
  const label = document.createElement("span");
  label.className = "think-label" + (waiting ? " waiting" : "");
  label.textContent = waiting ? "thinking…" : "Thinking";
  head.append(toggle, label);

  const pre = document.createElement("pre");
  pre.className = "reasoning";
  pre.hidden = !m._open;
  pre.textContent = m.reasoning || "";

  toggle.onclick = (e) => {
    e.stopPropagation();
    m._open = !m._open;
    pre.hidden = !m._open;
    toggle.textContent = m._open ? "−" : "+";
  };
  wrap.append(head, pre);
  m._els = { label, pre, toggle, wrap };
  return wrap;
}

function refreshThinking(m) {
  if (!m._els) return;
  const { label, pre } = m._els;
  const hasText = !!collectText(m.parts);
  const waiting = state.streaming && !(m.reasoning && m.reasoning.length) && !hasText;
  label.textContent = waiting ? "thinking…" : "Thinking";
  label.classList.toggle("waiting", waiting);
  pre.textContent = m.reasoning || "";
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

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

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
  if (!state.current) {
    alert("No chat is open. Use ＋ New chat (top of sidebar) or pick a chat inside one of your projects.");
    return;
  }
  const project = state.projects.find((p) => p.id === state.current.projectId);
  const useAgent = state.agentMode;
  if (useAgent && (!project || !project.path)) {
    alert("Agent mode needs the chat's project to have a folder on disk.");
    return;
  }
  const provider = currentProvider();
  if (!provider) {
    openSettings("providers");
    return;
  }
  if (!state.current) newSession();

  state.current.messages.push({ role: "user", parts });
  renderMessages();
  $("input").value = "";
  $("input").style.height = "auto";
  state.attachments = [];
  renderAttachTray();

  const assistantMsg = { role: "assistant", parts: [{ type: "text", text: "" }], reasoning: "" };
  state.current.messages.push(assistantMsg);
  const box = $("messages");
  const div = renderMsg(assistantMsg, true);
  const bubble = div.querySelector(".bubble");
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  state.streaming = true;
  setSendButton();
  state.abort = new AbortController();
  let usage = null;

  try {
    const res = await fetch(useAgent ? "/api/agent" : "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: state.providerId,
        system: state.system,
        effort: state.effort,
        useMemory: !!state.current.useMemory,
        projectId: useAgent ? state.current.projectId : null,
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
          const stick = isNearBottom(box);
          assistantMsg.parts[0].text += ev.text;
          bubble.classList.remove("hidden");
          bubble.innerHTML = renderMarkdown(assistantMsg.parts[0].text);
          if (stick) box.scrollTop = box.scrollHeight;
          updateContextMeter();
        } else if (ev.type === "reasoning") {
          const stick = isNearBottom(box);
          assistantMsg.reasoning = (assistantMsg.reasoning || "") + ev.text;
          refreshThinking(assistantMsg);
          if (stick) box.scrollTop = box.scrollHeight;
        } else if (ev.type === "tool_call") {
          const stick = isNearBottom(box);
          addToolBlock(div, ev);
          if (stick) box.scrollTop = box.scrollHeight;
        } else if (ev.type === "approval_request") {
          const stick = isNearBottom(box);
          attachApproval(div, ev);
          if (stick) box.scrollTop = box.scrollHeight;
        } else if (ev.type === "tool_running") {
          setToolStatus(div, ev.id, "running…", "running");
        } else if (ev.type === "tool_result") {
          const stick = isNearBottom(box);
          setToolResult(div, ev);
          if (stick) box.scrollTop = box.scrollHeight;
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
    refreshThinking(assistantMsg);
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

/* ---------- Agent tool blocks ---------- */

function toolBlock(div, callId) {
  return div.querySelector(`.tool-block[data-call-id="${CSS.escape(callId)}"]`);
}

function addToolBlock(div, ev) {
  let wrap = div.querySelector(".tools-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "tools-wrap";
    const bubble = div.querySelector(".bubble");
    div.insertBefore(wrap, bubble);
  }
  const block = document.createElement("div");
  block.className = "tool-block";
  block.dataset.callId = ev.id;
  const head = document.createElement("div");
  head.className = "tool-head";
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = "🔧 " + ev.tool;
  const sum = document.createElement("span");
  sum.className = "tool-sum";
  sum.textContent = ev.summary || "";
  sum.title = ev.summary || "";
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = "requested";
  const toggle = document.createElement("button");
  toggle.className = "think-toggle";
  toggle.textContent = "+";
  toggle.title = "Show details";
  const pre = document.createElement("pre");
  pre.className = "tool-io";
  pre.hidden = true;
  pre.textContent = ev.args && Object.keys(ev.args).length ? JSON.stringify(ev.args, null, 2) : "";
  toggle.onclick = (e) => {
    e.stopPropagation();
    pre.hidden = !pre.hidden;
    toggle.textContent = pre.hidden ? "+" : "−";
  };
  head.append(name, sum, status, toggle);
  const actions = document.createElement("div");
  actions.className = "tool-actions";
  block.append(head, actions, pre);
  wrap.appendChild(block);
  return block;
}

function attachApproval(div, ev) {
  const block = toolBlock(div, ev.callId);
  if (!block) return;
  const status = block.querySelector(".tool-status");
  status.textContent = "awaiting approval";
  status.className = "tool-status pending";
  const actions = block.querySelector(".tool-actions");
  actions.innerHTML = "";
  const ok = document.createElement("button");
  ok.className = "btn small primary";
  ok.textContent = "Approve";
  const no = document.createElement("button");
  no.className = "btn small ghost";
  no.textContent = "Deny";
  const decide = async (approved) => {
    ok.disabled = true;
    no.disabled = true;
    status.textContent = approved ? "running…" : "denied";
    status.className = "tool-status " + (approved ? "running" : "failed");
    try {
      await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId: ev.streamId, callId: ev.callId, approved }),
      });
    } catch {}
  };
  ok.onclick = () => decide(true);
  no.onclick = () => decide(false);
  actions.append(ok, no);
}

function setToolStatus(div, callId, text, cls) {
  const block = toolBlock(div, callId);
  if (!block) return;
  const status = block.querySelector(".tool-status");
  status.textContent = text;
  status.className = "tool-status " + cls;
}

function setToolResult(div, ev) {
  const block = toolBlock(div, ev.id);
  if (!block) return;
  const status = block.querySelector(".tool-status");
  status.textContent = ev.ok ? "done" : "failed";
  status.className = "tool-status " + (ev.ok ? "done" : "failed");
  const actions = block.querySelector(".tool-actions");
  actions.innerHTML = "";
  const pre = block.querySelector(".tool-io");
  const args = pre.textContent ? pre.textContent + "\n\n——— result ———\n" : "";
  pre.textContent = args + (ev.result || "");
  if (ev.ok) block.classList.add("ok");
  else block.classList.add("fail");
}

/* ---------- Settings modal ---------- */

function showSettingsTab(tab) {
  $("generalTab").classList.toggle("hidden", tab !== "general");
  $("providersTab").classList.toggle("hidden", tab !== "providers");
  $("tabGeneralBtn").classList.toggle("active", tab === "general");
  $("tabProvidersBtn").classList.toggle("active", tab === "providers");
}

function openSettings(tab = "general") {
  syncSettingsUI();
  showSettingsTab(tab);
  if (tab === "providers") renderProviderList();
  $("settingsModal").classList.remove("hidden");
}

$("settingsBtn").onclick = () => openSettings("general");
$("closeSettingsBtn").onclick = () => {
  $("settingsModal").classList.add("hidden");
  resetForm();
};
$("tabGeneralBtn").onclick = () => showSettingsTab("general");
$("tabProvidersBtn").onclick = () => {
  renderProviderList();
  showSettingsTab("providers");
};

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
  persistUi();
};
$("effortSelect").onchange = (e) => {
  state.effort = e.target.value;
  persistUi();
};
$("sysToggle").onclick = () => $("systemPromptWrap").classList.toggle("hidden");
$("systemPrompt").addEventListener("input", (e) => {
  state.system = e.target.value;
  persistUi();
});

$("newChatBtn").onclick = newChatDefault;
$("archivedBtn").onclick = openArchived;
$("closeArchivedBtn").onclick = () => $("archivedModal").classList.add("hidden");

$("npmCloseBtn").onclick = closeNameProjectModal;
$("npmCancelBtn").onclick = closeNameProjectModal;
$("npmSaveBtn").onclick = submitNameProjectModal;
$("npmInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitNameProjectModal();
  if (e.key === "Escape") closeNameProjectModal();
});

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
$("agentToggle").onclick = () => {
  state.agentMode = !state.agentMode;
  $("agentToggle").classList.toggle("active", state.agentMode);
};
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

/* ---------- Settings modal ---------- */

function openSettings() {
  syncSettingsUI();
  $("settingsModal").classList.remove("hidden");
  if (state.settings.memory.enabled) loadMemoryList();
}

$("settingsBtn").onclick = openSettings;
$("closeSettingsBtn").onclick = () => {
  $("settingsModal").classList.add("hidden");
};

$("memoryToggle").onchange = saveSettings;
$("browserToggle").onchange = () => {
  saveSettings();
};
$("certToggle").onchange = saveSettings;

$("clearCacheBtn").onclick = async () => {
  const r = await fetch("/api/browser/clear-cache", { method: "POST" });
  const out = await r.json();
  alert(`Browser cache cleared (${out.removed} item${out.removed === 1 ? "" : "s"}).`);
};

$("clearBrowserDataBtn").onclick = async () => {
  if (!confirm("Clear ALL built-in browser data (profile, cookies, cache)?")) return;
  const r = await fetch("/api/browser/clear-data", { method: "POST" });
  const out = await r.json();
  alert(`All browser data cleared (${out.removed} item${out.removed === 1 ? "" : "s"}).`);
};

$("clearMemoriesBtn").onclick = async () => {
  if (!confirm("Delete all stored memories?")) return;
  const items = await api("/api/memory");
  for (const i of items) {
    await api(`/api/memory/${i.id}`, { method: "DELETE" });
  }
  loadMemoryList();
};

/* ---------- Init ---------- */

(async function init() {
  await loadSettings();
  const ui = state.settings.ui || {};
  state.providerId = ui.lastProviderId || null;
  state.effort = ui.effort || "none";
  state.system = ui.systemPrompt || "";
  $("effortSelect").value = state.effort;
  $("systemPrompt").value = state.system;

  await loadProviders();
  await loadProjects();
  await loadSessions();

  if (state.sessions.length) {
    await openSession(state.sessions[0].id);
  } else {
    renderSidebar();
    renderMessages();
  }
  updateContextMeter();
  setSendButton();
})();
