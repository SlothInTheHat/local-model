import type { ChatMessage } from "./ollama";
import type { ToolDef, ToolCall, ToolResult } from "./tools";
import { executeTool, normalizeSubPath } from "./tools";
import { runAgentTurnForModel, streamChatForModel } from "./chatProvider";
import { resolveNumCtx } from "./contextSize";
import { fileExists, listDirectory } from "./fileSystem";
import type { FileEntry } from "./fileSystem";
import type { HardwareInfo } from "./hardware";
import { formatMemoryForContext, readProjectMemory } from "./projectMemory";
import { formatToolLabel, summariseToolResult } from "./toolFormatting";
import { StuckDetector, errorRecoveryHint, toolResultFailed } from "./stuckDetector";

export const DEFAULT_MAX_ROUNDS = 50;

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

/** Tools denied while in Plan (read-only) mode. */
export const PLAN_MODE_DENIED = new Set([
  "write_file", "patch_file", "apply_patch", "delete_file",
  "run_command", "git_add", "git_commit", "install_deps",
]);

/** Tools that mutate the workspace or run commands — require approval unless auto-approve is on. */
export const APPROVAL_REQUIRED = new Set([
  "write_file", "patch_file", "apply_patch", "delete_file",
  "run_command", "git_add", "git_commit",
]);

export interface OpenFileInfo {
  path: string;
  content: string;
  language: string;
}

export interface AgentRuntimeConfig {
  modelRef: string;
  hardware: HardwareInfo | null;
  numCtxOverride: number | null;

  dirHandle: FileSystemDirectoryHandle | null;
  workspacePath: string | null;
  workspaceName: string | null;

  tools: ToolDef[];
  agentBuildMode: boolean;
  autoApproveAll: boolean;
  toolsSupported: boolean;
  maxRounds: number;

  getCurrentOpenFile?: () => OpenFileInfo | null;

  onTextDelta: (chunk: string) => void;
  onTextReplace: (cleanText: string) => void;
  onToolCallStart: (call: ToolCall, label: string) => void;
  onApprovalNeeded: (call: ToolCall) => Promise<boolean>;
  onToolCallResolved: (call: ToolCall, label: string, result: ToolResult, summary: string, toolContent: string) => void;
  onRoundStart: (round: number, maxRounds: number) => void;
  onTodosChanged?: (todos: TodoItem[]) => void;
  onMemoryChanged?: (memory: string) => void;
  onActivity?: (label: string | null) => void;

  signal: AbortSignal;
}

export interface AgentRuntimeResult {
  hadSideEffects: boolean;
  hitRoundLimit: boolean;
  wasAborted: boolean;
  roundsUsed: number;
  finalHistory: ChatMessage[];
}

const TOOL_GROUPS: Array<[string, string[]]> = [
  ["files", ["read_file", "write_file", "patch_file", "apply_patch", "delete_file", "list_directory", "grep_files", "find_files", "create_folder"]],
  ["shell", ["run_command", "install_deps"]],
  ["git", ["git_status", "git_diff", "git_log", "git_add", "git_commit"]],
  ["web", ["web_search", "web_fetch"]],
  ["state", ["todo_write", "update_project_memory", "list_skills", "save_skill", "get_system_info"]],
];

