/**
 * Auto-reconnects enabled MCP servers on app launch.
 *
 * useMcpStore persists servers across restarts but deliberately resets
 * status/tools to "disconnected"/[] on load (see store/mcp.ts partialize —
 * "reconnect on startup"). Historically nothing actually did that reconnect:
 * the only connect path was the manual Connect button in McpSettings.tsx, so
 * every launch silently dropped MCP tools until the user reopened Settings.
 * This module closes that gap by calling the same connectMcpServer() used by
 * the UI, for every enabled server, once per app launch.
 */

import { useMcpStore } from "../store/mcp";
import { connectMcpServer } from "./mcp";

let started = false;

/**
 * Kick off connection attempts for every enabled, not-yet-connected server.
 * Fires all connects in parallel and does not block the caller — mount this
 * once from App.tsx:
 *
 *   import { initMcpAutoConnect } from "./lib/mcpAutoConnect";
 *   useEffect(() => { initMcpAutoConnect(); }, []);
 *
 * Idempotent: subsequent calls after the first are no-ops (guards against
 * React StrictMode double-invoke / re-renders re-triggering the effect).
 */
export function initMcpAutoConnect(): void {
  if (started) return;
  started = true;

  const { servers } = useMcpStore.getState();
  const targets = servers.filter((s) => s.enabled && s.status !== "connected");

  void Promise.allSettled(targets.map((s) => connectMcpServer(s)));
}

/**
 * Re-run the connect flow for a single server by id, regardless of the
 * one-shot `started` guard above (e.g. a "Reconnect all" action, or retrying
 * just-added server). No-ops if the server id doesn't exist.
 */
export function reconnectMcpServer(serverId: string): Promise<boolean> {
  const server = useMcpStore.getState().servers.find((s) => s.id === serverId);
  if (!server) return Promise.resolve(false);
  return connectMcpServer(server);
}
