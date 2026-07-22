//! Local IPC listener (WP5.4, task result retrieval added in WP6.4a).
//!
//! A loopback-only HTTP listener that lets other local programs on this
//! machine hand LocalMind a task without duplicating any agent logic. The
//! primary future consumer is the Python phone-agent (Telegram bridge), which
//! today runs its own duplicate agent loop — a later work package will
//! reduce it to a thin relay that POSTs here instead. That retirement is not
//! done by this file; this file only builds the listener.
//!
//! ─── THE CENTRAL SAFETY PROPERTY ───────────────────────────────────────────
//! This listener does NOT execute anything itself. It validates the token and
//! request body, then emits a Tauri event (`ipc-task`). A listener in
//! src/App.tsx enqueues the payload into the existing task queue
//! (`useTaskQueueStore.enqueue`), and the existing task runner
//! (src/lib/taskRunner.ts) drains it through the existing headless agent
//! runtime. Every approval gate, tool allowlist, and workspace confinement
//! already built in earlier phases therefore applies automatically — there is
//! no code path from this socket to a shell command, a file write, or a tool
//! call that skips the task queue.
//!
//! ─── WP6.4a: result retrieval ──────────────────────────────────────────────
//! `POST /task` is fire-and-forget for the caller — the answer comes back
//! later, from the frontend, after the task queue actually runs it. This adds
//! polling instead of a blocking response: `POST /task` now returns an id
//! immediately (still 202, still "queued", nothing executed yet), and the
//! caller polls `GET /task/{id}` for the outcome. Blocking the POST until
//! completion was deliberately rejected — tiny_http's accept loop is single-
//! threaded per `handle_request` call, so a slow agent run would wedge every
//! other request behind it. The in-memory `TASK_STORE` below is written to
//! twice: once here (status "queued", on accept) and once more from the
//! frontend via `ipc_report_task_result` once the task queue actually
//! finishes it — see src/App.tsx's `useTaskQueueStore` subscription. This
//! store does not change the safety property above: it only ever records
//! outcomes the task queue already produced, never triggers execution.
//!
//! ─── Why tiny_http + std::thread, not tokio ────────────────────────────────
//! tiny_http is a small, blocking HTTP server — one extra dependency instead
//! of pulling in axum/hyper for two endpoints. Being blocking, it runs on its
//! own OS thread via `std::thread::spawn` (the same pattern already used for
//! `ensure_ollama_running` in lib.rs), NOT `tauri::async_runtime::spawn`,
//! which is reserved for genuinely async work (see `spawn_scheduler`) — this
//! project has already been bitten once by a bare `tokio::spawn` outside a
//! reactor context panicking at runtime while `cargo check` stayed green.
//! `AppHandle` is `Send + Sync`, so emitting events from this thread is safe.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

/// Loopback-only — never `0.0.0.0` or a LAN-reachable address. Anything that
/// can reach this port can hand LocalMind a task (subject to the bearer
/// token), so it must be unreachable from anywhere but this machine.
const IPC_BIND_ADDR: &str = "127.0.0.1:41777";

/// Requests larger than this are rejected with 413. Enforced both via the
/// Content-Length header (before reading anything) and via a hard-capped
/// reader (in case a client lies about Content-Length), so an oversized body
/// is never read into memory in full.
const MAX_BODY_BYTES: u64 = 64 * 1024;

const TOKEN_FILE_NAME: &str = "ipc-token.txt";

/// Cached in-process copy of the token so we only touch disk once per launch.
static IPC_TOKEN: OnceLock<String> = OnceLock::new();

#[derive(Deserialize)]
struct TaskRequest {
    task: String,
    #[serde(rename = "targetView")]
    target_view: Option<String>,
    /// Whether this task is meant to CHANGE something rather than answer a
    /// question. Omitted defaults to false on this path: an IPC caller is
    /// typically conversational (the Telegram relay forwarding "what's in my
    /// README?"), and the headless runtime forces `outcome: "error"` when a
    /// run that expected side effects produced none. Senders that really do
    /// queue work to be done can pass `true`.
    #[serde(rename = "expectSideEffects")]
    expect_side_effects: Option<bool>,
}

