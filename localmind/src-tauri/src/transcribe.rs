//! Video/audio transcription for the desktop agent's `transcribe_video` tool.
//!
//! Two ways this pipeline can be found, checked in order:
//!   1. **Bundled** (packaged installer): a single `transcribe_tool.exe` —
//!      built by PyInstaller from `phone-agent/transcribe_tool.py`, which
//!      wraps both `transcribe_cli.py` and `whisper_daemon.py` in one binary
//!      so ctranslate2/faster-whisper's ~230MB of native libs ship once, not
//!      twice — plus a bundled `ffmpeg.exe`, both under Tauri's resource dir
//!      (see `tauri.conf.json`'s `bundle.resources` and
//!      `phone-agent/README.md`'s "Building the bundled pipeline" section
//!      for how these get produced). This is what a real end user's install
//!      actually has; earlier versions of this app had NO equivalent at all,
//!      so a packaged build silently could never transcribe anything.
//!   2. **Dev** (`npm run tauri dev`, resources not built yet): the raw
//!      `phone-agent/.venv` + `transcribe_cli.py`/`whisper_daemon.py`,
//!      located by walking up from the app's working/exe directory — the
//!      original mechanism, unchanged, so a normal dev checkout keeps
//!      working without anyone needing to run the PyInstaller build step.
//!
//! Transcription is CPU-heavy (seconds to minutes), so the blocking work
//! runs on a spawn_blocking thread.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

/// How to actually invoke the pipeline — resolved once per call by
/// `locate_pipeline`, then turned into a `Command` for either "cli" or
/// "daemon" mode by `pipeline_command`.
enum Pipeline {
    Bundled { exe: PathBuf, ffmpeg_dir: PathBuf },
    Dev { python: PathBuf, script_dir: PathBuf },
}

/// Bundled resource paths, relative to Tauri's resource_dir(), matching
/// `tauri.conf.json`'s `bundle.resources` globs exactly.
fn bundled_exe_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let exe = dir.join("resources/transcribe/dist/transcribe_tool/transcribe_tool.exe");
    exe.exists().then_some(exe)
}

fn bundled_ffmpeg_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let ffmpeg_dir = dir.join("resources/transcribe/ffmpeg");
    ffmpeg_dir.join("ffmpeg.exe").exists().then_some(ffmpeg_dir)
}

/// Dev fallback: find (venv_python, phone-agent dir) by walking up from
/// anchor dirs — unchanged from before the bundled path existed.
fn locate_dev_pipeline() -> Option<(PathBuf, PathBuf)> {
    #[cfg(target_os = "windows")]
    let py_rel = Path::new("phone-agent/.venv/Scripts/python.exe");
    #[cfg(not(target_os = "windows"))]
    let py_rel = Path::new("phone-agent/.venv/bin/python");
    let script_rel = Path::new("phone-agent/transcribe_cli.py");

    let mut anchors: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        anchors.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            anchors.push(dir.to_path_buf());
        }
    }

    for anchor in anchors {
        let mut dir: Option<&Path> = Some(anchor.as_path());
        for _ in 0..8 {
            let Some(d) = dir else { break };
            let py = d.join(py_rel);
            let script = d.join(script_rel);
            if py.exists() && script.exists() {
                return Some((py, d.join("phone-agent")));
            }
            dir = d.parent();
        }
    }
    None
}

fn locate_pipeline(app: &tauri::AppHandle) -> Option<Pipeline> {
    if let (Some(exe), Some(ffmpeg_dir)) = (bundled_exe_path(app), bundled_ffmpeg_dir(app)) {
        return Some(Pipeline::Bundled { exe, ffmpeg_dir });
    }
    let (python, script_dir) = locate_dev_pipeline()?;
    Some(Pipeline::Dev { python, script_dir })
}

/// PATH to inject into a spawned pipeline process: bundled mode prepends the
/// bundled ffmpeg's own directory (so it's found even if the user has no
/// ffmpeg installed at all — the whole point of bundling it); dev mode uses
/// the same PATH-augmentation the rest of this app relies on, unchanged.
fn pipeline_path_env(pipeline: &Pipeline) -> String {
    match pipeline {
        Pipeline::Bundled { ffmpeg_dir, .. } => {
            format!("{};{}", ffmpeg_dir.display(), crate::effective_path())
        }
        Pipeline::Dev { .. } => crate::effective_path().to_string(),
    }
}

