use std::process::Command;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::collections::{HashMap, HashSet};
use serde::Serialize;
use tauri::Emitter;

// ─── Workspace confinement (AD-3: confinement lives in Rust state) ────────────
//
// The native fs_* commands and run_command's cwd are confined to a set of
// workspace roots the frontend registers via `register_workspace_root` when a
// user opens a folder. Any path outside every registered root is refused.
//
// LIMITATION (documented honestly): run_command executes a shell, so the shell
// itself can still touch anything on disk (absolute paths, network, etc.). The
// confinement here only covers the *cwd* the command starts in and the fs_*
// API surface — arbitrary shell side effects are gated by the user approval
// dialog in the UI, not by this layer.

/// Canonicalized roots the frontend has registered. A path is allowed iff it is
/// inside (or equal to) one of these. Empty until a workspace is opened.
static REGISTERED_ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn registered_roots() -> &'static Mutex<HashSet<PathBuf>> {
    REGISTERED_ROOTS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// True if `candidate` is inside (or equal to) any root. All paths must already
/// be canonicalized. `starts_with` is component-wise, so `/foo/bar` is NOT
/// considered inside `/foo/ba`.
fn path_within_any(candidate: &Path, roots: &HashSet<PathBuf>) -> bool {
    roots.iter().any(|r| candidate.starts_with(r))
}

/// Canonicalize a path that may not exist yet: canonicalize the nearest existing
/// ancestor (which resolves any `..` and symlinks in the existing portion), then
/// re-append the not-yet-existing trailing components. This closes `..` escape
/// tricks while still allowing writes/mkdir to new paths under a root.
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    if let Ok(c) = dunce::canonicalize(path) {
        return Some(c);
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path;
    loop {
        let parent = cur.parent()?;
        let file = cur.file_name()?.to_os_string();
        if let Ok(canon_parent) = dunce::canonicalize(parent) {
            let mut result = canon_parent;
            result.push(&file);
            for comp in suffix.iter().rev() {
                result.push(comp);
            }
            return Some(result);
        }
        suffix.push(file);
        cur = parent;
    }
}

/// Resolve `path` and ensure it is confined to a registered workspace root.
/// Returns the canonical path on success, or a human-readable refusal error.
pub(crate) fn ensure_confined(path: &str) -> Result<PathBuf, String> {
    let target = canonicalize_lenient(Path::new(path))
        .ok_or_else(|| format!("Path confinement: cannot resolve '{path}'"))?;
    let guard = registered_roots()
        .lock()
        .map_err(|_| "Path confinement: roots lock poisoned".to_string())?;
    if guard.is_empty() {
        return Err(format!(
            "Path confinement: no workspace root registered — refusing to access '{}'. Open a workspace folder first.",
            target.display()
        ));
    }
    if path_within_any(&target, &guard) {
        Ok(target)
    } else {
        Err(format!(
            "Path confinement: '{}' is outside the registered workspace root(s). Access denied.",
            target.display()
        ))
    }
}

// ─── run_command cancellation ──────────────────────────────────────────────
//
// run_command is a synchronous, blocking Tauri command — there is no built-in
// way to cancel an in-flight `invoke()` from the JS side once it's been sent.
// To let the Terminal tab's "Kill" button do something real, the frontend
// generates a request_id per run, run_command registers its child PID under
// that id while it waits, and cancel_command below kills it on request (same
// taskkill/kill mechanism run_command's own timeout path already uses).

static RUNNING_COMMANDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn running_commands() -> &'static Mutex<HashMap<String, u32>> {
    RUNNING_COMMANDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes this request's PID from the registry on drop — covers every exit
/// path out of run_command's wait block (normal completion AND the early
/// `return` on timeout) without duplicating cleanup code at each return site.
struct RunningCommandGuard(String);
impl Drop for RunningCommandGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = running_commands().lock() {
            map.remove(&self.0);
        }
    }
}

/// Kill a command started via run_command, by the request_id the frontend
/// passed it. Returns false (not an error) if the command already finished
/// or no such request_id was ever registered — both are normal races, not
/// failures, since the Kill button and the command finishing can cross paths.
#[tauri::command]
fn cancel_command(request_id: String) -> Result<bool, String> {
    let pid = running_commands()
        .lock()
        .map_err(|_| "running-commands lock poisoned".to_string())?
        .remove(&request_id);
    let Some(pid) = pid else { return Ok(false) };

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill").args(["-9", &format!("-{pid}")]).output();
    }
    Ok(true)
}

/// Register a workspace root the fs_* commands and run_command are allowed to
/// touch. Called by the frontend whenever a user opens a folder. Canonicalizes
/// so later confinement checks compare like-for-like.
#[tauri::command]
fn register_workspace_root(path: String) -> Result<(), String> {
    let canon = dunce::canonicalize(&path)
        .map_err(|e| format!("Cannot register workspace root '{path}': {e}"))?;
    registered_roots()
        .lock()
        .map_err(|_| "roots lock poisoned".to_string())?
        .insert(canon);
    Ok(())
}

/// Revoke a previously registered root (Settings > Privacy & Security "known
/// folder" toggles turned off). Unlike register, this refuses silently rather
/// than erroring if the path no longer exists — turning off access to a folder
/// that's since been deleted should still succeed in revoking it.
#[tauri::command]
fn unregister_workspace_root(path: String) -> Result<(), String> {
    let mut guard = registered_roots()
        .lock()
        .map_err(|_| "roots lock poisoned".to_string())?;
    if let Ok(canon) = dunce::canonicalize(&path) {
        guard.remove(&canon);
    }
    // Also remove a non-canonicalized match in case the path no longer resolves.
    guard.remove(Path::new(&path));
    Ok(())
}

/// Resolve an OS well-known folder (Downloads/Desktop/Documents/Pictures/Home)
/// to its real path. Does NOT register it as an accessible root — that only
/// happens when the user explicitly enables it in Settings > Privacy & Security,
/// so this command alone grants no new file access, just a path lookup.
#[tauri::command]
fn get_known_folder(name: String) -> Result<String, String> {
    let path = match name.to_lowercase().as_str() {
        "downloads" => dirs::download_dir(),
        "desktop" => dirs::desktop_dir(),
        "documents" => dirs::document_dir(),
        "pictures" => dirs::picture_dir(),
        "home" => dirs::home_dir(),
        other => {
            return Err(format!(
                "Unknown known folder '{other}'. Valid names: downloads, desktop, documents, pictures, home."
            ))
        }
    };
    let path = path.ok_or_else(|| format!("Could not resolve the '{name}' folder on this system"))?;
    let canon = dunce::canonicalize(&path).map_err(|e| format!("Cannot resolve {name} folder: {e}"))?;
    Ok(canon.to_string_lossy().replace('\\', "/"))
}

/// Recursively copy a file or directory tree. Used by both fs_copy and
/// fs_move's cross-device fallback (std::fs::rename fails when `from`/`to`
/// live on different drives/filesystems, which copy+delete works around).
fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let dest = to.join(entry.file_name());
            copy_recursive(&entry.path(), &dest)?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to)?;
        Ok(())
    }
}

