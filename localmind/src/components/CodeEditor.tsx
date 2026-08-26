import React, { Suspense, useRef, useState, useEffect } from "react";
import { Save, ChevronRight, Send, Play, Square, ChevronDown, ChevronUp, X, Zap, ListTodo, Brain, Pencil, Sun, Moon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { FileTree } from "./FileTree";
import { openWorkspace, readFileFromHandle, writeFileToHandle } from "../lib/fileSystem";
import { injectGitCredentials, sanitizeOutput } from "../store/profile";
import { streamChatForModel } from "../lib/chatProvider";
import type { ChatMessage } from "../lib/ollama";
import { supportsNativeTools } from "../lib/modelCapabilities";
import { useAgentStore } from "../store/agent";
import { useModelStore } from "../store/models";
import { useSettingsStore } from "../store/settings";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { registerLocalMindMonacoThemes } from "../lib/monacoThemes";
import { registerLatexLanguage } from "../lib/monacoLatex";
import { ToolIcon } from "./ToolCallCard";
import { CheckpointBrowser } from "./CheckpointBrowser";
import { inlineHtmlResources } from "../lib/htmlPreview";
import { loadSkills, saveSkill } from "../lib/skillEngine";
import type { Skill } from "../lib/skillEngine";
import { readProjectMemory, writeProjectMemory } from "../lib/projectMemory";
import { loadDynamicTools } from "../lib/dynamicTools";
import type { DynamicToolDef } from "../lib/dynamicTools";
import { assembleSessionTools } from "../lib/capabilityRegistry";
import {
  startSession, endSession, logRound, logToolCall, logToolResult, logAgentText,
} from "../lib/agentLogger";
import { runAgentSession, DEFAULT_MAX_ROUNDS } from "../lib/agentRuntime";
import type { TodoItem } from "../lib/agentRuntime";

const MonacoEditor = React.lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default }))
);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact",
  js: "javascript", jsx: "javascriptreact",
  py: "python", rs: "rust", go: "go",
  json: "json", md: "markdown", css: "css",
  html: "html", sh: "shell", yaml: "yaml",
  yml: "yaml", toml: "toml", sql: "sql",
  cpp: "cpp", c: "c", java: "java",
  rb: "ruby", php: "php", cs: "csharp",
  kt: "kotlin", swift: "swift", dart: "dart",
  lua: "lua", r: "r", scala: "scala",
  xml: "xml", bat: "bat", ps1: "powershell",
  tex: "latex",
};

const ALL_LANGUAGES = [
  "plaintext", "typescript", "typescriptreact", "javascript", "javascriptreact",
  "python", "rust", "go", "json", "markdown", "css", "scss", "less", "html",
  "shell", "yaml", "toml", "sql", "cpp", "c", "csharp", "java", "ruby",
  "php", "kotlin", "swift", "dart", "lua", "r", "scala", "xml", "bat",
  "powershell", "dockerfile", "graphql", "ini", "makefile", "perl",
  "protobuf", "terraform",
];

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}

// Sandboxed JS runner — captures console output
function runJavaScript(code: string): { output: string; error: boolean } {
  const lines: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => lines.push(args.map(toStr).join(" ")),
    error: (...args: unknown[]) => lines.push("ERROR: " + args.map(toStr).join(" ")),
    warn: (...args: unknown[]) => lines.push("WARN: " + args.map(toStr).join(" ")),
    info: (...args: unknown[]) => lines.push("INFO: " + args.map(toStr).join(" ")),
  };
  function toStr(v: unknown) {
    if (typeof v === "object") {
      try { return JSON.stringify(v, null, 2); } catch { return String(v); }
    }
    return String(v);
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("console", code);
    const ret = fn(fakeConsole);
    if (ret !== undefined) lines.push("→ " + toStr(ret));
    return { output: lines.join("\n") || "(no output)", error: false };
  } catch (err) {
    return { output: (err as Error).message, error: true };
  }
}

const isTauri = () => {
  const w = window as unknown as Record<string, unknown>;
  // __TAURI__ is set when withGlobalTauri: true (our config).
  // __TAURI_INTERNALS__ is the low-level shim always present in Tauri v2 webviews.
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
};

async function tauriRun(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  const core = (tauri as Record<string, unknown>).core as { invoke: (c: string, a: unknown) => Promise<unknown> };
  return core.invoke("run_command", { cmd, cwd }) as Promise<{ stdout: string; stderr: string; exit_code: number }>;
}

type RunMode = "browser-js" | "html-preview" | "shell" | "none";

function getRunMode(lang: string): RunMode {
  if (lang === "javascript" || lang === "javascriptreact") return "browser-js";
  if (lang === "html") return "html-preview";
  const shellLangs = new Set([
    "python", "typescript", "typescriptreact", "ruby", "go", "rust",
    "shell", "powershell", "php", "perl", "lua", "r", "java", "swift", "dart", "kotlin",
  ]);
  if (shellLangs.has(lang)) return "shell";
  return "none";
}

function shellRunCmd(lang: string, filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  const name = p.split("/").pop() ?? p;
  const dir = p.includes("/") ? `"${p.slice(0, p.lastIndexOf("/"))}"` : ".";
  switch (lang) {
    case "python": return `python "${p}"`;
    case "typescript":
    case "typescriptreact": return `npx ts-node "${p}"`;
    case "javascript":
    case "javascriptreact": return `node "${p}"`;
    case "ruby": return `ruby "${p}"`;
    case "go": return `go run "${p}"`;
    case "rust": return `rustc "${p}" -o _lm_run && ./_lm_run && rm -f _lm_run`;
    case "shell": return `bash "${p}"`;
    case "powershell": return `powershell -ExecutionPolicy Bypass -File "${p}"`;
    case "php": return `php "${p}"`;
    case "perl": return `perl "${p}"`;
    case "lua": return `lua "${p}"`;
    case "r": return `Rscript "${p}"`;
    case "java": return `javac "${p}" && java -cp ${dir} "${name.replace(/\.java$/, "")}"`;
    case "swift": return `swift "${p}"`;
    case "dart": return `dart run "${p}"`;
    case "kotlin": return `kotlinc "${p}" -include-runtime -d _lm.jar 2>&1 && java -jar _lm.jar; rm -f _lm.jar`;
    default: return `echo "No run command for ${lang}"`;
  }
}

interface AiMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolError?: boolean;
  toolResult?: string;
  toolArgs?: Record<string, unknown>; // original args — needed to reconstruct history
}

interface CodeEditorProps {
  selectedModel: string;
  isActive?: boolean; // false when hidden behind another tab — used to re-layout Monaco on restore
}