/// Build the `Command` for one pipeline invocation. `mode` is "cli" or
/// "daemon"; `cli_arg` is the video path/URL for "cli" mode (ignored for
/// "daemon", which takes no positional arg — it reads requests from stdin).
fn pipeline_command(pipeline: &Pipeline, mode: &str, cli_arg: Option<&str>) -> Command {
    let mut cmd = match pipeline {
        Pipeline::Bundled { exe, .. } => {
            let mut c = Command::new(exe);
            c.arg(mode);
            c
        }
        Pipeline::Dev { python, script_dir } => {
            let script = if mode == "cli" { "transcribe_cli.py" } else { "whisper_daemon.py" };
            let mut c = Command::new(python);
            c.arg(script_dir.join(script));
            c
        }
    };
    if let Some(arg) = cli_arg {
        cmd.arg(arg);
    }
    cmd.env("PATH", pipeline_path_env(pipeline));
    cmd
}

fn transcribe_blocking(
    app: &tauri::AppHandle,
    video_path: String,
    whisper_model: Option<String>,
) -> Result<String, String> {
    let is_url = video_path.starts_with("http://") || video_path.starts_with("https://");
    if !is_url && !Path::new(&video_path).exists() {
        return Err(format!("Video file not found: {video_path}"));
    }

    let pipeline = locate_pipeline(app).ok_or_else(|| {
        "Transcription pipeline not found. This should always be present in a packaged \
         LocalMind install — if you're running from source, see phone-agent/README.md."
            .to_string()
    })?;

    let mut cmd = pipeline_command(&pipeline, "cli", Some(&video_path));
    if let Some(model) = whisper_model {
        if !model.trim().is_empty() {
            cmd.env("LOCALMIND_WHISPER_MODEL", model.trim());
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to launch transcription: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Transcription failed: {}", err.trim()));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("Transcription produced no text (the video may contain no speech).".to_string());
    }
    Ok(text)
}

#[tauri::command]
pub async fn transcribe_video(
    app: tauri::AppHandle,
    video_path: String,
    whisper_model: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || transcribe_blocking(&app, video_path, whisper_model))
        .await
        .map_err(|e| format!("Transcription task panicked: {e}"))?
}

// ─── Warm whisper daemon (dictation latency) ───────────────────────────────
//
// `transcribe_blocking` above pays the cost of loading the whisper model on
// every call (~2.5s measured on this machine, of a ~4.5s total dictation
// round trip) because the pipeline starts a fresh process each time. For
// dictation specifically — short clips, called repeatedly, latency-sensitive
// — we instead keep a long-lived daemon process around with the model
// already resident, and talk to it over a line-delimited JSON stdin/stdout
// protocol. `transcribe_video` is untouched: video files can be long, and
// this daemon is single-threaded by design, so routing video through it
// would block dictation behind a long transcription.

/// Generous but bounded: a long clip on `tiny`/`base` CPU is a few seconds,
/// and the first call after (re)spawn also pays model load (~1.6s measured).
/// Rust's blocking pipe reads have no built-in timeout, so the actual read
/// happens on a dedicated reader thread (spawned once per daemon process)
/// that streams lines into a channel; requests use `recv_timeout` on that
/// channel to bound the wait without blocking the OS thread indefinitely.
const DAEMON_READ_TIMEOUT: Duration = Duration::from_secs(90);

/// One line read from the daemon's stdout, or the reason the reader thread
/// stopped producing them (a read error). Channel disconnection (thread
/// exited after EOF) is handled separately by `recv_timeout`'s own result.
type DaemonLine = Result<String, String>;

struct DaemonHandle {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<DaemonLine>,
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Holds the running daemon, if any. `None` means no daemon is currently
/// alive (not yet spawned, or killed after an error) — the next dictation
/// call spawns a fresh one lazily.
static DAEMON: OnceLock<Mutex<Option<DaemonHandle>>> = OnceLock::new();

fn daemon_slot() -> &'static Mutex<Option<DaemonHandle>> {
    DAEMON.get_or_init(|| Mutex::new(None))
}

