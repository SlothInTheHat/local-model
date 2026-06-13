"""Video -> transcript -> skills pipeline.

ffmpeg extracts audio, faster-whisper transcribes it, Ollama mines the
transcript for skills/tools/techniques, web_search finds resources for
each, and skill_writer saves everything as LocalMind skills.
"""

import json
import subprocess
import tempfile
from pathlib import Path

import requests

import config
import db
import skill_writer
import web_search

_EXTRACT_PROMPT = """You are analyzing a transcript of a video. Identify any \
distinct tools, technologies, techniques, or skills that are discussed or \
demonstrated, that someone might want to learn more about or set up later.

Respond with ONLY a JSON object of the form:
{{"skills": [{{"name": "...", "tags": ["...", "..."], "summary": "1-2 sentence summary"}}]}}

If nothing notable is discussed, respond with {{"skills": []}}.

Transcript:
{transcript}
"""

_EXTRACT_PROMPT_STRICT = """Extract a JSON object and NOTHING ELSE - no \
markdown, no commentary, no code fences. The JSON must match exactly:
{{"skills": [{{"name": "...", "tags": ["..."], "summary": "..."}}]}}

Transcript:
{transcript}
"""


def extract_audio(video_path: Path) -> Path:
    """Extract a 16kHz mono WAV from a video using ffmpeg."""
    audio_path = Path(tempfile.mkstemp(suffix=".wav")[1])
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(video_path),
            "-ar", "16000", "-ac", "1",
            str(audio_path),
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')}")
    return audio_path


def transcribe(audio_path: Path) -> str:
    """Transcribe audio to text using faster-whisper (CPU, int8)."""
    from faster_whisper import WhisperModel

    model = WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(str(audio_path))
    return " ".join(segment.text.strip() for segment in segments)


def _ollama_generate_json(prompt: str) -> dict | None:
    try:
        resp = requests.post(
            f"{config.OLLAMA_HOST}/api/generate",
            json={
                "model": config.OLLAMA_MODEL,
                "prompt": prompt,
                "format": "json",
                "stream": False,
            },
            timeout=120,
        )
        resp.raise_for_status()
    except requests.RequestException:
        return None

    raw = resp.json().get("response", "")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def extract_skills(transcript: str) -> list[dict]:
    """Ask Ollama to mine a transcript for skills. Returns [] on failure."""
    parsed = _ollama_generate_json(_EXTRACT_PROMPT.format(transcript=transcript))
    if parsed is None:
        parsed = _ollama_generate_json(_EXTRACT_PROMPT_STRICT.format(transcript=transcript))

    if not parsed or not isinstance(parsed.get("skills"), list):
        return []

    skills = []
    for item in parsed["skills"]:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        tags = item.get("tags") or []
        if not isinstance(tags, list):
            tags = [str(tags)]
        skills.append({
            "name": str(item["name"]),
            "tags": [str(t) for t in tags],
            "summary": str(item.get("summary", "")),
        })
    return skills


def _save_transcript(video_path: Path, transcript: str) -> Path:
    config.TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    path = config.TRANSCRIPTS_DIR / f"{video_path.stem}.md"
    path.write_text(
        f"# Transcript: {video_path.name}\n\n{transcript}\n", encoding="utf-8"
    )
    return path


def _build_skill_content(skill: dict, results: list[dict], downloaded: list[Path | None]) -> str:
    lines = [skill["summary"] or f"Notes on {skill['name']}, extracted from a video transcript."]
    if results:
        lines.append("\n## Resources\n")
        for result, local_path in zip(results, downloaded):
            lines.append(f"- [{result['title']}]({result['url']})")
            if local_path is not None:
                lines.append(f"  - Downloaded to `{local_path}`")
    return "\n".join(lines)


def process_video(video_path: str | Path) -> tuple[str, list[str]]:
    """Run the full pipeline on a video file.

    Returns (summary_text, list_of_written_skill_paths).
    """
    video_path = Path(video_path)

    audio_path = extract_audio(video_path)
    try:
        transcript = transcribe(audio_path)
    finally:
        audio_path.unlink(missing_ok=True)

    transcript_path = _save_transcript(video_path, transcript)
    video_id = db.log_video(video_path.name, str(transcript_path))

    skills = extract_skills(transcript)

    written_paths: list[str] = []
    for skill in skills:
        if db.skill_exists(skill["name"]):
            continue

        results = web_search.search(f"{skill['name']} tutorial documentation github", max_results=2)

        downloaded: list[Path | None] = []
        for result in results:
            downloaded.append(skill_writer.download_resource(result["url"], skill_writer.slugify(skill["name"])))

        content = _build_skill_content(skill, results, downloaded)
        skill_path = skill_writer.write_skill_md(skill["name"], skill["tags"], content)

        resource_path = next((str(p) for p in downloaded if p is not None), None)
        db.log_skill(skill["name"], skill["tags"], str(skill_path), resource_path, video_id)

        written_paths.append(str(skill_path))

    if written_paths:
        summary = (
            f"Processed {video_path.name}: transcribed and found {len(written_paths)} "
            f"new skill(s):\n" + "\n".join(f"- {p}" for p in written_paths)
        )
    elif skills:
        summary = (
            f"Processed {video_path.name}: transcribed, but all "
            f"{len(skills)} mentioned skill(s) were already known."
        )
    else:
        summary = f"Processed {video_path.name}: transcribed, but no notable skills were found."

    return summary, written_paths
