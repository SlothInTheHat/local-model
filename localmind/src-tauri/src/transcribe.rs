//! Video/audio transcription for the desktop agent's `transcribe_video` tool.
//!
//! Locates the phone-agent Python pipeline (phone-agent/.venv + transcribe_cli.py)
//! by walking up from the app's working/exe directory, then runs it on a video
//! file and returns the transcript. Transcription is CPU-heavy (seconds to
//! minutes), so the blocking work runs on a spawn_blocking thread.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Find (venv_python, transcribe_cli.py) by walking up from anchor dirs.
fn locate_pipeline() -> Option<(PathBuf, PathBuf)> {
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
                return Some((py, script));
            }
            dir = d.parent();
        }
    }
    None
}

fn transcribe_blocking(video_path: String, whisper_model: Option<String>) -> Result<String, String> {
    let is_url = video_path.starts_with("http://") || video_path.starts_with("https://");
    if !is_url && !Path::new(&video_path).exists() {
        return Err(format!("Video file not found: {video_path}"));
    }

    let (python, script) = locate_pipeline().ok_or_else(|| {
        "Transcription pipeline not found. It requires the phone-agent Python setup \
         (phone-agent/.venv and transcribe_cli.py) — see phone-agent/README.md."
            .to_string()
    })?;

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg(&video_path)
        .env("PATH", crate::effective_path()); // so ffmpeg is on PATH
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
    video_path: String,
    whisper_model: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || transcribe_blocking(video_path, whisper_model))
        .await
        .map_err(|e| format!("Transcription task panicked: {e}"))?
}