#[derive(Serialize)]
struct TaskAccepted {
    status: &'static str,
    id: String,
}

#[derive(Serialize)]
struct HealthOk {
    status: &'static str,
}

/// Payload of the `ipc-task` event consumed by src/App.tsx. `target_view` is
/// passed through verbatim (defaulting to "chat" if the caller omitted it);
/// validating it against the real `AppView` union is left to the frontend
/// (src/types/app.ts is the single source of truth for that list, and
/// duplicating it here would just be a second place to keep in sync). `id`
/// (WP6.4a) is the same id returned in the `POST /task` response body and the
/// key `GET /task/{id}` looks up — src/App.tsx correlates it against the
/// queue-store id `enqueue()` mints internally (the two are never the same
/// string) so a later `done`/`error` transition can be reported back here.
#[derive(Serialize, Clone)]
struct IpcTaskEvent {
    id: String,
    task: String,
    #[serde(rename = "targetView")]
    target_view: String,
    #[serde(rename = "expectSideEffects")]
    expect_side_effects: bool,
}

// ─── WP6.4a: task result store ─────────────────────────────────────────────

/// Public-facing outcome of a queued task, as returned by `GET /task/{id}`
/// and written by the frontend via `ipc_report_task_result`.
#[derive(Serialize, Clone)]
struct TaskOutcome {
    /// "queued" | "running" | "done" | "error"
    status: String,
    summary: Option<String>,
    /// Unix seconds. Set only once status becomes "done"/"error".
    finished_at: Option<u64>,
}

/// Wraps a `TaskOutcome` with a bookkeeping timestamp used only for eviction —
/// `created_at` is when this map entry was first written (at `POST /task`
/// time, or when a report call resurrects an already-evicted id), NOT the
/// same as `finished_at` (which stays `None` until the task completes and is
/// never used for eviction, since a long-"queued" entry needs to age out too).
struct TaskEntry {
    outcome: TaskOutcome,
    created_at: u64,
}

/// Bound the store so a caller hammering `POST /task` can't grow it forever:
/// entries older than one hour are dropped, and the map is hard-capped at 200
/// entries regardless of age (oldest *finished* entries evicted first, since
/// those are the ones nobody's still polling for).
const MAX_TASK_ENTRIES: usize = 200;
const MAX_TASK_AGE_SECS: u64 = 60 * 60;

static TASK_STORE: OnceLock<Mutex<HashMap<String, TaskEntry>>> = OnceLock::new();

fn task_store() -> &'static Mutex<HashMap<String, TaskEntry>> {
    TASK_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Evict expired/excess entries. Called with the lock already held, on every
/// write to the store (insert from `POST /task`, update from
/// `ipc_report_task_result`) — no background timer, per design.
fn evict_locked(map: &mut HashMap<String, TaskEntry>) {
    let now = now_unix();
    map.retain(|_, entry| now.saturating_sub(entry.created_at) <= MAX_TASK_AGE_SECS);

    while map.len() > MAX_TASK_ENTRIES {
        // Prefer dropping the oldest entry that's already done/error — those
        // are done. If the map is somehow all still-queued/running entries
        // (shouldn't happen given the task runner's concurrency-1 drain, but
        // don't leave the cap unenforced if it does), fall back to the oldest
        // entry overall.
        let victim = map
            .iter()
            .filter(|(_, e)| e.outcome.status == "done" || e.outcome.status == "error")
            .min_by_key(|(_, e)| e.created_at)
            .map(|(k, _)| k.clone())
            .or_else(|| map.iter().min_by_key(|(_, e)| e.created_at).map(|(k, _)| k.clone()));

        match victim {
            Some(k) => {
                map.remove(&k);
            }
            None => break, // map is empty
        }
    }
}

