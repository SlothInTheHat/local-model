import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _require(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return val


TELEGRAM_TOKEN = _require("TELEGRAM_TOKEN")
ALLOWED_CHAT_ID = int(_require("ALLOWED_CHAT_ID"))

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")

WORKSPACE_DIR = Path(_require("LOCALMIND_WORKSPACE")).expanduser()
LOCALMIND_DIR = WORKSPACE_DIR / ".localmind"
SKILLS_DIR = LOCALMIND_DIR / "skills"
RESOURCES_DIR = LOCALMIND_DIR / "resources"
TRANSCRIPTS_DIR = RESOURCES_DIR / "transcripts"

DB_PATH = Path(__file__).resolve().parent / "phone_agent.db"

MAX_VIDEO_MB = int(os.environ.get("MAX_VIDEO_MB", "500"))
