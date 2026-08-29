"""Shared GPU-if-available, CPU-otherwise model loading for the faster-whisper
pipeline.

transcribe_cli.py (one-shot video/audio/URL transcription) and
whisper_daemon.py (the warm dictation daemon) both need the exact same
"use the GPU if this machine can actually run on it, otherwise fall back to
CPU" logic — kept here once so the two scripts can't drift, and both are
bundled into the same PyInstaller executable anyway (see transcribe_tool.py),
so this module ships for free alongside them.
"""

import sys


def load_whisper_model(model_name: str):
    """Loads `model_name` on CUDA/float16 if a working GPU is actually usable
    on this machine, otherwise CPU/int8. Returns (model, device_used).

    A real trial load of the REQUESTED model is the detection mechanism, not
    a separate "count the CUDA devices" probe: CTranslate2 can report a CUDA
    device present (driver-level) while still lacking the cuDNN/cuBLAS
    runtime libraries actual inference needs — a common partial-install
    state — so nothing short of a genuine load attempt is a reliable signal
    either way. Using the SAME model the caller actually wants (rather than
    e.g. probing with "tiny") means a failed GPU attempt never costs an
    extra, unwanted model download just to find out.
    """
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(model_name, device="cuda", compute_type="float16")
        return model, "cuda"
    except Exception as exc:
        print(
            f"[whisper] GPU unavailable for '{model_name}' ({exc}); using CPU (int8)",
            file=sys.stderr,
        )
        return WhisperModel(model_name, device="cpu", compute_type="int8"), "cpu"