function buildSystemPrompt(config: AgentRuntimeConfig): string {
  const modeTag = config.agentBuildMode ? "BUILD" : "PLAN";
  const lines: string[] = [];

  let runtimeLine = `Runtime: model=${config.modelRef}`;
  if (config.hardware) {
    runtimeLine += `, GPU=${config.hardware.gpuName} (${config.hardware.vramGb}GB VRAM), RAM=${config.hardware.ramGb}GB`;
  }
  runtimeLine += config.workspaceName
    ? `, workspace=${config.workspaceName}${config.workspacePath ? ` (${config.workspacePath})` : ""}`
    : ", workspace=none";

  lines.push(
    `You are a coding agent operating in ${modeTag} MODE.`,
    config.agentBuildMode
      ? "BUILD MODE: full access — read, write, patch, run commands, manage todos."
      : "PLAN MODE (read-only): you may read files, search, and call todo_write. write_file/patch_file/apply_patch/delete_file/run_command/install_deps/git_add/git_commit are denied — explore and plan; the user will switch to Build mode to execute.",
    "",
    runtimeLine,
    "",
    "## Core loop — every round",
    "1. ORIENT: read the 'Current state' block below (todos, file tree, last action, open file). Don't re-list a directory you've already seen — read the files inside it instead.",
    "2. PLAN: if you don't have a todo list yet, call todo_write ONCE with the full plan. Never call todo_write twice in a row.",
    "3. ACT: make exactly ONE tool call that advances the in_progress (or first pending) todo — a real action (read/write/patch/run/search), not another planning call.",
    "4. VERIFY: read the FULL result of that call before deciding what to do next. Exit code 0 and no errors means success.",
    "5. UPDATE: when a todo is finished, call todo_write to mark it complete, then immediately continue with the next todo — don't stop to announce it.",
    "6. ON ERROR: read the [RECOVERY HINT] attached to the failed result and follow it. Never repeat the exact same failing call — it will be blocked.",
    "",
    "## Core rules",
    "- Before touching a project, read its key files (package.json/README/entry point) to understand what already exists.",
    "- The system blocks write_file/patch_file/apply_patch on existing files you haven't read yet — call read_file first.",
    "- patch_file (or apply_patch) for edits to existing files. write_file is for brand-new files only.",
    "- run_command: pass cwd= for subdirectories, never 'cd dir && cmd'. Never start dev servers or other long-running/blocking processes (npm start, npm run dev, flask run, etc.) — use build/typecheck/test commands to verify instead.",
    "- 'up to date' / 'already satisfied' / 'already installed' in install output means the dependency is present — do not re-run the install, move on.",
    "- web_search is capped at 4 calls this session — after 1-2 searches, commit to an approach.",
    "- Never simulate actions in text (writing out 'Todos: ... (completed)', pasting code instead of writing it, describing a command instead of running it). Every action is a real tool call. A response with no tool call ends the task.",
  );

  if (config.toolsSupported) {
    const toolNames = new Set(config.tools.map((t) => t.name));
    lines.push("", "## Available tools");
    const known = new Set<string>();
    for (const [group, names] of TOOL_GROUPS) {
      const present = names.filter((n) => toolNames.has(n));
      present.forEach((n) => known.add(n));
      if (present.length) lines.push(`- ${group}: ${present.join(", ")}`);
    }
    const other = [...toolNames].filter((n) => !known.has(n));
    if (other.length) lines.push(`- other: ${other.join(", ")}`);
  } else {
    lines.push(
      "",
      "NOTE: this model does not support tool calls. Respond with the changed code only (kept short); the user applies it via the 'Apply to file' button."
    );
  }

  return lines.join("\n");
}

function formatTree(entries: FileEntry[], prefix: string): string {
  return entries
    .map((e) => {
      const line = prefix + (e.kind === "directory" ? "📁 " : "📄 ") + e.name;
      if (e.kind === "directory" && e.children && e.children.length > 0) {
        return line + "\n" + formatTree(e.children, prefix + "  ");
      }
      return line;
    })
    .join("\n");
}

async function readTodosFromDisk(dirHandle: FileSystemDirectoryHandle): Promise<TodoItem[]> {
  try {
    const lm = await dirHandle.getDirectoryHandle(".localmind", { create: false });
    const fh = await lm.getFileHandle("todos.json", { create: false });
    const file = await fh.getFile();
    const parsed = JSON.parse(await file.text());
    return Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
  } catch {
    return [];
  }
}

interface RuntimeState {
  lastActionSummary: string | null;
  cachedTree: string | null;
  treeDirty: boolean;
  cachedMemory: string;
  memoryDirty: boolean;
}

async function buildCurrentStateBlock(
  config: AgentRuntimeConfig,
  state: RuntimeState,
  round: number,
): Promise<string> {
  const lines: string[] = ["## Current state", `Round ${round}/${config.maxRounds}`];

  if (state.lastActionSummary) {
    lines.push(`Last action: ${state.lastActionSummary}`);
  }

  if (config.dirHandle) {
    const todos = await readTodosFromDisk(config.dirHandle);
    config.onTodosChanged?.(todos);
    if (todos.length > 0) {
      const todoLines = todos.map((t) => {
        const mark = t.status === "completed" ? "[x]" : t.status === "cancelled" ? "[-]" : t.status === "in_progress" ? "[>]" : "[ ]";
        return `${mark} ${t.content}`;
      });
      lines.push("", "Todo list:", ...todoLines);
    }

    if (state.treeDirty || state.cachedTree === null) {
      try {
        const entries = await listDirectory(config.dirHandle, 3);
        state.cachedTree = formatTree(entries, "");
      } catch {
        state.cachedTree = "(could not read workspace)";
      }
      state.treeDirty = false;
    }
    if (state.cachedTree) {
      const treeLines = state.cachedTree.split("\n");
      const capped = treeLines.slice(0, 60);
      lines.push("", "File tree:", capped.join("\n"));
      if (treeLines.length > 60) lines.push("…");
    }

    if (state.memoryDirty) {
      try {
        state.cachedMemory = await readProjectMemory(config.dirHandle);
      } catch {
        state.cachedMemory = "";
      }
      state.memoryDirty = false;
      config.onMemoryChanged?.(state.cachedMemory);
    }
    if (state.cachedMemory) {
      const truncated = state.cachedMemory.length > 400
        ? state.cachedMemory.slice(0, 400) + "\n…"
        : state.cachedMemory;
      lines.push("", formatMemoryForContext(truncated));
    }
  }

  const openFile = config.getCurrentOpenFile?.();
  if (openFile && openFile.path && openFile.content) {
    const fileLines = openFile.content.split("\n");
    const snippet = fileLines.slice(0, 80).join("\n");
    lines.push(
      "",
      `Open: ${openFile.path}`,
      "```" + openFile.language,
      snippet + (fileLines.length > 80 ? "\n…(truncated)" : ""),
      "```",
    );
  }

  return lines.join("\n");
}

