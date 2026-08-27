import json
import os
import threading

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")
PROVIDERS_FILE = os.path.join(DATA_DIR, "providers.json")
CONVERSATIONS_FILE = os.path.join(DATA_DIR, "conversations.json")

_lock = threading.Lock()


def ensure_dirs():
    os.makedirs(UPLOADS_DIR, exist_ok=True)


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
