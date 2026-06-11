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
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server '{cmd}': {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let mut child: Child = Command::new(&cmd)
        .args(&args)
        .envs(&env)
        .env("PATH", crate::effective_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server '{cmd}': {e}"))?;

    let mut stdin = child.stdin.take().ok_or("No stdin on child process")?;
    let stdout = child.stdout.take().ok_or("No stdout on child process")?;

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
        map.insert(id, StdioHandle { sender: tx });
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
    let sender = {
        let map = servers().lock().map_err(|e| e.to_string())?;
        map.get(&id)
            .map(|h| h.sender.clone())
            .ok_or_else(|| format!("MCP server '{id}' not running"))?
    };

    let (reply_tx, reply_rx) = oneshot::channel::<String>();

    sender
        .send((request_json, reply_tx))
        .map_err(|_| "MCP server channel closed".to_string())?;

    tokio::time::timeout(std::time::Duration::from_secs(120), reply_rx)
        .await
        .map_err(|_| "MCP request timed out after 120s (server may still be downloading — try again in a moment)".to_string())?
        .map_err(|_| "MCP server process exited unexpectedly — check that the command/package name is correct and that npx can reach npm".to_string())
}
