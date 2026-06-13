"""Lightweight DuckDuckGo web search — no API key required.

Mirrors the approach used by LocalMind's own src/lib/search.ts
(lite.duckduckgo.com / html.duckduckgo.com HTML scraping).
"""

import re
from html import unescape
from urllib.parse import parse_qs, unquote, urlparse

import requests

_TITLE_RE_LITE = re.compile(
    r'class="result-link"[^>]*>.*?<a\b[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_TITLE_RE_HTML = re.compile(
    r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")


def _clean_text(s: str) -> str:
    return " ".join(_TAG_RE.sub(" ", unescape(s)).split())


def _unwrap_url(url: str) -> str:
    """DDG sometimes wraps result links as //duckduckgo.com/l/?uddg=<encoded>."""
    if "duckduckgo.com/l/" in url:
        qs = parse_qs(urlparse(url).query)
        target = qs.get("uddg")
        if target:
            return unquote(target[0])
    return url


def _fetch(url: str, params: dict) -> str | None:
    try:
        resp = requests.get(
            url, params=params, timeout=10,
            headers={"User-Agent": "Mozilla/5.0 (LocalMind phone-agent)"},
        )
        if resp.ok:
            return resp.text
    except requests.RequestException:
        pass
    return None


def search(query: str, max_results: int = 5) -> list[dict]:
    """Return up to max_results {"title": str, "url": str} results."""
    results: list[dict] = []

    html = _fetch("https://lite.duckduckgo.com/lite/", {"q": query})
    if html:
        for m in _TITLE_RE_LITE.finditer(html):
            title = _clean_text(m.group(2))
            if not title or title.lower().startswith("next page") or title.lower().startswith("ad "):
                continue
            results.append({"title": title, "url": _unwrap_url(m.group(1))})

    if len(results) < max_results:
        html = _fetch("https://html.duckduckgo.com/html/", {"q": query})
        if html:
            for m in _TITLE_RE_HTML.finditer(html):
                title = _clean_text(m.group(2))
                if not title:
                    continue
                results.append({"title": title, "url": _unwrap_url(m.group(1))})

    # Deduplicate by title prefix, preserve order
    seen: set[str] = set()
    deduped: list[dict] = []
    for r in results:
        key = r["title"][:40].lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)

    return deduped[:max_results]