/// Move (rename) a file or directory. Both endpoints must resolve inside a
/// registered root. Falls back to copy+delete on cross-device rename failure.
#[tauri::command]
fn fs_move(from: String, to: String) -> Result<(), String> {
    let from_p = ensure_confined(&from)?;
    let to_p = ensure_confined(&to)?;
    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Err(rename_err) = std::fs::rename(&from_p, &to_p) {
        copy_recursive(&from_p, &to_p)
            .map_err(|copy_err| format!("{rename_err}; fallback copy also failed: {copy_err}"))?;
        if from_p.is_dir() {
            std::fs::remove_dir_all(&from_p).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&from_p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copy a file or directory. Both endpoints must resolve inside a registered root.
#[tauri::command]
fn fs_copy(from: String, to: String) -> Result<(), String> {
    let from_p = ensure_confined(&from)?;
    let to_p = ensure_confined(&to)?;
    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    copy_recursive(&from_p, &to_p).map_err(|e| e.to_string())
}

// ─── Ollama lifecycle ─────────────────────────────────────────────────────────

/// Holds the Child handle if *we* spawned Ollama. None means it was already running.
static OLLAMA_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

fn is_ollama_running() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    TcpStream::connect_timeout(
        &"127.0.0.1:11434".parse().unwrap(),
        Duration::from_millis(300),
    ).is_ok()
}

fn ensure_ollama_running() {
    // Always init the lock so the exit handler can safely call .get()
    let lock = OLLAMA_CHILD.get_or_init(|| Mutex::new(None));

    if is_ollama_running() {
        return; // already up — user-managed instance, leave it alone
    }

    // Uncached, resolved fresh on every call (not the cached effective_path())
    // — this only runs while Ollama is confirmed down, so a retry after the
    // user installs Ollama needs to see that install immediately rather than
    // reusing whatever PATH was cached at LocalMind's own first startup.
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("ollama")
        .arg("serve")
        .env("PATH", compute_effective_path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    #[cfg(not(target_os = "windows"))]
    let result = std::process::Command::new("ollama")
        .arg("serve")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    match result {
        Ok(child) => {
            if let Ok(mut guard) = lock.lock() {
                *guard = Some(child);
            }
        }
        Err(e) => {
            // Previously silent — a user with Ollama installed but not resolvable
            // on PATH (even after effective_path()'s fallback) got no signal at
            // all beyond the frontend's generic "is it installed?" after ~22s of
            // retries. At minimum this is now visible in the dev console; the
            // frontend's error message doesn't yet distinguish "not installed"
            // from "installed but not found on PATH" — see initOllama in App.tsx.
            eprintln!("[ollama] Failed to spawn 'ollama serve': {e}");
        }
    }
}

/// User-initiated hard restart of Ollama — the only way to make it re-detect
/// available GPUs, since Ollama only probes hardware once, at its own process
/// startup. A user who physically toggles a hybrid/discrete GPU on or off
/// while LocalMind (and Ollama) are already running needs this: Ollama will
/// keep running on whatever it saw at its last startup until something kills
/// and relaunches it. Unlike ensure_ollama_running (which leaves an
/// already-running instance alone, on the theory it might be user-managed),
/// this deliberately kills ANY running ollama process regardless of who
/// started it — that's the whole point of an explicit "restart" button.
/// Tree-kill (`/T`) also takes out the "ollama_llama_server" runner child
/// process a loaded model spawns, so it can't hold the port or a stale model
/// in VRAM after the parent dies.
#[tauri::command]
fn restart_ollama() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "ollama.exe", "/F", "/T"])
            .output();
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "ollama_llama_server.exe", "/F", "/T"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill").args(["-9", "-x", "ollama"]).output();
    }

    // Our own tracked child handle (if any) is now dead or about to be —
    // clear it so the exit handler doesn't try to kill/wait on a stale Child.
    if let Some(lock) = OLLAMA_CHILD.get() {
        if let Ok(mut guard) = lock.lock() {
            *guard = None;
        }
    }

    // Give the OS a moment to actually free the port before rebinding —
    // taskkill/pkill return before the process has fully torn down.
    std::thread::sleep(std::time::Duration::from_millis(800));

    ensure_ollama_running();

    // Ollama binds its port almost immediately on startup, well before any
    // model is loaded, so a short poll is enough to confirm it's really back.
    for _ in 0..20 {
        if is_ollama_running() {
            return Ok("Ollama restarted".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    Err("Ollama did not come back up within ~6s of restarting — check that 'ollama' is on PATH".to_string())
}

// ─── PATH augmentation ────────────────────────────────────────────────────────

static EFFECTIVE_PATH: OnceLock<String> = OnceLock::new();

/// Build a PATH that merges system PATH with the user PATH (HKCU\Environment).
/// On Windows, desktop apps launched outside a terminal only see system PATH,
/// so git/node/python installed by the user are invisible.
///
/// Split from `effective_path()` below so Ollama-detection retries (which
/// only fire while Ollama is confirmed down — see `ensure_ollama_running`)
/// can call this UNCACHED, fresh, every time. Confirmed real-world failure
/// this fixes: `effective_path()`'s cache is populated once, at LocalMind's
/// own first startup — if Ollama gets installed (or its installer's PATH
/// write lands) any time after that first check, every later retry
/// (watchdog every ~30s, or the manual "Restart Ollama" button) kept
/// reusing the stale pre-install PATH forever, so the only fix was fully
/// quitting and relaunching LocalMind — never surfaced to the user anywhere.
fn compute_effective_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();

        #[cfg(target_os = "windows")]
        {
            // 1. Try reading user PATH from the Windows environment registry via PowerShell.
            if let Ok(out) = Command::new("powershell")
                .args([
                    "-NoProfile", "-NonInteractive", "-Command",
                    "[Environment]::GetEnvironmentVariable('PATH','User')",
                ])
                .output()
            {
                if out.status.success() {
                    let user_path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !user_path.is_empty() {
                        return format!("{};{}", user_path, base);
                    }
                }
            }

            // 2. Fallback: prepend well-known tool locations that exist on disk.
            let username = std::env::var("USERNAME").unwrap_or_default();
            let candidates = vec![
                // Ollama's default Windows install location. Its installer normally
                // adds this to the User PATH itself (so step 1 above usually already
                // catches it), but that registry write can be missed (installed
                // before login, PATH read failing/timing out, etc.) — when that
                // happens ensure_ollama_running()'s spawn("ollama") silently fails
                // with no fallback, which is exactly the bug this candidate closes.
                format!(r"C:\Users\{username}\AppData\Local\Programs\Ollama"),
                r"C:\Program Files\Git\cmd".to_string(),
                r"C:\Program Files\Git\bin".to_string(),
                r"C:\Program Files\nodejs".to_string(),
                format!(r"C:\Users\{username}\AppData\Roaming\npm"),
                // Python (standard installer) — all common versions
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python313"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python312"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python311"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python310"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python39"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python38"),
                r"C:\Python313".to_string(),
                r"C:\Python312".to_string(),
                r"C:\Python311".to_string(),
                r"C:\Python310".to_string(),
                r"C:\Python39".to_string(),
                r"C:\Python38".to_string(),
                r"C:\Program Files\Python313".to_string(),
                r"C:\Program Files\Python312".to_string(),
                r"C:\Program Files\Python311".to_string(),
                // Conda / Miniconda / Anaconda
                format!(r"C:\Users\{username}\miniconda3"),
                format!(r"C:\Users\{username}\miniconda3\Scripts"),
                format!(r"C:\Users\{username}\anaconda3"),
                format!(r"C:\Users\{username}\anaconda3\Scripts"),
                format!(r"C:\ProgramData\miniconda3"),
                format!(r"C:\ProgramData\miniconda3\Scripts"),
                format!(r"C:\ProgramData\anaconda3"),
                format!(r"C:\ProgramData\anaconda3\Scripts"),
            ];
            let extra: Vec<String> = candidates
                .into_iter()
                .filter(|p| Path::new(p).exists())
                .collect();
            if !extra.is_empty() {
                return format!("{};{}", extra.join(";"), base);
            }
        }

    base
}

/// Cached wrapper around `compute_effective_path()` for frequent callers
/// (e.g. `run_command`) where a fresh PowerShell subprocess on every call
/// would be wasteful. Ollama-detection retries deliberately bypass this
/// cache — see `compute_effective_path`'s doc comment.
pub(crate) fn effective_path() -> &'static str {
    EFFECTIVE_PATH.get_or_init(compute_effective_path)
}

mod mcp;
use mcp::{mcp_start_server, mcp_stop_server, mcp_send_request};

mod transcribe;
use transcribe::{transcribe_video, transcribe_audio_base64};

mod pdf;
use pdf::{pdf_merge, pdf_to_text};

mod piper;
use piper::{piper_status, piper_setup, piper_download_voice, piper_speak};

mod db;
use db::{
    memory_upsert, memory_all, memory_delete, memory_touch, memory_delete_by_doc,
    jobs_insert, jobs_list, jobs_due, jobs_update_next, jobs_cancel,
    session_insert, session_search,
    collection_upsert, collections_all, collection_delete, collection_docs,
    kb_replace_graph, kb_get_graph, kb_delete_graph,
    kb_set_node_summary, kb_get_node_summaries,
};

mod tray;
use tray::{set_close_to_tray, show_result_widget};

