use std::process::Command;
use std::path::{Path, PathBuf};
use serde::Serialize;

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

/// Open a native folder-picker dialog and return the selected path.
/// Returns None if the user cancels.
#[tauri::command]
fn open_workspace_dialog() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select Workspace Folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/// Canonicalize a path, returning None if it does not exist.
fn try_canonicalize(p: &str) -> Option<PathBuf> {
    Path::new(p).canonicalize().ok()
}

/// Check that `candidate` is inside `root` (both must be canonicalized first).
fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Run a shell command, optionally sandboxed to a workspace root.
/// If workspace_root is provided:
///   - the cwd must be inside the root before running
///   - if a `cd` causes the new cwd to escape, it is reset to the root and
///     sandbox_blocked = true is returned
#[tauri::command]
fn run_command(
    cmd: String,
    cwd: Option<String>,
    workspace_root: Option<String>,
) -> Result<CommandResult, String> {
    let work_dir_str = cwd.as_deref().filter(|s| !s.is_empty()).unwrap_or(".");

    // Resolve and validate cwd against workspace root before running
    if let Some(ref root_str) = workspace_root {
        if let (Some(abs_root), Some(abs_cwd)) = (
            try_canonicalize(root_str),
            try_canonicalize(work_dir_str),
        ) {
            if !is_within(&abs_root, &abs_cwd) {
                return Err(format!(
                    "Workspace sandbox: '{}' is outside the workspace root '{}'",
                    abs_cwd.display(),
                    abs_root.display()
                ));
            }
        }
    }

    #[cfg(target_os = "windows")]
    let output = Command::new("cmd")
        .args(["/C", &cmd])
        .current_dir(work_dir_str)
        .output()
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("sh")
        .args(["-c", &cmd])
        .current_dir(work_dir_str)
        .output()
        .map_err(|e| e.to_string())?;

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

    // Enforce sandbox on the resulting cwd
    let (final_cwd, sandbox_blocked) = if let Some(ref root_str) = workspace_root {
        if let Some(abs_root) = try_canonicalize(root_str) {
            if !is_within(&abs_root, &new_cwd_canon) {
                (abs_root.to_string_lossy().to_string(), true)
            } else {
                (new_cwd_canon.to_string_lossy().to_string(), false)
            }
        } else {
            (new_cwd_canon.to_string_lossy().to_string(), false)
        }
    } else {
        (new_cwd_canon.to_string_lossy().to_string(), false)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace_dialog,
            run_command,
            get_cwd,
            get_system_info,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
