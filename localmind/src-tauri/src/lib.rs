use std::process::Command;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use serde::Serialize;

// ─── PATH augmentation ────────────────────────────────────────────────────────

static EFFECTIVE_PATH: OnceLock<String> = OnceLock::new();

/// Build a PATH that merges system PATH with the user PATH (HKCU\Environment).
/// On Windows, desktop apps launched outside a terminal only see system PATH,
/// so git/node/python installed by the user are invisible. We call PowerShell
/// once, cache the result, and inject it into every spawned command.
fn effective_path() -> &'static str {
    EFFECTIVE_PATH.get_or_init(|| {
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
                r"C:\Program Files\Git\cmd".to_string(),
                r"C:\Program Files\Git\bin".to_string(),
                r"C:\Program Files\nodejs".to_string(),
                format!(r"C:\Users\{username}\AppData\Roaming\npm"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python313"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python312"),
                format!(r"C:\Users\{username}\AppData\Local\Programs\Python\Python311"),
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
    })
}

mod mcp;
use mcp::{mcp_start_server, mcp_stop_server, mcp_send_request};

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
        .env("PATH", effective_path())
        .current_dir(work_dir_str)
        .output()
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("sh")
        .args(["-c", &cmd])
        .env("PATH", effective_path())
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

/// Return GPU name and VRAM using native OS queries.
#[tauri::command]
fn get_gpu_info() -> Vec<GpuInfo> {
    query_gpu_info()
}

#[cfg(target_os = "windows")]
fn query_gpu_info() -> Vec<GpuInfo> {
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

        let name = name_idx
            .and_then(|i| cols.get(i))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        if name.is_empty() { continue; }

        let vram_bytes: u64 = ram_idx
            .and_then(|i| cols.get(i))
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace_dialog,
            run_command,
            get_cwd,
            get_system_info,
            get_gpu_info,
            mcp_start_server,
            mcp_stop_server,
            mcp_send_request,
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