mod os_tools;
use os_tools::{
    open_application, list_windows, focus_window, take_screenshot, read_image_base64,
    capture_region, clear_pending_region, close_window, minimize_window,
    list_processes, kill_process, get_disk_usage, empty_recycle_bin, adjust_volume,
    speak_text, print_file,
};

mod ipc;
use ipc::{get_ipc_token, ipc_report_task_result};

mod git_shadow;
use git_shadow::{
    shadow_git_ensure_init, shadow_git_commit, shadow_git_log, shadow_git_show_file,
    shadow_git_diff, shadow_git_diff_range, shadow_git_restore_file, shadow_git_restore_all,
};

mod ui_automation;
use ui_automation::{uia_list_elements, uia_click_element, uia_read_element_text, uia_set_element_text};

mod credential_store;
use credential_store::{cred_set, cred_get, cred_delete};

// ─── Generic HTTP fetch (used by the frontend for requests that would hit CORS
// in the packaged webview, e.g. web search against DuckDuckGo) ────────────────

const HTTP_FETCH_MAX_BYTES: u64 = 2 * 1024 * 1024; // 2MB cap on response body

/// Fetch a URL from Rust (no CORS restrictions apply here) and return the body
/// as text. Used by src/lib/search.ts when running inside Tauri so packaged
/// builds can reach DuckDuckGo directly instead of relying on the Vite dev-only
/// proxy paths (`/ddg-search`, `/ddg-lite`, `/ddg-html`).
#[tauri::command]
fn http_fetch(
    url: String,
    method: Option<String>,
    body: Option<String>,
    headers: Option<Vec<(String, String)>>,
) -> Result<String, String> {
    use std::io::Read;

    let method = method.unwrap_or_else(|| "GET".to_string()).to_uppercase();

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();

    let mut req = agent.request(&method, &url);

    let mut has_user_agent = false;
    if let Some(hdrs) = &headers {
        for (k, v) in hdrs {
            if k.eq_ignore_ascii_case("user-agent") {
                has_user_agent = true;
            }
            req = req.set(k, v);
        }
    }
    // Some endpoints (DuckDuckGo included) 403 requests with no/odd User-Agent.
    if !has_user_agent {
        req = req.set(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        );
    }

    let result = match &body {
        Some(b) => req.send_string(b),
        None => req.call(),
    };

    match result {
        Ok(resp) => {
            let mut reader = resp.into_reader().take(HTTP_FETCH_MAX_BYTES);
            let mut buf = String::new();
            reader
                .read_to_string(&mut buf)
                .map_err(|e| format!("http_fetch: failed reading response body: {e}"))?;
            Ok(buf)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body_text = resp.into_string().unwrap_or_default();
            let snippet: String = body_text.chars().take(300).collect();
            Err(format!("http_fetch: HTTP {code}: {snippet}"))
        }
        Err(e) => Err(format!("http_fetch: request failed: {e}")),
    }
}

#[derive(serde::Serialize)]
struct HttpFetchWithHeaders {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

/// Like http_fetch, but also returns response headers — needed for checks
/// that depend on security headers (X-Frame-Options, CSP frame-ancestors)
/// that a browser's own `fetch()` cannot read cross-origin even when the body
/// itself is accessible: the CORS spec exposes only a small safelisted set of
/// response headers to JS unless the server explicitly opts in via
/// Access-Control-Expose-Headers, which a site has no reason to do for its
/// own security headers. Rust's HTTP client has no such restriction. Used by
/// show_webpage (src/lib/tools.ts) to decide whether a site can actually be
/// iframed before trying, rather than only discovering it blocked itself
/// after rendering a blank frame.
#[tauri::command]
fn http_fetch_with_headers(url: String) -> Result<HttpFetchWithHeaders, String> {
    use std::io::Read;

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();

    let result = agent
        .get(&url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )
        .call();

    match result {
        Ok(resp) => {
            let status = resp.status();
            let headers: Vec<(String, String)> = resp
                .headers_names()
                .into_iter()
                .filter_map(|name| resp.header(&name).map(|v| (name.to_lowercase(), v.to_string())))
                .collect();
            let mut reader = resp.into_reader().take(HTTP_FETCH_MAX_BYTES);
            let mut body = String::new();
            reader
                .read_to_string(&mut body)
                .map_err(|e| format!("http_fetch_with_headers: failed reading response body: {e}"))?;
            Ok(HttpFetchWithHeaders { status, headers, body })
        }
        Err(ureq::Error::Status(code, resp)) => {
            let headers: Vec<(String, String)> = resp
                .headers_names()
                .into_iter()
                .filter_map(|name| resp.header(&name).map(|v| (name.to_lowercase(), v.to_string())))
                .collect();
            let body = resp.into_string().unwrap_or_default();
            Ok(HttpFetchWithHeaders { status: code, headers, body })
        }
        Err(e) => Err(format!("http_fetch_with_headers: request failed: {e}")),
    }
}

// ─── Native file system commands (used instead of File System Access API) ────

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Read a file as UTF-8 text.
#[tauri::command]
fn fs_read_file(path: String) -> Result<String, String> {
    let p = ensure_confined(&path)?;
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// Write text content to a file (creates parent directories as needed).
#[tauri::command]
fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let p = ensure_confined(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content.as_bytes()).map_err(|e| e.to_string())
}

/// List immediate children of a directory.
#[tauri::command]
fn fs_list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let path = ensure_confined(&path)?;
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        // Always use forward slashes for consistency with JS paths
        let p = item.path().to_string_lossy().replace('\\', "/");
        entries.push(FsEntry { name, path: p, is_dir });
    }
    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// Delete a file or directory.
