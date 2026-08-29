//! Kokoro-82M offline text-to-speech — replaces the earlier Piper integration.
//!
//! Two real advantages over Piper drove the swap: Kokoro's weights are
//! Apache-2.0 (Piper's `piper-tts` package is GPL-3.0 — a licensing wart the
//! old piper.rs had to call out explicitly), and Kokoro ships every voice in
//! ONE shared model+voices download instead of Piper's one-download-per-voice
//! model, so there's no separate "download a voice" step once setup is done.
//!
//! Like Piper before it, this manages its own dedicated venv under the app
//! data dir (kokoro-onnx is a Python-only package, not a standalone
//! executable) and shells out to it — nothing here bundles or redistributes
//! kokoro-onnx or its weights; both are fetched at the user's request the
//! same way `ollama pull` fetches a model.
//!
//! Unlike Piper's `piper_speak` (which shelled out to a FRESH `python -m
//! piper` process — and therefore reloaded the model from scratch — on every
//! single utterance), synthesis here goes through a warm daemon process that
//! keeps the model resident in RAM, mirroring transcribe.rs's whisper daemon
//! pattern exactly (same line-delimited-JSON-over-stdin/stdout protocol,
//! same reader-thread + recv_timeout + kill-and-retry-once design). That
//! daemon's actual Python source lives in kokoro_daemon.py, embedded into
//! this binary via include_str! and written out fresh before every spawn so
//! an app update always runs the latest version against an existing venv.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::Manager;

use crate::effective_path;

/// Embedded at compile time — see this file's header comment for why it's
/// written out fresh before every daemon spawn rather than only at setup.
const KOKORO_DAEMON_SOURCE: &str = include_str!("kokoro_daemon.py");

const MODEL_URL: &str =
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx";
const VOICES_URL: &str =
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";

fn kokoro_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?
        .join("kokoro");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create '{}': {e}", dir.display()))?;
    Ok(dir)
}

fn venv_python(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        root.join("venv").join("Scripts").join("python.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        root.join("venv").join("bin").join("python")
    }
}

fn model_path(root: &Path) -> PathBuf {
    root.join("model").join("kokoro-v1.0.int8.onnx")
}

fn voices_path(root: &Path) -> PathBuf {
    root.join("model").join("voices-v1.0.bin")
}

fn daemon_script_path(root: &Path) -> PathBuf {
    root.join("kokoro_daemon.py")
}

/// Finds a system Python launcher — identical approach to the deleted
/// piper.rs (preferring Windows' "py" launcher, which always resolves the
/// right installed version, then falling back to python3/python).
fn find_system_python() -> Option<(&'static str, Vec<&'static str>)> {
    let candidates: &[(&str, &[&str])] = &[
        ("py", &["-3", "--version"]),
        ("python3", &["--version"]),
        ("python", &["--version"]),
    ];
    for (cmd, version_args) in candidates {
        let ok = Command::new(cmd)
            .args(*version_args)
            .env("PATH", effective_path())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            let venv_args: Vec<&str> = if *cmd == "py" { vec!["-3"] } else { vec![] };
            return Some((cmd, venv_args));
        }
    }
    None
}