fn spawn_daemon(pipeline: &Pipeline) -> Result<DaemonHandle, String> {
    let mut child = pipeline_command(pipeline, "daemon", None)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn whisper daemon: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "whisper daemon child has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "whisper daemon child has no stdout".to_string())?;
    let stderr = child.stderr.take();

    // Drain the child's stderr on its own thread so it can never fill its
    // pipe buffer and block the daemon (which would otherwise wedge every
    // future request behind a full pipe). Diagnostic-only, relayed for
    // debugging; the daemon's protocol lives entirely on stdout/stdin.
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[whisper_daemon] {line}");
            }
        });
    }

    // Reader thread: owns the stdout pipe for the life of the daemon and
    // streams complete lines into a channel. This is what makes the 90s
    // timeout possible — the main thread never does a blocking pipe read
    // itself, it just waits on `rx.recv_timeout(..)`, which returns even if
    // the child never writes anything.
    let (tx, rx) = mpsc::channel::<DaemonLine>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(Ok(l)).is_err() {
                        break; // nobody listening anymore
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("daemon stdout read error: {e}")));
                    break;
                }
            }
        }
        // EOF (or the error above) ends the loop; tx drops here, which is
        // what turns a pending `recv_timeout` into `Disconnected`.
    });

    Ok(DaemonHandle { child, stdin, rx })
}

/// Kill and drop whatever daemon is currently held, leaving `None` behind so
/// the next call spawns a fresh one rather than inheriting a poisoned one.
fn kill_daemon(guard: &mut Option<DaemonHandle>) {
    *guard = None; // Drop impl kills + waits on the child
}

/// Send one request line and wait (bounded by `DAEMON_READ_TIMEOUT`) for the
/// matching response line. Any error here — timeout, malformed JSON, an
/// error object from the daemon, EOF/disconnect — is the caller's signal to
/// kill the daemon and either retry fresh once or fall back.
fn send_request(handle: &mut DaemonHandle, audio_path: &str, model: &str) -> Result<String, String> {
    let request = serde_json::json!({ "path": audio_path, "model": model }).to_string();
    handle
        .stdin
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|e| format!("failed writing to whisper daemon stdin: {e}"))?;
    handle
        .stdin
        .flush()
        .map_err(|e| format!("failed flushing whisper daemon stdin: {e}"))?;

    match handle.rx.recv_timeout(DAEMON_READ_TIMEOUT) {
        Ok(Ok(line)) => {
            let value: serde_json::Value = serde_json::from_str(&line)
                .map_err(|e| format!("malformed whisper daemon response ({e}): {line}"))?;
            if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                Err(format!("Transcription failed: {err}"))
            } else if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
                Ok(text.trim().to_string())
            } else {
                Err(format!("whisper daemon response missing text/error: {line}"))
            }
        }
        Ok(Err(reason)) => Err(reason),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("whisper daemon read timed out after {DAEMON_READ_TIMEOUT:?}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("whisper daemon exited (stdout closed)".to_string())
        }
    }
}

/// Transcribe via the warm daemon: lazily spawn on first use, and on any
/// failure kill the wedged/dead daemon and retry once with a fresh one
/// (never in a loop — a second failure is surfaced to the caller, which
/// falls back to the one-shot pipeline).
fn daemon_transcribe(app: &tauri::AppHandle, audio_path: &str, model: &str) -> Result<String, String> {
    let pipeline = locate_pipeline(app).ok_or_else(|| {
        "Transcription pipeline not found".to_string()
    })?;

    let mut guard = daemon_slot().lock().unwrap_or_else(|e| e.into_inner());

    if guard.is_none() {
        *guard = Some(spawn_daemon(&pipeline)?);
    }

    let first_attempt = send_request(guard.as_mut().expect("daemon just ensured"), audio_path, model);
    if let Ok(text) = first_attempt {
        return Ok(text);
    }
    let first_err = first_attempt.unwrap_err();
    eprintln!("[whisper_daemon] request failed, respawning once: {first_err}");
    kill_daemon(&mut guard);

    let handle = spawn_daemon(&pipeline)?;
    *guard = Some(handle);
    let retry = send_request(guard.as_mut().expect("daemon just respawned"), audio_path, model);
    if retry.is_err() {
        // Don't leave a possibly-poisoned daemon around for the next call.
        kill_daemon(&mut guard);
    }
    retry
}