#[tauri::command]
fn fs_delete(path: String, recursive: bool) -> Result<(), String> {
    let p = ensure_confined(&path)?;
    let p = p.as_path();
    if p.is_dir() {
        if recursive {
            std::fs::remove_dir_all(p).map_err(|e| e.to_string())
        } else {
            std::fs::remove_dir(p).map_err(|e| e.to_string())
        }
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Return true if the path exists on disk.
///
/// Intentionally left UNCONFINED: this is read-only and is used to validate a
/// remembered workspace path *before* it can be opened/registered (see
/// openWorkspaceByPath in src/lib/fileSystem.ts). Confining it would create a
/// chicken-and-egg problem (you cannot register a root you cannot first check).
#[tauri::command]
fn fs_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Create a directory (and all parents).
#[tauri::command]
fn fs_mkdir(path: String) -> Result<(), String> {
    let p = ensure_confined(&path)?;
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())
}

/// Read a file as a base64-encoded string (used for inlining binary assets in HTML preview).
#[tauri::command]
fn fs_read_file_base64(path: String) -> Result<String, String> {
    let p = ensure_confined(&path)?;
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(base64_encode(&bytes))
}

/// Write a base64-encoded byte string to a file (creates parent directories as
/// needed). The binary counterpart to fs_write_file, which only accepts text —
/// used by agent tools that produce binary output in JS (e.g. remove_background's
/// @imgly/background-removal result) and need to save it through the confined
/// native fs layer.
#[tauri::command]
fn fs_write_file_base64(path: String, data_base64: String) -> Result<(), String> {
    let p = ensure_confined(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = base64_decode(&data_base64)?;
    std::fs::write(&p, bytes).map_err(|e| e.to_string())
}

/// Cap on how much a single download_file call will pull down — generous
/// enough for images/PDFs/small archives while still bounding an unattended
/// or malicious response from exhausting disk/memory.
const FETCH_BINARY_MAX_BYTES: u64 = 200 * 1024 * 1024; // 200MB

/// Download a URL's binary body straight to disk — the binary-safe counterpart
/// to http_fetch, which reads everything as UTF-8 text with a 2MB cap. This is
/// what the agent's download_file tool uses to actually save an image/PDF/zip
/// from a URL, which no prior tool could do.
#[tauri::command]
fn fetch_binary(url: String, dest_path: String) -> Result<u64, String> {
    use std::io::Read;

    let dest = ensure_confined(&dest_path)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(60))
        .build();
    let resp = agent
        .get(&url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )
        .call()
        .map_err(|e| format!("download_file: request failed: {e}"))?;

    let mut buf = Vec::new();
    resp.into_reader()
        .take(FETCH_BINARY_MAX_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("download_file: failed reading response body: {e}"))?;

    let len = buf.len() as u64;
    std::fs::write(&dest, buf).map_err(|e| e.to_string())?;
    Ok(len)
}

/// Zip one or more files/directories (recursively) into a single archive.
#[tauri::command]
fn fs_compress(paths: Vec<String>, dest_path: String) -> Result<(), String> {
    if paths.is_empty() {
        return Err("compress_files: no paths given".to_string());
    }
    let dest = ensure_confined(&dest_path)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let confined: Vec<PathBuf> = paths
        .iter()
        .map(|p| ensure_confined(p))
        .collect::<Result<_, _>>()?;

    let file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    fn add_entry(
        zip: &mut zip::ZipWriter<std::fs::File>,
        options: zip::write::SimpleFileOptions,
        base: &Path,
        entry: &Path,
    ) -> Result<(), String> {
        let rel = entry.strip_prefix(base).unwrap_or(entry).to_string_lossy().replace('\\', "/");
        if entry.is_dir() {
            for child in std::fs::read_dir(entry).map_err(|e| e.to_string())? {
                add_entry(zip, options, base, &child.map_err(|e| e.to_string())?.path())?;
            }
        } else {
            zip.start_file(rel, options).map_err(|e| e.to_string())?;
            let bytes = std::fs::read(entry).map_err(|e| e.to_string())?;
            std::io::Write::write_all(zip, &bytes).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    for p in &confined {
        let base = p.parent().unwrap_or(p);
        add_entry(&mut zip, options, base, p)?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract a zip archive into a destination directory.
#[tauri::command]
fn fs_extract(archive_path: String, dest_dir: String) -> Result<(), String> {
    let archive_p = ensure_confined(&archive_path)?;
    let dest = ensure_confined(&dest_dir)?;
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(&archive_p).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("extract_archive: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Reject any entry path that escapes dest_dir via ".." — mirrors the
        // same traversal protection ensure_confined gives every other command.
        let out_path = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => return Err(format!("extract_archive: unsafe path in archive entry {i}")),
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Resize (optional, downscale-only, aspect-ratio preserved) and/or convert an
/// image's format. Format is inferred from dest_path's extension — the same
/// convention image::DynamicImage::save already follows.
#[tauri::command]
fn image_convert(
    src_path: String,
    dest_path: String,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> Result<(), String> {
    let src = ensure_confined(&src_path)?;
    let dest = ensure_confined(&dest_path)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut img = image::open(&src).map_err(|e| format!("Cannot open image: {e}"))?;
    if max_width.is_some() || max_height.is_some() {
        let w = max_width.unwrap_or(u32::MAX);
        let h = max_height.unwrap_or(u32::MAX);
        img = img.thumbnail(w, h);
    }
    img.save(&dest).map_err(|e| format!("Cannot save image: {e}"))
}

/// KM1 — file extensions the Knowledge Hub is allowed to ingest. Shared
/// between `open_upload_dialog`'s picker filter and `read_upload_bytes`'s
/// allowlist check so the two can never drift apart.
const ALLOWED_UPLOAD_EXTENSIONS: &[&str] =
    &["pdf", "md", "markdown", "txt", "png", "jpg", "jpeg", "webp"];

/// Cap on `read_upload_bytes` file size — ingestion holds a whole file's
/// bytes (and every extracted chunk) in memory at once, so this is a sane
/// upper bound for a single document (50 MB).
const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;

/// KM1 — read an arbitrary file's bytes (base64-encoded) for document
/// ingestion, invoked directly by the Knowledge Hub UI.
///
/// SECURITY: this is deliberately NOT `ensure_confined` — uploads are files
/// the user explicitly chose via `open_upload_dialog`'s native OS picker
/// (or will choose via an `<input type="file">` fallback), which IS the
/// authorization, and legitimately live outside every registered workspace
/// root (e.g. a PDF sitting in Downloads). To keep this from becoming a
/// general arbitrary-file-read primitive despite skipping confinement:
///   (a) the extension must be in `ALLOWED_UPLOAD_EXTENSIONS` (rejected otherwise);
///   (b) the file must be <= `MAX_UPLOAD_BYTES` (rejected otherwise);
///   (c) this is NOT registered as an agent tool (no entry in
///       src/lib/tools.ts's ToolName/TOOL_DEFINITIONS) — it is only ever
///       invoked directly by the Knowledge Hub UI, never reachable from a
///       model-driven tool call.
#[tauri::command]
fn read_upload_bytes(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .ok_or_else(|| format!("File has no extension: '{path}'"))?;
    if !ALLOWED_UPLOAD_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "File type '.{ext}' is not allowed for ingestion (allowed: {})",
            ALLOWED_UPLOAD_EXTENSIONS.join(", ")
        ));
    }
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "File is too large ({} bytes; max {MAX_UPLOAD_BYTES} bytes)",
            meta.len()
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(base64_encode(&bytes))
}

/// `pub(crate)` (not private) so `os_tools::read_image_base64` (WP6.2b) can
/// reuse it instead of pulling in a whole crate for one encode call — this
/// project already has zero base64 dependency and this hand-rolled encoder
/// has been fine for `fs_read_file_base64` above.
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let len = chunk.len();
        let b0 = chunk[0] as u32;
        let b1 = if len > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if len > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 0x3f) as usize] as char);
        out.push(T[((n >> 12) & 0x3f) as usize] as char);
        if len > 1 { out.push(T[((n >> 6) & 0x3f) as usize] as char); } else { out.push('='); }
        if len > 2 { out.push(T[(n & 0x3f) as usize] as char); } else { out.push('='); }
    }
    out
}

/// Decode a standard base64 string (with the '+'/'/' alphabet and '=' padding,
/// matching `base64_encode` above) back to raw bytes. Used by
/// `transcribe::transcribe_audio_base64` (WP6.3 local dictation) to turn a
/// recorded audio Blob's base64 payload back into bytes before writing it to
/// a temp file for the whisper pipeline. Whitespace (e.g. a stray newline) is
/// tolerated; any other invalid character or a length that isn't a multiple
/// of 4 is a hard error rather than a silent skip, since corrupted audio
/// bytes would otherwise fail confusingly deep inside ffmpeg/whisper instead
/// of here.
pub(crate) fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    if cleaned.len() % 4 != 0 {
        return Err("Invalid base64 length (not a multiple of 4)".to_string());
    }

    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for group in cleaned.chunks(4) {
        let mut pad = 0usize;
        let mut vals = [0u8; 4];
        for (i, &b) in group.iter().enumerate() {
            if b == b'=' {
                pad += 1;
                vals[i] = 0;
            } else {
                vals[i] = val(b).ok_or_else(|| format!("Invalid base64 character: '{}'", b as char))?;
            }
        }
        let n = ((vals[0] as u32) << 18) | ((vals[1] as u32) << 12) | ((vals[2] as u32) << 6) | (vals[3] as u32);
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct CommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    cwd: String,
    sandbox_blocked: bool,
}

#[derive(Serialize)]
pub struct SystemInfo {
    os: String,
    os_version: String,
    cpu_threads: usize,
    hostname: String,
}

#[derive(Serialize)]
pub struct GpuInfo {
    name: String,
    vram_mb: u64,
}