interface GuardedExecution {
  result: ToolResult;
  toolContent: string;
  blocked: boolean;
  sideEffect: boolean;
}

function pathsFromCall(call: ToolCall): string[] {
  if (call.name === "apply_patch") {
    const patches = call.args["patches"];
    if (Array.isArray(patches)) {
      return patches
        .map((p) => (p as Record<string, unknown>)["path"])
        .filter((p): p is string => typeof p === "string" && p.length > 0);
    }
    return [];
  }
  const path = call.args["path"];
  return typeof path === "string" && path.length > 0 ? [path] : [];
}

const SIDE_EFFECT_TOOLS = new Set([
  "write_file", "patch_file", "apply_patch", "delete_file", "create_folder", "run_command", "install_deps",
]);

async function executeToolGuarded(
  call: ToolCall,
  config: AgentRuntimeConfig,
  detector: StuckDetector,
  sessionReadPaths: Set<string>,
): Promise<GuardedExecution> {
  // 1. Plan-mode denial
  if (!config.agentBuildMode && PLAN_MODE_DENIED.has(call.name)) {
    return {
      result: { toolCallId: call.id, name: call.name, output: "", error: "Denied (Plan mode)" },
      toolContent: "DENIED: You are in Plan mode (read-only). You may read files, search, and call todo_write. The user must switch to Build mode before write/patch/run/install/git-write tools can run.",
      blocked: true,
      sideEffect: false,
    };
  }

  // 2. Approval gate
  if (APPROVAL_REQUIRED.has(call.name) && !config.autoApproveAll) {
    const approved = await config.onApprovalNeeded(call);
    if (!approved) {
      return {
        result: { toolCallId: call.id, name: call.name, output: "", error: "Denied by user" },
        toolContent: "Tool call denied by user.",
        blocked: true,
        sideEffect: false,
      };
    }
  }

  // 3. Stuck-detector pre-check
  const blockMsg = detector.checkBeforeExecute(call);
  if (blockMsg) {
    return {
      result: { toolCallId: call.id, name: call.name, output: "", error: "Blocked (loop guard)" },
      toolContent: blockMsg,
      blocked: true,
      sideEffect: false,
    };
  }

  // 4. Hard read-before-write gate
  if (config.dirHandle && (call.name === "write_file" || call.name === "patch_file" || call.name === "apply_patch")) {
    const unread: string[] = [];
    for (const p of pathsFromCall(call)) {
      const norm = normalizeSubPath(p);
      if (sessionReadPaths.has(norm)) continue;
      if (call.name === "write_file") {
        if (await fileExists(config.dirHandle, norm)) unread.push(p);
      } else {
        unread.push(p);
      }
    }
    if (unread.length > 0) {
      const list = unread.map((p) => `"${p}"`).join(", ");
      return {
        result: { toolCallId: call.id, name: call.name, output: "", error: "Blocked (read-before-write)" },
        toolContent: `BLOCKED: ${list} must be read with read_file before you can ${call.name === "write_file" ? "overwrite" : "patch"} ${unread.length > 1 ? "them" : "it"}. Call read_file now, then retry ${call.name}.`,
        blocked: true,
        sideEffect: false,
      };
    }
  }

  // 5. Execute
  const result = await executeTool(call, config.dirHandle, config.workspacePath ?? undefined);

  // 6. Update session read/write tracking
  if (!result.error) {
    if (call.name === "read_file") {
      const p = call.args["path"];
      if (typeof p === "string" && p) sessionReadPaths.add(normalizeSubPath(p));
    }
    if (call.name === "write_file" || call.name === "patch_file" || call.name === "apply_patch") {
      for (const p of pathsFromCall(call)) sessionReadPaths.add(normalizeSubPath(p));
    }
  }

  // 7. Record result + notes
  const notes = detector.recordResult(call, result);

  // 8. Error-recovery hint
  if (toolResultFailed(result)) {
    const hint = errorRecoveryHint(`${result.output}\n${result.error ?? ""}`);
    if (hint) notes.push(hint);
  }

  // 9. Build the content the model will see
  const isShellTool = call.name === "run_command" || call.name.startsWith("git_");
  let toolContent: string;
  if (isShellTool) {
    toolContent = result.output + (result.error ? `\n[${result.error}]` : "");
  } else {
    toolContent = result.error ? `Error: ${result.error}` : result.output;
  }
  if (notes.length > 0) toolContent += `\n\n${notes.join("\n\n")}`;

  const sideEffect = !result.error && SIDE_EFFECT_TOOLS.has(call.name);

  return { result, toolContent, blocked: false, sideEffect };
}

