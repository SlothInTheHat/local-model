import { useState } from "react";
import { Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Circle, ChevronDown, ChevronRight, Mail, HardDrive, Calendar, Globe, Check, GraduationCap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { useMcpStore, type McpServer } from "../store/mcp";
import { connectMcpServer, mcpStopServer } from "../lib/mcp";
import { MCP_PRESETS } from "../lib/mcpPresets";

interface QuickTemplate {
  id: string;
  label: string;
  Icon: LucideIcon;
  command: string;
  args: string;
  description: string;
  /** Env vars the server needs; KEY → placeholder value shown pre-filled in the form. */
  env?: Record<string, string>;
  /**
   * Needs per-user credentials. Clicking the card opens the manual Add form
   * pre-filled (so the user can supply the credential path / review the auth
   * step) instead of silently creating a server that will fail to connect.
   */
  setup?: boolean;
}

// Icon is a UI-only concern, kept local to this component. Data (id/label/
// command/args/description/env/setup) lives in lib/mcpPresets.ts — the
// single source of truth also used by capabilityRegistry.ts for prompts.
const PRESET_ICONS: Record<string, LucideIcon> = {
  gmail: Mail,
  gdrive: HardDrive,
  gcal: Calendar,
  canvas: GraduationCap,
  browser: Globe,
};

const QUICK_TEMPLATES: QuickTemplate[] = MCP_PRESETS.map((p) => ({
  ...p,
  Icon: PRESET_ICONS[p.id] ?? Globe,
}));

const STATUS_ICON: Record<McpServer["status"], React.ReactNode> = {
  disconnected: <Circle className="size-3 text-muted-foreground" />,
  connecting: <RefreshCw className="size-3 text-amber-500 animate-spin" />,
  connected: <CheckCircle2 className="size-3 text-green-500" />,
  error: <XCircle className="size-3 text-destructive" />,
};

export function McpSettings() {
  const { servers, addServer, removeServer, updateServer, setStatus, setTools } = useMcpStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [form, setForm] = useState({
    label: "",
    transport: "stdio" as "stdio" | "sse",
    command: "",
    args: "",
    env: "",
    url: "",
  });

  async function connect(server: McpServer) {
    // Shared with mcpAutoConnect.ts so the manual Connect button and the
    // on-launch auto-reconnect can never drift out of sync (status updates,
    // error-message handling, tool discovery all live in one place).
    await connectMcpServer(server);
  }

  async function disconnect(server: McpServer) {
    await mcpStopServer(server).catch(() => {});
    setStatus(server.id, "disconnected");
    setTools(server.id, []);
  }

  function handleAdd() {
    if (!form.label.trim()) return;

    const envRecord: Record<string, string> = {};
    form.env.split("\n").forEach((line) => {
      const [k, ...rest] = line.split("=");
      if (k?.trim()) envRecord[k.trim()] = rest.join("=").trim();
    });

    addServer({
      id: crypto.randomUUID(),
      label: form.label.trim(),
      transport: form.transport,
      command: form.transport === "stdio" ? form.command.trim() : undefined,
      args: form.transport === "stdio" ? form.args.split(" ").filter(Boolean) : undefined,
      env: form.transport === "stdio" ? envRecord : undefined,
      url: form.transport === "sse" ? form.url.trim() : undefined,
      enabled: true,
    });
    setForm({ label: "", transport: "stdio", command: "", args: "", env: "", url: "" });
    setAdding(false);
  }

  return (
    <div className="space-y-3">
      {/* Quick Setup cards */}
      <div>
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Quick Setup</span>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          {QUICK_TEMPLATES.map((t) => {
            const alreadyAdded = servers.some((s) => s.id === t.id);
            return (
              <button
                key={t.id}
                disabled={alreadyAdded}
                onClick={() => {
                  if (alreadyAdded) return;
                  // Credential-needing presets: open the manual form pre-filled
                  // so the user can fill in their env/credential path. Others
                  // (no auth) add in one click as before.
                  if (t.setup) {
                    setForm({
                      label: t.label,
                      transport: "stdio",
                      command: t.command,
                      args: t.args,
                      env: Object.entries(t.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
                      url: "",
                    });
                    setAdding(true);
                    return;
                  }
                  addServer({
                    id: t.id,
                    label: t.label,
                    transport: "stdio",
                    command: t.command,
                    args: t.args.split(" ").filter(Boolean),
                    env: {},
                    url: undefined,
                    enabled: true,
                  });
                }}
                className={`flex flex-col items-start p-2 rounded-md border text-left transition-colors ${
                  alreadyAdded
                    ? "border-green-200 bg-green-50 text-green-700 cursor-default"
                    : "border-border bg-background hover:bg-accent hover:border-primary/30 cursor-pointer"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  {alreadyAdded
                    ? <Check className="size-3 text-green-600 shrink-0" />
                    : <t.Icon className="size-3 text-muted-foreground shrink-0" />}
                  <span className="text-[11px] font-medium leading-none">{t.label}</span>
                </div>
                <span className="text-[9px] text-muted-foreground leading-tight">{t.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">MCP Servers</span>
        <Button size="sm" variant="ghost" className="h-6 text-xs gap-1" onClick={() => setAdding((v) => !v)}>
          <Plus className="size-3" /> Add
        </Button>
      </div>

      {adding && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <input
              placeholder="Label (e.g. Filesystem)"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              className="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex gap-1">
              {(["stdio", "sse"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setForm((f) => ({ ...f, transport: t }))}
                  className={`flex-1 text-xs py-1 rounded border transition-colors ${
                    form.transport === t
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover:text-foreground"
                  }`}
                >
                  {t === "stdio" ? "Local (stdio)" : "Remote (SSE)"}
                </button>
              ))}
            </div>

            {form.transport === "stdio" ? (
              <>
                <input
                  placeholder="Command (e.g. npx mcp-server-filesystem)"
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  className="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
                <input
                  placeholder="Args (space-separated)"
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  className="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
                <textarea
                  placeholder={"Env vars (KEY=VALUE, one per line)"}
                  value={form.env}
                  onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                  rows={2}
                  className="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring resize-none"
                />
              </>
            ) : (
              <input
                placeholder="SSE URL (e.g. http://localhost:8080/sse)"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                className="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            )}

            <div className="flex gap-1">
              <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleAdd}>Add Server</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {servers.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground px-1">No MCP servers configured.</p>
      )}

      {servers.map((server) => (
        <Card key={server.id}>
          <CardContent className="p-2.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              {STATUS_ICON[server.status]}
              <button
                className="flex-1 text-left text-xs font-medium text-foreground flex items-center gap-1"
                onClick={() => setExpanded((v) => (v === server.id ? null : server.id))}
              >
                {server.label}
                {expanded === server.id ? <ChevronDown className="size-3 ml-auto" /> : <ChevronRight className="size-3 ml-auto" />}
              </button>
              <button
                onClick={() => updateServer(server.id, { enabled: !server.enabled })}
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium transition-colors ${
                  server.enabled
                    ? "bg-green-100 text-green-700"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {server.enabled ? "on" : "off"}
              </button>
            </div>

            {server.errorMessage && server.status === "error" && (
              <p className="text-[10px] text-destructive break-all whitespace-pre-wrap leading-tight">{server.errorMessage}</p>
            )}

            {expanded === server.id && (
              <div className="space-y-1.5 pt-1 border-t border-border">
                <p className="text-[10px] text-muted-foreground">
                  {server.transport === "stdio" ? server.command : server.url}
                </p>
                {server.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {server.tools.map((t) => (
                      <span key={t.name} className="text-[10px] px-1.5 py-0.5 bg-muted rounded-full text-muted-foreground">
                        {t.name.split("__")[1] ?? t.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-1">
                  {server.status !== "connected" ? (
                    <Button
                      size="sm"
                      className="h-6 text-xs flex-1"
                      disabled={server.status === "connecting"}
                      onClick={() => void connect(server)}
                    >
                      {server.status === "connecting" ? "Connecting…" : "Connect"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs flex-1"
                      onClick={() => void disconnect(server)}
                    >
                      Disconnect
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs text-destructive hover:text-destructive"
                    onClick={() => { void disconnect(server); removeServer(server.id); }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