/// Open a native folder-picker dialog and return the selected path.
/// Returns None if the user cancels.
#[tauri::command]
fn open_workspace_dialog() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select Workspace Folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/// KM1 — open a native multi-file picker scoped to document types the
/// Knowledge Hub can ingest (see `ALLOWED_UPLOAD_EXTENSIONS` below, which
/// this filter matches). Returns None if the user cancels.
#[tauri::command]
fn open_upload_dialog() -> Option<Vec<String>> {
    rfd::FileDialog::new()
        .set_title("Select Documents to Ingest")
        .add_filter("Documents", ALLOWED_UPLOAD_EXTENSIONS)
        .pick_files()
        .map(|paths| paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}

/// Split a command string on top-level `&&` (outside single/double quotes),
/// returning the trimmed segments. PowerShell backtick escapes inside double
/// quotes are preserved verbatim so a `&&` cannot hide behind an escape.
fn split_top_level_and(cmd: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        if in_double && c == '`' {
            // PowerShell escape inside double quotes: keep escape + next char.
            cur.push(c);
            if let Some(n) = chars.next() { cur.push(n); }
            continue;
        }
        match c {
            '\'' if !in_double => { in_single = !in_single; cur.push(c); }
            '"' if !in_single => { in_double = !in_double; cur.push(c); }
            '&' if !in_single && !in_double && chars.peek() == Some(&'&') => {
                chars.next(); // consume the second '&'
                segments.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    segments.push(cur.trim().to_string());
    segments
}

/// Translate `A && B && C` into PowerShell that short-circuits on failure:
/// `A; if ($?) { B; if ($?) { C } }`.
///
/// Windows PowerShell 5.1 (which we invoke as `powershell`) does not support the
/// `&&` operator at all, and the previous naive `" && " -> " ; "` rewrite was
/// wrong: `;` runs the next command even when the first fails (silently breaking
/// `build && deploy` guards) and it also corrupted `&&` appearing inside quoted
/// strings. This quote-aware, short-circuiting translation fixes both (S5).
fn translate_and_for_powershell(cmd: &str) -> String {
    let segments = split_top_level_and(cmd);
    if segments.len() <= 1 {
        return cmd.to_string();
    }
    // Build nested if-blocks from the inside out so a failure at any stage stops
    // every later stage (a flat `; if ($?)` chain would not short-circuit).
    let mut iter = segments.into_iter().rev();
    let mut acc = iter.next().unwrap();
    for seg in iter {
        acc = format!("{seg}; if ($?) {{ {acc} }}");
    }
    acc
}

/// Run a shell command, confined to a registered workspace root.
///
/// The starting cwd must be inside a registered root (defaults to the first
/// registered root when the caller omits it). If a leading `cd` moves the
/// resulting cwd outside every root, it is reset to a root and
/// sandbox_blocked = true is returned. See the confinement LIMITATION note near
/// REGISTERED_ROOTS: the shell can still touch arbitrary paths itself; this only
/// bounds the cwd and is backed by the UI approval gate.
#[tauri::command]
fn run_command(
    cmd: String,
    cwd: Option<String>,
    request_id: Option<String>,
) -> Result<CommandResult, String> {
    // Default cwd to the first registered root when the model omits it.
    let default_root: Option<String> = registered_roots()
        .lock()
        .ok()
        .and_then(|g| g.iter().next().map(|p| p.to_string_lossy().to_string()));
    let work_dir_owned: String = cwd
        .filter(|s| !s.is_empty())
        .or(default_root)
        .unwrap_or_else(|| ".".to_string());
    let work_dir_str = work_dir_owned.as_str();

    // Confine the starting cwd to a registered root before running anything.
    let work_dir_canon = ensure_confined(work_dir_str)?;
    let work_dir_str = work_dir_canon.to_str().unwrap_or(work_dir_str);

    // Run with a 30-second timeout so GUI apps (OpenCV, pygame, etc.) don't block forever.
    // Uses std::process::Child so cwd is always respected (tokio jobs ignore cwd).
    const TIMEOUT_SECS: u64 = 30;

    const TIMEOUT_MSG: &str = "(timed out after 30s and the process was terminated - dev servers and other long-running commands (npm start, npm run dev, flask run, etc.) must be run manually in your own terminal, not via the agent. Use a build/typecheck/test command to verify instead.)";

    #[cfg(target_os = "windows")]
    let output = {
        use std::process::Stdio;
        let ps_cmd = translate_and_for_powershell(&cmd);
        let child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
            .env("PATH", effective_path())
            .current_dir(work_dir_str)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        let pid = child.id();
        let _cmd_guard = request_id.as_ref().map(|rid| {
            if let Ok(mut map) = running_commands().lock() { map.insert(rid.clone(), pid); }
            RunningCommandGuard(rid.clone())
        });
        let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<std::process::Output>>();
        std::thread::spawn(move || { let _ = tx.send(child.wait_with_output()); });

        match rx.recv_timeout(std::time::Duration::from_secs(TIMEOUT_SECS)) {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => {
                // Kill the whole process tree (e.g. powershell -> npm -> node) so
                // dev servers don't keep running in the background after we time out.
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .output();
                return Ok(CommandResult {
                    stdout: TIMEOUT_MSG.to_string(),
                    stderr: String::new(),
                    exit_code: 1,
                    cwd: work_dir_str.to_string(),
                    sandbox_blocked: false,
                });
            }
        }
    };

    #[cfg(not(target_os = "windows"))]
    let output = {
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        let child = Command::new("sh")
            .args(["-c", &cmd])
            .env("PATH", effective_path())
            .current_dir(work_dir_str)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // New process group so we can kill the whole tree (sh + any children
            // it spawns, e.g. npm -> node) on timeout, not just the shell.
            .process_group(0)
            .spawn()
            .map_err(|e| e.to_string())?;

        let pid = child.id();
        let _cmd_guard = request_id.as_ref().map(|rid| {
            if let Ok(mut map) = running_commands().lock() { map.insert(rid.clone(), pid); }
            RunningCommandGuard(rid.clone())
        });
        let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<std::process::Output>>();
        std::thread::spawn(move || { let _ = tx.send(child.wait_with_output()); });

        match rx.recv_timeout(std::time::Duration::from_secs(TIMEOUT_SECS)) {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => {
                let _ = Command::new("kill").args(["-9", &format!("-{pid}")]).output();
                return Ok(CommandResult {
                    stdout: TIMEOUT_MSG.to_string(),
                    stderr: String::new(),
                    exit_code: 1,
                    cwd: work_dir_str.to_string(),
                    sandbox_blocked: false,
                });
            }
        }
    };

    // Compute new cwd from cd commands
    let new_cwd_raw: PathBuf = if cmd.trim_start().to_lowercase().starts_with("cd ") {
        let target = cmd.trim_start()[3..].trim();
        Path::new(work_dir_str).join(target)
    } else {
        Path::new(work_dir_str).to_path_buf()
    };

    let new_cwd_canon = new_cwd_raw
        .canonicalize()
        .unwrap_or_else(|_| Path::new(work_dir_str).to_path_buf());

    // Enforce confinement on the resulting cwd: if a `cd` escaped every root,
    // reset to a registered root and flag sandbox_blocked.
    let (final_cwd, sandbox_blocked) = {
        let guard = registered_roots().lock().ok();
        match guard {
            Some(roots) if !roots.is_empty() => {
                if path_within_any(&new_cwd_canon, &roots) {
                    (new_cwd_canon.to_string_lossy().to_string(), false)
                } else {
                    // Escaped every root — reset to a registered root.
                    let fallback = roots
                        .iter()
                        .next()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| work_dir_str.to_string());
                    (fallback, true)
                }
            }
            _ => (new_cwd_canon.to_string_lossy().to_string(), false),
        }
    };

    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        cwd: final_cwd,
        sandbox_blocked,
    })
}

/// Return the current working directory of the app process.
#[tauri::command]
fn get_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

/// Return basic system information.
#[tauri::command]
fn get_system_info() -> SystemInfo {
    let os = std::env::consts::OS.to_string();
    let os_version = os_version_string();
    let cpu_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    SystemInfo { os, os_version, cpu_threads, hostname }
}

