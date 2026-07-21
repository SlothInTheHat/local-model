"""Standalone video/audio/URL -> transcript CLI (no Telegram/config/db deps).

Used by the LocalMind desktop app's `transcribe_video` agent tool. Prints the
transcript to stdout and nothing else.

Accepts either:
  * a local video/audio file path, or
  * a URL (YouTube etc.) — captions are fetched first (fast, via yt-dlp); if the
    video has none, the audio is downloaded and transcribed with whisper.

Requires ffmpeg on PATH and faster-whisper + yt-dlp installed — this repo's
phone-agent/.venv provides all three.

Usage: python transcribe_cli.py <path_or_url>
Env:   LOCALMIND_WHISPER_MODEL  (default "base")  e.g. base/small/medium
"""

import gc
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def extract_audio(video_path: Path) -> Path:
    """Extract a 16 kHz mono WAV from a video/audio file using ffmpeg."""
    audio_path = Path(tempfile.mkstemp(suffix=".wav")[1])
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path), "-ar", "16000", "-ac", "1", str(audio_path)],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')}")
    return audio_path


def transcribe(audio_path: Path, model_name: str) -> str:
    """Transcribe audio to text using faster-whisper (CPU, int8)."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    try:
        segments, _info = model.transcribe(str(audio_path))
        return " ".join(seg.text.strip() for seg in segments)
    finally:
        del model
        gc.collect()


# ── URL (YouTube etc.) support via yt-dlp ─────────────────────────────────────

def _yt_dlp(args: list[str]) -> subprocess.CompletedProcess:
    # Invoke via the same interpreter so we always hit the venv's yt-dlp.
    return subprocess.run(
        [sys.executable, "-m", "yt_dlp", *args], capture_output=True, text=True
    )


_VTT_TAG_RE = re.compile(r"<[^>]+>")


def parse_vtt(vtt: str) -> str:
    """Flatten a WebVTT caption file to plain deduplicated text."""
    out: list[str] = []
    prev: str | None = None
    for raw in vtt.splitlines():
        line = raw.strip()
        if (
            not line
            or line == "WEBVTT"
            or "-->" in line
            or line.isdigit()
            or line.startswith(("Kind:", "Language:", "NOTE"))
        ):
            continue
        line = _VTT_TAG_RE.sub("", line).strip()
        if not line or line == prev:  # rolling auto-captions repeat lines
            continue
        out.append(line)
        prev = line
    return " ".join(out)


def fetch_captions(url: str, workdir: Path) -> str | None:
    """Try to get existing/auto captions (fast, no download). None if absent."""
    _yt_dlp([
        "--skip-download", "--write-auto-subs", "--write-subs",
        "--sub-langs", "en.*,en", "--sub-format", "vtt",
        "-o", str(workdir / "%(id)s.%(ext)s"), url,
    ])
    vtts = sorted(workdir.glob("*.vtt"))
    if not vtts:
        return None
    text = parse_vtt(vtts[0].read_text(encoding="utf-8", errors="replace"))
    return text or None


def download_audio_media(url: str, workdir: Path) -> Path | None:
    """Download the best audio stream. Returns the media file, or None."""
    res = _yt_dlp(["-f", "bestaudio/best", "-o", str(workdir / "%(id)s.%(ext)s"), url])
    if res.returncode != 0:
        return None
    media = [p for p in workdir.iterdir() if p.is_file() and p.suffix.lower() != ".vtt"]
    return media[0] if media else None


def transcribe_url(url: str, model_name: str) -> str:
    workdir = Path(tempfile.mkdtemp())
    try:
        captions = fetch_captions(url, workdir)
        if captions:
            return captions
        # No captions — fall back to downloading audio and running whisper.
        media = download_audio_media(url, workdir)
        if media is None:
            raise RuntimeError("could not fetch captions or audio for the URL")
        audio = extract_audio(media)
        try:
            return transcribe(audio, model_name)
        finally:
            try:
                audio.unlink(missing_ok=True)
            except OSError:
                pass
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def transcribe_local(path: Path, model_name: str) -> str:
    audio = extract_audio(path)
    try:
        return transcribe(audio, model_name)
    finally:
        # faster-whisper can hold the WAV open on Windows; cleanup is best-effort.
        try:
            audio.unlink(missing_ok=True)
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe_cli.py <path_or_url>", file=sys.stderr)
        return 2

    src = sys.argv[1]
    model_name = os.environ.get("LOCALMIND_WHISPER_MODEL", "base")

    try:
        if is_url(src):
            text = transcribe_url(src, model_name)
        else:
            p = Path(src)
            if not p.exists():
                print(f"file not found: {p}", file=sys.stderr)
                return 1
            text = transcribe_local(p, model_name)
    except Exception as exc:  # surface a clean reason to the caller
        print(str(exc), file=sys.stderr)
        return 1

    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