/// Resolve the model name the same way transcribe_cli.py's env-var default
/// does: an explicit non-empty override, else "base".
fn resolve_model(whisper_model: &Option<String>) -> String {
    whisper_model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("base")
        .to_string()
}

// ─── Local offline dictation (WP6.3) ───────────────────────────────────────
//
// The mic button in ChatInput records audio in the browser (MediaRecorder),
// base64-encodes the Blob, and sends it here. We decode it to a temp file and
// hand it to the exact same `transcribe_blocking` pipeline `transcribe_video`
// already uses (phone-agent's faster-whisper CLI) — no separate pipeline.

/// Extensions the frontend is allowed to request. `mime_ext` is
/// frontend-controlled and lands in a filesystem path, so it is checked
/// against this fixed allowlist rather than sanitized/escaped — anything not
/// in this list is refused outright.
const ALLOWED_DICTATION_EXTS: &[&str] = &["webm", "ogg", "wav", "mp4", "m4a"];

/// Deletes the temp dictation file on drop, on every code path that reaches
/// construction — normal return, early `?` error return, or even a panic
/// during unwind (this crate does not set `panic = "abort"`). Mirrors the
/// `CaptureGuard` Drop pattern in os_tools.rs, applied to a temp file instead
/// of GDI handles. Recorded voice audio must never accumulate in the OS temp
/// directory.
struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn transcribe_audio_base64_blocking(
    app: &tauri::AppHandle,
    audio_base64: String,
    mime_ext: String,
    whisper_model: Option<String>,
) -> Result<String, String> {
    let ext = mime_ext.trim().to_ascii_lowercase();
    if !ALLOWED_DICTATION_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported audio extension '{mime_ext}' — expected one of: {}",
            ALLOWED_DICTATION_EXTS.join(", ")
        ));
    }

    let bytes = crate::base64_decode(&audio_base64)
        .map_err(|e| format!("Failed to decode recorded audio: {e}"))?;

    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("localmind-dictation-{epoch_ms}.{ext}"));

    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Failed to write temp dictation audio: {e}"))?;
    // From this point on, `_guard`'s Drop deletes the temp file no matter how
    // this function returns below (Ok, transcribe error, or panic-unwind).
    let _guard = TempFileGuard(path.clone());
    let path_str = path.to_string_lossy().to_string();

    // Dictation is latency-sensitive and called repeatedly, so route it
    // through the warm daemon (model stays resident between calls). If the
    // daemon can't be used for any reason — not found, failed to spawn,
    // wedged twice — fall back to the existing one-shot pipeline rather than
    // failing the dictation outright: working slowly beats not working.
    let model = resolve_model(&whisper_model);
    match daemon_transcribe(app, &path_str, &model) {
        Ok(text) => {
            if text.is_empty() {
                Err("Transcription produced no text (the clip may contain no speech).".to_string())
            } else {
                Ok(text)
            }
        }
        Err(daemon_err) => {
            eprintln!(
                "[dictation] warm daemon unavailable ({daemon_err}); falling back to one-shot transcription"
            );
            transcribe_blocking(app, path_str, whisper_model)
        }
    }
}

/// Transcribe a base64-encoded audio recording (from the ChatInput mic
/// button) using the same local faster-whisper pipeline as `transcribe_video`.
/// Runs on a blocking thread since transcription is CPU-heavy (seconds, on
/// short dictation clips).
#[tauri::command]
pub async fn transcribe_audio_base64(
    app: tauri::AppHandle,
    audio_base64: String,
    mime_ext: String,
    whisper_model: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        transcribe_audio_base64_blocking(&app, audio_base64, mime_ext, whisper_model)
    })
    .await
    .map_err(|e| format!("Transcription task panicked: {e}"))?
}
