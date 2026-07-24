import type { ToolDef } from "./tools";
import { TOOL_DEFINITIONS, getToolDefinitions } from "./tools";
import { APP_VIEWS, VIEW_DESCRIPTIONS } from "../types/app";
import { MCP_PRESETS } from "./mcpPresets";
import { useMcpStore } from "../store/mcp";
import { useAgentStore } from "../store/agent";
import { loadDynamicTools, toOllamaTool } from "./dynamicTools";

/** Stable render order for the tool-group section — mirrors ToolDef["group"]. */
const GROUP_ORDER: NonNullable<ToolDef["group"]>[] = ["files", "shell", "git", "web", "media", "state", "app", "ui"];

/**
 * Renders the tab list from VIEW_DESCRIPTIONS in APP_VIEWS order, e.g.
 * "- chat: conversational chat, optional agent tools".
 */
function renderTabList(): string {
  return APP_VIEWS.map((v) => `- ${v}: ${VIEW_DESCRIPTIONS[v]}`).join("\n");
}

/**
 * Groups sessionTools by their ToolDef.group metadata and renders one line
 * per group, e.g. "- files: read_file, write_file, ...". Tools with no group
 * (or an MCP-style "serverId__toolName" name) are bucketed into a trailing
 * "integrations (MCP)" line.
 */
function renderToolGroups(sessionTools: ToolDef[]): string {
  const byGroup = new Map<string, string[]>();
  const other: string[] = [];

  for (const t of sessionTools) {
    if (t.name.includes("__") || !t.group || !GROUP_ORDER.includes(t.group as (typeof GROUP_ORDER)[number])) {
      other.push(t.name);
      continue;
    }
    const list = byGroup.get(t.group) ?? [];
    list.push(t.name);
    byGroup.set(t.group, list);
  }

  const lines: string[] = [];
  for (const group of GROUP_ORDER) {
    const names = byGroup.get(group);
    if (names && names.length > 0) lines.push(`- ${group}: ${names.join(", ")}`);
  }
  if (other.length > 0) lines.push(`- integrations (MCP): ${other.join(", ")}`);
  return lines.join("\n");
}

/**
 * Live snapshot of the user's MCP integrations, so the agent can accurately
 * answer "what are you connected to?" and guide setup — instead of wrongly
 * denying it has any integration capability. Reads the MCP store once when
 * the block is built (per prompt render).
 */
function renderMcpStatus(): string {
  const servers = useMcpStore.getState().servers;
  const lines: string[] = ["Integrations (MCP):"];
  if (servers.length === 0) {
    lines.push("No MCP servers are configured yet — no external integrations are active right now.");
  } else {
    for (const s of servers) {
      const state = s.enabled ? s.status : "off";
      const detail = s.status === "connected" && s.tools.length > 0
        ? ` — tools: ${s.tools.map((t) => t.name).join(", ")}`
        : "";
      lines.push(`- ${s.label}: ${state}${detail}`);
    }
  }
  const presetLabels = MCP_PRESETS.map((p) => p.label).join(", ");
  lines.push(
    `To add an integration the user opens Settings → MCP servers. Quick Setup presets (one click to add, then the user clicks Connect): ${presetLabels}. The Google presets need OAuth before they will connect. Only servers shown "connected" above expose tools you can actually call now — do not claim to use a tool from a server that is not connected.`,
  );
  return lines.join("\n");
}

/**
 * Lists which well-known OS folders (Downloads, Desktop, etc.) the user has
 * enabled in Settings > Privacy & Security, with their real paths, so the
 * model can pass those absolute paths directly to read_file/write_file/
 * list_directory/etc. without a round-trip through get_known_folder first.
 */
function renderExtraRoots(): string {
  const extraRoots = useAgentStore.getState().extraRoots;
  const entries = Object.entries(extraRoots).filter(([, path]) => !!path);
  if (entries.length === 0) {
    return "No extra folders are enabled — file tools only reach the open workspace. If the user asks about Downloads/Desktop/etc., tell them to enable it in Settings > Privacy & Security first.";
  }
  const lines = entries.map(([name, path]) => `- ${name}: ${path}`);
  return [
    "Folders enabled for file access beyond the open workspace (Settings > Privacy & Security):",
    ...lines,
    "Pass these paths directly to file tools (read_file, write_file, list_directory, find_files, grep_files, delete_file, move_file, copy_file, rename_file, create_folder).",
  ].join("\n");
}

/**
 * Composes the full "## About LocalMind" section injected into every system
 * prompt: the tab list, the tool inventory (grouped by ToolDef metadata),
 * live MCP status, and the load-bearing standing guidance paragraphs. This is
 * the single source of truth for LocalMind's generated self-description —
 * replaces the old hand-maintained APP_CAPABILITIES_BLOCK + TOOL_GROUPS +
 * buildMcpStatusBlock in agentRuntime.ts.
 */
