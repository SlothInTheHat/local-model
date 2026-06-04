/**
 * MCP (Model Context Protocol) client.
 * Supports two transports:
 *  - stdio: Tauri spawns a local process; JSON-RPC 2.0 over stdin/stdout via Rust commands.
 *  - sse:   Remote server; JSON-RPC requests sent via POST, responses streamed via EventSource.
 */

import type { McpServer } from "../store/mcp";
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

// ─── Core send ────────────────────────────────────────────────────────────────

async function sendRequest(server: McpServer, method: string, params?: unknown): Promise<unknown> {
  const req = buildRequest(method, params);
  const reqId = (JSON.parse(req) as { id: string }).id;

  if (server.transport === "stdio") {
    const raw = await tauriInvoke<string>("mcp_send_request", {
      id: server.id,
      requestJson: req,
    });
    const resp = parseResponse(raw);
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

/** Stop a stdio server. No-op for SSE servers. */
export async function mcpStopServer(server: McpServer): Promise<void> {
  if (server.transport === "stdio") {
    await tauriInvoke("mcp_stop_server", { id: server.id });
  } else {
    disconnectSse(server.id);
  }
}
