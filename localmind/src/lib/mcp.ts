/**
 * MCP (Model Context Protocol) client.
 * Supports two transports:
 *  - stdio: Tauri spawns a local process; JSON-RPC 2.0 over stdin/stdout via Rust commands.
 *  - sse:   Remote server; JSON-RPC requests sent via POST, responses streamed via EventSource.
 */

import { useMcpStore, type McpServer } from "../store/mcp";
import type { ToolDef } from "./tools";

// ─── Tauri bridge ────────────────────────────────────────────────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

let _reqId = 1;
function nextId() {
  return String(_reqId++);
}

function buildRequest(method: string, params?: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params });
}

interface JsonRpcResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

function parseResponse(json: string): JsonRpcResponse {
  return JSON.parse(json) as JsonRpcResponse;
}

// ─── SSE client state (remote servers) ───────────────────────────────────────

interface SseState {
  es: EventSource;
  pending: Map<string, (resp: JsonRpcResponse) => void>;
  postUrl: string;
}

const sseClients = new Map<string, SseState>();

function getSseState(server: McpServer): SseState {
  const existing = sseClients.get(server.id);
  if (existing) return existing;

  const url = server.url!;
  const sseUrl = url.endsWith("/sse") ? url : `${url}/sse`;
  const postUrl = url.endsWith("/sse") ? url.replace(/\/sse$/, "/message") : `${url}/message`;

  const pending = new Map<string, (r: JsonRpcResponse) => void>();
  const es = new EventSource(sseUrl);

  es.addEventListener("message", (ev) => {
    try {
      const resp = parseResponse(ev.data as string);
      const cb = pending.get(resp.id);
      if (cb) {
        pending.delete(resp.id);
        cb(resp);
      }
    } catch { /* ignore malformed */ }
  });

  // Connection dropped (network blip, remote restart, etc). Close + evict the
  // cached client so the next sendRequest re-establishes a fresh EventSource
  // instead of silently sending POSTs into a dead stream. Any requests already
  // pending on this connection still resolve via the existing 30s timeout in
  // sendRequest — we don't need to reject them here.
  es.onerror = () => {
    es.close();
    sseClients.delete(server.id);
    useMcpStore.getState().setStatus(server.id, "error", "MCP SSE connection lost");
  };

  const state: SseState = { es, pending, postUrl };
  sseClients.set(server.id, state);
  return state;
}

export function disconnectSse(serverId: string) {
  const state = sseClients.get(serverId);
  if (state) {
    state.es.close();
    sseClients.delete(serverId);
  }
}

// ─── Crash recovery (stdio) ───────────────────────────────────────────────────

// Matches the error strings src-tauri/src/mcp.rs returns from mcp_send_request
// when the child process is gone: "MCP server '{id}' not running" (handle
// missing), "MCP server channel closed" (writer task died), "MCP server
// exited before responding..." / "MCP server exited on startup..." (process
// died). Deliberately excludes the 120s timeout message — a slow-but-alive
// server (e.g. downloading a package) shouldn't be treated as dead.
function isDeadServerError(message: string): boolean {
  return /not running|exited|channel closed/i.test(message);
}

// Per-server cooldown so a permanently-broken server doesn't respawn on every
// single tool call — one reconnect attempt per RECONNECT_COOLDOWN_MS.
const RECONNECT_COOLDOWN_MS = 10_000;
const lastReconnectAttempt = new Map<string, number>();

async function stdioInvoke(server: McpServer, req: string): Promise<JsonRpcResponse> {
  const raw = await tauriInvoke<string>("mcp_send_request", {
    id: server.id,
    requestJson: req,
  });
  return parseResponse(raw);
}

