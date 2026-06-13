import sqlite3
import time
from contextlib import closing

import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    transcript_path TEXT,
    processed_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tags TEXT NOT NULL,
    skill_path TEXT NOT NULL,
    resource_path TEXT,
    source_video_id INTEGER,
    created_at REAL NOT NULL,
    FOREIGN KEY (source_video_id) REFERENCES videos(id)
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH)
    conn.executescript(_SCHEMA)
    return conn


def log_video(filename: str, transcript_path: str | None) -> int:
    with closing(_connect()) as conn:
        cur = conn.execute(
            "INSERT INTO videos (filename, transcript_path, processed_at) VALUES (?, ?, ?)",
            (filename, transcript_path, time.time()),
        )
        conn.commit()
        return cur.lastrowid


def log_skill(
    name: str,
    tags: list[str],
    skill_path: str,
    resource_path: str | None,
    source_video_id: int | None,
) -> int:
    with closing(_connect()) as conn:
        cur = conn.execute(
            "INSERT INTO skills (name, tags, skill_path, resource_path, source_video_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, ", ".join(tags), skill_path, resource_path, source_video_id, time.time()),
        )
        conn.commit()
        return cur.lastrowid


def skill_exists(name: str) -> bool:
    with closing(_connect()) as conn:
        cur = conn.execute(
            "SELECT 1 FROM skills WHERE lower(name) = lower(?) LIMIT 1", (name,)
        )
        return cur.fetchone() is not None


def recent_skills(limit: int = 10) -> list[dict]:
    with closing(_connect()) as conn:
        cur = conn.execute(
            "SELECT name, tags, skill_path, created_at FROM skills "
            "ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
        return [
            {"name": row[0], "tags": row[1], "skill_path": row[2], "created_at": row[3]}
            for row in cur.fetchall()
        ]
