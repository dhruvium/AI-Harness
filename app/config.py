import json
import os
import threading

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")
PROVIDERS_FILE = os.path.join(DATA_DIR, "providers.json")
CONVERSATIONS_FILE = os.path.join(DATA_DIR, "conversations.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
MEMORY_FILE = os.path.join(DATA_DIR, "memory.json")
PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
BROWSER_PROFILE_DIR = os.path.join(DATA_DIR, "browser", "profile")
BROWSER_CACHE_DIR = os.path.join(DATA_DIR, "browser", "cache")

_lock = threading.Lock()

DEFAULT_SETTINGS = {
    "memory": {"enabled": False},
    "browser": {"enabled": False, "ignoreCertErrors": False},
    "power": {"preventSleep": False},
    "ui": {"lastProviderId": None, "effort": "none", "systemPrompt": ""},
}


def ensure_dirs():
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    os.makedirs(BROWSER_PROFILE_DIR, exist_ok=True)
    os.makedirs(BROWSER_CACHE_DIR, exist_ok=True)


def _read_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_providers():
    with _lock:
        return _read_json(PROVIDERS_FILE, [])


def save_providers(providers):
    with _lock:
        _write_json(PROVIDERS_FILE, providers)


def load_conversations():
    with _lock:
        return _read_json(CONVERSATIONS_FILE, [])


def save_conversations(convs):
    with _lock:
        _write_json(CONVERSATIONS_FILE, convs)


def load_settings():
    saved = _read_json(SETTINGS_FILE, {})
    merged = json.loads(json.dumps(DEFAULT_SETTINGS))
    for section in ("memory", "browser", "power", "ui"):
        if isinstance(saved.get(section), dict):
            merged[section].update({
                k: v for k, v in saved[section].items() if k in merged[section]
            })
    return merged


def save_settings(settings):
    with _lock:
        _write_json(SETTINGS_FILE, settings)


def load_memory():
    with _lock:
        return _read_json(MEMORY_FILE, [])


def save_memory(items):
    with _lock:
        _write_json(MEMORY_FILE, items)


def load_projects():
    with _lock:
        return sorted(
            _read_json(PROJECTS_FILE, []), key=lambda p: p.get("name", "").lower()
        )


def save_projects(projects):
    with _lock:
        _write_json(PROJECTS_FILE, projects)
