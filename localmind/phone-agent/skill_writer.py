"""Writes LocalMind skill files (.localmind/skills/*.md) and downloads
supporting resources (.localmind/resources/<slug>/...).

The skill md format and slug algorithm here must match
src/lib/skillEngine.ts's saveSkill() exactly so skills written here show
up correctly in LocalMind's Skills tab.
"""

import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import requests

import config

_SLUG_INVALID_RE = re.compile(r"[^a-z0-9]+")
_DOC_EXTENSIONS = (".md", ".txt", ".rst")


def slugify(name: str) -> str:
    """Match skillEngine.ts's saveSkill slug algorithm exactly:
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    """
    slug = _SLUG_INVALID_RE.sub("-", name.lower())
    return slug.strip("-")


def write_skill_md(name: str, tags: list[str], content: str) -> Path:
    """Write SKILLS_DIR/{slug}.md with frontmatter matching skillEngine.ts."""
    config.SKILLS_DIR.mkdir(parents=True, exist_ok=True)

    slug = slugify(name)
    body = (
        "---\n"
        f"name: {name}\n"
        f"tags: {', '.join(tags)}\n"
        "---\n"
        "\n"
        f"{content.strip()}\n"
    )

    path = config.SKILLS_DIR / f"{slug}.md"
    path.write_text(body, encoding="utf-8")
    return path


def _is_github_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return host == "github.com" or host.endswith(".github.com")


def download_resource(url: str, slug: str) -> Path | None:
    """Download a resource for a skill into RESOURCES_DIR/{slug}/...

    GitHub URLs are shallow-cloned into RESOURCES_DIR/{slug}/repo.
    .md/.txt/.rst URLs are saved into RESOURCES_DIR/{slug}/docs/.
    Returns the path written, or None if the URL wasn't handled or the
    download failed.
    """
    if _is_github_url(url):
        return _clone_github_repo(url, slug)

    parsed = urlparse(url)
    if parsed.path.lower().endswith(_DOC_EXTENSIONS):
        return _download_doc(url, slug)

    return None


def _clone_github_repo(url: str, slug: str) -> Path | None:
    target = config.RESOURCES_DIR / slug / "repo"
    if target.exists():
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["git", "clone", "--depth=1", url, str(target)],
            capture_output=True,
            timeout=120,
        )
    except (subprocess.SubprocessError, OSError):
        return None

    if result.returncode != 0:
        return None
    return target


def _download_doc(url: str, slug: str) -> Path | None:
    docs_dir = config.RESOURCES_DIR / slug / "docs"

    parsed = urlparse(url)
    filename = Path(parsed.path).name or "resource.md"

    try:
        resp = requests.get(
            url, timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (LocalMind phone-agent)"},
        )
        if not resp.ok:
            return None
    except requests.RequestException:
        return None

    docs_dir.mkdir(parents=True, exist_ok=True)
    path = docs_dir / filename
    path.write_bytes(resp.content)
    return path
