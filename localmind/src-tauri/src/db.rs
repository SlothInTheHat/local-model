//! SQLite storage substrate (WP1.4).
//!
//! Replaces the old localStorage-backed vector memory (capped at ~5MB, which
//! silently fails once a few hundred 768-dim embeddings accumulate) with a
//! bundled SQLite database in the Rust backend. Also establishes the schema
//! for tables later work packages need (sessions/jobs/improvements) so the
//! schema is defined once, up front.
//!
//! ─── Connection strategy ───────────────────────────────────────────────────
//! A single `Connection` is lazily opened on first command call and cached in
//! a `Mutex` behind a `OnceLock`, mirroring the `REGISTERED_ROOTS` /
//! `OLLAMA_CHILD` pattern already used in lib.rs. Opening lazily (rather than
//! in `setup()`) is necessary because resolving the app-data directory needs
//! a `tauri::AppHandle`, which commands receive automatically but `setup()`
//! plumbing would require extra wiring for no real benefit at this volume.
//! Per-call open was considered (simpler) but a cached connection avoids
//! re-running the `CREATE TABLE IF NOT EXISTS` schema init on every single
//! memory read/write.
//!
//! ─── Embedding serialization ────────────────────────────────────────────────
//! Embeddings are stored as a JSON array string (`serde_json::to_string` of
//! `Vec<f32>`) in the `embedding` column (declared BLOB, but SQLite's dynamic
//! typing/type affinity does not force a conversion — BLOB affinity stores
//! whatever is given it, so a TEXT value round-trips unchanged). JSON was
//! chosen over a packed little-endian f32 byte blob because it is trivial to
//! keep in lockstep with the TypeScript side (`JSON.stringify`/`JSON.parse`
//! equivalent behavior) and the embeddings here are small (768 floats) so the
//! extra JSON overhead is not a real cost at this volume.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create app data dir '{}': {e}", dir.display()))?;
    Ok(dir.join("localmind.db"))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            embedding BLOB,
            tags TEXT,
            source TEXT,
            created_at INTEGER,
            last_used_at INTEGER,
            use_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            origin TEXT,
            task TEXT,
            transcript TEXT,
            outcome TEXT,
            created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            spec TEXT,
            next_run_at INTEGER,
            status TEXT,
            created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS improvements (
            id TEXT PRIMARY KEY,
            spec TEXT,
            status TEXT,
            created_at INTEGER
        );
        ",
    )
    .map_err(|e| format!("Schema init failed: {e}"))?;

    // FTS5 virtual table for full-text session search (wired up by WP4.3).
    // rusqlite's `bundled` feature compiles FTS5 into the bundled SQLite by
    // default, so this should always succeed — but degrade gracefully to a
    // plain shadow table + LIKE if a given build ever lacks FTS5, rather than
    // failing the whole schema init (and thus every memory command).
    if let Err(e) = conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(id UNINDEXED, task, transcript, outcome);",
    ) {
        eprintln!("[db] FTS5 unavailable ({e}); falling back to plain sessions_fts_plain table for LIKE-based search");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions_fts_plain (id TEXT PRIMARY KEY, task TEXT, transcript TEXT, outcome TEXT);",
        )
        .map_err(|e| format!("Fallback FTS table init failed: {e}"))?;
    }

    Ok(())
}

/// Get (lazily opening + initializing on first call) the cached connection.
fn get_db(app: &tauri::AppHandle) -> Result<&'static Mutex<Connection>, String> {
    if let Some(db) = DB.get() {
        return Ok(db);
    }
    let path = db_path(app)?;
    let conn = Connection::open(&path)
        .map_err(|e| format!("Cannot open db at '{}': {e}", path.display()))?;
    init_schema(&conn)?;
    // If another thread beat us to it, DB.set fails and our `conn` is dropped —
    // DB.get() below still returns the (only) stored connection either way.
    let _ = DB.set(Mutex::new(conn));
    Ok(DB.get().expect("DB was just initialized"))
}

#[derive(Serialize)]
pub struct MemoryRow {
    pub id: String,
    pub text: String,
    pub embedding: Vec<f32>,
    pub tags: String,
    pub source: String,
    pub created_at: i64,
    pub last_used_at: i64,
    pub use_count: i64,
}

