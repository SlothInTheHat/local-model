import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ToolDef } from "../lib/tools";
import { deleteCredential, getCredential, setCredential } from "../lib/credentials";

/** Credential-vault "service" namespace for MCP server env vars (see src/lib/credentials.ts).
 *  Stored as one JSON-serialized secret per server id, since env is an
 *  arbitrary key/value map rather than a single well-known field. */
const CRED_SERVICE = "mcp-server-env";

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
  /** Hydrates every stdio server's env from the credential vault. Call once
   *  at startup (App.tsx) — env is deliberately excluded from this store's
   *  own persisted snapshot (see partialize below), so without this call
   *  every server's env would read back empty after a restart. */
  loadServerEnvs: () => Promise<void>;

  /** All tools from all enabled + connected servers. */
  getEnabledTools: () => ToolDef[];
}

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      servers: [],

      addServer: (server) => {
        set((s) => ({
          servers: [
            ...s.servers,
            { ...server, status: "disconnected", tools: [] },
          ],
        }));
        if (server.env && Object.keys(server.env).length > 0) {
          void setCredential(CRED_SERVICE, server.id, JSON.stringify(server.env));
        }
      },

      removeServer: (id) => {
        set((s) => ({ servers: s.servers.filter((sv) => sv.id !== id) }));
        void deleteCredential(CRED_SERVICE, id);
      },

      updateServer: (id, patch) => {
        set((s) => ({
          servers: s.servers.map((sv) => (sv.id === id ? { ...sv, ...patch } : sv)),
        }));
        if (patch.env !== undefined) {
          void setCredential(CRED_SERVICE, id, JSON.stringify(patch.env));
        }
      },

      loadServerEnvs: async () => {
        const ids = get().servers.filter((sv) => sv.transport === "stdio").map((sv) => sv.id);
        const raw = await Promise.all(ids.map((id) => getCredential(CRED_SERVICE, id)));
        set((s) => ({
          servers: s.servers.map((sv) => {
            const i = ids.indexOf(sv.id);
            if (i < 0 || !raw[i]) return sv;
            try {
              return { ...sv, env: JSON.parse(raw[i]) as Record<string, string> };
            } catch {
              return sv; // corrupt/unexpected vault value — leave env as-is rather than throwing
            }
          }),
        }));
      },

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
      // Don't persist runtime status or discovered tools — reconnect on startup.
      // env is excluded too (credential-isolation fix) — it lives in the
      // credential vault instead and is rehydrated by loadServerEnvs() at
      // startup (see App.tsx), same pattern as store/providers.ts's apiKey.
      partialize: (s) => ({
        servers: s.servers.map((sv) => ({
          ...sv,
          status: "disconnected" as const,
          tools: [],
          errorMessage: undefined,
          env: sv.env && Object.keys(sv.env).length > 0 ? {} : sv.env,
        })),
      }),
    }
  )
);
