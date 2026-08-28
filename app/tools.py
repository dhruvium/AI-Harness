import json
import os
import subprocess


class ToolError(Exception):
    pass


MAX_OUTPUT = 8000
MAX_READ = 200 * 1024
COMMAND_TIMEOUT = 180

TOOL_NAMES = ["write_file", "read_file", "list_dir", "run_command"]

_SCHEMAS = {
    "write_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path relative to the project folder"},
            "content": {"type": "string", "description": "Full file content to write"},
        },
        "required": ["path", "content"],
    },
    "read_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path relative to the project folder"},
        },
        "required": ["path"],
    },
    "list_dir": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Directory path relative to project folder (default '.')"},
        },
    },
    "run_command": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "PowerShell command to run inside the project folder"},
        },
        "required": ["command"],
    },
}

_DESCRIPTIONS = {
    "write_file": "Create or overwrite a file inside the project folder with the given content.",
    "read_file": "Read a text file from the project folder.",
    "list_dir": "List files and folders in a directory inside the project folder.",
    "run_command": "Run a PowerShell command with the project folder as working directory. Use for builds, running scripts, installing dependencies, etc.",
}


def tool_specs(fmt: str):
    if fmt == "anthropic":
        return [
            {"name": n, "description": _DESCRIPTIONS[n], "input_schema": _SCHEMAS[n]}
            for n in TOOL_NAMES
        ]
    return [
        {"type": "function", "function": {"name": n, "description": _DESCRIPTIONS[n], "parameters": _SCHEMAS[n]}}
        for n in TOOL_NAMES
    ]


def _safe_path(root: str, rel: str) -> str:
    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, rel))
    if target != root_real and not target.startswith(root_real + os.sep):
        raise ToolError(f"Path escapes the project folder: {rel}")
    return target


def _truncate(text: str, limit: int = MAX_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated, {len(text) - limit} more chars]"


def execute_tool(root: str, name: str, args: dict) -> str:
    if not root or not os.path.isdir(root):
        raise ToolError("Project folder does not exist on disk")
    if name == "write_file":
        rel = args.get("path", "")
        content = args.get("content", "")
        if not rel:
            raise ToolError("write_file requires 'path'")
        path = _safe_path(root, rel)
        os.makedirs(os.path.dirname(path) or root, exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return f"Wrote {len(content.encode('utf-8'))} bytes to {rel}"
    if name == "read_file":
        rel = args.get("path", "")
        if not rel:
            raise ToolError("read_file requires 'path'")
        path = _safe_path(root, rel)
        if not os.path.isfile(path):
            raise ToolError(f"File not found: {rel}")
        size = os.path.getsize(path)
        if size > MAX_READ:
            raise ToolError(f"File too large to read ({size} bytes, max {MAX_READ})")
        with open(path, "rb") as f:
            raw = f.read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ToolError("File appears to be binary; cannot display as text")
        return _truncate(text)
    if name == "list_dir":
        rel = args.get("path") or "."
        path = _safe_path(root, rel)
        if not os.path.isdir(path):
            raise ToolError(f"Directory not found: {rel}")
        entries = []
        for entry in sorted(os.listdir(path)):
            full = os.path.join(path, entry)
            if os.path.isdir(full):
                entries.append(f"[dir]  {entry}")
            else:
                entries.append(f"[file] {entry} ({os.path.getsize(full)} bytes)")
        if not entries:
            return "(empty directory)"
        return _truncate("\n".join(entries[:500]))
    if name == "run_command":
        cmd = args.get("command", "")
        if not cmd:
            raise ToolError("run_command requires 'command'")
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT,
            encoding="utf-8",
            errors="replace",
        )
        out = ""
        if proc.stdout:
            out += f"stdout:\n{_truncate(proc.stdout)}\n"
        if proc.stderr:
            out += f"stderr:\n{_truncate(proc.stderr)}\n"
        out += f"exit code: {proc.returncode}"
        return out.strip()
    raise ToolError(f"Unknown tool: {name}")


def args_summary(name: str, args: dict) -> str:
    if name == "run_command":
        return args.get("command", "")
    if name in ("write_file", "read_file", "list_dir"):
        return args.get("path", ".")
    try:
        return json.dumps(args)
    except Exception:
        return str(args)