export async function runAgentSession(
  priorHistory: ChatMessage[],
  config: AgentRuntimeConfig,
): Promise<AgentRuntimeResult> {
  const numCtx = resolveNumCtx(config.hardware, config.numCtxOverride);
  const systemPrompt = buildSystemPrompt(config);
  const detector = new StuckDetector();
  const sessionReadPaths = new Set<string>();
  const state: RuntimeState = {
    lastActionSummary: null,
    cachedTree: null,
    treeDirty: true,
    cachedMemory: "",
    memoryDirty: true,
  };

  let history: ChatMessage[] = [...priorHistory];
  let hadSideEffects = false;
  let hitRoundLimit = false;
  let wasAborted = false;
  let round = 0;
  let lastRoundHadToolCalls = false;

  const toolsForModel = config.toolsSupported ? config.tools : [];

  try {
    if (!config.toolsSupported) {
      round = 1;
      config.onRoundStart(round, config.maxRounds);
      for await (const chunk of streamChatForModel(
        config.modelRef,
        [{ role: "system", content: systemPrompt }, ...history],
        config.signal,
      )) {
        config.onTextDelta(chunk);
      }
      return { hadSideEffects, hitRoundLimit, wasAborted, roundsUsed: round, finalHistory: history };
    }

    while (round < config.maxRounds) {
      round++;
      config.onRoundStart(round, config.maxRounds);

      const stateBlock = await buildCurrentStateBlock(config, state, round);
      const messagesForRound: ChatMessage[] = [
        { role: "system", content: `${systemPrompt}\n\n${stateBlock}` },
        ...history,
      ];

      lastRoundHadToolCalls = false;

      for await (const event of runAgentTurnForModel(config.modelRef, messagesForRound, toolsForModel, config.signal, { numCtx })) {
        if (config.signal.aborted) throw new DOMException("Aborted", "AbortError");

        if (event.type === "text_delta" && event.content) {
          if (event.content.startsWith("\x00CLEAN:")) {
            config.onTextReplace(event.content.slice("\x00CLEAN:".length));
          } else {
            const cleaned = event.content.replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/g, "");
            if (cleaned) config.onTextDelta(cleaned);
          }
        } else if (event.type === "tool_calls" && event.toolCalls) {
          lastRoundHadToolCalls = true;

          for (const call of event.toolCalls) {
            if (config.signal.aborted) throw new DOMException("Aborted", "AbortError");

            const label = formatToolLabel(call.name, call.args);
            config.onToolCallStart(call, label);
            config.onActivity?.(label);

            const { result, toolContent, blocked, sideEffect } = await executeToolGuarded(call, config, detector, sessionReadPaths);

            config.onActivity?.(null);

            if (sideEffect) {
              hadSideEffects = true;
              state.treeDirty = true;
              if (call.name === "install_deps") state.memoryDirty = true;
            }
            if (!blocked && call.name === "update_project_memory" && !result.error) {
              state.memoryDirty = true;
            }

            const summary = blocked
              ? `${label} → ${result.error}`
              : result.error ? `${label} → error` : summariseToolResult(call.name, call.args, result.output);

            state.lastActionSummary = summary;

            config.onToolCallResolved(call, label, result, summary, toolContent);

            history = [
              ...history,
              { role: "assistant", content: "", tool_calls: [{ function: { name: call.name, arguments: call.args } }] },
              { role: "tool", content: toolContent },
            ];
          }
        } else if (event.type === "error") {
          config.onTextDelta(`\n\n*[Agent error: ${event.error}]*`);
        }
      }

      if (!lastRoundHadToolCalls) break;
    }

    if (round >= config.maxRounds && lastRoundHadToolCalls) {
      hitRoundLimit = true;
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      wasAborted = true;
    } else {
      throw err;
    }
  }

  return { hadSideEffects, hitRoundLimit, wasAborted, roundsUsed: round, finalHistory: history };
}