/** Send a single JSON-RPC request over stdio, reconnecting once if the server process is dead. */
async function sendStdioRequest(server: McpServer, req: string, isRetry = false): Promise<JsonRpcResponse> {
  try {
    return await stdioInvoke(server, req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = e instanceof Error ? e : new Error(msg);
    if (isRetry || !isDeadServerError(msg)) throw err;

    const now = Date.now();
    const last = lastReconnectAttempt.get(server.id) ?? 0;
    if (now - last < RECONNECT_COOLDOWN_MS) {
      // Reconnected too recently (or a reconnect is already unwinding above
      // us on the call stack) — don't loop, just surface the error.
      useMcpStore.getState().setStatus(server.id, "error", msg);
      throw err;
    }
    lastReconnectAttempt.set(server.id, now);

    try {
      await mcpInitialize(server); // respawns the stdio process + re-runs the handshake
    } catch (initErr) {
      const initMsg = initErr instanceof Error ? initErr.message : String(initErr);
      useMcpStore.getState().setStatus(server.id, "error", initMsg);
      throw initErr instanceof Error ? initErr : new Error(initMsg);
    }

    try {
      const resp = await sendStdioRequest(server, req, true);
      useMcpStore.getState().setStatus(server.id, "connected");
      return resp;
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      useMcpStore.getState().setStatus(server.id, "error", retryMsg);
      throw retryErr;
    }
  }
}

// ─── Core send ────────────────────────────────────────────────────────────────

async function sendRequest(server: McpServer, method: string, params?: unknown): Promise<unknown> {
  const req = buildRequest(method, params);
  const reqId = (JSON.parse(req) as { id: string }).id;

  if (server.transport === "stdio") {
    const resp = await sendStdioRequest(server, req);
    if (resp.error) throw new Error(resp.error.message);
    return resp.result;
  }

  // SSE transport
  const state = getSseState(server);
  return new Promise<unknown>((resolve, reject) => {
    state.pending.set(reqId, (resp) => {
      if (resp.error) reject(new Error(resp.error.message));
      else resolve(resp.result);
    });

    setTimeout(() => {
      if (state.pending.has(reqId)) {
        state.pending.delete(reqId);
        reject(new Error("MCP SSE request timed out"));
      }
    }, 30_000);

    fetch(state.postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: req,
    }).catch(reject);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Send the MCP initialize handshake. Returns the server's declared capabilities. */
export async function mcpInitialize(server: McpServer): Promise<unknown> {
  if (server.transport === "stdio") {
    await tauriInvoke("mcp_start_server", {
      id: server.id,
      cmd: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
    });
  }
  return sendRequest(server, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "LocalMind", version: "0.2.0" },
  });
}

/** Fetch available tools from the MCP server and convert to LocalMind ToolDef format. */
export async function mcpListTools(server: McpServer): Promise<ToolDef[]> {
  const result = (await sendRequest(server, "tools/list")) as {
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  };

  return (result.tools ?? []).map((t) => ({
    name: `${server.id}__${t.name}` as ToolDef["name"],
    description: `[${server.label}] ${t.description ?? t.name}`,
    parameters: t.inputSchema ?? { type: "object", properties: {} },
  }));
}

/** Call a tool on the server and return its text output. */
export async function mcpCallTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  // Strip the serverId prefix to get the real tool name
  const realName = toolName.startsWith(`${server.id}__`)
    ? toolName.slice(server.id.length + 2)
    : toolName;

  const result = (await sendRequest(server, "tools/call", {
    name: realName,
    arguments: args,
  })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };

  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

  if (result.isError) throw new Error(text || "MCP tool returned an error");
  return text;
}

/**
 * Connect to a server end-to-end (initialize handshake + list tools) and
 * reflect the outcome in useMcpStore. Single shared code path used by both
 * the McpSettings "Connect" button and mcpAutoConnect on app launch, so the
 * two never drift out of sync.
 */
export async function connectMcpServer(server: McpServer): Promise<boolean> {
  const { setStatus, setTools } = useMcpStore.getState();
  setStatus(server.id, "connecting");
  try {
    await mcpInitialize(server);
    const tools = await mcpListTools(server);
    setTools(server.id, tools);
    setStatus(server.id, "connected");
    return true;
  } catch (e) {
    // Tauri rejects a failed invoke with the raw Err(String), not an Error
    // object — so (e as Error).message would be undefined and the UI would
    // show a red X with no explanation. Handle both shapes.
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(server.id, "error", msg || "Connection failed (no error detail).");
    return false;
  }
}

/** Stop a stdio server. No-op for SSE servers. */
export async function mcpStopServer(server: McpServer): Promise<void> {
  if (server.transport === "stdio") {
    await tauriInvoke("mcp_stop_server", { id: server.id });
  } else {
    disconnectSse(server.id);
  }
}
