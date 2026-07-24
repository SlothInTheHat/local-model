//! Piper (OHF-Voice/piper1-gpl) offline neural text-to-speech.
//!
//! Windows' built-in speech voices (surfaced to speak_text via the Web Speech
//! API) are limited to whatever SAPI/OneCore voices are installed — often just
//! the classic robotic-sounding ones. Piper is a real local neural TTS engine
//! but ships only as a Python package (`pip install piper-tts`), not a
//! standalone executable, so this manages its own dedicated venv under the
//! app data dir (mirroring transcribe.rs's phone-agent venv pattern, but
//! self-contained rather than depending on the phone-agent's own venv) and
//! shells out to `python -m piper` / `python -m piper.download_voices`.
//!
//! LICENSING NOTE: piper-tts is GPL-3.0 (the original MIT-licensed rhasspy/piper
//! is archived/unmaintained). Nothing here bundles or redistributes that code —
//! the venv and the pip-installed package live entirely in the user's own app
//! data directory, downloaded directly from PyPI at the user's request, the
//! same way `ollama pull` fetches a model. LocalMind's own license is
//! unaffected by invoking it as a separate process.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;

use crate::effective_path;

fn piper_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?
        .join("piper");
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

/// Finds a system Python launcher, preferring Windows' "py" launcher (always
/// resolves the right installed version) then falling back to python3/python.
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

#[derive(serde::Serialize)]
pub struct PiperStatus {
    python_available: bool,
    venv_ready: bool,
    /// Voice ids (e.g. "en_US-lessac-medium") already downloaded and ready to use.
    voices: Vec<String>,
}

#[tauri::command]
pub fn piper_status(app: tauri::AppHandle) -> Result<PiperStatus, String> {
    let root = piper_root(&app)?;
    let python_available = find_system_python().is_some();
    let venv_ready = venv_python(&root).exists();

    let voices_dir = root.join("voices");
    let mut voices: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&voices_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(id) = name.strip_suffix(".onnx") {
                voices.push(id.to_string());
            }
        }
    }
    voices.sort();

    Ok(PiperStatus { python_available, venv_ready, voices })
}

/// Creates the dedicated venv and installs piper-tts into it. Takes a while
/// (pip resolving + downloading torch-free onnxruntime deps) — the frontend
/// should show this as a real "setting up" state, not an instant action.
#[tauri::command]
pub fn piper_setup(app: tauri::AppHandle) -> Result<String, String> {
    let root = piper_root(&app)?;
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
    let output = Command::new(&python)
        .args(["-m", "pip", "install", "--upgrade", "pip", "piper-tts"])
        .env("PATH", effective_path())
        .output()
        .map_err(|e| format!("Failed to install piper-tts: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to install piper-tts: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok("Piper is set up and ready — download a voice next.".to_string())
}

/// Downloads a named voice (e.g. "en_US-lessac-medium") into this app's own
/// voices directory via piper's own downloader (handles the actual model
/// hosting/URLs itself — nothing hardcoded here).
#[tauri::command]
pub fn piper_download_voice(app: tauri::AppHandle, voice: String) -> Result<String, String> {
    let root = piper_root(&app)?;
    let python = venv_python(&root);
    if !python.exists() {
        return Err("Piper isn't set up yet — run setup first.".to_string());
    }
    let voices_dir = root.join("voices");
    std::fs::create_dir_all(&voices_dir).map_err(|e| e.to_string())?;

    let output = Command::new(&python)
        .args(["-m", "piper.download_voices", "--data-dir"])
        .arg(&voices_dir)
        .arg(&voice)
        .env("PATH", effective_path())
        .output()
        .map_err(|e| format!("Failed to download voice '{voice}': {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to download voice '{voice}': {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(format!("Downloaded voice: {voice}"))
}

/// Synthesizes text with the given voice to a temp WAV file, then plays it
/// synchronously via PowerShell's SoundPlayer — same shell-out-for-audio
/// pattern already used by speak_text/print_file, no new audio-playback crate
/// needed. Blocks until playback finishes, matching speak_text's contract.
#[tauri::command]
pub fn piper_speak(app: tauri::AppHandle, text: String, voice: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("piper_speak: empty text".to_string());
    }
    let root = piper_root(&app)?;
    let python = venv_python(&root);
    if !python.exists() {
        return Err("Piper isn't set up yet — set it up in Settings first.".to_string());
    }
    let voices_dir = root.join("voices");
    if !voices_dir.join(format!("{voice}.onnx")).exists() {
        return Err(format!("Voice '{voice}' isn't downloaded yet — download it in Settings first."));
    }

    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_wav = std::env::temp_dir().join(format!("localmind-piper-{epoch_ms}.wav"));

    let output = Command::new(&python)
        .args(["-m", "piper", "-m", &voice, "--data-dir"])
        .arg(&voices_dir)
        .arg("-f")
        .arg(&out_wav)
        .arg("--")
        .arg(&text)
        .env("PATH", effective_path())
        .output()
        .map_err(|e| format!("Piper synthesis failed to run: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Piper synthesis failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let wav_str = out_wav.to_string_lossy().replace('\'', "''");
    // SoundPlayer lazily loads its stream on the first Play/PlaySync call rather
    // than at construction — calling PlaySync() directly starts playback before
    // the device/buffer is primed, which clips the first fraction of a second
    // of audio. An explicit synchronous Load() first (documented .NET behavior,
    // a well-known fix for this exact clipped-start symptom) forces the whole
    // file to be loaded and decoded before playback begins.
    let script = format!(
        "$p = New-Object Media.SoundPlayer '{wav_str}'; $p.Load(); $p.PlaySync()"
    );
    let play_result = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
    let _ = std::fs::remove_file(&out_wav);

    match play_result {
        Ok(out) if out.status.success() => Ok("Spoke the text aloud using Piper.".to_string()),
        Ok(out) => Err(format!("Piper synthesized audio but playback failed: {}", String::from_utf8_lossy(&out.stderr))),
        Err(e) => Err(format!("Piper synthesized audio but playback failed: {e}")),
    }
}
