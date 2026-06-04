import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ToolDef } from "../lib/tools";

export interface McpServer {
  id: string;
  label: string;
  transport: "stdio" | "sse";
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse fields
  url?: string;
  enabled: boolean;
  status: "disconnected" | "connecting" | "connected" | "error";
  errorMessage?: string;
  // tools discovered after connect
  tools: ToolDef[];
}

interface McpState {
  servers: McpServer[];

  addServer: (server: Omit<McpServer, "status" | "tools">) => void;
  removeServer: (id: string) => void;
  updateServer: (id: string, patch: Partial<McpServer>) => void;
  setStatus: (id: string, status: McpServer["status"], errorMessage?: string) => void;
  setTools: (id: string, tools: ToolDef[]) => void;

  /** All tools from all enabled + connected servers. */
  getEnabledTools: () => ToolDef[];
}

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      servers: [],

      addServer: (server) =>
        set((s) => ({
          servers: [
            ...s.servers,
            { ...server, status: "disconnected", tools: [] },
          ],
        })),

      removeServer: (id) =>
        set((s) => ({ servers: s.servers.filter((sv) => sv.id !== id) })),

      updateServer: (id, patch) =>
        set((s) => ({
          servers: s.servers.map((sv) => (sv.id === id ? { ...sv, ...patch } : sv)),
        })),

      setStatus: (id, status, errorMessage) =>
        set((s) => ({
          servers: s.servers.map((sv) =>
            sv.id === id ? { ...sv, status, errorMessage } : sv
          ),
        })),

      setTools: (id, tools) =>
        set((s) => ({
          servers: s.servers.map((sv) => (sv.id === id ? { ...sv, tools } : sv)),
        })),

      getEnabledTools: () => {
        const { servers } = get();
        return servers
          .filter((sv) => sv.enabled && sv.status === "connected")
          .flatMap((sv) => sv.tools);
      },
    }),
    {
      name: "localmind-mcp",
      // Don't persist runtime status or discovered tools — reconnect on startup
      partialize: (s) => ({
        servers: s.servers.map((sv) => ({
          ...sv,
          status: "disconnected" as const,
          tools: [],
          errorMessage: undefined,
        })),
      }),
    }
  )
);
