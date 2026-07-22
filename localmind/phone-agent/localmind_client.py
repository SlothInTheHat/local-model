"""Thin HTTP client for the LocalMind desktop app's local IPC listener.

The desktop app (src-tauri/src/ipc.rs) runs a loopback-only HTTP server on
127.0.0.1:41777, protected by a bearer token the app generates on first run
and persists to disk. This module knows nothing about Telegram — it just
knows how to find that token and talk to that server:

    POST /task          -> {"status": "queued", "id": "<uuid>"}
    GET  /task/{id}      -> {"id", "status", "summary"}   status in
                            queued | running | done | error
    GET  /health         -> {"status": "ok"}

`agent.py` is the only caller; it imports `read_token`, `health`, `submit`,
and `poll` and has no direct knowledge of the wire format.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable, Optional

import requests

DEFAULT_BASE_URL = "http://127.0.0.1:41777"
APP_IDENTIFIER = "com.lalwa.localmind"
TOKEN_FILE_NAME = "ipc-token.txt"

# Per-request network timeout (seconds). Applied to every call this module
# makes so a wedged/hung server can never hang the caller indefinitely -
# poll() layers its own overall timeout on top of these per-request ones.
_REQUEST_TIMEOUT_S = 10.0

# poll() backoff: hammering a local agent run (which takes tens of seconds)
# every 200ms is pointless. Poll quickly for the first stretch in case the
# task finishes fast, then back off to reduce overhead on longer runs.
_FAST_POLL_INTERVAL_S = 1.0
_FAST_POLL_WINDOW_S = 15.0
_SLOW_POLL_INTERVAL_S = 3.0

TERMINAL_STATUSES = ("done", "error")


class LocalMindClientError(RuntimeError):
    """Raised for configuration problems (e.g. missing token) - not for
    ordinary network/HTTP failures, which are left as requests exceptions
    so callers can distinguish "misconfigured" from "app isn't running"."""


def _default_token_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        base = Path(appdata)
    else:
        # Non-Windows fallback (this app is Windows-first, but don't hard
        # fail just because APPDATA isn't set in some other environment).
        base = Path.home() / "AppData" / "Roaming"
    return base / APP_IDENTIFIER / TOKEN_FILE_NAME


def read_token() -> str:
    """Locate and return the IPC bearer token.

    Resolution order:
      1. `LOCALMIND_IPC_TOKEN` env var - the raw token string.
      2. `LOCALMIND_IPC_TOKEN_FILE` env var - path to a file containing it.
      3. `%APPDATA%/com.lalwa.localmind/ipc-token.txt` (the Tauri
         `app_data_dir` default on Windows).

    Raises LocalMindClientError with an actionable message if none of the
    above yields a non-empty token.
    """
    raw = os.environ.get("LOCALMIND_IPC_TOKEN")
    if raw and raw.strip():
        return raw.strip()

    override_path = os.environ.get("LOCALMIND_IPC_TOKEN_FILE")
    candidate = Path(override_path) if override_path else _default_token_path()

    try:
        content = candidate.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise LocalMindClientError(
            f"Could not read the LocalMind IPC token from '{candidate}': {exc}.\n"
            "Make sure the LocalMind desktop app has been run at least once "
            "(it generates this file on first launch), or set "
            "LOCALMIND_IPC_TOKEN / LOCALMIND_IPC_TOKEN_FILE to point at it."
        ) from exc

    if not content:
        raise LocalMindClientError(
            f"Token file '{candidate}' exists but is empty. Restart the "
            "LocalMind desktop app to regenerate it."
        )
    return content


def _base_url() -> str:
    return os.environ.get("LOCALMIND_IPC_URL", DEFAULT_BASE_URL).rstrip("/")


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def health() -> bool:
    """True iff the local app is reachable and accepts our token."""
    try:
        token = read_token()
    except LocalMindClientError:
        return False
    try:
        resp = requests.get(
            f"{_base_url()}/health", headers=_headers(token), timeout=_REQUEST_TIMEOUT_S
        )
    except requests.RequestException:
        return False
    return resp.status_code == 200


def submit(task: str, target_view: str = "chat") -> str:
    """POST /task and return the queued task's id.

    Always sends expectSideEffects: false - a Telegram message is normally
    a question, and the desktop runtime forces outcome: "error" on a run
    that expected side effects but produced none.
    """
    token = read_token()
    resp = requests.post(
        f"{_base_url()}/task",
        json={"task": task, "targetView": target_view, "expectSideEffects": False},
        headers=_headers(token),
        timeout=_REQUEST_TIMEOUT_S,
    )
    resp.raise_for_status()
    body = resp.json()
    return body["id"]


def get_task(task_id: str) -> dict:
    """GET /task/{id} once. Returns {"id", "status", "summary"}."""
    token = read_token()
    resp = requests.get(
        f"{_base_url()}/task/{task_id}", headers=_headers(token), timeout=_REQUEST_TIMEOUT_S
    )
    resp.raise_for_status()
    return resp.json()


def poll(
    task_id: str,
    timeout_s: float,
    on_status: Optional[Callable[[str], None]] = None,
) -> dict:
    """Poll GET /task/{id} until it reaches a terminal status or timeout_s
    elapses.

    Backoff: every _FAST_POLL_INTERVAL_S (1s) for the first
    _FAST_POLL_WINDOW_S (~15s), then every _SLOW_POLL_INTERVAL_S (3s) after
    that - a local agent run takes tens of seconds, so polling every 200ms
    would just waste cycles.

    `on_status`, if given, is called with the new status string only when
    it *changes* from the previous poll (including the very first
    observation), so a caller updating a Telegram message doesn't spam
    edits on every poll tick.

    Returns the last-seen task dict regardless of whether it reached a
    terminal status - callers should check `result["status"]` against
    TERMINAL_STATUSES to distinguish a real answer from a timeout.
    """
    start = time.monotonic()
    last_status: Optional[str] = None
    last_result: dict = {"id": task_id, "status": "queued", "summary": None}

    while True:
        try:
            last_result = get_task(task_id)
        except requests.RequestException:
            # Transient network hiccup against a server we already reached
            # once to submit() - keep polling rather than aborting the
            # whole wait, as long as time remains.
            pass
        else:
            status = last_result.get("status")
            if status != last_status:
                last_status = status
                if on_status is not None:
                    on_status(status)
            if status in TERMINAL_STATUSES:
                return last_result

        elapsed = time.monotonic() - start
        if elapsed >= timeout_s:
            return last_result

        interval = (
            _FAST_POLL_INTERVAL_S if elapsed < _FAST_POLL_WINDOW_S else _SLOW_POLL_INTERVAL_S
        )
        remaining = timeout_s - elapsed
        time.sleep(min(interval, remaining))