/// Cheap presence check for setup-time package selection (onnxruntime-gpu vs
/// plain onnxruntime — see kokoro_setup's doc comment for why this is a
/// package-choice decision here, unlike faster-whisper's single wheel that
/// supports both). Not the last word on whether the GPU actually works —
/// kokoro_daemon.py's own CUDAExecutionProvider->CPUExecutionProvider
/// provider list handles that at runtime regardless of what this returns.
fn has_nvidia_gpu() -> bool {
    Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .env("PATH", effective_path())
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct KokoroStatus {
    python_available: bool,
    venv_ready: bool,
    model_ready: bool,
    /// Informational only — surfaced so Settings can tell the user why setup
    /// is about to download the (larger) GPU-capable onnxruntime package.
    gpu_detected: bool,
}

#[tauri::command]
pub fn kokoro_status(app: tauri::AppHandle) -> Result<KokoroStatus, String> {
    let root = kokoro_root(&app)?;
    Ok(KokoroStatus {
        python_available: find_system_python().is_some(),
        venv_ready: venv_python(&root).exists(),
        model_ready: model_path(&root).exists() && voices_path(&root).exists(),
        gpu_detected: has_nvidia_gpu(),
    })
}

/// Creates the dedicated venv and installs kokoro-onnx (+ soundfile, and
/// whichever onnxruntime package matches this machine) into it, then writes
/// out the daemon script. Takes a while (pip resolving/downloading) — the
/// frontend should show this as a real "setting up" state, not an instant
/// action.
#[tauri::command]
pub fn kokoro_setup(app: tauri::AppHandle) -> Result<String, String> {
    let root = kokoro_root(&app)?;
    let (launcher, venv_extra_args) = find_system_python().ok_or_else(|| {
        "No Python installation found. Install Python 3.9+ from python.org (make sure \"Add to PATH\" is checked during install), then try again.".to_string()
    })?;

    let venv_dir = root.join("venv");
    if !venv_python(&root).exists() {
        let mut args = venv_extra_args.clone();
        args.extend(["-m", "venv"]);
        let output = Command::new(launcher)
            .args(&args)
            .arg(&venv_dir)
            .env("PATH", effective_path())
            .output()
            .map_err(|e| format!("Failed to create virtual environment: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Failed to create virtual environment: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    let python = venv_python(&root);

    // onnxruntime-gpu and plain onnxruntime are mutually exclusive PyPI
    // packages (unlike ctranslate2/faster-whisper's single wheel that
    // supports both) — this is the one place GPU-vs-CPU is actually a
    // choice rather than automatic. Picking wrong isn't fatal either way:
    // onnxruntime-gpu on a machine with no working CUDA runtime just runs on
    // its own CPU provider (see kokoro_daemon.py's provider list), it's only
    // a larger download than necessary.
    let onnx_package = if has_nvidia_gpu() { "onnxruntime-gpu" } else { "onnxruntime" };
    let output = Command::new(&python)
        .args(["-m", "pip", "install", "--upgrade", "pip", "kokoro-onnx", "soundfile", onnx_package])
        .env("PATH", effective_path())
        .output()
        .map_err(|e| format!("Failed to install kokoro-onnx: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to install kokoro-onnx: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    std::fs::write(daemon_script_path(&root), KOKORO_DAEMON_SOURCE)
        .map_err(|e| format!("Failed to write kokoro_daemon.py: {e}"))?;

    Ok(format!(
        "Kokoro is set up ({onnx_package}) — download the voice model next."
    ))
}

/// Downloads the one shared model+voices files via the venv's own Python
/// (stdlib urllib — no new Rust HTTP dependency needed for a single
/// one-time download, matching how piper_download_voice shelled out to
/// piper's own downloader rather than LocalMind fetching anything itself).
#[tauri::command]
pub fn kokoro_download_model(app: tauri::AppHandle) -> Result<String, String> {
    let root = kokoro_root(&app)?;
    let python = venv_python(&root);
    if !python.exists() {
        return Err("Kokoro isn't set up yet — run setup first.".to_string());
    }
    let model_dir = root.join("model");
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    let script = format!(
        "import urllib.request\n\
         urllib.request.urlretrieve({model_url:?}, {model_path:?})\n\
         urllib.request.urlretrieve({voices_url:?}, {voices_path:?})\n",
        model_url = MODEL_URL,
        model_path = model_path(&root).to_string_lossy(),
        voices_url = VOICES_URL,
        voices_path = voices_path(&root).to_string_lossy(),
    );

    let output = Command::new(&python)
        .args(["-c", &script])
        .env("PATH", effective_path())
        .output()
        .map_err(|e| format!("Failed to download the voice model: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to download the voice model: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok("Downloaded the Kokoro voice model.".to_string())
}

// ─── Warm Kokoro daemon (mirrors transcribe.rs's whisper daemon exactly) ───

const DAEMON_READ_TIMEOUT: Duration = Duration::from_secs(60);

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

static DAEMON: OnceLock<Mutex<Option<DaemonHandle>>> = OnceLock::new();

fn daemon_slot() -> &'static Mutex<Option<DaemonHandle>> {
    DAEMON.get_or_init(|| Mutex::new(None))
}

fn spawn_daemon(root: &Path) -> Result<DaemonHandle, String> {
    let python = venv_python(root);
    if !python.exists() {
        return Err("Kokoro isn't set up yet — set it up in Settings first.".to_string());
    }
    if !model_path(root).exists() || !voices_path(root).exists() {
        return Err("Kokoro's voice model isn't downloaded yet — download it in Settings first.".to_string());
    }

    // Re-written on every spawn (not just at setup time) so an app update
    // always runs the latest daemon script against an already-set-up venv —
    // see this file's header comment.
    std::fs::write(daemon_script_path(root), KOKORO_DAEMON_SOURCE)
        .map_err(|e| format!("Failed to write kokoro_daemon.py: {e}"))?;

    let mut child = Command::new(&python)
        .arg(daemon_script_path(root))
        .arg(model_path(root))
        .arg(voices_path(root))
        .env("PATH", effective_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn kokoro daemon: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "kokoro daemon child has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "kokoro daemon child has no stdout".to_string())?;
    let stderr = child.stderr.take();

    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[kokoro_daemon] {line}");
            }
        });
    }

    let (tx, rx) = mpsc::channel::<DaemonLine>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(Ok(l)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("daemon stdout read error: {e}")));
                    break;
                }
            }
        }
    });

    Ok(DaemonHandle { child, stdin, rx })
}