/// Insert or update (by id) a memory entry. Embeddings are JSON-encoded —
/// see the module doc comment for why.
#[tauri::command]
pub fn memory_upsert(
    app: tauri::AppHandle,
    id: String,
    text: String,
    embedding: Vec<f32>,
    tags: String,
    source: String,
    created_at: i64,
) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    let embedding_json = serde_json::to_string(&embedding).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO memories (id, text, embedding, tags, source, created_at, last_used_at, use_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)
         ON CONFLICT(id) DO UPDATE SET
            text = excluded.text,
            embedding = excluded.embedding,
            tags = excluded.tags,
            source = excluded.source,
            created_at = excluded.created_at",
        params![id, text, embedding_json, tags, source, created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Return all memories (including embeddings) for JS-side cosine search.
/// Fine at low volume (hundreds of rows); revisit if this ever needs paging.
#[tauri::command]
pub fn memory_all(app: tauri::AppHandle) -> Result<Vec<MemoryRow>, String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    let mut stmt = conn
        // COALESCE: pre-existing rows may have NULL last_used_at / use_count.
        .prepare("SELECT id, text, embedding, tags, source, created_at, COALESCE(last_used_at, created_at), COALESCE(use_count, 0) FROM memories ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let embedding_json: Option<String> = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                embedding_json,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        let (id, text, embedding_json, tags, source, created_at, last_used_at, use_count) =
            r.map_err(|e| e.to_string())?;
        let embedding: Vec<f32> = embedding_json
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        out.push(MemoryRow {
            id,
            text,
            embedding,
            tags: tags.unwrap_or_default(),
            source: source.unwrap_or_default(),
            created_at,
            last_used_at,
            use_count,
        });
    }
    Ok(out)
}