fn os_version_string() -> String {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "ver"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "Windows".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("sw_vers")
            .args(["-productVersion"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| format!("macOS {}", s.trim()))
            .unwrap_or_else(|| "macOS".to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("uname")
            .args(["-sr"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "Linux".to_string())
    }
}

/// Return GPU name and VRAM using native OS queries.
#[tauri::command]
fn get_gpu_info() -> Vec<GpuInfo> {
    query_gpu_info()
}

#[cfg(target_os = "windows")]
fn query_gpu_info() -> Vec<GpuInfo> {
    // 1. nvidia-smi — most accurate source for NVIDIA GPUs.
    //    wmic AdapterRAM is a 32-bit field and returns wrong values for cards > 4 GB.
    if let Ok(out) = Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .env("PATH", effective_path())
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let gpus: Vec<GpuInfo> = text.lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(2, ',');
                    let name = parts.next()?.trim().to_string();
                    // nvidia-smi reports MiB; convert to MB (≈1 MiB = 1.049 MB, close enough)
                    let vram_mb: u64 = parts.next()?.trim().parse().ok()?;
                    if name.is_empty() { return None; }
                    Some(GpuInfo { name, vram_mb })
                })
                .collect();
            if !gpus.is_empty() { return gpus; }
        }
    }

    // 2. PowerShell DXGI query — works for AMD, Intel Arc, and any DirectX 12 adapter.
    //    Returns DedicatedVideoMemory in bytes (64-bit, no truncation).
    if let Ok(out) = Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-Command",
            r#"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DXGI {
    [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);
    public static Guid IID_IDXGIFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
}
'@
try {
    $f = [IntPtr]::Zero
    $g = [DXGI]::IID_IDXGIFactory1
    if ([DXGI]::CreateDXGIFactory1([ref]$g, [ref]$f) -eq 0) {
        # Use WMI as a simpler alternative
        Get-CimInstance Win32_VideoController | ForEach-Object {
            "$($_.Name)|$($_.AdapterRAM)"
        }
    }
} catch {}
Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }
"#,
        ])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut gpus: Vec<GpuInfo> = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() { continue; }
                let mut parts = line.splitn(2, '|');
                let name = match parts.next() { Some(n) => n.trim().to_string(), None => continue };
                if name.is_empty() { continue; }
                // AdapterRAM from CIM is still 32-bit on some systems; treat 0 as unknown
                let vram_bytes: u64 = parts.next()
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .unwrap_or(0);
                let vram_mb = vram_bytes / (1024 * 1024);
                gpus.push(GpuInfo { name, vram_mb });
            }
            if !gpus.is_empty() { return gpus; }
        }
    }

    // 3. Last resort: wmic csv (original approach)
    let Ok(out) = Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "AdapterRAM,Name", "/format:csv"])
        .output()
    else {
        return vec![];
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let mut gpus = vec![];
    let mut name_idx: Option<usize> = None;
    let mut ram_idx: Option<usize> = None;
    let mut header_done = false;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let cols: Vec<&str> = line.split(',').collect();
        if !header_done {
            for (i, col) in cols.iter().enumerate() {
                match col.trim().to_lowercase().as_str() {
                    "name" => name_idx = Some(i),
                    "adapterram" => ram_idx = Some(i),
                    _ => {}
                }
            }
            header_done = true;
            continue;
        }
        let name = name_idx.and_then(|i| cols.get(i)).map(|s| s.trim().to_string()).unwrap_or_default();
        if name.is_empty() { continue; }
        let vram_bytes: u64 = ram_idx.and_then(|i| cols.get(i)).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        gpus.push(GpuInfo { name, vram_mb: vram_bytes / (1024 * 1024) });
    }
    gpus
}

#[cfg(target_os = "macos")]
fn query_gpu_info() -> Vec<GpuInfo> {
    let Ok(out) = Command::new("system_profiler")
        .args(["SPDisplaysDataType"])
        .output()
    else {
        return vec![];
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let mut gpus: Vec<GpuInfo> = vec![];
    let mut current_name = String::new();
    let mut current_vram_mb: u64 = 0;

    for line in text.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("Chipset Model:") {
            if !current_name.is_empty() {
                gpus.push(GpuInfo { name: std::mem::take(&mut current_name), vram_mb: current_vram_mb });
                current_vram_mb = 0;
            }
            current_name = name.trim().to_string();
        } else if t.contains("VRAM") && t.contains(':') {
            if let Some(val) = t.splitn(2, ':').nth(1).map(str::trim) {
                if let Some(gb) = val.strip_suffix(" GB").and_then(|s| s.trim().parse::<f64>().ok()) {
                    current_vram_mb = (gb * 1024.0) as u64;
                } else if let Some(mb) = val.strip_suffix(" MB").and_then(|s| s.trim().parse::<u64>().ok()) {
                    current_vram_mb = mb;
                }
            }
        }
    }
    if !current_name.is_empty() {
        gpus.push(GpuInfo { name: current_name, vram_mb: current_vram_mb });
    }
    gpus
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn query_gpu_info() -> Vec<GpuInfo> {
    // Try nvidia-smi first
    if let Ok(out) = Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let gpus: Vec<GpuInfo> = text.lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(2, ',');
                    let name = parts.next()?.trim().to_string();
                    let vram_mb: u64 = parts.next()?.trim().parse().ok()?;
                    if name.is_empty() { return None; }
                    Some(GpuInfo { name, vram_mb })
                })
                .collect();
            if !gpus.is_empty() { return gpus; }
        }
    }
    vec![]
}

// ─── Background scheduler (WP2.2) ──────────────────────────────────────────
//
// Ticks every 30s: finds due jobs (SQLite `jobs` table, status='active' AND
// next_run_at <= now), emits a `job-due` event per job (id + spec — the
// frontend owns interpreting `spec` and actually running the agent task via
// the headless runtime; per AD-6 the tick only ever emits events + updates
// the DB, it never runs agent work itself), then advances each job's
// next_run_at/status:
//   - "interval:<secs>"  -> next_run_at = (previous) next_run_at + secs*1000,
//                           stays active. Anchored on the job's own prior
//                           schedule point rather than `now` so tick latency
//                           (up to SCHEDULER_TICK_SECS) and job-processing
//                           time never compound into drift across firings —
//                           only whether we happened to catch the anchor
//                           within this tick's granularity, not when the tick
//                           ran, decides the next fire time. If we're behind
//                           by more than one interval (app was closed, or a
//                           tick landed unusually late), whole missed
//                           occurrences are skipped — never rapid-fired — to
//                           land on the first anchor point strictly after
//                           now; see `compute_next_run`.
//   - "once:<unix_secs>" -> status becomes "done" (fires once, never again)
//   - "cron:<expr>"      -> next occurrence computed via the `cron` crate;
//                           a bare 5-field expression (no seconds field) is
//                           normalized by prepending "0 " since the `cron`
//                           crate's parser requires a leading seconds field.
//
// All timestamps in the `jobs` table (`next_run_at`, and the ms-since-epoch
// values schedule descriptors are computed against) are milliseconds since
// the Unix epoch — the same unit as `db::now_ms()` and JS `Date.now()` — so
// the TS side (src/lib/scheduler.ts, src/lib/tools.ts) never has to convert.
//
// Catch-up policy: a job whose next_run_at is more than 24h in the past is
// NOT fired (it's treated as stale/abandoned while the app was closed) — its
// next_run_at is rolled forward without emitting `job-due`. Jobs overdue by
// less than 24h (the common case: app closed overnight) DO fire once on the
// next tick after launch, then resume their normal cadence.
const SCHEDULER_TICK_SECS: u64 = 30;
const CATCH_UP_LIMIT_MS: i64 = 24 * 60 * 60 * 1000;

/// Parse the `schedule` field out of a job's opaque JSON `spec` string.
/// Returns None if the JSON is malformed or the field is missing.
fn extract_schedule(spec: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(spec).ok()?;
    v.get("schedule")?.as_str().map(|s| s.to_string())
}

/// Compute (next_run_at_ms, status) for a job that just fired (or was
/// skipped for being too stale), given its schedule descriptor, the job's
/// previous `next_run_at` (the anchor its cadence is measured from), and the
/// current time in ms since epoch.
fn compute_next_run(schedule: &str, prev_next_run_at: i64, now_ms: i64) -> (i64, String) {
    if let Some(rest) = schedule.strip_prefix("interval:") {
        let secs: i64 = rest.trim().parse().unwrap_or(3600);
        let step = secs.max(1) * 1000;
        // Anchor on the PREVIOUS scheduled point, not `now` — otherwise every
        // firing is pushed back by however late the tick/processing was, and
        // that lateness compounds cycle over cycle (a 60s job drifting to
        // 60-90s and wandering further with each tick).
        let mut next = prev_next_run_at + step;
        if next <= now_ms {
            // We're behind by one or more whole intervals (app was closed, or
            // a tick ran later than a full `step`) — skip the missed
            // occurrences rather than rapid-firing catch-up ticks. Land on
            // the first anchor point strictly after `now` (integer ceil-div;
            // `next > now_ms` holds for any step >= 1 and diff >= 1).
            let diff = now_ms - next + 1;
            let missed = (diff + step - 1) / step;
            next += missed * step;
        }
        return (next, "active".to_string());
    }
    if schedule.starts_with("once:") {
        // One-shot jobs never reschedule — mark done regardless of the
        // timestamp (it has already fired, by definition, once we get here).
        return (now_ms, "done".to_string());
    }
    if let Some(expr) = schedule.strip_prefix("cron:") {
        if let Some(next) = compute_next_cron(expr.trim(), now_ms) {
            return (next, "active".to_string());
        }
        // Unparseable cron expression — don't wedge the job into a tight
        // retry loop; push it an hour out and let the tick try again later
        // (the job stays visible/editable rather than silently vanishing).
        eprintln!("[scheduler] could not parse cron expression '{expr}', deferring 1h");
        return (now_ms + 60 * 60 * 1000, "active".to_string());
    }
    eprintln!("[scheduler] unrecognized schedule descriptor '{schedule}', deferring 1h");
    (now_ms + 60 * 60 * 1000, "active".to_string())
}