fn kill_daemon(guard: &mut Option<DaemonHandle>) {
    *guard = None; // Drop impl kills + waits on the child
}

fn send_request(handle: &mut DaemonHandle, text: &str, voice: &str) -> Result<String, String> {
    let request = serde_json::json!({ "text": text, "voice": voice }).to_string();
    handle
        .stdin
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|e| format!("failed writing to kokoro daemon stdin: {e}"))?;
    handle
        .stdin
        .flush()
        .map_err(|e| format!("failed flushing kokoro daemon stdin: {e}"))?;

    match handle.rx.recv_timeout(DAEMON_READ_TIMEOUT) {
        Ok(Ok(line)) => {
            let value: serde_json::Value = serde_json::from_str(&line)
                .map_err(|e| format!("malformed kokoro daemon response ({e}): {line}"))?;
            if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                Err(format!("Kokoro synthesis failed: {err}"))
            } else if let Some(path) = value.get("path").and_then(|v| v.as_str()) {
                Ok(path.to_string())
            } else {
                Err(format!("kokoro daemon response missing path/error: {line}"))
            }
        }
        Ok(Err(reason)) => Err(reason),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("kokoro daemon read timed out after {DAEMON_READ_TIMEOUT:?}"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("kokoro daemon exited (stdout closed)".to_string())
        }
    }
}

/// Synthesize via the warm daemon: lazily spawn on first use, retry once
/// with a fresh daemon on any failure (never in a loop — a second failure
/// is surfaced to the caller). Same contract as transcribe.rs's
/// daemon_transcribe.
fn daemon_synthesize(root: &Path, text: &str, voice: &str) -> Result<String, String> {
    let mut guard = daemon_slot().lock().unwrap_or_else(|e| e.into_inner());

    if guard.is_none() {
        *guard = Some(spawn_daemon(root)?);
    }

    let first_attempt = send_request(guard.as_mut().expect("daemon just ensured"), text, voice);
    if let Ok(path) = first_attempt {
        return Ok(path);
    }
    let first_err = first_attempt.unwrap_err();
    eprintln!("[kokoro_daemon] request failed, respawning once: {first_err}");
    kill_daemon(&mut guard);

    let handle = spawn_daemon(root)?;
    *guard = Some(handle);
    let retry = send_request(guard.as_mut().expect("daemon just respawned"), text, voice);
    if retry.is_err() {
        kill_daemon(&mut guard);
    }
    retry
}

/// Synthesizes text with the given voice via the warm daemon, then plays the
/// resulting WAV synchronously via PowerShell's SoundPlayer — same
/// shell-out-for-audio pattern the deleted piper_speak used, no new audio
/// crate needed. Blocks until playback finishes, matching speak_text's
/// contract.
#[tauri::command]
pub async fn kokoro_speak(app: tauri::AppHandle, text: String, voice: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("kokoro_speak: empty text".to_string());
    }
    let root = kokoro_root(&app)?;

    let wav_path = tokio::task::spawn_blocking(move || daemon_synthesize(&root, &text, &voice))
        .await
        .map_err(|e| format!("Kokoro synthesis task panicked: {e}"))??;

    let wav_str = wav_path.replace('\'', "''");
    // Same explicit Load()-before-PlaySync() fix as the deleted piper_speak
    // (SoundPlayer otherwise clips the first fraction of a second of audio).
    let script = format!(
        "$p = New-Object Media.SoundPlayer '{wav_str}'; $p.Load(); $p.PlaySync()"
    );
    let play_result = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
    let _ = std::fs::remove_file(&wav_path);

    match play_result {
        Ok(out) if out.status.success() => Ok("Spoke the text aloud using Kokoro.".to_string()),
        Ok(out) => Err(format!("Kokoro synthesized audio but playback failed: {}", String::from_utf8_lossy(&out.stderr))),
        Err(e) => Err(format!("Kokoro synthesized audio but playback failed: {e}")),
    }
}