/// Delete a memory by id. Not an error if the id doesn't exist.
#[tauri::command]
pub fn memory_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute("DELETE FROM memories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bump `last_used_at` / `use_count` for a memory. Called (fire-and-forget)
/// by searchMemory in src/lib/vectorMemory.ts for every retrieved memory;
/// feeds the usage-weighted ranking there.
#[tauri::command]
pub fn memory_touch(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute(
        "UPDATE memories SET last_used_at = ?2, use_count = use_count + 1 WHERE id = ?1",
        params![id, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Jobs (WP2.2: background scheduler) ────────────────────────────────────
//
// The `jobs` table (schema declared above in init_schema) holds scheduled
// agent tasks. `spec` is an opaque JSON string owned entirely by the
// TypeScript side (task text + schedule descriptor) — Rust never parses it,
// it only stores/retrieves it and hands it back verbatim in the `job-due`
// event payload. The scheduler TICK lives in lib.rs and calls `jobs_due_at`
// directly (bypassing the Tauri command layer) since it runs inside the same
// process on a timer, not in response to a frontend invoke.

#[derive(Serialize, Clone)]
pub struct JobRow {
    pub id: String,
    pub spec: String,
    pub next_run_at: i64,
    pub status: String,
    pub created_at: i64,
}

fn map_job_row(row: &rusqlite::Row) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: row.get(0)?,
        spec: row.get(1)?,
        next_run_at: row.get(2)?,
        status: row.get(3)?,
        created_at: row.get(4)?,
    })
}

/// Insert (or replace, by id) a scheduled job.
#[tauri::command]
pub fn jobs_insert(
    app: tauri::AppHandle,
    id: String,
    spec: String,
    next_run_at: i64,
    status: String,
) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute(
        "INSERT INTO jobs (id, spec, next_run_at, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            spec = excluded.spec,
            next_run_at = excluded.next_run_at,
            status = excluded.status",
        params![id, spec, next_run_at, status, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// List every job (any status), most recently created first.
#[tauri::command]
pub fn jobs_list(app: tauri::AppHandle) -> Result<Vec<JobRow>, String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, spec, next_run_at, status, created_at FROM jobs ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_job_row)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Non-command helper: return active jobs due at or before `now` (ms since
/// epoch). Factored out so the scheduler tick in lib.rs can call it directly
/// on a timer without going through the Tauri invoke machinery.
pub fn jobs_due_at(conn: &Connection, now: i64) -> Result<Vec<JobRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, spec, next_run_at, status, created_at FROM jobs
             WHERE status = 'active' AND next_run_at <= ?1
             ORDER BY next_run_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![now], map_job_row).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Tauri command wrapper around `jobs_due_at` (exposed for completeness /
/// possible future frontend polling use, e.g. a manual "check now" button).
#[tauri::command]
pub fn jobs_due(app: tauri::AppHandle, now: i64) -> Result<Vec<JobRow>, String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    jobs_due_at(&conn, now)
}

/// Update a job's next scheduled run time and status (e.g. after firing:
/// roll `next_run_at` forward, or set status = 'done' for a one-shot job).
#[tauri::command]
pub fn jobs_update_next(
    app: tauri::AppHandle,
    id: String,
    next_run_at: i64,
    status: String,
) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute(
        "UPDATE jobs SET next_run_at = ?2, status = ?3 WHERE id = ?1",
        params![id, next_run_at, status],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Non-command variant of `jobs_update_next`, used by the tick loop (which
/// already holds a `Connection`, not an `AppHandle`).
pub fn jobs_update_next_conn(
    conn: &Connection,
    id: &str,
    next_run_at: i64,
    status: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE jobs SET next_run_at = ?2, status = ?3 WHERE id = ?1",
        params![id, next_run_at, status],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cancel (delete) a scheduled job by id. Not an error if the id doesn't exist.
#[tauri::command]
pub fn jobs_cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the cached DB connection for use by the scheduler tick (lib.rs),
/// which needs direct `Connection` access (not a Tauri command context) to
/// call `jobs_due_at` / `jobs_update_next_conn` on a timer.
pub fn get_db_for_tick(app: &tauri::AppHandle) -> Result<&'static Mutex<Connection>, String> {
    get_db(app)
}

// ─── Sessions (WP4.3: past-session full-text search) ──────────────────────
//
// `sessions` (schema in init_schema) holds one row per headless run (task
// queue / scheduler / subagent) or interactive conversation, keyed by the
// caller's own id (a headless run's SessionResult.id, or a chat conversation
// id). `sessions_fts` is reindexed alongside on every insert/update — FTS5
// has no UPSERT, so writers must DELETE then INSERT. If FTS5 ops ever error
// (or, per init_schema, the virtual table never existed on this build), we
// mirror the same row into `sessions_fts_plain` instead, so session_search's
// LIKE fallback always has something to scan.

#[derive(Serialize)]
pub struct SessionSearchRow {
    pub id: String,
    pub origin: String,
    pub task: String,
    pub snippet: String,
    pub outcome: String,
    pub created_at: i64,
}

/// Insert or update (by id) a session transcript, and keep the FTS index (or
/// its plain fallback) in sync. Callers are expected to cap `transcript` to a
/// reasonable size themselves (the TS side caps at ~20k chars) — this command
/// stores whatever it's given.
#[tauri::command]
pub fn session_insert(
    app: tauri::AppHandle,
    id: String,
    origin: String,
    task: String,
    transcript: String,
    outcome: String,
    created_at: i64,
) -> Result<(), String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;
    conn.execute(
        "INSERT INTO sessions (id, origin, task, transcript, outcome, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            origin = excluded.origin,
            task = excluded.task,
            transcript = excluded.transcript,
            outcome = excluded.outcome,
            created_at = excluded.created_at",
        params![id, origin, task, transcript, outcome, created_at],
    )
    .map_err(|e| e.to_string())?;

    // FTS5 has no UPSERT — delete then reinsert. On any error (including the
    // table not existing on a build without FTS5), fall back to mirroring the
    // row into the plain LIKE-scan shadow table instead.
    let fts_result: rusqlite::Result<()> = (|| {
        conn.execute("DELETE FROM sessions_fts WHERE id = ?1", params![id])?;
        conn.execute(
            "INSERT INTO sessions_fts (id, task, transcript, outcome) VALUES (?1, ?2, ?3, ?4)",
            params![id, task, transcript, outcome],
        )?;
        Ok(())
    })();
    if fts_result.is_err() {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions_fts_plain (id TEXT PRIMARY KEY, task TEXT, transcript TEXT, outcome TEXT);",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sessions_fts_plain WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO sessions_fts_plain (id, task, transcript, outcome) VALUES (?1, ?2, ?3, ?4)",
            params![id, task, transcript, outcome],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Sanitize a free-text query into an FTS5 MATCH expression: split on
/// whitespace, strip everything but alphanumerics from each term (FTS5
/// chokes on bare `-`, `"`, `(` etc.), quote each surviving term, and AND
/// them together (FTS5's implicit default between quoted terms). Returns an
/// empty string if nothing survives (e.g. a query of just punctuation) — the
/// caller treats that as "no results" rather than running a MATCH ''.
fn sanitize_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|term| term.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(" ")
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// Build a short manual snippet around the first case-insensitive match of
/// `query` in `transcript`, for the LIKE-fallback path (FTS5's own `snippet()`
/// covers the primary path). Falls back to the transcript's first ~120 chars
/// if the query isn't found verbatim (e.g. it matched via a different
/// sanitized term than the raw substring check here).
fn manual_snippet(transcript: &str, query: &str) -> String {
    let lower = transcript.to_lowercase();
    let q = query.to_lowercase();
    match lower.find(&q) {
        Some(i) => {
            let start = floor_char_boundary(transcript, i.saturating_sub(40));
            let end = ceil_char_boundary(transcript, (i + q.len() + 80).min(transcript.len()));
            format!("…{}…", &transcript[start..end])
        }
        None => {
            let end = ceil_char_boundary(transcript, transcript.len().min(120));
            transcript[..end].to_string()
        }
    }
}

/// LIKE-based fallback for `session_search`, used when the FTS5 MATCH query
/// errors (or FTS5 was unavailable at schema-init time). Prefers the plain
/// shadow table kept in sync by `session_insert`; if that table doesn't exist
/// either (e.g. FTS5 has always worked on this build and the fallback table
/// was never created, but the MATCH query still failed for some other
/// reason), scans `sessions` directly.
fn like_fallback_search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SessionSearchRow>, String> {
    let escaped = query.replace('%', "").replace('_', "");
    if escaped.is_empty() {
        return Ok(vec![]);
    }
    let pattern = format!("%{escaped}%");

    let from_plain: rusqlite::Result<Vec<SessionSearchRow>> = (|| {
        let mut stmt = conn.prepare(
            "SELECT p.id, s.origin, p.task, p.transcript, p.outcome, s.created_at
             FROM sessions_fts_plain p
             JOIN sessions s ON s.id = p.id
             WHERE p.task LIKE ?1 OR p.transcript LIKE ?1 OR p.outcome LIKE ?1
             ORDER BY s.created_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |row| {
            let transcript: String = row.get(3)?;
            Ok(SessionSearchRow {
                id: row.get(0)?,
                origin: row.get(1)?,
                task: row.get(2)?,
                snippet: manual_snippet(&transcript, query),
                outcome: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    })();
    if let Ok(rows) = from_plain {
        return Ok(rows);
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, origin, task, transcript, outcome, created_at FROM sessions
             WHERE task LIKE ?1 OR transcript LIKE ?1 OR outcome LIKE ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![pattern, limit], |row| {
            let transcript: String = row.get(3)?;
            Ok(SessionSearchRow {
                id: row.get(0)?,
                origin: row.get(1)?,
                task: row.get(2)?,
                snippet: manual_snippet(&transcript, query),
                outcome: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Full-text search across `sessions` via the FTS5 index, ranked by bm25
/// (best match first). Degrades to `like_fallback_search` if the MATCH query
/// errors for any reason (FTS5 unavailable, corrupt index, etc.).
#[tauri::command]
pub fn session_search(app: tauri::AppHandle, query: String, limit: i64) -> Result<Vec<SessionSearchRow>, String> {
    let db = get_db(&app)?;
    let conn = db.lock().map_err(|_| "db lock poisoned".to_string())?;

    let fts_query = sanitize_fts_query(&query);
    if fts_query.is_empty() {
        return Ok(vec![]);
    }

    let fts_attempt: rusqlite::Result<Vec<SessionSearchRow>> = (|| {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.origin, s.task, snippet(sessions_fts, 2, '[', ']', '…', 10), s.outcome, s.created_at
             FROM sessions_fts
             JOIN sessions s ON s.id = sessions_fts.id
             WHERE sessions_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts_query, limit], |row| {
            Ok(SessionSearchRow {
                id: row.get(0)?,
                origin: row.get(1)?,
                task: row.get(2)?,
                snippet: row.get(3)?,
                outcome: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    })();

    match fts_attempt {
        Ok(rows) => Ok(rows),
        Err(e) => {
            eprintln!("[db] session_search FTS query failed ({e}); falling back to LIKE scan");
            like_fallback_search(&conn, &query, limit)
        }
    }
}