/// Compute the next cron occurrence strictly after `now_ms`, returned as ms
/// since epoch. Accepts either a standard 5-field expression (min hour dom
/// month dow) or a 6-field one with a leading seconds field.
fn compute_next_cron(expr: &str, now_ms: i64) -> Option<i64> {
    use std::str::FromStr;
    let field_count = expr.split_whitespace().count();
    let normalized = if field_count == 5 { format!("0 {expr}") } else { expr.to_string() };
    let schedule = cron::Schedule::from_str(&normalized).ok()?;
    let after = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)?;
    let next = schedule.after(&after).next()?;
    Some(next.timestamp_millis())
}

// ─── Ollama watchdog ────────────────────────────────────────────────────────
//
// ensure_ollama_running() previously only ran once at app startup. If the
// Ollama server crashes/hangs later (observed under VRAM thrash from
// concurrent generations), nothing brought it back until the user restarted
// the app. Piggyback a health check onto the existing 30s scheduler tick
// instead of spawning a second timer loop.
//
// Debounced: a single failed TCP connect could just be a transient hiccup
// (the connect_timeout is only 300ms), so we require two consecutive down
// ticks — i.e. Ollama unreachable for a sustained ~30s+ — before restarting.
// This does NOT get confused by a slow model load: the health check only
// tests whether something is listening on the port, which happens as soon as
// `ollama serve` binds, well before any model weights are loaded.
static WATCHDOG_DOWN_STREAK: OnceLock<Mutex<u32>> = OnceLock::new();

fn watchdog_check() {
    let streak_lock = WATCHDOG_DOWN_STREAK.get_or_init(|| Mutex::new(0));

    if is_ollama_running() {
        if let Ok(mut streak) = streak_lock.lock() {
            *streak = 0;
        }
        return;
    }

    let Ok(mut streak) = streak_lock.lock() else { return };
    *streak += 1;
    if *streak >= 2 {
        eprintln!(
            "[watchdog] Ollama unreachable on 127.0.0.1:11434 for {} consecutive checks — restarting",
            *streak
        );
        ensure_ollama_running();
        *streak = 0;
    }
}

/// Run a single scheduler tick: query due jobs and process each. Errors are
/// logged, never propagated — a broken tick must never crash the app.
fn run_scheduler_tick(app: &tauri::AppHandle) {
    watchdog_check();

    let db = match db::get_db_for_tick(app) {
        Ok(db) => db,
        Err(e) => { eprintln!("[scheduler] cannot open db: {e}"); return; }
    };
    let conn = match db.lock() {
        Ok(c) => c,
        Err(_) => { eprintln!("[scheduler] db lock poisoned"); return; }
    };
    let now = db::now_ms();
    let due = match db::jobs_due_at(&conn, now) {
        Ok(d) => d,
        Err(e) => { eprintln!("[scheduler] jobs_due_at failed: {e}"); return; }
    };
    for job in due {
        let Some(schedule) = extract_schedule(&job.spec) else {
            eprintln!("[scheduler] job {} has an unparseable spec, skipping this tick", job.id);
            continue;
        };
        let overdue_ms = now - job.next_run_at;
        if overdue_ms > CATCH_UP_LIMIT_MS {
            eprintln!(
                "[scheduler] job {} overdue by >{}h, skipping fire and rolling forward",
                job.id,
                CATCH_UP_LIMIT_MS / 3_600_000
            );
        } else if let Err(e) = app.emit("job-due", &job) {
            eprintln!("[scheduler] failed to emit job-due for {}: {e}", job.id);
        }
        let (next_run_at, status) = compute_next_run(&schedule, job.next_run_at, now);
        if let Err(e) = db::jobs_update_next_conn(&conn, &job.id, next_run_at, &status) {
            eprintln!("[scheduler] failed to update job {}: {e}", job.id);
        }
    }
}

/// Spawn the background scheduler loop (WP2.2). Ticks every
/// SCHEDULER_TICK_SECS for the lifetime of the app; see `run_scheduler_tick`
/// for the per-tick logic. Kept intentionally lightweight (DB query + event
/// emit only) — all agent execution happens in TS (AD-6).
fn spawn_scheduler(app_handle: tauri::AppHandle) {
    // Use Tauri's managed Tokio runtime, not bare `tokio::spawn`: this runs from
    // the `setup()` hook where no Tokio reactor is entered on the current thread,
    // so `tokio::spawn`/`tokio::time::interval` would panic ("no reactor running").
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(SCHEDULER_TICK_SECS));
        // Default `Burst` would fire this loop back-to-back for every missed
        // tick after a long stall (laptop suspend) — wasted DB queries, and
        // pointless besides, since compute_next_run anchors each job's next
        // fire off its own prior next_run_at rather than tick timing, so a
        // single post-wake tick already catches every job up correctly.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            run_scheduler_tick(&app_handle);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace_dialog,
            register_workspace_root,
            unregister_workspace_root,
            get_known_folder,
            fs_move,
            fs_copy,
            run_command,
            cancel_command,
            get_cwd,
            get_system_info,
            get_gpu_info,
            mcp_start_server,
            mcp_stop_server,
            mcp_send_request,
            transcribe_video,
            transcribe_audio_base64,
            fs_read_file,
            fs_write_file,
            fs_list_dir,
            fs_delete,
            fs_exists,
            fs_mkdir,
            fs_read_file_base64,
            fs_write_file_base64,
            fetch_binary,
            fs_compress,
            fs_extract,
            image_convert,
            pdf_merge,
            pdf_to_text,
            piper_status,
            piper_setup,
            piper_download_voice,
            piper_speak,
            open_upload_dialog,
            read_upload_bytes,
            memory_upsert,
            memory_all,
            memory_delete,
            memory_touch,
            memory_delete_by_doc,
            collection_upsert,
            collections_all,
            collection_delete,
            collection_docs,
            kb_replace_graph,
            kb_get_graph,
            kb_delete_graph,
            kb_set_node_summary,
            kb_get_node_summaries,
            jobs_insert,
            jobs_list,
            jobs_due,
            jobs_update_next,
            jobs_cancel,
            session_insert,
            session_search,
            http_fetch,
            http_fetch_with_headers,
            set_close_to_tray,
            show_result_widget,
            open_application,
            list_windows,
            focus_window,
            close_window,
            minimize_window,
            take_screenshot,
            read_image_base64,
            capture_region,
            clear_pending_region,
            list_processes,
            kill_process,
            restart_ollama,
            get_disk_usage,
            empty_recycle_bin,
            adjust_volume,
            speak_text,
            print_file,
            get_ipc_token,
            ipc_report_task_result,
            shadow_git_ensure_init,
            shadow_git_commit,
            shadow_git_log,
            shadow_git_show_file,
            shadow_git_diff,
            shadow_git_diff_range,
            shadow_git_restore_file,
            shadow_git_restore_all,
            uia_list_elements,
            uia_click_element,
            uia_read_element_text,
            uia_set_element_text,
            cred_set,
            cred_get,
            cred_delete,
        ])
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
                    // Fire on key-down only — ShortcutState::Released would
                    // otherwise toggle twice per press.
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Two shortcuts are registered now (main window toggle +
                    // WP5.3 overlay toggle), so dispatch on which one fired.
                    if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space) {
                        tray::toggle_main_window(app);
                    } else if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyK) {
                        tray::toggle_overlay(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Start Ollama in a background thread so the UI loads immediately.
            // If Ollama is already running (user-managed), this is a no-op.
            std::thread::spawn(ensure_ollama_running);

            // WP2.2: background job scheduler — ticks every 30s and emits
            // `job-due` events for due jobs; src/lib/scheduler.ts listens and
            // executes them via the headless agent runtime (AD-6: the tick
            // lives in Rust, execution lives in TS).
            spawn_scheduler(app.handle().clone());

            // WP5.1: tray icon, right-click menu, and close-to-tray window
            // interception. See tray.rs.
            if let Err(e) = tray::init(app.handle()) {
                eprintln!("[tray] failed to initialize system tray: {e}");
            }

            // WP5.4: loopback-only local IPC listener so other local programs
            // (e.g. the phone-agent Telegram bridge) can hand LocalMind a
            // task. Runs on its own thread and only ever enqueues into the
            // existing task queue via an `ipc-task` event — see ipc.rs for
            // the full safety writeup. Bind failures are logged, not fatal.
            ipc::start(app.handle().clone());

            // WP5.1: global hotkey (Ctrl+Shift+Space) to show/hide the main
            // window from anywhere in the OS. Registration can fail if
            // another app already owns the combo — log and keep going rather
            // than crash, per the plugin's own advice that shortcuts are
            // "inherently dangerous" to assume exclusive ownership of.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                if let Err(e) = app.global_shortcut().register(hotkey) {
                    eprintln!("[hotkey] could not register Ctrl+Shift+Space (likely owned by another app): {e}");
                }
            }

            // WP5.3: global hotkey (Ctrl+Shift+K) to show/hide the quick-invoke
            // overlay from anywhere in the OS. Same "log and keep going" policy
            // as above — another app may already own this combo, and that must
            // not be fatal to startup.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let overlay_hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK);
                if let Err(e) = app.global_shortcut().register(overlay_hotkey) {
                    eprintln!("[hotkey] could not register Ctrl+Shift+K (likely owned by another app): {e}");
                }
            }

            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // Only kill Ollama if we were the ones who started it.
                if let Some(lock) = OLLAMA_CHILD.get() {
                    if let Ok(mut guard) = lock.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}