/// True iff `s` is exactly the shape of a `Uuid::new_v4().to_string()` output:
/// 36 lowercase-hex-and-hyphen characters, hyphens at 8/13/18/23. Rejecting
/// anything else before it ever reaches a `HashMap` lookup means a caller
/// can't hand `GET /task/{id}` path-traversal-ish junk (or anything else) and
/// have it treated as a meaningful key — it's just a 404 either way.
fn is_valid_task_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        };
        if !ok {
            return false;
        }
    }
    true
}

fn token_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create app data dir '{}': {e}", dir.display()))?;
    Ok(dir.join(TOKEN_FILE_NAME))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Load the persisted token, or generate a fresh 32-byte (256-bit) random
/// token hex-encoded and persist it, so app restarts reuse the same token
/// instead of invalidating every existing consumer's copy on every launch.
fn load_or_create_token(app: &AppHandle) -> Result<String, String> {
    let path = token_file_path(app)?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("getrandom failed: {e}"))?;
    let token = hex_encode(&bytes);

    std::fs::write(&path, &token).map_err(|e| format!("Cannot write token file: {e}"))?;

    // Best-effort restrictive permissions. On Unix, cut access down to the
    // owner. On Windows there is no simple chmod equivalent — the ACL model
    // there is per-file DACLs inherited from the parent directory, not a
    // single permission bit — so we deliberately do NOT fake a no-op that
    // looks like it worked. The real (and honest) protection on Windows is
    // that app_data_dir() resolves under this user's profile
    // (%APPDATA%\...\com.lalwa.localmind), which is only readable by the
    // owning user and Administrators by default, same as every other secret
    // this app already stores there (e.g. the SQLite db with git tokens).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(token)
}

/// Constant-time byte comparison.
///
/// A naive `==` on strings/slices short-circuits on the first differing
/// byte, which leaks timing information an attacker on the same machine could
/// use to recover the token byte-by-byte across many requests. This compares
/// lengths first (the token's length is fixed and not itself secret), then
/// ORs together the XOR of every byte pair regardless of whether an earlier
/// pair already differed — so the number of operations performed (and thus
/// the time taken) never depends on *where* a mismatch occurs.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Return the persisted/generated token, initializing it on first call.
/// Exposed to the frontend (Settings → Desktop Integration) so the user can
/// copy it into whatever local program will POST to this listener.
#[tauri::command]
pub fn get_ipc_token(app: AppHandle) -> Result<String, String> {
    if let Some(t) = IPC_TOKEN.get() {
        return Ok(t.clone());
    }
    let token = load_or_create_token(&app)?;
    Ok(IPC_TOKEN.get_or_init(|| token).clone())
}

fn extract_bearer(header_value: &str) -> Option<&str> {
    header_value.strip_prefix("Bearer ").map(|s| s.trim())
}

/// True iff the request carries `Authorization: Bearer <token>` matching the
/// expected token via constant-time comparison. Any other/missing header is
/// unauthorized.
fn is_authorized(request: &tiny_http::Request, token: &str) -> bool {
    for header in request.headers() {
        if header.field.as_str().as_str().eq_ignore_ascii_case("authorization") {
            return match extract_bearer(header.value.as_str()) {
                Some(presented) => constant_time_eq(presented.as_bytes(), token.as_bytes()),
                None => false,
            };
        }
    }
    false
}

fn json_response(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static content-type header is always valid ASCII");
    Response::from_string(body).with_status_code(status).with_header(header)
}