export function CodeEditor({ selectedModel, isActive = true }: CodeEditorProps) {
  const { dirHandle, workspacePath, setWorkspace } = useAgentStore();
  const { hardware, vramOverride } = useModelStore();
  const { numCtxOverride, codeEditorTheme, setCodeEditorTheme } = useSettingsStore();
  const effectiveHardware = vramOverride != null && hardware ? { ...hardware, vramGb: vramOverride } : hardware;

  // Multi-file tabs
  interface OpenTab { path: string; content: string; isDirty: boolean; }
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string>("");

  const [fileContent, setFileContent] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [language, setLanguage] = useState<string>("plaintext");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  // AI panel
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [chatPrompt, setChatPrompt] = useState<string>("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(true);
  const aiBottomRef = useRef<HTMLDivElement>(null);

  // Workspace file tree + auto-read markdown docs
  const [_workspaceDocs, setWorkspaceDocs] = useState<string>("");
  const [treeVersion, setTreeVersion] = useState(0);

  // Run output panel
  const [runOutput, setRunOutput] = useState<{ output: string; error: boolean } | null>(null);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  // HTML preview — stores a blob URL so navigation stays sandboxed
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  const [htmlPreviewPath, setHtmlPreviewPath] = useState<string>("");
  const prevPreviewUrlRef = useRef<string | null>(null);

  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logSessionRef = useRef<string | null>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const autoRestartCountRef = useRef(0);
  const MAX_AUTO_RESTARTS = 5;

  // Live activity status shown above the conversation while streaming
  const [currentActivity, setCurrentActivity] = useState<string | null>(null);

  // Plan / Build agent mode (Plan = read-only like OpenCode's Plan agent)
  const [agentBuildMode, setAgentBuildMode] = useState(true); // true = Build, false = Plan
  // Mirrors agentBuildMode/autoApproveAll for the in-flight agent session to read live
  // (see AgentRuntimeConfig's doc comment) — a plain boolean baked into the config at
  // session start stayed frozen for the whole multi-round loop, so toggling either
  // mid-response had no effect until the next message. Passing `() => ref.current`
  // instead of the raw state value fixes that.
  const agentBuildModeRef = useRef(agentBuildMode);
  useEffect(() => { agentBuildModeRef.current = agentBuildMode; }, [agentBuildMode]);
  const planModeDeniedThisSessionRef = useRef(false);

  // Todo list (mirrors .localmind/todos.json)
  const [todos, setTodos] = useState<TodoItem[]>([]);

  // Integrated terminal — shows agent + user commands; user can type their own
  interface TerminalEntry { id: string; cmd: string; output: string; error: boolean; running: boolean; durationMs?: number; source: "agent" | "user"; }
  const [terminalLog, setTerminalLog] = useState<TerminalEntry[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalRunning, setTerminalRunning] = useState(false);

  // Paths the agent has written to — used to auto-expand parent directories
  const [autoExpandPaths, setAutoExpandPaths] = useState<Set<string>>(new Set());

  // Agent UX: inline approval, round counter, auto-approve, expandable tool results
  const [pendingApproval, setPendingApproval] = useState<{ name: string; args: Record<string, unknown> } | null>(null);
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const [agentRound, setAgentRound] = useState(0);
  const [autoApproveAll, setAutoApproveAll] = useState(false);
  const autoApproveAllRef = useRef(autoApproveAll);
  useEffect(() => { autoApproveAllRef.current = autoApproveAll; }, [autoApproveAll]);
  const [expandedToolIndices, setExpandedToolIndices] = useState<Set<number>>(new Set());

  // Task queue
  const [taskQueue, setTaskQueue] = useState<string[]>([]);
  const [showQueue, setShowQueue] = useState(false);

  // Phase 3: Skills, memory, dynamic tools
  const [_skills, setSkills] = useState<Skill[]>([]);
  const [projectMemory, setProjectMemory] = useState<string>("");
  const [dynamicToolDefs, setDynamicToolDefs] = useState<DynamicToolDef[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [editingMemory, setEditingMemory] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");

  // Phase 3: Reflection
  const [reflectionOffer, setReflectionOffer] = useState(false);
  const [isSavingSkill, setIsSavingSkill] = useState(false);
  const [pendingSkill, setPendingSkill] = useState<{ name: string; tags: string[]; content: string } | null>(null);
  const [isPreviewingSkill, setIsPreviewingSkill] = useState(false);

  // Refresh workspace tree + eagerly read markdown docs when workspace changes
  useEffect(() => {
    if (!dirHandle) {
      setWorkspaceDocs("");
      setSkills([]);
      setProjectMemory("");
      setDynamicToolDefs([]);
      return;
    }

    // Load skills, project memory, dynamic tools, and todos in parallel
    loadSkills(dirHandle).then(setSkills).catch(() => {});
    readProjectMemory(dirHandle).then(setProjectMemory).catch(() => {});
    loadDynamicTools(dirHandle).then(setDynamicToolDefs).catch(() => {});
    // Load todos from .localmind/todos.json
    dirHandle.getDirectoryHandle(".localmind", { create: false })
      .then((lm) => lm.getFileHandle("todos.json", { create: false }))
      .then((fh) => fh.getFile())
      .then((f) => f.text())
      .then((t) => setTodos(JSON.parse(t) as TodoItem[]))
      .catch(() => setTodos([]));;

    // Read well-known markdown docs in priority order
    const MD_CANDIDATES = [
      "CLAUDE.md", "claude.md",
      "README.md", "readme.md", "README.mdx",
      "CONTRIBUTING.md", "contributing.md",
      "ARCHITECTURE.md", "architecture.md",
      "DEVELOPMENT.md", "development.md",
      "docs/README.md", "docs/OVERVIEW.md",
    ];

    (async () => {
      const found: string[] = [];
      for (const path of MD_CANDIDATES) {
        try {
          const text = await readFileFromHandle(dirHandle, path);
          found.push(`### ${path}\n${text.slice(0, 6000)}${text.length > 6000 ? "\n…(truncated)" : ""}`);
          if (found.length >= 3) break; // cap at 3 docs to avoid overflowing context
        } catch {
          // file doesn't exist, skip
        }
      }
      setWorkspaceDocs(found.join("\n\n"));
    })();
  }, [dirHandle, treeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Monaco doesn't know its size when hidden — force a re-layout when tab becomes active again
  useEffect(() => {
    if (isActive) {
      setTimeout(() => editorRef.current?.layout(), 50);
    }
  }, [isActive]);

  // Refresh the file tree once when the agent finishes streaming, in case
  // run_command created files that write_file didn't explicitly notify about.
  useEffect(() => {
    if (!isChatStreaming) {
      scheduleTreeRefresh();
    }
  }, [isChatStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-update the HTML preview as the user types (400 ms debounce).
  // Reads htmlPreviewUrl and language from the closure so the effect only
  // fires on content changes without needing them as deps.
  useEffect(() => {
    if (htmlPreviewUrl === null || language !== "html") return;
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      void (async () => {
        const processed = dirHandle
          ? await inlineHtmlResources(fileContent, dirHandle, currentPath, workspacePath)
          : fileContent;
        setHtmlPreviewUrl(buildPreviewBlobUrl(processed));
        setHtmlPreviewPath(currentPath);
      })();
    }, 400);
    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    };
  }, [fileContent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced tree refresh. Also records parent directory paths so the FileTree
  // can auto-expand them and show the newly created file immediately.
  function scheduleTreeRefresh(writtenPath?: string) {
    if (writtenPath) {
      const parts = writtenPath.split("/").filter(Boolean);
      const parents: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        parents.push(parts.slice(0, i).join("/"));
      }
      if (parents.length > 0) {
        setAutoExpandPaths((prev) => {
          const next = new Set(prev);
          parents.forEach((p) => next.add(p));
          return next;
        });
      }
    }
    if (treeRefreshDebounceRef.current) clearTimeout(treeRefreshDebounceRef.current);
    treeRefreshDebounceRef.current = setTimeout(() => setTreeVersion((v) => v + 1), 800);
  }

  async function handleOpenDir() {
    try {
      const ws = await openWorkspace();
      setWorkspace(ws.handle, ws.path, ws.name);
      toast.success(`Workspace opened: ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(`Could not open folder: ${e.message}`);
    }
  }

  async function handleOpenFile(_handle: FileSystemFileHandle, path: string) {
    if (!dirHandle) return;

    // Switch to already-open tab if exists
    const existing = openTabs.find((t) => t.path === path);
    if (existing) {
      setActiveTabPath(path);
      setFileContent(existing.content);
      setCurrentPath(path);
      setLanguage(detectLanguage(path));
      return;
    }

    try {
      const text = await readFileFromHandle(dirHandle, path);
      setOpenTabs((prev) => [...prev, { path, content: text, isDirty: false }]);
      setActiveTabPath(path);
      setFileContent(text);
      setCurrentPath(path);
      setLanguage(detectLanguage(path));
      setRunOutput(null);
      toast.success(`Opened ${path.split("/").pop()}`);
    } catch (err) {
      toast.error(`Could not open file: ${(err as Error).message}`);
    }
  }

  function handleSwitchTab(path: string) {
    const tab = openTabs.find((t) => t.path === path);
    if (!tab) return;
    // Persist current content back into tabs before switching
    setOpenTabs((prev) => prev.map((t) => t.path === activeTabPath ? { ...t, content: fileContent } : t));
    setActiveTabPath(path);
    setFileContent(tab.content);
    setCurrentPath(path);
    setLanguage(detectLanguage(path));
    setRunOutput(null);
  }

  function handleCloseTab(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    const tab = openTabs.find((t) => t.path === path);
    if (tab?.isDirty && !window.confirm(`${path.split("/").pop()} has unsaved changes. Close anyway?`)) return;
    const newTabs = openTabs.filter((t) => t.path !== path);
    setOpenTabs(newTabs);
    if (activeTabPath === path) {
      const last = newTabs[newTabs.length - 1];
      if (last) {
        setActiveTabPath(last.path);
        setFileContent(last.content);
        setCurrentPath(last.path);
        setLanguage(detectLanguage(last.path));
      } else {
        setActiveTabPath("");
        setFileContent("");
        setCurrentPath("");
        setLanguage("plaintext");
      }
    }
  }

  // Inject a script into HTML that turns local navigation into postMessage events,
  // then create a blob URL so the iframe origin is null (can't bleed into the app).
  function buildPreviewBlobUrl(html: string): string {
    const interceptor = `<script>
(function(){
  function nav(url){
    if(!url||url.startsWith('http')||url.startsWith('//')||url.startsWith('data:')||url.startsWith('javascript:')) return;
    window.parent.postMessage({type:'lm-nav',to:url},'*');
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(a){var h=a.getAttribute('href');if(h&&!h.startsWith('http')&&!h.startsWith('#')){e.preventDefault();nav(h);}}
  },true);
  // Rewrite inline onclick that would have called location.href
})();
<\/script>`;

    // Rewrite: window.location.href = 'url' → postMessage (covers inline onclick attrs)
    const patched = html
      .replace(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/g,
        "window.parent.postMessage({type:'lm-nav',to:'$1'},'*')")
      .replace(/location\.href\s*=\s*['"]([^'"]+)['"]/g,
        "window.parent.postMessage({type:'lm-nav',to:'$1'},'*')");

    const injected = patched.includes("<head")
      ? patched.replace(/(<head[^>]*>)/i, `$1${interceptor}`)
      : interceptor + patched;

    // Revoke previous URL to avoid memory leaks
    if (prevPreviewUrlRef.current) {
      URL.revokeObjectURL(prevPreviewUrlRef.current);
    }
    const url = URL.createObjectURL(new Blob([injected], { type: "text/html" }));
    prevPreviewUrlRef.current = url;
    return url;
  }

  // Listen for in-preview navigation requests
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      if (!e.data || e.data.type !== "lm-nav") return;
      const target: string = e.data.to as string;
      if (!dirHandle || !htmlPreviewPath) return;

      // Resolve path relative to the file currently being previewed
      const base = htmlPreviewPath.includes("/")
        ? htmlPreviewPath.slice(0, htmlPreviewPath.lastIndexOf("/"))
        : "";
      const resolved = base ? `${base}/${target}` : target;

      try {
        const content = await readFileFromHandle(dirHandle, resolved);
        const processed = await inlineHtmlResources(content, dirHandle, resolved, workspacePath);
        const url = buildPreviewBlobUrl(processed);
        setHtmlPreviewUrl(url);
        setHtmlPreviewPath(resolved);
      } catch {
        toast.error(`Preview: file not found — ${resolved}`);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [dirHandle, htmlPreviewPath]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!dirHandle || !currentPath) return;
    setSaveStatus("saving");
    try {
      await writeFileToHandle(dirHandle, currentPath, fileContent);
      setSaveStatus("saved");
      setOpenTabs((prev) => prev.map((t) => t.path === currentPath ? { ...t, isDirty: false, content: fileContent } : t));
      toast.success(`Saved ${currentPath.split("/").pop()}`);
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
      setSaveStatus("idle");
    }
  }

  async function handleTerminalRun(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed || terminalRunning) return;
    if (!isTauri()) {
      const id = crypto.randomUUID();
      setTerminalLog((prev) => [...prev, { id, cmd: trimmed, output: "Terminal commands require the desktop app (npm run tauri dev).", error: true, running: false, source: "user" }]);
      return;
    }
    const id = crypto.randomUUID();
    setTerminalLog((prev) => [...prev, { id, cmd: trimmed, output: "", error: false, running: true, source: "user" }]);
    setTerminalRunning(true);
    setTimeout(() => terminalEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    try {
      const result = await tauriRun(trimmed, workspacePath || undefined);
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      setTerminalLog((prev) => prev.map((e) => e.id === id
        ? { ...e, output: combined || "(no output)", error: result.exit_code !== 0, running: false }
        : e
      ));
    } catch (err) {
      setTerminalLog((prev) => prev.map((e) => e.id === id
        ? { ...e, output: (err as Error).message, error: true, running: false }
        : e
      ));
    } finally {
      setTerminalRunning(false);
      setTimeout(() => terminalEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  async function handleRun() {
    if (!fileContent.trim()) return;
    const mode = getRunMode(language);

    if (mode === "browser-js") {
      setHtmlPreviewUrl(null);
      setHtmlPreviewPath("");
      const result = runJavaScript(fileContent);
      setRunOutput(result);
      setIsOutputOpen(true);
      if (result.error) toast.error("Runtime error");
      else toast.success("Ran successfully");
      return;
    }

    if (mode === "html-preview") {
      setRunOutput(null);
      // Inline all local CSS, JS, and image references so the blob URL
      // renders identically to opening the file in a real browser.
      const processed = dirHandle
        ? await inlineHtmlResources(fileContent, dirHandle, currentPath, workspacePath)
        : fileContent;
      const url = buildPreviewBlobUrl(processed);
      setHtmlPreviewUrl(url);
      setHtmlPreviewPath(currentPath);
      return;
    }

    if (mode === "shell") {
      setHtmlPreviewUrl(null);
      setHtmlPreviewPath("");
      if (!isTauri()) {
        const cmd = shellRunCmd(language, currentPath || "file");
        setRunOutput({ output: `Not running in desktop mode.\n\nTo run this file, use your terminal:\n\n  ${cmd}`, error: true });
        setIsOutputOpen(true);
        return;
      }
      if (!currentPath) {
        setRunOutput({ output: "No file is open. Open a file from the file tree first.", error: true });
        setIsOutputOpen(true);
        return;
      }
      if (!workspacePath) {
        setRunOutput({ output: "No workspace folder is open.\n\nClick the folder icon in the file tree to open your project, then run again.", error: true });
        setIsOutputOpen(true);
        return;
      }

      // Auto-save if the file has unsaved changes before running
      const activeTab = openTabs.find((t) => t.path === currentPath);
      if (activeTab?.isDirty && dirHandle) {
        try {
          await writeFileToHandle(dirHandle, currentPath, fileContent);
          setOpenTabs((prev) => prev.map((t) => t.path === currentPath ? { ...t, isDirty: false, content: fileContent } : t));
        } catch (e) {
          setRunOutput({ output: `Could not save file before running: ${(e as Error).message}`, error: true });
          setIsOutputOpen(true);
          return;
        }
      }

      const cmd = shellRunCmd(language, currentPath);
      setRunOutput({ output: `$ ${cmd}\n\nRunning…`, error: false });
      setIsOutputOpen(true);
      try {
        const result = await tauriRun(injectGitCredentials(cmd), workspacePath);
        const combined = sanitizeOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
        setRunOutput({ output: `$ ${cmd}\n\n${combined || "(no output)"}`, error: result.exit_code !== 0 });
        if (result.exit_code !== 0) toast.error(`Exited ${result.exit_code}`);
        else toast.success("Ran successfully");
      } catch (e) {
        setRunOutput({ output: `Failed to run: ${(e as Error).message}`, error: true });
        toast.error("Run failed");
      }
      return;
    }

    // mode === "none"
    setRunOutput({ output: `No runner available for "${language}" files.`, error: true });
    setIsOutputOpen(true);
  }

  function requestApproval(name: string, args: Record<string, unknown>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      approvalResolverRef.current = resolve;
      setPendingApproval({ name, args });
      setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    });
  }

  function handleApprovalDecision(approved: boolean) {
    setPendingApproval(null);
    approvalResolverRef.current?.(approved);
    approvalResolverRef.current = null;
  }

  async function handleChatSend(promptOverride?: string, _isAutoRestart?: boolean) {
    const raw = promptOverride ?? chatPrompt;
    if (!raw.trim() || !selectedModel || isChatStreaming) return;
    const prompt = raw.trim();
    if (!promptOverride) {
      setChatPrompt("");
      autoRestartCountRef.current = 0; // user sent a new message — reset restart counter
    }
    setAgentRound(0);
    setReflectionOffer(false);
    planModeDeniedThisSessionRef.current = false;

    const userMsg: AiMessage = { role: "user", content: prompt };
    const displayMessages: AiMessage[] = [...aiMessages, userMsg, { role: "assistant", content: "" }];
    setAiMessages(displayMessages);
    setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    setIsChatStreaming(true);
    setCurrentActivity(null);
    abortRef.current = new AbortController();

    // Start background logging session
    logSessionRef.current = startSession(prompt, selectedModel, dirHandle?.name);

    const toolsSupported = supportsNativeTools(selectedModel);

    // Build dynamic tool definitions for this request.
    // Only send the essential coding tools — sending all 24 tools exceeds Ollama's context budget.
    const ESSENTIAL_CODING_TOOLS = new Set([
      "read_file", "write_file", "patch_file", "apply_patch",
      "list_directory", "grep_files", "find_files",
      "run_command", "web_search", "web_fetch",
      "install_deps", "todo_write",
      "git_status", "git_commit",
      "update_project_memory",
      "create_folder", "register_tool",
      "switch_model", "switch_view", "send_task_to_tab",
    ]);
    const CODE_TOOLS = await assembleSessionTools({ dirHandle, essentialOnly: ESSENTIAL_CODING_TOOLS });

    // Build chat history — reconstruct proper tool call/result pairs so the
    // model knows what it did in previous rounds and doesn't re-simulate them as text.
    // No leading system message: agentRuntime builds and prepends its own per round.
    let history: ChatMessage[] = [
      ...aiMessages.flatMap((m): ChatMessage[] => {
        if (m.role === "user") return [{ role: "user", content: m.content }];
        if (m.role === "assistant") {
          if (!m.content) return []; // empty placeholder between rounds
          return [{ role: "assistant", content: m.content }];
        }
        if (m.role === "tool" && m.toolName && m.toolArgs !== undefined) {
          // Reconstruct assistant tool_call + tool result pair
          return [
            { role: "assistant", content: "", tool_calls: [{ function: { name: m.toolName, arguments: m.toolArgs } }] },
            { role: "tool", content: m.toolResult ?? (m.toolError ? "[tool failed or was denied]" : m.content) },
          ];
        }
        return [];
      }),
      { role: "user", content: prompt },
    ];

    const appendToLastAssistant = (chunk: string) => {
      setAiMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
        }
        return msgs;
      });
      setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
    };

    const setLastAssistantError = (msg: string) => {
      setAiMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, content: msg };
        } else {
          msgs.push({ role: "assistant", content: msg });
        }
        return msgs;
      });
    };

    let hadSideEffects = false;
    let hitRoundLimit = false;
    let wasAborted = false;
    // Tool-call durations span the async gap between onToolCallStart and onToolCallResolved
    const toolStartTimes = new Map<string, number>();

    try {
      const sessionResult = await runAgentSession(history, {
        modelRef: selectedModel,
        hardware: effectiveHardware,
        numCtxOverride,
        dirHandle,
        workspacePath,
        workspaceName: dirHandle?.name ?? null,
        currentView: "code",
        tools: CODE_TOOLS,
        // Live getters, not the raw state values — lets toggling Full Auto or
        // Plan/Build mode mid-session take effect on this session's very next
        // tool call instead of only the next message (see AgentRuntimeConfig's
        // doc comment on why a frozen snapshot was the actual cause of "Full
        // Auto still prompted").
        agentBuildMode: () => agentBuildModeRef.current,
        autoApproveAll: () => autoApproveAllRef.current,
        toolsSupported,
        maxRounds: DEFAULT_MAX_ROUNDS,
        getCurrentOpenFile: () =>
          currentPath && fileContent ? { path: currentPath, content: fileContent, language } : null,

        onPlanModeDenial: () => {
          if (planModeDeniedThisSessionRef.current) return;
          planModeDeniedThisSessionRef.current = true;
          toast.warning("Blocked by Plan mode", {
            description: "Full Auto only auto-approves in Build mode — switch to Build to let the agent write/run.",
          });
        },

        onTextDelta: (chunk) => {
          appendToLastAssistant(chunk);
          if (logSessionRef.current) logAgentText(logSessionRef.current, chunk);
        },

        onTextReplace: (cleanText) => {
          setAiMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, content: cleanText };
            return msgs;
          });
        },

        onToolCallStart: (call, label) => {
          // Remove any trailing empty assistant placeholder before adding the chip.
          // Store toolArgs so history reconstruction can emit proper tool_calls pairs.
          setAiMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant" && !last.content) msgs.pop();
            return [...msgs, { role: "tool", content: label, toolName: call.name, toolArgs: call.args }];
          });
          setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);

          // Attach dynamic tool template so executeTool can route it
          const dynDef = dynamicToolDefs.find((d) => d.name === call.name);
          if (dynDef) (call as unknown as Record<string, unknown>)._dynamicTemplate = dynDef.template;

          if (logSessionRef.current) logToolCall(logSessionRef.current, call.name, call.args);
          toolStartTimes.set(call.id, Date.now());

          // For run_command: add a "running" entry to the terminal log immediately
          if (call.name === "run_command") {
            const cmd = String(call.args["cmd"] ?? "");
            setTerminalLog((prev) => [...prev, { id: call.id, cmd, output: "", error: false, running: true, source: "agent" as const }]);
            setTerminalOpen(true);
            setTimeout(() => terminalEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
          }
        },

        onApprovalNeeded: (call) => requestApproval(call.name, call.args),

        onToolCallResolved: (call, label, result, summary) => {
          const toolMs = Date.now() - (toolStartTimes.get(call.id) ?? Date.now());
          toolStartTimes.delete(call.id);

          // Update terminal entry with result
          if (call.name === "run_command") {
            setTerminalLog((prev) =>
              prev.map((e) =>
                e.id === call.id
                  ? { ...e, output: result.output || "(no output)", error: !!result.error, running: false, durationMs: toolMs }
                  : e
              )
            );
            setTimeout(() => terminalEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
          }

          // Log tool result
          if (logSessionRef.current) {
            logToolResult(logSessionRef.current, call.name, result.output, result.error, toolMs);
          }

          setAiMessages((prev) => {
            const msgs = [...prev];
            let idx = -1;
            for (let j = msgs.length - 1; j >= 0; j--) {
              if (msgs[j].role === "tool" && msgs[j].content === label) { idx = j; break; }
            }
            if (idx !== -1) {
              msgs[idx] = {
                role: "tool",
                content: summary,
                toolName: call.name,
                toolError: !!result.error,
                toolResult: result.error ? undefined : result.output,
              };
            }
            return msgs;
          });

          if (!result.error && (call.name === "write_file" || call.name === "patch_file")) {
            const writtenPath = String(call.args["path"] ?? call.args["file_path"] ?? "");
            scheduleTreeRefresh(writtenPath);
            // Sync the editor if this file is currently open
            if (writtenPath && dirHandle) {
              readFileFromHandle(dirHandle, writtenPath).then((newContent) => {
                // Update the active editor view
                if (writtenPath === currentPath) {
                  setFileContent(newContent);
                }
                // Update the tab's cached content (keeps isDirty false)
                setOpenTabs((prev) =>
                  prev.map((t) => t.path === writtenPath ? { ...t, content: newContent, isDirty: false } : t)
                );
              }).catch(() => {});
            }
          }

          if (!result.error && call.name === "apply_patch") {
            // apply_patch touches multiple files — refresh any that are open
            const patches = call.args["patches"] as Array<{ path: string }> | undefined;
            if (Array.isArray(patches) && dirHandle) {
              for (const p of patches) {
                const pp = p.path;
                scheduleTreeRefresh(pp);
                readFileFromHandle(dirHandle, pp).then((newContent) => {
                  if (pp === currentPath) setFileContent(newContent);
                  setOpenTabs((prev) =>
                    prev.map((t) => t.path === pp ? { ...t, content: newContent, isDirty: false } : t)
                  );
                }).catch(() => {});
              }
            }
          }
        },

        onRoundStart: (round) => {
          setAgentRound(round);
          if (logSessionRef.current) logRound(logSessionRef.current, round);
          // Add a single empty assistant bubble for this round's response
          if (round > 1) {
            setAiMessages((prev) => [...prev, { role: "assistant", content: "" }]);
          }
        },

        onTodosChanged: setTodos,
        onMemoryChanged: setProjectMemory,
        onActivity: setCurrentActivity,

        signal: abortRef.current.signal,
      });

      hadSideEffects = sessionResult.hadSideEffects;
      hitRoundLimit = sessionResult.hitRoundLimit;
      wasAborted = sessionResult.wasAborted;

      if (hitRoundLimit) {
        setAiMessages((prev) => [...prev, {
          role: "assistant",
          content: autoApproveAll
            ? "Round limit reached — auto-continuing from PLAN.md…"
            : `Reached the ${DEFAULT_MAX_ROUNDS}-round limit. Ask me to continue if needed.`,
        }]);
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        wasAborted = true;
      } else {
        setLastAssistantError(`Error: ${e.message}`);
      }
    } finally {
      setIsChatStreaming(false);
      setCurrentActivity(null);
      abortRef.current = null;
      // End logging session
      if (logSessionRef.current) {
        endSession(logSessionRef.current, hadSideEffects);
        logSessionRef.current = null;
      }
      // Offer to save as a skill if the agent did real work
      if (hadSideEffects && !reflectionOffer) {
        setReflectionOffer(true);
        void generateSkillPreview();
      }
      // Auto-run next queued task
      setTaskQueue((prev) => {
        if (prev.length > 0) {
          const [next, ...rest] = prev;
          setTimeout(() => void handleChatSend(next), 300);
          return rest;
        }
        return prev;
      });
      // Completion signal: in Full Auto, check todos from disk after every stop
      // (round limit OR natural stop) and re-enter if work is unfinished.
      // Skip when user clicked Stop, or when auto-restart cap is reached.
      if (autoApproveAll && dirHandle && !wasAborted) {
        if (autoRestartCountRef.current >= MAX_AUTO_RESTARTS) {
          // Hit the cap — show a message and stop looping
          setAiMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `⚠️ Full Auto stopped after ${MAX_AUTO_RESTARTS} automatic restarts. The agent still has incomplete todos but hasn't made enough progress. Review the todos and send a message to continue manually.`,
            },
          ]);
          autoRestartCountRef.current = 0;
        } else {
          const continueMsg = await (async () => {
            // Always check todos first, even when the round limit was hit — a
            // session that spent its last few rounds on harmless
            // re-verification (pushing it over the cap) must not be force-
            // restarted into a whole new session if everything is actually
            // done. Only fall back to the round-limit message when there's no
            // todos.json to consult at all.
            try {
              const lm = await dirHandle.getDirectoryHandle(".localmind", { create: false });
              const fh = await lm.getFileHandle("todos.json", { create: false });
              const f = await fh.getFile();
              type TodoItem = { id: string; content: string; status: string };
              const latestTodos = JSON.parse(await f.text()) as TodoItem[];
              const incomplete = latestTodos.filter((t) => t.status === "pending" || t.status === "in_progress");
              if (incomplete.length === 0) return null; // all done — stop, even if we hit the round cap
              const next = incomplete.find((t) => t.status === "in_progress") ?? incomplete[0];
              return hitRoundLimit
                ? `Round limit reached with ${incomplete.length} todo(s) still incomplete — resume from: "${next.content}"`
                : `Task incomplete — ${incomplete.length} todo(s) remaining. Resume from: "${next.content}"`;
            } catch {
              return hitRoundLimit ? "Round limit reached — resume from the next pending task." : null; // no todos file — nothing to resume
            }
          })();
          if (continueMsg) {
            autoRestartCountRef.current += 1;
            setTimeout(() => void handleChatSend(continueMsg, true), 500);
          } else {
            autoRestartCountRef.current = 0; // completed cleanly — reset
          }
        }
      }
    }
  }

  // Called automatically after successful agentic run.
  // Generates a skill preview in the background so the user can see the name before confirming.
  async function generateSkillPreview() {
    if (!selectedModel) return;
    setIsPreviewingSkill(true);
    setPendingSkill(null);
    try {
      const convoSummary = aiMessages
        .filter((m) => m.role !== "tool")
        .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
        .join("\n");
      const genHistory = [
        {
          role: "system" as const,
          content:
            "Your job is to distill a STRATEGIC, REUSABLE skill from this conversation.\n\n" +
            "RULES (strictly enforced):\n" +
            "- NO code snippets, no HTML/CSS/JS examples, no literal implementations.\n" +
            "- NO project-specific names, file paths, or variable names.\n" +
            "- Content must be STRATEGY and DECISION-MAKING: when to use this approach, what to think about, what to watch out for, what patterns to follow — NOT a step-by-step recipe.\n" +
            "- Write as if coaching a developer on HOW TO THINK about this class of problem, not how to solve this one instance.\n" +
            "- Bad example: 'Create index.html with <!DOCTYPE html>...' (too literal)\n" +
            "- Good example: 'Structure the project around semantic HTML sections. Consider navigation, content, and contact patterns. Prioritize mobile-first CSS and lazy-load heavy assets.' (strategic)\n\n" +
            "Reply with ONLY a JSON object — no text outside it:\n" +
            "  name: short title for the skill class (e.g. 'Building Multi-Section Static Sites')\n" +
            "  tags: comma-separated keywords that describe the domain, not the task\n" +
            "  content: 150–300 word markdown strategy guide — prose paragraphs and short bullet points only, zero code blocks\n",
        },
        { role: "user" as const, content: convoSummary },
      ];
      let json = "";
      for await (const chunk of streamChatForModel(selectedModel, genHistory)) {
        json += chunk;
      }
      const start = json.indexOf("{");
      const end   = json.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("No JSON in response");
      const parsed = JSON.parse(json.slice(start, end + 1)) as { name: string; tags: string; content: string };
      const tags = parsed.tags.split(",").map((t: string) => t.trim()).filter(Boolean);
      setPendingSkill({ name: parsed.name, tags, content: parsed.content });
    } catch {
      // Preview failed silently — user can still dismiss the offer
      setPendingSkill(null);
    } finally {
      setIsPreviewingSkill(false);
    }
  }

  // Phase 2 — called when user clicks "Save" on the offer card.
  // The skill was already generated; just write it to disk.
  async function handleSaveAsSkill() {
    if (!dirHandle || !pendingSkill) return;
    setIsSavingSkill(true);
    try {
      const filename = await saveSkill(dirHandle, pendingSkill);
      const updatedSkills = await loadSkills(dirHandle);
      setSkills(updatedSkills);
      toast.success(`Skill saved: ${pendingSkill.name} → .localmind/skills/${filename}`);
      setReflectionOffer(false);
      setPendingSkill(null);
    } catch (err) {
      toast.error(`Could not save skill: ${(err as Error).message}`);
    } finally {
      setIsSavingSkill(false);
    }
  }

  // Memory save
  async function handleSaveMemory() {
    if (!dirHandle) return;
    await writeProjectMemory(dirHandle, memoryDraft);
    setProjectMemory(memoryDraft);
    setEditingMemory(false);
    toast.success("Project memory saved");
  }

  function handleApplyLastResponse() {
    const editor = editorRef.current;
    const lastAssistant = [...aiMessages].reverse().find((m) => m.role === "assistant");
    if (!editor || !lastAssistant?.content) return;

    // Extract code from markdown code block if present
    const codeMatch = lastAssistant.content.match(/```(?:\w+)?\n([\s\S]*?)```/);
    const code = codeMatch ? codeMatch[1] : lastAssistant.content;

    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      editor.executeEdits("ai-apply", [{ range: selection, text: code, forceMoveMarkers: true }]);
      toast.success("Applied to selection");
    } else {
      // Replace entire file
      const model = editor.getModel();
      if (model) {
        editor.executeEdits("ai-apply", [{
          range: model.getFullModelRange(),
          text: code,
          forceMoveMarkers: true,
        }]);
        toast.success("Applied to file");
      }
    }
  }

  const pathParts = currentPath ? currentPath.split("/") : [];
  const runMode = getRunMode(language);
  const canRun = runMode !== "none";
  const runLabel = runMode === "html-preview" ? "Preview" : "Run";

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: File tree */}
        <div className="w-[200px] shrink-0 border-r bg-card flex flex-col">
          <FileTree
            dirHandle={dirHandle}
            onOpenFile={handleOpenFile}
            onOpenDir={handleOpenDir}
            refreshKey={treeVersion}
            onRefresh={() => scheduleTreeRefresh()}
            autoExpandPaths={autoExpandPaths}
          />
        </div>

        {/* Center: Editor + output */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Tab bar */}
          {openTabs.length > 0 && (
            <div className="flex items-end gap-0 border-b bg-muted/30 shrink-0 overflow-x-auto">
              {openTabs.map((tab) => {
                const name = tab.path.split("/").pop() ?? tab.path;
                const isActive = tab.path === activeTabPath;
                return (
                  <div
                    key={tab.path}
                    onClick={() => handleSwitchTab(tab.path)}
                    className={`flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r whitespace-nowrap shrink-0 transition-colors ${
                      isActive
                        ? "bg-background text-foreground border-b-2 border-b-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-background/60"
                    }`}
                  >
                    <span className={tab.isDirty ? "italic" : ""}>{name}</span>
                    {tab.isDirty && <span className="size-1.5 rounded-full bg-warning shrink-0" />}
                    <button
                      onClick={(e) => handleCloseTab(tab.path, e)}
                      className="ml-0.5 opacity-50 hover:opacity-100 transition-opacity"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Top bar */}
          <div className="h-10 border-b bg-card px-3 flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground flex-1 min-w-0 overflow-hidden">
              {dirHandle && (
                <span className="text-foreground font-medium truncate shrink-0">{dirHandle.name}</span>
              )}
              {pathParts.map((part, i) => (
                <React.Fragment key={i}>
                  <ChevronRight className="size-3 shrink-0" />
                  <span className={i === pathParts.length - 1 ? "text-foreground font-medium truncate" : "truncate"}>
                    {part}
                  </span>
                </React.Fragment>
              ))}
              {!currentPath && <span className="italic">No file open</span>}
            </div>

            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="text-xs h-7 px-1.5 rounded border border-border bg-background text-foreground shrink-0 cursor-pointer"
              title="Select language"
            >
              {ALL_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setCodeEditorTheme(codeEditorTheme === "dark" ? "light" : "dark")}
              title={codeEditorTheme === "dark" ? "Editor theme: Dark — click for Light" : "Editor theme: Light — click for Dark"}
              className="size-7 shrink-0 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {codeEditorTheme === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
            </button>

            <Button
              size="sm" variant={canRun ? "default" : "outline"}
              className="text-xs h-7 px-2 shrink-0 gap-1"
              onClick={() => void handleRun()}
              disabled={!fileContent.trim()}
              title={
                runMode === "browser-js" ? "Run in browser sandbox (Ctrl+Enter)" :
                runMode === "html-preview" ? "Preview HTML (Ctrl+Enter)" :
                runMode === "shell" ? `Run via shell${isTauri() ? "" : " (desktop mode required)"}` :
                "No runner for this language"
              }
            >
              <Play className="size-3" />
              {runLabel}
            </Button>

            <Button
              size="sm" variant="outline"
              className="text-xs h-7 px-2 shrink-0"
              onClick={handleSave}
              disabled={!currentPath || saveStatus === "saving"}
            >
              <Save className="size-3 mr-1" />
              {saveStatus === "saved" ? "Saved!" : saveStatus === "saving" ? "Saving…" : "Save"}
            </Button>

            <Button
              size="sm" variant="ghost"
              className="text-xs h-7 px-2 shrink-0"
              onClick={() => setIsChatPanelOpen((v) => !v)}
            >
              AI {isChatPanelOpen ? "▶" : "◀"}
            </Button>
          </div>

          {/* Editor row — splits horizontally when HTML preview is active */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Monaco editor */}
            <div className={`flex flex-col min-w-0 ${htmlPreviewUrl !== null ? "w-1/2" : "flex-1"}`}>
              <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading editor…</div>}>
                <MonacoEditor
                  height="100%"
                  language={language}
                  value={fileContent}
                  theme={codeEditorTheme === "dark" ? "localmind-dark" : "localmind-light"}
                  onChange={(v) => {
                    const content = v ?? "";
                    setFileContent(content);
                    if (currentPath) {
                      setOpenTabs((prev) =>
                        prev.map((t) => t.path === currentPath ? { ...t, content, isDirty: true } : t)
                      );
                    }
                  }}
                  beforeMount={(monacoInstance) => {
                    registerLocalMindMonacoThemes(monacoInstance);
                    registerLatexLanguage(monacoInstance);
                  }}
                  onMount={(ed) => {
                    editorRef.current = ed;
                    // Ctrl+Enter to run/preview
                    ed.addCommand(2048 /* Ctrl */ | 3 /* Enter */, () => void handleRun());
                    // Ctrl+S to save
                    ed.addCommand(2048 | 49 /* S */, () => void handleSave());
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    // The Nucleus island clips overlay content via `overflow:
                    // hidden` + a 26px border-radius. Without this, Monaco's
                    // overlay widgets (autocomplete, hover, find/replace) get
                    // clipped mid-popup instead of portaling to <body>.
                    fixedOverflowWidgets: true,
                  }}
                />
              </Suspense>
            </div>

            {/* HTML Preview — side panel (full height, beside the editor) */}
            {htmlPreviewUrl !== null && (
              <div className="w-1/2 border-l flex flex-col min-w-0">
                {/* Preview header bar */}
                <div className="flex items-center gap-2 px-3 h-8 bg-card text-xs text-muted-foreground border-b border-border shrink-0">
                  <span className="text-info font-medium">Preview</span>
                  {htmlPreviewPath && (
                    <span className="text-muted-foreground truncate">{htmlPreviewPath.split("/").pop()}</span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground/70">live · 400 ms</span>
                  <button
                    type="button"
                    onClick={() => { setHtmlPreviewUrl(null); setHtmlPreviewPath(""); }}
                    className="text-muted-foreground hover:text-foreground transition-colors ml-1"
                    title="Close preview"
                  >
                    <X className="size-3" />
                  </button>
                </div>
                {/* iframe fills remaining height */}
                <iframe
                  key={htmlPreviewUrl}
                  src={htmlPreviewUrl}
                  sandbox="allow-scripts allow-same-origin"
                  className="flex-1 w-full bg-white"
                  style={{ border: "none" }}
                  title="HTML Preview"
                />
              </div>
            )}
          </div>

          {/* Integrated Terminal — VS Code style, shows agent + user commands */}
          <div className="border-t bg-card shrink-0 flex flex-col" style={{ height: terminalOpen ? 240 : 32 }}>
            {/* Terminal header tab bar */}
            <div className="flex items-center gap-0 h-8 shrink-0 border-b border-border">
              <button
                type="button"
                className="flex items-center gap-1.5 px-3 h-full text-xs text-muted-foreground hover:bg-muted border-t-2 border-t-green-500 transition-colors"
                onClick={() => setTerminalOpen((v) => !v)}
              >
                <span className="font-medium">Terminal</span>
                {terminalLog.some((e) => e.running) && (
                  <span className="size-1.5 rounded-full bg-warning animate-pulse" />
                )}
                {!terminalLog.some((e) => e.running) && terminalLog.some((e) => e.error) && (
                  <span className="size-1.5 rounded-full bg-destructive" />
                )}
              </button>
              <div className="flex-1" />
              {terminalLog.length > 0 && (
                <button
                  type="button"
                  className="px-2 h-full text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors"
                  onClick={() => setTerminalLog([])}
                  title="Clear terminal"
                >
                  ✕ clear
                </button>
              )}
              <button
                type="button"
                className="px-2 h-full text-muted-foreground/70 hover:text-foreground transition-colors"
                onClick={() => setTerminalOpen((v) => !v)}
                title={terminalOpen ? "Minimize terminal" : "Expand terminal"}
              >
                {terminalOpen ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
              </button>
            </div>

            {terminalOpen && (
              <>
                {/* Output area */}
                <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-0 font-mono">
                  {terminalLog.length === 0 && (
                    <p className="text-muted-foreground/70 text-[11px]">No commands run yet. Type a command below or let the agent run one.</p>
                  )}
                  {terminalLog.map((entry) => (
                    <div key={entry.id} className="space-y-0.5">
                      <div className="flex items-baseline gap-2">
                        <span className={`text-[11px] shrink-0 ${entry.source === "user" ? "text-blue-400" : "text-green-400"}`}>
                          {entry.source === "user" ? "❯" : "⚡"}
                        </span>
                        <span className="text-foreground text-[11px] break-all">{entry.cmd}</span>
                        {entry.running && <span className="text-warning text-[10px] animate-pulse shrink-0">running…</span>}
                        {!entry.running && entry.durationMs !== undefined && (
                          <span className="text-muted-foreground/70 text-[10px] shrink-0 ml-auto">{entry.durationMs}ms</span>
                        )}
                      </div>
                      {entry.output && (
                        <pre className={`text-[11px] whitespace-pre-wrap break-all pl-4 leading-relaxed ${
                          entry.error ? "text-destructive" : "text-muted-foreground"
                        }`}>
                          {entry.output.length > 3000 ? entry.output.slice(0, 3000) + "\n…(truncated)" : entry.output}
                        </pre>
                      )}
                    </div>
                  ))}
                  <div ref={terminalEndRef} />
                </div>

                {/* Input row */}
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border shrink-0">
                  <span className="text-green-400 text-[11px] font-mono shrink-0">
                    {workspacePath ? workspacePath.split(/[\\/]/).pop() : "~"}$
                  </span>
                  <input
                    type="text"
                    value={terminalInput}
                    onChange={(e) => setTerminalInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        const cmd = terminalInput;
                        setTerminalInput("");
                        void handleTerminalRun(cmd);
                      }
                    }}
                    disabled={terminalRunning}
                    placeholder="Type a command and press Enter…"
                    className="flex-1 bg-transparent text-foreground text-[11px] font-mono outline-none placeholder:text-muted-foreground/60"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                  />
                  {terminalRunning && <span className="text-warning text-[10px] animate-pulse shrink-0">running</span>}
                </div>
              </>
            )}
          </div>

          {/* Text output panel */}
          {runOutput && !htmlPreviewUrl && (
            <div className="border-t bg-card shrink-0" style={{ maxHeight: isOutputOpen ? 200 : 32 }}>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 h-8 text-xs text-muted-foreground hover:bg-muted transition-colors"
                onClick={() => setIsOutputOpen((v) => !v)}
              >
                {isOutputOpen ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
                <span className={runOutput.error ? "text-destructive" : "text-success"}>
                  {runOutput.error ? "Error" : "Output"}
                </span>
                <span className="text-muted-foreground ml-auto">{currentPath.split("/").pop()}</span>
              </button>
              {isOutputOpen && (
                <pre className="px-3 pb-3 text-xs font-mono overflow-y-auto text-foreground whitespace-pre-wrap"
                  style={{ maxHeight: 168 }}>
                  {runOutput.output}
                </pre>
              )}
            </div>
          )}

          {/* Checkpoint browser — collapsible, shows backups for current file */}
          <CheckpointBrowser
            workspacePath={workspacePath}
            currentPath={currentPath}
            onRestore={(content) => {
              setFileContent(content);
              if (currentPath) {
                setOpenTabs((prev) => prev.map((t) => t.path === currentPath ? { ...t, content, isDirty: true } : t));
              }
            }}
          />
        </div>

        {/* Right: AI chat panel */}
        {isChatPanelOpen && (
          <div className="w-[280px] shrink-0 border-l bg-card flex flex-col">
            <div className="px-3 py-2 border-b text-xs font-medium text-foreground flex items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                <span>AI Assistant</span>
                {!supportsNativeTools(selectedModel) ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
                    no tools · {selectedModel.split(":")[0]}
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success border border-success/30">
                    tools on
                  </span>
                )}
                {isChatStreaming && agentRound > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-info/10 text-info border border-info/30 tabular-nums">
                    Round {agentRound}/50
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {supportsNativeTools(selectedModel) && (
                  <>
                    <button
                      type="button"
                      title={agentBuildMode
                        ? "Build mode — can write files and run commands. Click to switch to Plan mode (read-only)."
                        : "Plan mode — read-only. Click to switch to Build mode."}
                      onClick={() => setAgentBuildMode((v) => !v)}
                      className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                        agentBuildMode
                          ? "bg-primary/10 text-primary border-primary/20"
                          : "bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {agentBuildMode ? <Zap className="size-2.5" /> : <Brain className="size-2.5" />}
                      {agentBuildMode ? "Build" : "Plan"}
                    </button>
                    <button
                      type="button"
                      title={autoApproveAll
                        ? "Full Auto ON — all tool calls execute without approval. Click to disable."
                        : "Enable Full Auto — skips all approval prompts (write, delete, run, git). Agent works autonomously."}
                      onClick={() => setAutoApproveAll((v) => !v)}
                      className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                        autoApproveAll
                          ? "bg-destructive/10 text-destructive border-destructive/30"
                          : "text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
                      }`}
                    >
                      <Zap className="size-2.5" />
                      {autoApproveAll ? "Full Auto" : "Auto"}
                    </button>
                    <button
                      type="button"
                      title="Task queue"
                      onClick={() => setShowQueue((v) => !v)}
                      className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                        taskQueue.length > 0
                          ? "bg-primary/10 text-primary border-primary/20"
                          : "text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
                      }`}
                    >
                      <ListTodo className="size-2.5" />
                      {taskQueue.length > 0 ? `Queue (${taskQueue.length})` : "Queue"}
                    </button>
                  </>
                )}
                {aiMessages.length > 0 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-[10px]"
                    onClick={() => {
                      if (pendingApproval) handleApprovalDecision(false);
                      abortRef.current?.abort();
                      setAiMessages([]);
                      setAgentRound(0);
                      setExpandedToolIndices(new Set());
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Live activity status bar */}
            {isChatStreaming && (
              <div className="px-3 py-1.5 border-b bg-muted/30 flex items-center gap-2 shrink-0">
                <span className="size-1.5 rounded-full bg-success animate-pulse shrink-0" />
                <span className="text-[10px] text-muted-foreground truncate">
                  {currentActivity ?? "Thinking…"}
                </span>
              </div>
            )}

            {/* Conversation */}
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {aiMessages.length === 0 && (
                <p className="text-xs text-muted-foreground italic">Ask about this file…</p>
              )}
              {aiMessages.map((msg, i) => {
                if (msg.role === "tool") {
                  const isExpanded = expandedToolIndices.has(i);
                  const hasResult = !!msg.toolResult;
                  const isPending = !hasResult && !msg.toolError && isChatStreaming;
                  const toolName = msg.toolName ?? "";

                  // Status color only (error/pending) — tool identity is
                  // conveyed by the icon, not a per-tool-type background hue,
                  // to match the rest of the app's flatter, token-driven look.
                  const chipColor = msg.toolError
                    ? "bg-destructive/10 text-destructive border-destructive/30"
                    : isPending
                    ? "bg-warning/10 text-warning border-warning/40"
                    : "bg-muted text-foreground border-border";

                  return (
                    <div key={i} className="flex flex-col items-start gap-1 w-full">
                      <button
                        type="button"
                        onClick={() => {
                          if (!hasResult) return;
                          setExpandedToolIndices((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i); else next.add(i);
                            return next;
                          });
                        }}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-mono border transition-colors w-full text-left ${chipColor} ${
                          isPending ? "animate-pulse" : ""
                        } ${hasResult ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                      >
                        <ToolIcon name={toolName} className="size-3 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{msg.content}</span>
                        {isPending && <span className="shrink-0 text-[9px]">…</span>}
                        {hasResult && (
                          <ChevronDown className={`size-3 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                        )}
                      </button>
                      {isExpanded && msg.toolResult && (
                        <pre className="w-full text-[10px] font-mono bg-muted text-foreground rounded p-2 overflow-y-auto whitespace-pre-wrap break-all"
                          style={{ maxHeight: 200 }}>
                          {msg.toolResult.length > 4000
                            ? msg.toolResult.slice(0, 4000) + "\n…(truncated)"
                            : msg.toolResult}
                        </pre>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={i} className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}>
                    <div className={`max-w-full rounded-lg px-2.5 py-1.5 text-xs ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground font-mono whitespace-pre-wrap"
                    }`}>
                      {msg.content || <span className="animate-pulse">▌</span>}
                    </div>
                  </div>
                );
              })}
              <div ref={aiBottomRef} />
            </div>

            {/* Inline approval card — replaces window.confirm() for destructive tool calls */}
            {pendingApproval && (
              <div className="mx-3 mb-1 rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-2 shrink-0">
                <p className="text-xs font-medium text-warning">
                  {pendingApproval.name === "write_file" && `Write file: ${String(pendingApproval.args["path"] ?? "")}`}
                  {pendingApproval.name === "delete_file" && `DELETE: ${String(pendingApproval.args["path"] ?? "")}`}
                  {pendingApproval.name === "run_command" && "Run shell command:"}
                  {pendingApproval.name === "git_add" && `git add ${String(pendingApproval.args["paths"] ?? "")}`}
                  {pendingApproval.name === "git_commit" && "git commit:"}
                  {!["write_file","delete_file","run_command","git_add","git_commit"].includes(pendingApproval.name) && `Run: ${pendingApproval.name}`}
                </p>
                {(pendingApproval.name === "run_command" || pendingApproval.name === "git_commit") && (
                  <pre className="text-[10px] font-mono bg-warning/15 rounded px-2 py-1 overflow-x-auto text-warning whitespace-pre-wrap break-all">
                    {String(pendingApproval.args[pendingApproval.name === "git_commit" ? "message" : "cmd"] ?? "")}
                  </pre>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 text-xs h-6 bg-success hover:bg-success/90 text-success-foreground border-0"
                    onClick={() => handleApprovalDecision(true)}
                  >
                    Allow
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="flex-1 text-xs h-6 border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => handleApprovalDecision(false)}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            )}

            {/* Reflection offer — save as skill after successful tool run */}
            {reflectionOffer && (
              <div className="mx-3 mb-1 rounded-lg border border-success/30 bg-success/5 p-3 space-y-2 shrink-0">
                {isPreviewingSkill ? (
                  <p className="text-xs text-success italic">Analyzing workflow…</p>
                ) : pendingSkill ? (
                  <>
                    <p className="text-xs font-medium text-success">
                      Save as skill: <span className="font-semibold">"{pendingSkill.name}"</span>
                    </p>
                    {pendingSkill.tags.length > 0 && (
                      <p className="text-[10px] text-success">
                        Tags: {pendingSkill.tags.join(", ")}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-xs font-medium text-success">Save this workflow as a skill?</p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 text-xs h-6 bg-success hover:bg-success/90 text-success-foreground border-0"
                    onClick={() => void handleSaveAsSkill()}
                    disabled={isSavingSkill || isPreviewingSkill || !pendingSkill}
                  >
                    {isSavingSkill ? "Saving…" : "Save skill"}
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="text-xs h-6 border-success/30 text-success"
                    onClick={() => { setReflectionOffer(false); setPendingSkill(null); }}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {/* Apply button — only shown when model can't use tools (fallback for plain text responses) */}
            {!supportsNativeTools(selectedModel) && aiMessages.some((m) => m.role === "assistant" && m.content) && (
              <div className="px-3 py-1.5 border-t">
                <Button size="sm" variant="outline" className="w-full text-xs h-7" onClick={handleApplyLastResponse}>
                  Apply to {editorRef.current?.getSelection()?.isEmpty() === false ? "selection" : "file"}
                </Button>
              </div>
            )}

            {/* Input */}
            <div className="p-3 border-t space-y-2">
              <Textarea
                value={chatPrompt}
                onChange={(e) => setChatPrompt(e.target.value)}
                placeholder={selectedModel ? "Ask about this code…" : "No model selected"}
                rows={3}
                className="text-xs min-h-[60px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); }
                }}
              />
              <div className="flex gap-2">
                <Button
                  size="sm" className="flex-1 text-xs h-7"
                  onClick={() => void handleChatSend()}
                  disabled={!chatPrompt.trim() || isChatStreaming || !selectedModel}
                >
                  <Send className="size-3 mr-1" />
                  {isChatStreaming ? "…" : "Send"}
                </Button>
                {supportsNativeTools(selectedModel) && chatPrompt.trim() && !isChatStreaming && (
                  <Button
                    size="sm" variant="outline" className="text-xs h-7 px-2"
                    title="Add to queue (runs after current task)"
                    onClick={() => {
                      setTaskQueue((prev) => [...prev, chatPrompt.trim()]);
                      setChatPrompt("");
                      toast.info("Added to task queue");
                    }}
                  >
                    <ListTodo className="size-3" />
                  </Button>
                )}
                {isChatStreaming && (
                  <Button size="sm" variant="outline" className="text-xs h-7 px-2"
                    onClick={() => abortRef.current?.abort()}>
                    <Square className="size-3" />
                  </Button>
                )}
              </div>
            </div>

            {/* Task queue panel */}
            {showQueue && (
              <div className="border-t px-3 py-2 space-y-1.5 shrink-0">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Task queue {taskQueue.length > 0 ? `(${taskQueue.length})` : "— empty"}
                </p>
                {taskQueue.length === 0 && (
                  <p className="text-[10px] text-muted-foreground">Use the queue icon to add tasks that run sequentially.</p>
                )}
                {taskQueue.map((task, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px] bg-muted rounded px-2 py-1">
                    <span className="text-muted-foreground shrink-0">{i + 1}.</span>
                    <span className="flex-1 truncate">{task}</span>
                    <button onClick={() => setTaskQueue((prev) => prev.filter((_, j) => j !== i))}
                      className="text-muted-foreground hover:text-destructive shrink-0">
                      <X className="size-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Todo panel — shows current task list from todo_write */}
            {todos.length > 0 && (
              <div className="border-t shrink-0 px-3 py-2 max-h-40 overflow-y-auto">
                <div className="text-[10px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                  <ListTodo className="size-3" />
                  Tasks
                  <span className="ml-auto text-[9px]">
                    {todos.filter((t) => t.status === "completed").length}/{todos.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {todos.map((todo) => (
                    <div key={todo.id} className="flex items-start gap-1.5">
                      <span className="shrink-0 text-[11px] leading-none mt-0.5">
                        {todo.status === "completed" ? "✅" :
                         todo.status === "in_progress" ? "🔵" :
                         todo.status === "cancelled" ? "❌" : "⬜"}
                      </span>
                      <span className={`text-[10px] leading-snug ${
                        todo.status === "completed" ? "line-through text-muted-foreground" :
                        todo.status === "in_progress" ? "text-info font-medium" :
                        todo.status === "cancelled" ? "line-through text-muted-foreground" :
                        "text-foreground"
                      }`}>
                        {todo.content}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Project memory panel */}
            <div className="border-t shrink-0">
              <button
                type="button"
                onClick={() => { setShowMemory((v) => !v); if (!showMemory) setMemoryDraft(projectMemory); }}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <Brain className="size-2.5" />
                <span>Project Memory</span>
                {projectMemory && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-success shrink-0" />}
                <span className="ml-auto">{showMemory ? <ChevronDown className="size-2.5" /> : <ChevronUp className="size-2.5" />}</span>
              </button>
              {showMemory && (
                <div className="px-3 pb-3 space-y-2">
                  {editingMemory ? (
                    <>
                      <Textarea
                        value={memoryDraft}
                        onChange={(e) => setMemoryDraft(e.target.value)}
                        placeholder="## Tech Stack&#10;React, TypeScript, Tauri&#10;&#10;## Common Commands&#10;npm run tauri dev"
                        rows={6}
                        className="text-[10px] font-mono min-h-[100px]"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" className="flex-1 text-xs h-6" onClick={() => void handleSaveMemory()}>Save</Button>
                        <Button size="sm" variant="outline" className="text-xs h-6" onClick={() => setEditingMemory(false)}>Cancel</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      {projectMemory ? (
                        <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap max-h-32 overflow-y-auto">
                          {projectMemory.slice(0, 800)}{projectMemory.length > 800 ? "…" : ""}
                        </pre>
                      ) : (
                        <p className="text-[10px] text-muted-foreground italic">No memory yet — the agent uses update_project_memory to store context.</p>
                      )}
                      <Button size="sm" variant="outline" className="text-xs h-6 gap-1 w-full"
                        onClick={() => { setMemoryDraft(projectMemory); setEditingMemory(true); }}>
                        <Pencil className="size-2.5" /> Edit memory
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
