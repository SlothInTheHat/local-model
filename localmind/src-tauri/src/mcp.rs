use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>;

struct StdioHandle {
    /// Send (json_request, reply_channel) to the writer task.
    sender: std::sync::mpsc::SyncSender<(String, oneshot::Sender<String>)>,
    /// Rolling capture of the child's stderr, so a startup failure can be
    /// surfaced to the user instead of a generic "exited unexpectedly".
    stderr: Arc<Mutex<String>>,
}

static STDIO_SERVERS: OnceLock<Mutex<HashMap<String, StdioHandle>>> = OnceLock::new();

fn servers() -> &'static Mutex<HashMap<String, StdioHandle>> {
    STDIO_SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Spawn a stdio MCP server and wire up async I/O bridging.
#[tauri::command]
pub async fn mcp_start_server(
    id: String,
    cmd: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    // On Windows, route through cmd.exe so that .cmd extensions (npx.cmd, node.cmd, etc.)
    // are resolved correctly — Rust's Command::new() cannot directly spawn .cmd files.
    // Also inject effective_path() so user-installed tools (node, npm) are on PATH.
    #[cfg(target_os = "windows")]
    let mut child: Child = Command::new("cmd")
        .arg("/c")
        .arg(&cmd)
        .args(&args)
        .envs(&env)
        .env("PATH", crate::effective_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server '{cmd}': {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let mut child: Child = Command::new(&cmd)
        .args(&args)
        .envs(&env)
        .env("PATH", crate::effective_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server '{cmd}': {e}"))?;

    let mut stdin = child.stdin.take().ok_or("No stdin on child process")?;
    let stdout = child.stdout.take().ok_or("No stdout on child process")?;
    let stderr = child.stderr.take();

    // Capture stderr into a rolling buffer (last ~4 KB) so startup failures —
    // e.g. a missing OAuth credential or a bad package name — are visible.
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let buf = Arc::clone(&stderr_buf);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut s) = buf.lock() {
                    s.push_str(&line);
                    s.push('\n');
                    if s.len() > 8192 {
                        let trimmed: String = s.chars().skip(s.chars().count().saturating_sub(4000)).collect();
                        *s = trimmed;
                    }
                }
            }
        });
    }

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = Arc::clone(&pending);

    let (tx, rx) = std::sync::mpsc::sync_channel::<(String, oneshot::Sender<String>)>(64);

    // Writer task: drain the channel, write each request to stdin.
    let pending_writer = Arc::clone(&pending);
    tokio::spawn(async move {
        for (req_json, reply_tx) in rx {
            let req_id = serde_json::from_str::<serde_json::Value>(&req_json)
                .ok()
                .and_then(|v| v["id"].as_str().map(String::from))
                .unwrap_or_default();

            if !req_id.is_empty() {
                if let Ok(mut map) = pending_writer.lock() {
                    map.insert(req_id, reply_tx);
                }
            }

            let line = format!("{req_json}\n");
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    // Reader task: parse stdout lines, match by id, dispatch to waiting senders.
    // When stdout closes (server exited), drop all pending senders so callers
    // fail fast instead of waiting for the full timeout.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let resp_id = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|v| v["id"].as_str().map(String::from))
                .unwrap_or_default();

            if !resp_id.is_empty() {
                if let Ok(mut map) = pending_reader.lock() {
                    if let Some(tx) = map.remove(&resp_id) {
                        let _ = tx.send(line);
                    }
                }
            }
        }
        // Server process exited — cancel all pending requests immediately.
        if let Ok(mut map) = pending_reader.lock() {
            map.clear();
        }
    });

    if let Ok(mut map) = servers().lock() {
        map.insert(id, StdioHandle { sender: tx, stderr: stderr_buf });
    }

    // Let the child run independently.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    Ok(())
}

/// Remove a server handle (the writer channel drop will cause the child to stop receiving).
#[tauri::command]
pub fn mcp_stop_server(id: String) {
    if let Ok(mut map) = servers().lock() {
        map.remove(&id);
    }
}

/// Send a JSON-RPC request to a running stdio server and return the response JSON.
#[tauri::command]
pub async fn mcp_send_request(id: String, request_json: String) -> Result<String, String> {
    let (sender, stderr_buf) = {
        let map = servers().lock().map_err(|e| e.to_string())?;
        let h = map
            .get(&id)
            .ok_or_else(|| format!("MCP server '{id}' not running"))?;
        (h.sender.clone(), Arc::clone(&h.stderr))
    };

    let (reply_tx, reply_rx) = oneshot::channel::<String>();

    sender
        .send((request_json, reply_tx))
        .map_err(|_| "MCP server channel closed".to_string())?;

    match tokio::time::timeout(std::time::Duration::from_secs(120), reply_rx).await {
        Err(_) => Err(
            "MCP request timed out after 120s (server may still be downloading — try again in a moment)"
                .to_string(),
        ),
        Ok(Ok(line)) => Ok(line),
        // The reply channel was dropped → the server process exited before
        // responding. Surface whatever it wrote to stderr so the user can see
        // the real cause (missing OAuth credentials, bad package name, etc.).
        Ok(Err(_)) => {
            let captured = stderr_buf.lock().map(|s| s.trim().to_string()).unwrap_or_default();
            if captured.is_empty() {
                Err("MCP server exited before responding, with no error output. Check the command/package name and that npx can reach npm.".to_string())
            } else {
                let tail: String = captured
                    .chars()
                    .rev()
                    .take(1000)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                Err(format!("MCP server exited on startup. Its error output:\n{tail}"))
            }
        }
    }
}