export function buildCapabilityBlock(sessionTools: ToolDef[], verbose = true): string {
  if (!verbose) {
    // Lean build-mode variant: ONLY the callable tools + a one-line MCP note.
    // The full tab tour + guidance paragraphs (below) bloat the system prompt
    // enough to degrade tool-calling on small models, and make them describe
    // the UI ("go to the Settings tab") instead of acting. Build sessions need
    // to know their tools and act — not tour the app.
    const lean: string[] = ["## Your tools (call these to act)", renderToolGroups(sessionTools)];
    const extraRoots = useAgentStore.getState().extraRoots;
    if (Object.keys(extraRoots).length > 0) {
      lean.push("", renderExtraRoots());
    }
    const connected = useMcpStore.getState().servers.filter((s) => s.enabled && s.status === "connected");
    if (connected.length > 0) {
      lean.push("", `Connected integrations: ${connected.map((s) => s.label).join(", ")} (their tools appear above under "integrations (MCP)").`);
    }
    return lean.join("\n");
  }
  const lines: string[] = [
    "## About LocalMind",
    "LocalMind is a desktop app (Tauri + React) wrapping local Ollama models in a coding-agent UI with multiple tabs:",
    renderTabList(),
    "",
    "Tools available this session:",
    renderToolGroups(sessionTools),
    "",
    renderExtraRoots(),
    "",
    renderMcpStatus(),
    "",
    "The sidebar's workspace switcher remembers recently-opened project folders — the user can switch between projects without losing this global memory, which is searched and injected into context every turn regardless of which project is open.",
    "",
    "The agent can transcribe a video/audio file in the workspace OR an online video (YouTube etc. — by URL) with the transcribe_video tool (captions when available, else offline ffmpeg + whisper), then use the transcript to answer, write a document, or mine reusable skills to save with save_skill. Skills in .localmind/skills/ may also be added by an external \"phone agent\" (a Telegram bot companion that researches topics from videos sent to it) — treat those the same as manually-saved skills.",
    "",
    "LocalMind runs locally by default but is extensible via MCP (Model Context Protocol). The user can add external MCP servers under Settings → MCP servers (either a stdio command or an SSE URL); once a server connects, its tools become available to the agent in agent mode. This is the supported way to integrate outside services: to connect Gmail, Google Calendar, GitHub, etc., the user adds an MCP server that exposes those tools — there is no built-in Google/account login, and you cannot do it for them, but you SHOULD explain this MCP path when asked. Do not claim LocalMind \"cannot\" integrate with such services — it can, through MCP.",
    "",
    "LocalMind is single-user with no built-in real-time collaboration, account sync, or plugin/extension marketplace. If asked what LocalMind can do, answer using the tabs and tools listed above plus whatever MCP tools are currently connected — do not invent built-in tabs or features that aren't listed.",
  ];
  return lines.join("\n");
}

export interface AssembleSessionToolsOptions {
  /** Workspace directory handle — dynamic tools (.localmind/tools/*.json) are
   * skipped entirely when null (no open workspace). */
  dirHandle: FileSystemDirectoryHandle | null;
  /** Per-tool enable/disable map from useAgentStore. Only consulted when
   * `essentialOnly` is not given — ignored otherwise. */
  toolsEnabled?: Record<string, boolean>;
  /** MCP tools from useMcpStore.getEnabledTools(). Always included verbatim
   * (never filtered by toolsEnabled — matches existing App.tsx behavior). */
  mcpTools?: ToolDef[];
  /** If given, restricts the static TOOL_DEFINITIONS set to exactly these
   * names (CodeEditor's coding-tools allowlist) instead of filtering by
   * toolsEnabled. mcpTools is ignored in this mode, matching CodeEditor's
   * current behavior of not offering MCP tools. */
  essentialOnly?: Set<string>;
}

/**
 * Composes the full tool list for an agent session: enabled static
 * TOOL_DEFINITIONS (or an explicit allowlist), plus MCP tools, plus dynamic
 * tools loaded from .localmind/tools/. Single source of truth for "what
 * tools does this session get" — used by both the chat tab (App.tsx) and the
 * Code tab (CodeEditor.tsx) so the two surfaces stay in sync instead of
 * assembling their tool lists independently.
 *
 * Dynamic tools are converted via dynamicTools.toOllamaTool, which stamps
 * them with explicit external-tool gating metadata (group:"external",
 * risk:"execute", planModeAllowed:false, requiresApproval:true) — they are
 * agent/user-authored shell templates with no built-in safety review, so
 * they always require approval and are always denied in Plan mode.
 */
export async function assembleSessionTools(
  opts: AssembleSessionToolsOptions,
): Promise<ToolDef[]> {
  const { dirHandle, toolsEnabled, mcpTools = [], essentialOnly } = opts;

  const staticTools: ToolDef[] = essentialOnly
    ? TOOL_DEFINITIONS.filter((t) => essentialOnly.has(t.name))
    : getToolDefinitions(mcpTools).filter(
        (t) => t.name.includes("__") || (toolsEnabled?.[t.name] ?? false),
      );

  let dynamicTools: ToolDef[] = [];
  if (dirHandle) {
    try {
      const defs = await loadDynamicTools(dirHandle);
      dynamicTools = defs.map(toOllamaTool);
    } catch {
      // no .localmind/tools directory yet, or unreadable — treat as none
    }
  }

  return [...staticTools, ...dynamicTools];
}
