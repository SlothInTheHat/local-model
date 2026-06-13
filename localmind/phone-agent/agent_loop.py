"""Tool-using agent loop for the Telegram bot.

Mirrors src/lib/agentLoop.ts: calls Ollama /api/chat with a tools array.
Read-only tools (see agent_tools.MUTATING_TOOLS) are executed immediately;
mutating tools are queued for the user to approve/deny via Telegram inline
buttons before they run.

State is kept in-memory per chat — it resets if the bot restarts.
"""

import json
import logging

import requests

import agent_tools
import config

logger = logging.getLogger("phone-agent.loop")

MAX_ROUNDS = 10

# chat_id -> list of {"role": ..., "content": ..., ...}
_history: dict[int, list[dict]] = {}
# chat_id -> list of (tool_name, args) awaiting approval
_pending: dict[int, list[tuple[str, dict]]] = {}
# chat_id -> model override (falls back to config.OLLAMA_MODEL if unset)
_model: dict[int, str] = {}


class StepResult:
    """Result of a loop step.

    kind == "reply": `text` is the assistant's final reply for this turn.
    kind == "approval_needed": `calls` is the list of (tool_name, args)
      pending approval; ask the user before calling approve()/deny().
    """

    def __init__(self, kind: str, **kw):
        self.kind = kind
        for key, val in kw.items():
            setattr(self, key, val)


def reset(chat_id: int) -> None:
    _history.pop(chat_id, None)
    _pending.pop(chat_id, None)


def has_pending(chat_id: int) -> bool:
    return chat_id in _pending


_NATIVE_TOOL_MODEL_HINTS = (
    "llama3.1", "llama3.2", "llama3.3", "llama3.4", "llama 3.1", "llama 3.2", "llama 3.3", "llama 3.4",
    "mistral-nemo", "mistral-large", "devstral", "mixtral",
    "qwen2", "qwen3", "command-r", "hermes2", "hermes3", "hermes-2", "hermes-3",
    "granite3", "granite-3", "nemotron", "firefunction", "gemma2", "gemma-2", "grok",
)


def supports_native_tools(model: str) -> bool:
    lower = model.lower()
    return any(hint in lower for hint in _NATIVE_TOOL_MODEL_HINTS)


def get_model(chat_id: int) -> str:
    """The model this chat will use - the per-chat override, or the configured default."""
    return _model.get(chat_id, config.OLLAMA_MODEL)


def set_model(chat_id: int, model: str) -> None:
    _model[chat_id] = model


def list_models() -> list[str]:
    """Names of models currently pulled in Ollama (e.g. "llama3.2:latest")."""
    resp = requests.get(f"{config.OLLAMA_HOST}/api/tags", timeout=30)
    resp.raise_for_status()
    return [m["name"] for m in resp.json().get("models", [])]


def resolve_model(requested: str, available: list[str]) -> str | None:
    """Match a user-supplied model name against installed models.

    Tolerates a missing `:latest` tag (e.g. "llama3.2" -> "llama3.2:latest").
    Returns None if nothing matches.
    """
    if requested in available:
        return requested
    if f"{requested}:latest" in available:
        return f"{requested}:latest"
    for name in available:
        if name.split(":")[0] == requested:
            return name
    return None


def _parse_args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _chat(messages: list[dict], model: str) -> dict:
    resp = requests.post(
        f"{config.OLLAMA_HOST}/api/chat",
        json={
            "model": model,
            "messages": messages,
            "tools": agent_tools.TOOL_DEFINITIONS,
            "stream": False,
        },
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()["message"]


def _execute_and_record(history: list[dict], name: str, args: dict) -> None:
    try:
        output = agent_tools.execute_tool(name, args)
    except Exception as exc:  # noqa: BLE001 - surface any tool failure to the model
        output = f"Error: {exc}"
    history.append({"role": "tool", "content": output})


def _run(chat_id: int) -> StepResult:
    history = _history[chat_id]
    model = get_model(chat_id)

    for _ in range(MAX_ROUNDS):
        message = _chat(history, model)
        history.append(message)

        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            return StepResult("reply", text=message.get("content") or "(empty response)")

        mutating: list[tuple[str, dict]] = []
        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            args = _parse_args(fn.get("arguments"))
            if name in agent_tools.MUTATING_TOOLS:
                mutating.append((name, args))
            else:
                _execute_and_record(history, name, args)

        if mutating:
            _pending[chat_id] = mutating
            return StepResult("approval_needed", calls=mutating)

    return StepResult("reply", text="(stopped after reaching the maximum number of tool-call rounds)")


def start(chat_id: int, user_text: str) -> StepResult:
    """Begin a new turn with a user message. Returns the first step result."""
    history = _history.setdefault(chat_id, [])
    history.append({"role": "user", "content": user_text})
    return _run(chat_id)


def approve(chat_id: int) -> StepResult:
    """Execute the pending mutating tool calls and continue the loop."""
    calls = _pending.pop(chat_id, [])
    history = _history[chat_id]
    for name, args in calls:
        _execute_and_record(history, name, args)
    return _run(chat_id)


def deny(chat_id: int) -> StepResult:
    """Skip the pending mutating tool calls and continue the loop."""
    calls = _pending.pop(chat_id, [])
    history = _history[chat_id]
    for name, _args in calls:
        history.append({"role": "tool", "content": f"User denied this {name} call."})
    return _run(chat_id)
