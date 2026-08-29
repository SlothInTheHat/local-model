"""Long-lived Kokoro-82M TTS worker — mirrors phone-agent/whisper_daemon.py's
warm-model pattern so LocalMind pays kokoro-onnx's model-load cost once per
app session, not once per spoken sentence (Piper, the engine this replaces,
had no such daemon — it shelled out to a fresh Python process, reloading the
model from scratch, for every single utterance).

This file is embedded into the Rust binary via include_str! (see kokoro.rs)
and written out to <kokoro venv root>/kokoro_daemon.py at setup time and
before every daemon spawn, so an app update always runs the latest version
of this script even against an already-set-up venv.

Protocol (line-delimited JSON over stdin/stdout):
  request:  {"text": "...", "voice": "af_heart"}\n
  response: {"path": "<wav file>"}\n   on success — caller deletes it after playback
            {"error": "..."}\n         on failure

Nothing but those JSON response lines may ever reach stdout — mirrors
whisper_daemon.py's same constraint (the Rust caller parses stdout
line-by-line, and a stray print would corrupt the protocol). All
diagnostics go to stderr instead.

Exits cleanly on stdin EOF (parent closed/dropped the pipe) — same
orphan-cleanup rationale as whisper_daemon.py: if LocalMind exits or
crashes, this notices its stdin close and exits on its own rather than
lingering with a model resident in RAM.

Usage: python kokoro_daemon.py <model_path> <voices_path>
"""

import json
import sys
import tempfile

_KOKORO = None


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _get_kokoro(model_path: str, voices_path: str):
    global _KOKORO
    if _KOKORO is not None:
        return _KOKORO

    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    _log("kokoro_daemon: loading model ...")
    # CUDAExecutionProvider first, CPUExecutionProvider as the fallback —
    # onnxruntime tries providers in order and silently falls through to the
    # next one if a given provider can't actually be initialized (missing
    # cuDNN/cuBLAS runtime libs, no compatible GPU, etc.), so this one line
    # is the entire "use the GPU if it works, otherwise CPU" policy: no
    # separate detection/try-except dance needed on this side, unlike
    # CTranslate2/faster-whisper which has no such automatic fallback.
    session = ort.InferenceSession(model_path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    used = session.get_providers()[0] if session.get_providers() else "unknown"
    _KOKORO = Kokoro.from_session(session, voices_path)
    _log(f"kokoro_daemon: model ready (provider={used})")
    return _KOKORO


def _synthesize(kokoro, text: str, voice: str) -> str:
    import soundfile as sf

    samples, sample_rate = kokoro.create(text, voice=voice)
    out_path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    sf.write(out_path, samples, sample_rate)
    return out_path


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: kokoro_daemon.py <model_path> <voices_path>", file=sys.stderr)
        return 2
    model_path, voices_path = sys.argv[1], sys.argv[2]

    _log("kokoro_daemon: starting, waiting for requests on stdin")
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            text = req["text"]
            voice = (req.get("voice") or "af_heart").strip() or "af_heart"
        except Exception as exc:
            print(json.dumps({"error": f"bad request: {exc}"}), flush=True)
            continue

        try:
            kokoro = _get_kokoro(model_path, voices_path)
            path = _synthesize(kokoro, text, voice)
            print(json.dumps({"path": path}), flush=True)
        except Exception as exc:  # keep the daemon alive across bad requests
            print(json.dumps({"error": str(exc)}), flush=True)

    _log("kokoro_daemon: stdin closed, exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
