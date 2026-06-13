"""Tool definitions and execution for the phone-agent's own agent loop.

Mirrors a useful subset of src/lib/tools.ts, scoped to LOCALMIND_WORKSPACE.
This runs as a trusted local process for a single user, so unlike the
browser's File System Access API there is no path-traversal sandboxing —
paths are resolved relative to the workspace root with normal filesystem
semantics.
"""

import ast
import fnmatch
import json
import math
import operator
import platform
import re
import subprocess
from pathlib import Path

import requests

import config
import skill_writer
import web_search as web_search_mod

# ─── Tool schema (Ollama tool-calling format) ────────────────────────────

TOOL_DEFINITIONS = [
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read the text content of a file from the workspace.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path to the file within the workspace (e.g. 'src/main.ts')."},
            },
            "required": ["path"],
        },
    }},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "Create a NEW file or completely replace an existing one. For editing existing files, prefer patch_file instead.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path to the file within the workspace."},
                "content": {"type": "string", "description": "The full text content to write."},
            },
            "required": ["path", "content"],
        },
    }},
    {"type": "function", "function": {
        "name": "patch_file",
        "description": "Edit an existing file by replacing old_string with new_string. Uses fuzzy matching. Re-read the file first if unsure of exact content.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path to the file within the workspace."},
                "old_string": {"type": "string", "description": "The exact string to find and replace (must match character-for-character including newlines and indentation)."},
                "new_string": {"type": "string", "description": "The replacement string."},
                "replace_all": {"type": "boolean", "description": "If true, replace every occurrence instead of just the first. Defaults to false."},
            },
            "required": ["path", "old_string", "new_string"],
        },
    }},
    {"type": "function", "function": {
        "name": "list_directory",
        "description": "List the files and subdirectories in the workspace (up to 2 levels deep).",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Optional sub-path within the workspace. Defaults to root."},
            },
            "required": [],
        },
    }},
    {"type": "function", "function": {
        "name": "grep_files",
        "description": "Search file contents for a pattern (like grep). Returns matching lines with file path and line number.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression or plain string to search for."},
                "path": {"type": "string", "description": "Directory to search in, relative to workspace root. Defaults to root."},
                "file_pattern": {"type": "string", "description": "Glob to filter which files to search, e.g. '*.ts' or '*.tsx'. Defaults to all files."},
                "case_sensitive": {"type": "boolean", "description": "Whether the search is case-sensitive. Defaults to false."},
            },
            "required": ["pattern"],
        },
    }},
    {"type": "function", "function": {
        "name": "find_files",
        "description": "Find files or directories by name pattern (like find). Returns a list of matching paths.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Name pattern to match. Supports * wildcard, e.g. '*.ts', 'use*.ts', 'App*'."},
                "path": {"type": "string", "description": "Directory to search in, relative to workspace root. Defaults to root."},
            },
            "required": ["pattern"],
        },
    }},
    {"type": "function", "function": {
        "name": "delete_file",
        "description": "Permanently delete a file from the workspace. Cannot be undone. Only deletes files, not directories.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path to the file within the workspace (e.g. 'src/old.ts')."},
            },
            "required": ["path"],
        },
    }},
    {"type": "function", "function": {
        "name": "create_folder",
        "description": "Create a directory (and all parent directories) within the workspace.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path within the workspace to create, e.g. 'src/components'."},
            },
            "required": ["path"],
        },
    }},
    {"type": "function", "function": {
        "name": "run_command",
        "description": "Execute a shell command in the workspace and return its stdout/stderr output. Use for running scripts, compiling code, checking status, installing packages, etc.",
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": {"type": "string", "description": "The shell command to run (e.g. 'npm install', 'git status', 'python main.py')."},
                "cwd": {"type": "string", "description": "Working directory for the command, relative to the workspace. Defaults to the workspace root."},
            },
            "required": ["cmd"],
        },
    }},
    {"type": "function", "function": {
        "name": "get_system_info",
        "description": "Get system information: OS, Python version, and the configured Ollama model.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    {"type": "function", "function": {
        "name": "git_status",
        "description": "Show the working tree status (changed, staged, and untracked files).",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    {"type": "function", "function": {
        "name": "git_diff",
        "description": "Show the diff of unstaged or staged changes. Optionally limit to a specific file.",
        "parameters": {
            "type": "object",
            "properties": {
                "staged": {"type": "boolean", "description": "If true, show staged (--cached) diff."},
                "path": {"type": "string", "description": "Optional file path to limit the diff to."},
            },
            "required": [],
        },
    }},
    {"type": "function", "function": {
        "name": "git_log",
        "description": "Show the last 20 commits in one-line format.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
    {"type": "function", "function": {
        "name": "git_add",
        "description": "Stage file(s) for commit.",
        "parameters": {
            "type": "object",
            "properties": {
                "paths": {"type": "string", "description": "Space-separated list of files/patterns to stage, e.g. 'src/main.ts' or '.' for all."},
            },
            "required": ["paths"],
        },
    }},
    {"type": "function", "function": {
        "name": "git_commit",
        "description": "Create a git commit with the given message. Only stage changes you intend to commit first.",
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "The commit message."},
            },
            "required": ["message"],
        },
    }},
    {"type": "function", "function": {
        "name": "calculator",
        "description": "Evaluate a mathematical expression and return the numeric result.",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {"type": "string", "description": "The math expression to evaluate (e.g. '2 + 2', 'sqrt(16)', 'sin(pi/4)')."},
            },
            "required": ["expression"],
        },
    }},
    {"type": "function", "function": {
        "name": "web_search",
        "description": "Search the web using DuckDuckGo and return a summary of results.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The search query string."},
            },
            "required": ["query"],
        },
    }},
    {"type": "function", "function": {
        "name": "web_fetch",
        "description": "Fetch a URL and return its content as plain text (HTML tags stripped).",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The URL to fetch (must start with https:// or http://)."},
            },
            "required": ["url"],
        },
    }},
    {"type": "function", "function": {
        "name": "save_skill",
        "description": "Save a reusable skill (procedural knowledge) to the workspace skill registry at .localmind/skills/.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Human-readable skill name, e.g. 'Docker Debugging'."},
                "tags": {"type": "string", "description": "Comma-separated tags for skill discovery, e.g. 'docker,container,debug'."},
                "content": {"type": "string", "description": "Markdown content: step-by-step instructions, commands, and tips."},
            },
            "required": ["name", "tags", "content"],
        },
    }},
    {"type": "function", "function": {
        "name": "list_skills",
        "description": "List all skills in the workspace skill registry (.localmind/skills/). Returns skill names and tags.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    }},
]

MUTATING_TOOLS = {
    "write_file", "patch_file", "delete_file", "create_folder",
    "run_command", "git_add", "git_commit", "save_skill",
}

SKIP_DIRS = {
    "node_modules", ".git", "dist", ".next", "__pycache__",
    ".venv", "venv", "env", ".env", "myenv", "virtualenv", ".virtualenv",
    "build", "coverage", "target", ".localmind-backups",
}


# ─── Path / glob helpers ──────────────────────────────────────────────────

def _resolve(path: str) -> Path:
    path = (path or "").strip().lstrip("/\\")
    if not path:
        return config.WORKSPACE_DIR
    p = Path(path)
    if p.is_absolute():
        # Drive-letter/UNC absolute paths would otherwise make Path.__truediv__
        # discard WORKSPACE_DIR entirely and escape the workspace. Strip the
        # anchor and treat the rest as relative.
        p = Path(*p.parts[1:])
    return config.WORKSPACE_DIR / p


def _glob_to_regex(pattern: str) -> re.Pattern:
    escaped = re.escape(pattern)
    # re.escape turns "*" into "\*" and "?" into "\?" — undo that for wildcard handling
    escaped = escaped.replace(r"\*\*", ".+").replace(r"\*", "[^/]*").replace(r"\?", "[^/]")
    return re.compile(f"^{escaped}$", re.IGNORECASE)


def _matches_file_glob(name: str, pattern: str) -> bool:
    if not pattern or pattern in ("*", "**/*"):
        return True
    return _glob_to_regex(pattern).match(name) is not None


# Files that commonly hold credentials/keys. Reading these (read_file/grep_files)
# never requires Telegram approval, so block their *content* outright — this
# matters if the workspace ever contains this bot's own .env (TELEGRAM_TOKEN etc).
_SENSITIVE_FILE_GLOBS = (".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "*.pfx", "*.p12", "*.ppk")


def _is_sensitive_file(p: Path) -> bool:
    return any(_matches_file_glob(p.name, pat) for pat in _SENSITIVE_FILE_GLOBS)


# ─── Fuzzy patch matcher (subset of tools.ts's fuzzyFindMatch) ───────────

def _fuzzy_find_match(content: str, old: str) -> tuple[int, int] | None:
    idx = content.find(old)
    if idx != -1:
        return idx, idx + len(old)

    nc = content.replace("\r\n", "\n").replace("\r", "\n")
    no = old.replace("\r\n", "\n").replace("\r", "\n")

    idx = nc.find(no)
    if idx != -1:
        return idx, idx + len(no)

    nc_lines = nc.split("\n")
    no_lines = no.split("\n")
    n = len(no_lines)

    def line_range(i: int) -> tuple[int, int]:
        start = sum(len(nc_lines[k]) + 1 for k in range(i))
        end = start + sum(len(nc_lines[k]) + 1 for k in range(i, i + n))
        return start, min(end, len(nc))

    # Trailing-whitespace-trimmed match
    trimmed = [l.rstrip() for l in no_lines]
    for i in range(0, len(nc_lines) - n + 1):
        if [l.rstrip() for l in nc_lines[i:i + n]] == trimmed:
            return line_range(i)

    # Whitespace-normalized match
    def ws_norm(s: str) -> str:
        return " ".join(s.split())

    norm_old = ws_norm(no)
    for i in range(0, len(nc_lines) - n + 1):
        if ws_norm("\n".join(nc_lines[i:i + n])) == norm_old:
            return line_range(i)

    return None


# ─── Safe calculator ──────────────────────────────────────────────────────

_CALC_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
    ast.USub: operator.neg, ast.UAdd: operator.pos, ast.FloorDiv: operator.floordiv,
}
_CALC_NAMES = {**{k: v for k, v in vars(math).items() if not k.startswith("_")}}


def _eval_calc_node(node):
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError("Invalid constant in expression")
    if isinstance(node, ast.BinOp) and type(node.op) in _CALC_OPS:
        return _CALC_OPS[type(node.op)](_eval_calc_node(node.left), _eval_calc_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _CALC_OPS:
        return _CALC_OPS[type(node.op)](_eval_calc_node(node.operand))
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _CALC_NAMES:
            raise ValueError(f"Unknown function: {getattr(node.func, 'id', node.func)}")
        fn = _CALC_NAMES[node.func.id]
        if not callable(fn):
            raise ValueError(f"'{node.func.id}' is not a function")
        return fn(*[_eval_calc_node(a) for a in node.args])
    if isinstance(node, ast.Name):
        if node.id in _CALC_NAMES and not callable(_CALC_NAMES[node.id]):
            return _CALC_NAMES[node.id]
        raise ValueError(f"Unknown name: {node.id}")
    raise ValueError("Unsupported expression")


def _calculator(expression: str) -> str:
    tree = ast.parse(expression, mode="eval")
    return str(_eval_calc_node(tree.body))


# ─── Tool implementations ─────────────────────────────────────────────────

def _read_file(path: str) -> str:
    p = _resolve(path)
    if not p.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    if _is_sensitive_file(p):
        raise PermissionError(f"Refusing to read sensitive file: {path}")
    return p.read_text(encoding="utf-8", errors="replace")


def _write_file(path: str, content: str) -> str:
    p = _resolve(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    existed = p.exists()
    p.write_text(content, encoding="utf-8")
    return f"{'File written' if existed else 'File created'}: {path}"


def _patch_file(path: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
    p = _resolve(path)
    if not p.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    original = p.read_text(encoding="utf-8", errors="replace")

    if replace_all:
        patched = original.replace(old_string, new_string)
        if patched == original:
            normalized_old = old_string.replace("\r\n", "\n").replace("\r", "\n")
            patched = original.replace("\r\n", "\n").replace("\r", "\n").replace(normalized_old, new_string)
        if patched == original:
            raise ValueError(f"old_string not found in {path}")
    else:
        match = _fuzzy_find_match(original, old_string)
        if match is None:
            raise ValueError(
                f"old_string not found in {path} (tried exact, CRLF-normalized, "
                f"line-trimmed, and whitespace-normalized matching). Re-read the file first."
            )
        start, end = match
        patched = original[:start] + new_string + original[end:]

    p.write_text(patched, encoding="utf-8")
    return f"Patched {path}."


def _list_directory(path: str = "") -> str:
    root = _resolve(path)
    if not root.is_dir():
        raise NotADirectoryError(f"Directory not found: {path}")

    def render(dir_path: Path, depth: int, indent: str) -> list[str]:
        entries = sorted(dir_path.iterdir(), key=lambda e: e.name.lower())
        lines = []
        for entry in entries:
            if entry.is_dir():
                if entry.name in SKIP_DIRS:
                    lines.append(f"{indent}[DIR]  {entry.name}/ (skipped)")
                    continue
                lines.append(f"{indent}[DIR]  {entry.name}")
                if depth > 0:
                    lines.extend(render(entry, depth - 1, indent + "  "))
            else:
                lines.append(f"{indent}[FILE] {entry.name}")
        return lines

    lines = render(root, 2, "")
    return "\n".join(lines) if lines else "(empty directory)"


def _grep_files(pattern: str, path: str = "", file_pattern: str = "*", case_sensitive: bool = False) -> str:
    root = _resolve(path)
    if not root.is_dir():
        raise NotADirectoryError(f"Directory not found: {path}")

    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        regex = re.compile(pattern, flags)
    except re.error:
        regex = re.compile(re.escape(pattern), flags)

    results: list[str] = []
    max_results = 100

    def walk(dir_path: Path, prefix: str):
        if len(results) >= max_results:
            return
        for entry in sorted(dir_path.iterdir(), key=lambda e: e.name.lower()):
            if len(results) >= max_results:
                return
            entry_path = f"{prefix}/{entry.name}" if prefix else entry.name
            if entry.is_dir():
                if entry.name in SKIP_DIRS:
                    continue
                walk(entry, entry_path)
            elif _matches_file_glob(entry.name, file_pattern):
                if _is_sensitive_file(entry):
                    continue
                try:
                    if entry.stat().st_size > 500_000:
                        continue
                    text = entry.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                for i, line in enumerate(text.split("\n"), start=1):
                    if regex.search(line):
                        results.append(f"{entry_path}:{i}: {line.rstrip()}")
                        if len(results) >= max_results:
                            return

    walk(root, path.strip("/").replace("\\", "/") if path.strip("/") else ".")

    if not results:
        return "No matches found."
    return f"{len(results)} match{'es' if len(results) != 1 else ''}:\n" + "\n".join(results)


def _find_files(pattern: str, path: str = "") -> str:
    root = _resolve(path)
    if not root.is_dir():
        raise NotADirectoryError(f"Directory not found: {path}")

    name_pattern = pattern.rsplit("/", 1)[-1]
    results: list[str] = []
    max_results = 200

    def walk(dir_path: Path, prefix: str):
        if len(results) >= max_results:
            return
        for entry in sorted(dir_path.iterdir(), key=lambda e: e.name.lower()):
            if len(results) >= max_results:
                return
            entry_path = f"{prefix}/{entry.name}" if prefix else entry.name
            if fnmatch.fnmatch(entry.name.lower(), name_pattern.lower()):
                results.append(entry_path)
            if entry.is_dir():
                if entry.name in SKIP_DIRS:
                    continue
                walk(entry, entry_path)

    walk(root, path.strip("/").replace("\\", "/") if path.strip("/") else ".")

    if not results:
        return "No files matched."
    return f"{len(results)} file{'s' if len(results) != 1 else ''} found:\n" + "\n".join(results)


def _delete_file(path: str) -> str:
    p = _resolve(path)
    if not p.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    p.unlink()
    return f"Deleted: {path}"


def _create_folder(path: str) -> str:
    p = _resolve(path)
    p.mkdir(parents=True, exist_ok=True)
    return f"Created folder: {path}"


def _run_command(cmd: str, cwd: str = "") -> str:
    workdir = _resolve(cwd) if cwd else config.WORKSPACE_DIR
    try:
        result = subprocess.run(
            cmd, shell=True, cwd=str(workdir),
            capture_output=True, text=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        return "Command timed out after 120 seconds."

    combined = "\n".join(s for s in (result.stdout, result.stderr) if s).strip()
    exit_note = f"[exit code: {result.returncode}]"
    return f"{combined}\n\n{exit_note}" if combined else exit_note


def _git(cmd: str) -> str:
    return _run_command(cmd)


def _git_diff(staged: bool = False, path: str = "") -> str:
    cmd = "git diff " + ("--cached " if staged else "")
    if path:
        cmd += f"-- {path}"
    return _git(cmd.strip())


def _git_add(paths: str) -> str:
    return _git(f"git add {paths}")


def _git_commit(message: str) -> str:
    escaped = message.replace('"', '\\"')
    return _git(f'git commit -m "{escaped}"')


def _get_system_info() -> str:
    info = {
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "ollama_host": config.OLLAMA_HOST,
        "ollama_model": config.OLLAMA_MODEL,
        "workspace": str(config.WORKSPACE_DIR),
    }
    return json.dumps(info, indent=2)


def _web_search(query: str) -> str:
    results = web_search_mod.search(query, max_results=5)
    if not results:
        return "No results found."
    return "\n".join(f"{i}. {r['title']}\n   {r['url']}" for i, r in enumerate(results, start=1))


_TAG_RE = re.compile(r"<[^>]+>")


def _web_fetch(url: str) -> str:
    if not url.startswith(("http://", "https://")):
        raise ValueError("url must start with http:// or https://")

    resp = requests.get(url, headers={"User-Agent": "LocalMind-PhoneAgent/1.0"}, timeout=20)
    resp.raise_for_status()

    text = resp.text
    content_type = resp.headers.get("content-type", "")
    if "html" in content_type:
        text = re.sub(r"<script[\s\S]*?</script>", "", text, flags=re.IGNORECASE)
        text = re.sub(r"<style[\s\S]*?</style>", "", text, flags=re.IGNORECASE)
        text = re.sub(r"<!--[\s\S]*?-->", "", text)
        text = _TAG_RE.sub(" ", text)
        text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
        text = re.sub(r"[ \t]{2,}", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()

    max_len = 12000
    return text[:max_len] + "\n\n…(truncated)" if len(text) > max_len else text


def _save_skill(name: str, tags: str, content: str) -> str:
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    path = skill_writer.write_skill_md(name, tag_list, content)
    return f"Skill saved: {path.relative_to(config.WORKSPACE_DIR).as_posix()}"


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def _list_skills() -> str:
    if not config.SKILLS_DIR.is_dir():
        return "No skills found in .localmind/skills/."

    skills = []
    for f in sorted(config.SKILLS_DIR.glob("*.md")):
        text = f.read_text(encoding="utf-8", errors="replace")
        m = _FRONTMATTER_RE.match(text)
        name, tags = f.stem, ""
        if m:
            for line in m.group(1).split("\n"):
                if ":" not in line:
                    continue
                key, _, val = line.partition(":")
                key, val = key.strip(), val.strip()
                if key == "name":
                    name = val
                elif key == "tags":
                    tags = val
        skills.append((name, tags))

    if not skills:
        return "No skills found in .localmind/skills/."

    lines = [f"- **{name}** [{tags}]" for name, tags in skills]
    return f"{len(skills)} skills:\n" + "\n".join(lines)


# ─── Dispatcher ────────────────────────────────────────────────────────────

def execute_tool(name: str, args: dict) -> str:
    """Execute a tool by name and return its text output. Raises on error."""
    if name == "read_file":
        return _read_file(args["path"])
    if name == "write_file":
        return _write_file(args["path"], args.get("content", ""))
    if name == "patch_file":
        return _patch_file(args["path"], args["old_string"], args.get("new_string", ""), bool(args.get("replace_all", False)))
    if name == "list_directory":
        return _list_directory(args.get("path", ""))
    if name == "grep_files":
        return _grep_files(args["pattern"], args.get("path", ""), args.get("file_pattern", "*"), bool(args.get("case_sensitive", False)))
    if name == "find_files":
        return _find_files(args["pattern"], args.get("path", ""))
    if name == "delete_file":
        return _delete_file(args["path"])
    if name == "create_folder":
        return _create_folder(args["path"])
    if name == "run_command":
        return _run_command(args["cmd"], args.get("cwd", ""))
    if name == "get_system_info":
        return _get_system_info()
    if name == "git_status":
        return _git("git status --porcelain")
    if name == "git_diff":
        return _git_diff(bool(args.get("staged", False)), args.get("path", ""))
    if name == "git_log":
        return _git("git log --oneline -20")
    if name == "git_add":
        return _git_add(args["paths"])
    if name == "git_commit":
        return _git_commit(args["message"])
    if name == "calculator":
        return _calculator(args["expression"])
    if name == "web_search":
        return _web_search(args["query"])
    if name == "web_fetch":
        return _web_fetch(args["url"])
    if name == "save_skill":
        return _save_skill(args["name"], args.get("tags", ""), args["content"])
    if name == "list_skills":
        return _list_skills()
    raise ValueError(f"Unknown tool: {name}")