/// Handle one connection. Route table is an explicit, closed match — any
/// method/path combination not listed here falls through to 404, so there is
/// no wildcard routing that could later grow an unintended surface. The one
/// exception is `GET /task/{id}` (WP6.4a), which has a dynamic path segment;
/// it's parsed up front into `task_id_segment` so both the route-table check
/// and the dispatch below share a single parse instead of two.
fn handle_request(app: &AppHandle, token: &str, request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();

    let task_id_segment: Option<&str> =
        if method == Method::Get { url.strip_prefix("/task/") } else { None };
    let has_task_id_route = matches!(task_id_segment, Some(s) if !s.is_empty());

    let known_route = matches!(
        (&method, url.as_str()),
        (Method::Post, "/task") | (Method::Get, "/health")
    ) || has_task_id_route;
    if !known_route {
        let _ = request.respond(json_response(404, r#"{"error":"not found"}"#));
        return;
    }

    // Every endpoint requires the token — an unauthenticated /health would
    // otherwise be a free "is LocalMind running" probe for anything else on
    // the machine, and an unauthenticated /task/{id} would leak task content
    // to anything else running locally.
    if !is_authorized(&request, token) {
        let _ = request.respond(json_response(401, r#"{"error":"unauthorized"}"#));
        return;
    }

    if has_task_id_route {
        // Safe to unwrap: has_task_id_route is only true when task_id_segment
        // is Some(non-empty).
        let id = task_id_segment.unwrap().to_string();
        handle_task_get(request, &id);
        return;
    }

    match (&method, url.as_str()) {
        (Method::Get, "/health") => {
            let body = serde_json::to_string(&HealthOk { status: "ok" }).unwrap_or_default();
            let _ = request.respond(json_response(200, &body));
        }
        (Method::Post, "/task") => handle_task_post(app, request),
        _ => unreachable!("every route reaching here was already matched by known_route"),
    }
}

fn handle_task_post(app: &AppHandle, mut request: tiny_http::Request) {
    // 1. Reject on declared Content-Length before reading anything, when the
    // client sends one.
    if let Some(len) = request.body_length() {
        if len as u64 > MAX_BODY_BYTES {
            let _ = request.respond(json_response(413, r#"{"error":"payload too large"}"#));
            return;
        }
    }

    // 2. Hard cap the actual read regardless of what Content-Length claimed,
    // so a client that lies about it still can't force a large read into
    // memory — we only ever buffer at most MAX_BODY_BYTES + 1 bytes.
    let mut limited = request.as_reader().take(MAX_BODY_BYTES + 1);
    let mut buf = Vec::new();
    if limited.read_to_end(&mut buf).is_err() {
        let _ = request.respond(json_response(400, r#"{"error":"could not read request body"}"#));
        return;
    }
    if buf.len() as u64 > MAX_BODY_BYTES {
        let _ = request.respond(json_response(413, r#"{"error":"payload too large"}"#));
        return;
    }

    let parsed: Result<TaskRequest, _> = serde_json::from_slice(&buf);
    let task_req = match parsed {
        Ok(t) => t,
        Err(_) => {
            let _ = request.respond(json_response(400, r#"{"error":"malformed JSON"}"#));
            return;
        }
    };

    let task = task_req.task.trim().to_string();
    if task.is_empty() {
        let _ = request.respond(json_response(
            400,
            r#"{"error":"'task' must be a non-empty string"}"#,
        ));
        return;
    }

    let target_view = task_req
        .target_view
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "chat".to_string());
    let expect_side_effects = task_req.expect_side_effects;

    // WP6.4a: mint an id for this task before emitting, so both the event
    // payload (which src/App.tsx correlates against its own queue-store id)
    // and the HTTP response (which the caller polls with) carry the same
    // value. Seed the store with "queued" now — GET /task/{id} must return
    // something sane even in the instant between accept and the frontend
    // actually enqueuing it.
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut map = task_store().lock().unwrap_or_else(|e| e.into_inner());
        evict_locked(&mut map);
        map.insert(
            id.clone(),
            TaskEntry {
                outcome: TaskOutcome { status: "queued".to_string(), summary: None, finished_at: None },
                created_at: now_unix(),
            },
        );
    }

    let event = IpcTaskEvent {
        id: id.clone(),
        task,
        target_view,
        expect_side_effects: expect_side_effects.unwrap_or(false),
    };
    if let Err(e) = app.emit("ipc-task", event) {
        eprintln!("[ipc] failed to emit ipc-task event: {e}");
        let _ = request.respond(json_response(500, r#"{"error":"internal error"}"#));
        return;
    }

    // 202 Accepted: the task has been QUEUED, not executed or completed.
    // Whether it actually succeeds is decided later, unattended, by the task
    // runner (src/lib/taskRunner.ts) — this response must never be read as
    // "the work is done". The caller polls GET /task/{id} for the outcome.
    let body = serde_json::to_string(&TaskAccepted { status: "queued", id }).unwrap_or_default();
    let _ = request.respond(json_response(202, &body));
}

#[derive(Serialize)]
struct TaskStatusResponse {
    id: String,
    status: String,
    summary: Option<String>,
}

/// `GET /task/{id}` (WP6.4a). `id` has already been through the router's
/// `has_task_id_route` non-empty check but NOT yet the shape check — that
/// happens here, before it ever reaches the `HashMap` as a key.
fn handle_task_get(request: tiny_http::Request, id: &str) {
    if !is_valid_task_id(id) {
        let _ = request.respond(json_response(404, r#"{"error":"unknown task id"}"#));
        return;
    }

    let found = {
        let mut map = task_store().lock().unwrap_or_else(|e| e.into_inner());
        // Keep the store bounded even under GET-only traffic (a caller that
        // polls forever and never POSTs again would otherwise never trigger
        // the insert-time eviction path).
        evict_locked(&mut map);
        map.get(id).map(|entry| TaskStatusResponse {
            id: id.to_string(),
            status: entry.outcome.status.clone(),
            summary: entry.outcome.summary.clone(),
        })
    };

    match found {
        Some(resp) => {
            let body = serde_json::to_string(&resp).unwrap_or_default();
            let _ = request.respond(json_response(200, &body));
        }
        None => {
            let _ = request.respond(json_response(404, r#"{"error":"unknown task id"}"#));
        }
    }
}

/// Written by src/App.tsx once a task queue run correlated to this `id`
/// transitions to "running"/"done"/"error", so a poller can distinguish
/// "still queued", "actively running", and a final outcome. Resurrects the
/// entry (with a fresh `created_at`) if it was already evicted — safer than
/// silently dropping a legitimate report on the floor, and still bounded by
/// the same `evict_locked` cap enforced right after the insert.
#[tauri::command]
pub fn ipc_report_task_result(id: String, status: String, summary: Option<String>) -> Result<(), String> {
    if !is_valid_task_id(&id) {
        return Err(format!("ipc_report_task_result: '{id}' is not a valid task id"));
    }

    let now = now_unix();
    let finished_at = if status == "done" || status == "error" { Some(now) } else { None };

    let mut map = task_store()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    evict_locked(&mut map);
    map.entry(id)
        .and_modify(|entry| {
            entry.outcome.status = status.clone();
            entry.outcome.summary = summary.clone();
            entry.outcome.finished_at = finished_at;
        })
        .or_insert_with(|| TaskEntry {
            outcome: TaskOutcome { status, summary, finished_at },
            created_at: now,
        });
    Ok(())
}

/// Start the IPC listener on its own OS thread. Called once from `setup()`.
/// A bind failure (e.g. port 41777 already held by another LocalMind
/// instance) is logged and swallowed, never propagated — same policy as the
/// global-hotkey registration in lib.rs: a failed IPC listener must never
/// prevent the app from starting.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let token = match load_or_create_token(&app) {
            Ok(t) => IPC_TOKEN.get_or_init(|| t).clone(),
            Err(e) => {
                eprintln!("[ipc] could not initialize token, listener disabled: {e}");
                return;
            }
        };

        let server = match Server::http(IPC_BIND_ADDR) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[ipc] could not bind {IPC_BIND_ADDR}, listener disabled: {e}");
                return;
            }
        };

        eprintln!("[ipc] listening on http://{IPC_BIND_ADDR}");
        for request in server.incoming_requests() {
            handle_request(&app, &token, request);
        }
    });
}
