"""Long-lived faster-whisper worker for low-latency local dictation.

Loading the whisper model is the expensive part of every one-shot
`transcribe_cli.py` invocation (~1.6s on this machine, vs ~1.65s for the
actual transcription of a 6s clip). This daemon keeps the model resident in
RAM across requests so only the first dictation pays the load cost.

Protocol (line-delimited JSON over stdin/stdout):
  request:  {"path": "<audio file>", "model": "base"}\n
  response: {"text": "..."}\n            on success
            {"error": "..."}\n           on failure

Nothing but those JSON response lines may ever reach stdout — the Rust
caller (src-tauri/src/transcribe.rs) parses stdout line-by-line, and a stray
print (progress bar, warning banner, etc.) would corrupt the protocol. All
diagnostics go to stderr instead.

Exits cleanly when stdin hits EOF (i.e. the parent closed/dropped the pipe).
This is the orphan-cleanup mechanism: if LocalMind exits or crashes, the
daemon notices its stdin close and exits on its own rather than lingering
with a model resident in RAM.

Kept dependency-identical to transcribe_cli.py (faster-whisper only, stdlib
otherwise) — no new pip packages in this venv.

Usage: python whisper_daemon.py
"""

import gc
import json
import sys

# Models loaded so far, keyed by model name (e.g. "tiny", "base"), so
# switching models doesn't reload one that's already resident, and repeated
# requests for the same model reuse it instead of reloading every time.
_MODELS: dict = {}


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _get_model(model_name: str):
    model = _MODELS.get(model_name)
    if model is not None:
        return model

    from faster_whisper import WhisperModel

    _log(f"whisper_daemon: loading model '{model_name}' ...")
    # Same device/compute_type as transcribe_cli.py's transcribe() — this
    # machine's GPU reports 0 CUDA devices to CTranslate2, so CPU/int8 is the
    # only supported combination here.
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    _MODELS[model_name] = model
    _log(f"whisper_daemon: model '{model_name}' ready")
    return model


def _transcribe(path: str, model_name: str) -> str:
    """Mirrors transcribe_cli.py's transcribe(): same settings, same join."""
    model = _get_model(model_name)
    segments, _info = model.transcribe(path)
    return " ".join(seg.text.strip() for seg in segments)


def main() -> int:
    _log("whisper_daemon: starting, waiting for requests on stdin")
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            path = req["path"]
            model_name = (req.get("model") or "base").strip() or "base"
        except Exception as exc:
            print(json.dumps({"error": f"bad request: {exc}"}), flush=True)
            continue

        try:
            text = _transcribe(path, model_name)
            print(json.dumps({"text": text}), flush=True)
        except Exception as exc:  # keep the daemon alive across bad requests
            print(json.dumps({"error": str(exc)}), flush=True)

    # stdin closed (EOF) — parent process exited or dropped the pipe. Free
    # models explicitly and exit rather than lingering with RAM held.
    _MODELS.clear()
    gc.collect()
    _log("whisper_daemon: stdin closed, exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