// ─── Tests ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn roots(paths: &[&str]) -> HashSet<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    // ── base64 (WP6.3: hand-rolled, decodes recorded microphone audio) ───────
    //
    // Worth real coverage rather than a read-through: a subtle decoder bug
    // wouldn't fail loudly, it would hand ffmpeg/whisper corrupted audio and
    // surface as "transcription is gibberish", which is miserable to trace
    // back to here. The padding cases are where hand-rolled decoders go wrong.

    #[test]
    fn base64_roundtrips_all_padding_cases() {
        // Lengths mod 3 = 1, 2, 0 exercise "==", "=", and no padding.
        for len in 0..=64usize {
            let original: Vec<u8> = (0..len).map(|i| (i * 7 % 256) as u8).collect();
            let encoded = base64_encode(&original);
            let decoded = base64_decode(&encoded)
                .unwrap_or_else(|e| panic!("len {len} failed to decode: {e}"));
            assert_eq!(decoded, original, "round-trip mismatch at length {len}");
        }
    }

    #[test]
    fn base64_decodes_known_vectors() {
        // RFC 4648 test vectors — catches an encoder and decoder that are
        // wrong in the same direction and would agree with each other.
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(base64_decode("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(base64_decode("Zm9vYmE=").unwrap(), b"fooba");
        assert_eq!(base64_decode("Zm9vYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn base64_handles_binary_high_bytes() {
        // Audio is binary, not ASCII — make sure 0x80..0xFF survive.
        let original: Vec<u8> = (0..=255u8).collect();
        assert_eq!(base64_decode(&base64_encode(&original)).unwrap(), original);
    }

    #[test]
    fn base64_rejects_malformed_input() {
        assert!(base64_decode("abc").is_err(), "bad length should be rejected");
        assert!(base64_decode("ab*d").is_err(), "invalid char should be rejected");
    }

    #[test]
    fn base64_ignores_whitespace() {
        // Some encoders wrap at 76 columns; the decoder strips whitespace.
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar");
    }

    // ── Path containment (WP0.1: S3 confinement logic) ───────────────────────
    #[test]
    fn within_root_is_allowed() {
        let r = roots(&["/home/user/ws"]);
        assert!(path_within_any(Path::new("/home/user/ws"), &r));
        assert!(path_within_any(Path::new("/home/user/ws/src/main.rs"), &r));
    }

    #[test]
    fn outside_root_is_refused() {
        let r = roots(&["/home/user/ws"]);
        assert!(!path_within_any(Path::new("/etc/passwd"), &r));
        assert!(!path_within_any(Path::new("/home/user"), &r));
    }

    #[test]
    fn sibling_prefix_is_not_confused_for_child() {
        // "/home/user/ws" must NOT contain "/home/user/ws-secret" (component-wise).
        let r = roots(&["/home/user/ws"]);
        assert!(!path_within_any(Path::new("/home/user/ws-secret/data"), &r));
    }

    #[test]
    fn multiple_roots_any_match() {
        let r = roots(&["/a/proj1", "/b/proj2"]);
        assert!(path_within_any(Path::new("/b/proj2/file"), &r));
        assert!(!path_within_any(Path::new("/c/other"), &r));
    }

    // ── && translation (WP0.5: S5 PowerShell chaining) ───────────────────────
    #[test]
    fn single_command_is_untouched() {
        assert_eq!(translate_and_for_powershell("echo hi"), "echo hi");
    }

    #[test]
    fn and_becomes_short_circuit() {
        // `false && echo hi` must guard echo behind success, so hi is not printed.
        assert_eq!(
            translate_and_for_powershell("false && echo hi"),
            "false; if ($?) { echo hi }"
        );
    }

    #[test]
    fn chained_and_nests_right() {
        assert_eq!(
            translate_and_for_powershell("a && b && c"),
            "a; if ($?) { b; if ($?) { c } }"
        );
    }

    #[test]
    fn and_inside_quotes_is_not_split() {
        // The `&&` here is data, not an operator — it must survive verbatim.
        assert_eq!(
            translate_and_for_powershell("echo \"a && b\""),
            "echo \"a && b\""
        );
        assert_eq!(
            translate_and_for_powershell("echo 'x && y'"),
            "echo 'x && y'"
        );
    }

    #[test]
    fn split_counts_top_level_segments() {
        assert_eq!(split_top_level_and("a && b").len(), 2);
        assert_eq!(split_top_level_and("echo \"a && b\"").len(), 1);
        assert_eq!(split_top_level_and("single").len(), 1);
    }

    // ── Scheduler interval anchoring (drift fix) ─────────────────────────────
    #[test]
    fn interval_advances_from_previous_anchor_not_now() {
        // Tick ran late (processed 25s after the anchor) — next_run_at must
        // still be prev + interval, not now + interval, or lateness compounds.
        let prev_anchor = 1_000_000_i64;
        let now = prev_anchor + 25_000; // tick fired 25s late
        let (next, status) = compute_next_run("interval:60", prev_anchor, now);
        assert_eq!(next, prev_anchor + 60_000);
        assert_eq!(status, "active");
    }

    #[test]
    fn interval_behind_by_three_lands_on_first_future_anchor() {
        // App was asleep well past several 60s anchors. The original anchor
        // sequence from prev_anchor=0 is 60_000, 120_000, 180_000, 240_000...
        // now=185_000 falls between the 3rd (180_000) and 4th (240_000), so
        // the first anchor strictly after now is 240_000 — occurrences at
        // 60_000/120_000/180_000 must be skipped, not rapid-fired.
        let prev_anchor = 0_i64;
        let now = 185_000_i64;
        let (next, _status) = compute_next_run("interval:60", prev_anchor, now);
        assert_eq!(next, 240_000);
    }

    #[test]
    fn interval_next_run_is_always_strictly_after_now() {
        // Sweep a range of "how late did we catch this" offsets, including
        // exact anchor hits and multi-interval overruns, and confirm the
        // invariant compute_next_run relies on (next > now) always holds.
        let step = 60_000_i64;
        let prev_anchor = 1_700_000_000_000_i64;
        for behind in [0_i64, 1, 59_999, 60_000, 60_001, 125_001, 999_999] {
            let now = prev_anchor + behind;
            let (next, _status) = compute_next_run("interval:60", prev_anchor, now);
            assert!(
                next > now,
                "next ({next}) must be strictly after now ({now}) for behind={behind}"
            );
        }
    }
}
