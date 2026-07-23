import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, SlidersHorizontal, Volume2, VolumeX, Lightbulb, FolderTree, Maximize2, Minimize2 } from "lucide-react";
import { toast, Toaster } from "sonner";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { recommendModel } from "./lib/modelRecommender";
import { listModels, pullModel } from "./lib/ollama";
import type { ChatMessage } from "./lib/ollama";
import { searchWeb } from "./lib/search";
import { runAgentSession, DEFAULT_MAX_ROUNDS, buildIdentitySystemPrompt } from "./lib/agentRuntime";
import { streamChatForModel, formatModelRef } from "./lib/chatProvider";
import { classifyIntent, heuristicIntent } from "./lib/intentRouter";
import { setSystemInfoContext } from "./lib/tools";
import { assembleSessionTools } from "./lib/capabilityRegistry";
import { supportsNativeTools, probeAllModels } from "./lib/modelCapabilities";
import { useModelStore } from "./store/models";
import { useSettingsStore } from "./store/settings";
import { useMcpStore } from "./store/mcp";
import { useProvidersStore } from "./store/providers";
import { openWorkspace, openWorkspaceByPath, isTauriEnv } from "./lib/fileSystem";
import { searchMemory, formatMemoriesForContext } from "./lib/vectorMemory";
import { useChatStore } from "./store/chat";
import { useAgentStore } from "./store/agent";
import { useWorkspacesStore } from "./store/workspaces";
import { useAppViewStore } from "./store/appView";
import { useModelSelectionStore } from "./store/modelSelection";
import { useSessionResultsStore } from "./store/sessionResults";
import { useChatSeedStore } from "./store/chatSeed";
import { startTaskRunner, SAFE_QUEUE_ALLOWLIST } from "./lib/taskRunner";
import { initScheduler } from "./lib/scheduler";
import { initMcpAutoConnect } from "./lib/mcpAutoConnect";
import { initTrayIntegration } from "./lib/trayIntegration";
import { syncConversationsToFts } from "./lib/sessionSearch";
import { runHeadlessTask } from "./lib/headlessRunner";
import { QueuedTaskBanner } from "./components/QueuedTaskBanner";
import { Nucleus } from "./components/Nucleus";
import { ChatSidePanel } from "./components/ChatSidePanel";
import { ConversationSearch } from "./components/ConversationSearch";
import { ChatMessages } from "./components/ChatMessages";
import { ChatInput } from "./components/ChatInput";
import { ModelManager } from "./components/ModelManager";
import { AgentToolbar } from "./components/AgentToolbar";
import { ToolCallCard } from "./components/ToolCallCard";
import { SystemPromptDialog } from "./components/SystemPromptDialog";
import { Onboarding } from "./components/Onboarding";
import { useOnboardingStore } from "./store/onboarding";
import { FileTree } from "./components/FileTree";
import { FilePreviewPanel } from "./components/FilePreviewPanel";
import { lazy, Suspense } from "react";
import { VIEW_WIDTH, APP_VIEWS } from "./types/app";
import type { AppView } from "./types/app";
import { useTaskQueueStore } from "./store/taskQueue";

const CodeEditor = lazy(() =>
  import("./components/CodeEditor").then((m) => ({ default: m.CodeEditor }))
);
const DocEditor = lazy(() =>
  import("./components/DocEditor").then((m) => ({ default: m.DocEditor }))
);
const Terminal = lazy(() =>
  import("./components/Terminal").then((m) => ({ default: m.Terminal }))
);
const SubagentManager = lazy(() =>
  import("./components/SubagentManager").then((m) => ({ default: m.SubagentManager }))
);
const DeepResearch = lazy(() =>
  import("./components/DeepResearch").then((m) => ({ default: m.DeepResearch }))
);
const KnowledgeHub = lazy(() =>
  import("./components/KnowledgeHub").then((m) => ({ default: m.KnowledgeHub }))
);
const ImageEditor = lazy(() =>
  import("./components/ImageEditor").then((m) => ({ default: m.ImageEditor }))
);
const SkillRegistry = lazy(() =>
  import("./components/SkillRegistry").then((m) => ({ default: m.SkillRegistry }))
);
const Workflows = lazy(() =>
  import("./components/Workflows").then((m) => ({ default: m.Workflows }))
);
const HistoryView = lazy(() =>
  import("./components/HistoryView").then((m) => ({ default: m.HistoryView }))
);
const BenchmarkRunner = lazy(() =>
  import("./components/BenchmarkRunner").then((m) => ({ default: m.BenchmarkRunner }))
);
const AppSettings = lazy(() =>
  import("./components/AppSettings").then((m) => ({ default: m.AppSettings }))
);
const Compare = lazy(() =>
  import("./components/Compare").then((m) => ({ default: m.Compare }))
);
const MemoryView = lazy(() =>
  import("./components/MemoryView").then((m) => ({ default: m.MemoryView }))
);
const AgentLogs = lazy(() =>
  import("./components/AgentLogs").then((m) => ({ default: m.AgentLogs }))
);

// Quick-invoke widget runs get a slightly wider allowlist than the task queue
// / scheduler's SAFE_QUEUE_ALLOWLIST. Those fire when the user is genuinely
// absent, so they keep the narrower, purely-file/read-oriented set. Quick
// invoke, by contrast, is fired by a user sitting at the keyboard *right now*
// — and its single most common use is asking about what's currently on
// screen ("what's on my screen", "summarize this window"). Auto-denying
// take_screenshot (as SAFE_QUEUE_ALLOWLIST does) means the model asks for a
// screenshot, gets refused, and answers blind, which is exactly the bug this
// fixes. read_clipboard and list_windows are the same story — read-only
// observation tools a present user would approve instantly anyway.
// set_clipboard, focus_window, and open_application are deliberately NOT
// included here: those ACT on the system rather than observe it, so they stay
// behind an explicit approval even for quick invoke. Placed at module scope
// (not inside the component) so it isn't rebuilt on every render.
const QUICK_INVOKE_ALLOWLIST = [...SAFE_QUEUE_ALLOWLIST, "take_screenshot", "read_clipboard", "list_windows"];

// ─── WP7.1: "circle what you care about" region preamble ──────────────────
//
// The annotate overlay (src/annotate/Annotate.tsx) captures a cropped region
// of the screen and stashes it in Rust (see PENDING_REGION in
// src-tauri/src/os_tools.rs) so the NEXT take_screenshot call returns that
// crop instead of the whole screen. But the model has no other way to know
// a region is even waiting for it — its take_screenshot tool schema is
// completely unchanged, and nothing about the prompt text implies "call
// take_screenshot" on its own. This preamble is the only signal: it's
// prepended to the task text whenever hasRegion is true, telling the model
// exactly what calling take_screenshot will get it and why. take_screenshot
// is already in QUICK_INVOKE_ALLOWLIST above, so no allowlist change is
// needed for this to work.
const QUICK_INVOKE_REGION_PREAMBLE =
  "The user has circled a specific region of their screen. Call take_screenshot to see it — it returns ONLY that circled region, already cropped. Answer about what is in it.\n\n";

// ─── WP6.4a: IPC task result correlation ───────────────────────────────────
//
// The Rust IPC listener (src-tauri/src/ipc.rs) mints an id per `POST /task`
// and returns it to the external caller so it can poll `GET /task/{id}`. The
// task queue's own `useTaskQueueStore.enqueue()` mints a SEPARATE id when the
// `ipc-task` listener below pushes the task in — the two ids are unrelated
// strings, minted by different code in different processes. This map bridges
// them: queue-store task id -> the IPC caller's id, so that once the queue
// runner transitions the task to running/done/error we know which id to
// report the outcome back under via `ipc_report_task_result`.
//
// SUPERSEDED: this was a module-scope Map<queueTaskId, ipcId>. Module scope
// survives a re-render, but NOT a webview reload — and the task queue is
// persisted, so it does survive one. A reload (Vite re-optimizing deps after
// an npm install, a crash, a manual refresh) therefore orphaned every
// in-flight external task: the task ran to completion while its submitter
// polled "queued" forever, which is exactly the symptom that took hours to
// pin down. The id now lives on the persisted task itself as
// `QueuedTask.externalId`, so the two can't drift apart.

// Tasks we've already sent a "running" report for — a task can stay in
// "running" status across many unrelated store updates (e.g. another queued
// task changing state), and without this we'd re-invoke ipc_report_task_result
// on every one of them instead of once.
const ipcReportedRunning = new Set<string>();

// Idempotence guard, same pattern as taskRunner.ts's `started` flag: a second
// call to startIpcResultReporter() (e.g. a React effect re-invocation) must
// not register a duplicate store subscription.
let ipcResultReporterStarted = false;

/**
 * Watches the task queue for tasks carrying an `externalId` (see above)
 * to an externally-submitted IPC task, and reports their status back to Rust
 * via the ipc_report_task_result command so a caller polling
 * `GET /task/{id}` can see "running" while it's in flight and "done"/"error"
 * with a summary once it finishes.
 *
 * Subscribes to useTaskQueueStore at module scope, outside React render —
 * mirrors taskRunner.ts's startTaskRunner()/useTaskQueueStore.subscribe
 * pattern exactly, rather than a component-scoped effect, so it isn't tied to
 * any particular component's mount lifecycle.
 *
 * Every invoke() call is wrapped in try/catch (via .catch(), logged not
 * thrown) — same guard as the other Tauri-boundary calls in this file
 * (showResultWidget, handleQuickInvokeChat's window-surfacing calls): an
 * unguarded rejection here would reach main.tsx's global unhandledrejection
 * handler and replace #root with an error screen, i.e. a missing capability
 * permission or a stale/evicted task id would take down the whole UI instead
 * of just failing to report one outcome.
 */
function startIpcResultReporter(): void {
  if (ipcResultReporterStarted) return;
  ipcResultReporterStarted = true;

  useTaskQueueStore.subscribe((state, prev) => {
    // A task DELETED before it finished (the X button in QueuedTaskBanner)
    // would otherwise leave its external submitter polling "running" forever:
    // the task just vanishes from the array, so the status loop below never
    // sees a terminal state to report. Detect the disappearance and close the
    // loop honestly as a cancellation.
    if (prev && prev.tasks !== state.tasks) {
      const stillPresent = new Set(state.tasks.map((t) => t.id));
      for (const gone of prev.tasks) {
        if (!gone.externalId) continue;
        if (stillPresent.has(gone.id)) continue;
        if (gone.status === "done" || gone.status === "error") continue; // already reported
        void invoke("ipc_report_task_result", {
          id: gone.externalId,
          status: "error",
          summary: "Cancelled — the task was removed from the queue in LocalMind before it finished.",
        }).catch((err) => {
          console.error("[ipc] ipc_report_task_result(cancelled) failed:", err);
        });
        ipcReportedRunning.delete(gone.id);
      }
    }

    for (const task of state.tasks) {
      const ipcId = task.externalId;
      if (!ipcId) continue; // not an externally-submitted task

      if (task.status === "running") {
        if (!ipcReportedRunning.has(task.id)) {
          ipcReportedRunning.add(task.id);
          void invoke("ipc_report_task_result", { id: ipcId, status: "running", summary: null }).catch((err) => {
            console.error("[ipc] ipc_report_task_result(running) failed:", err);
          });
        }
        continue;
      }

      if (task.status === "done" || task.status === "error") {
        // Prefer `fullText` (the agent's real answer, capped at 8000 chars)
        // over `summary`, which is hard-capped at 500 and exists only to label
        // a Logs row — sending it to a chat client truncates answers
        // mid-sentence. `summary` remains the fallback for records persisted
        // before fullText existed.
        const result = task.resultId
          ? useSessionResultsStore.getState().results.find((r) => r.id === task.resultId)
          : undefined;
        const summary = result?.fullText ?? result?.summary ?? "(no result recorded)";
        void invoke("ipc_report_task_result", { id: ipcId, status: task.status, summary }).catch((err) => {
          console.error("[ipc] ipc_report_task_result(outcome) failed:", err);
        });
        // `externalId` stays on the task (it's part of the persisted record,
        // and re-reporting a terminal outcome is harmless — Rust just
        // overwrites the same value). Only the in-memory dedupe set needs
        // clearing so it can't grow unbounded.
        ipcReportedRunning.delete(task.id);
      }
    }
  });
}

export default function App() {
  const {
    conversations,
    activeId,
    isStreaming,
    availableModels,
    setModels,
    newConversation,
    selectConversation,
    addMessage,
    appendToLastMessage,
    setLastMessageContent,
    setStreaming,
    updateTitle,
    updateSystemPrompt,
  } = useChatStore();

  const {
    dirHandle,
    workspacePath,
    toolsEnabled,
    pendingToolCalls,
    setWorkspace,
    setToolEnabled,
    setPendingToolCalls,
    clearPendingToolCalls,
  } = useAgentStore();

  const { hardware, vramOverride } = useModelStore();
  const { numCtxOverride, featureIdeasSteering, theme } = useSettingsStore();
  const { hasCompletedOnboarding } = useOnboardingStore();

  const { view, mountedViews, setView } = useAppViewStore();
  const { selectedModel, setSelectedModel } = useModelSelectionStore();
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [showFileTree, setShowFileTree] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ handle: FileSystemFileHandle; path: string } | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  // Persistent left panel inside the chat view (recent chats/model/MCP) —
  // replaces the old slide-over ChatDrawer. Defaults open in chat view;
  // toggled by the Nucleus's history icon (onToggleChatSidebar).
  const [chatSidebarOpen, setChatSidebarOpen] = useState(true);
  // Windowed (floating island) vs fullscreen (fills the app window) — CSS/layout
  // only, no Tauri window API calls. Toggled from the island's top-right button,
  // visible across all 15 views.
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Nucleus floating-island mount choreography: seed → compact → expanded.
  const [pillState, setPillState] = useState<"seed" | "compact" | "expanded">("seed");
  useEffect(() => {
    const t1 = setTimeout(() => setPillState("compact"), 60);
    const t2 = setTimeout(() => setPillState("expanded"), 240);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // Applies the Settings theme toggle to the actual document — previously
  // `theme` was only ever persisted in store/settings.ts and never written
  // anywhere the CSS (index.css's `:root[data-theme="dark"]` block) could see
  // it, so switching to Dark changed stored state but nothing visible.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const isIslandExpanded = pillState === "expanded";
  const isIslandCompact = pillState === "compact";
  const isWideView = VIEW_WIDTH[view] === "wide";
  // Chat's side panels (chat sidebar, file tree, preview) used to float over
  // the 580px chat column as absolute overlays because they didn't fit;
  // they're now real flex siblings (see the chat view JSX below), so the
  // island itself has to widen to make room for them instead. The more of
  // them are open at once, the wider the island needs to be — additive
  // rather than a single "any panel open" cutover.
  const chatSidebarShown = view === "chat" && chatSidebarOpen;
  const chatFileTreeShown = view === "chat" && showFileTree && !!dirHandle;
  const chatPreviewShown = view === "chat" && !!previewFile;
  const openChatPanelCount =
    (chatSidebarShown ? 1 : 0) + (chatFileTreeShown ? 1 : 0) + (chatPreviewShown ? 1 : 0);
  const chatPanelsOpen = openChatPanelCount > 0;

  const expandedWidth =
    openChatPanelCount >= 3
      ? "min(1850px, calc(100vw - 24px))" // sidebar + file tree + preview all open
      : openChatPanelCount === 2
      ? "min(1600px, calc(100vw - 24px))" // any two of sidebar/tree/preview open
      : isWideView || chatPanelsOpen
      ? "min(1400px, calc(100vw - 24px))" // reuse the existing "wide" value
      : "min(580px, calc(100vw - 24px))";

  const islandStyle: CSSProperties = {
    position: "fixed",
    top: isFullscreen ? "0px" : "18px",
    // Horizontal position is deliberately CONSTANT. Animating `left`
    // (50%→0) and `transform` (translateX(-50%)→none) together made the
    // fullscreen toggle jitter — two compounding positional animations on an
    // overshooting curve. A 100vw box centered at left:50% with
    // translateX(-50%) already spans exactly 0→100vw, so width alone gets us
    // there with no positional motion at all.
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 50,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    width: isFullscreen
      ? "100vw"
      : isIslandExpanded
      ? expandedWidth
      : isIslandCompact
      ? "160px"
      : "0px",
    height: isFullscreen
      ? "100vh"
      : isIslandExpanded
      ? "calc(100vh - 36px)"
      : isIslandCompact
      ? "40px"
      : "0px",
    borderRadius: isFullscreen ? "0px" : isIslandExpanded ? "26px" : "9999px",
    background: isIslandExpanded ? "var(--card)" : "#0A0A0A",
    border: isIslandExpanded ? "1px solid rgba(0,0,0,0.09)" : "1px solid transparent",
    boxShadow: isFullscreen
      ? "none"
      : isIslandExpanded
      ? "0 8px 60px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)"
      : "0 2px 16px rgba(0,0,0,0.18)",
    // No overshoot on the shell: a curve >1 on `width` would push the box past
    // 100vw mid-flight going fullscreen, which reads as a jitter at the edges.
    // (The bounce lives on the small Nucleus pill instead, where overshooting
    // costs nothing.) `left`/`transform` are intentionally absent — they no
    // longer change.
    transition: [
      "width 0.65s cubic-bezier(0.32, 0.72, 0, 1)",
      "height 0.65s cubic-bezier(0.32, 0.72, 0, 1)",
      "top 0.65s cubic-bezier(0.32, 0.72, 0, 1)",
      "border-radius 0.65s cubic-bezier(0.32, 0.72, 0, 1)",
      "background 0.4s ease",
      "box-shadow 0.4s ease",
    ].join(", "),
  };

  // Ref to track current convId across async agent continuations
  const activeConvIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track last recommendation shown to avoid repeating the same toast
  const lastRecRef = useRef<string>("");
  const prevIsStreamingRef = useRef(false);
  // Resolves the Promise returned to agentRuntime's onApprovalNeeded —
  // set by onApprovalNeeded itself, resolved by handleApproveAll/handleDenyCall.
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);
  // Once the user clicks "Approve All", remaining approval-required calls for
  // the rest of this task are auto-approved without prompting again.
  const autoApproveRemainingRef = useRef(false);
  // Always-current pointer to handleSend, so the mount-once quick-invoke
  // listener below (WP5.3) never calls a stale closure — handleSend reads
  // several pieces of component state (selectedModel, agentMode, dirHandle,
  // etc.) directly rather than via store getState(), so the ref must be
  // refreshed on every render rather than captured once.
  const handleSendRef = useRef<typeof handleSend | null>(null);

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;

  // Keep tool system-info context up to date with current model and hardware
  useEffect(() => {
    setSystemInfoContext({
      model: selectedModel,
      gpuName: hardware?.gpuName,
      vramGb: hardware?.vramGb,
      ramGb: hardware?.ramGb,
      cpuThreads: hardware?.cpuThreads,
    });
  }, [selectedModel, hardware]);

  // Sync selected model when switching conversations
  useEffect(() => {
    if (activeConv?.model && availableModels.includes(activeConv.model)) {
      setSelectedModel(activeConv.model);
      toast.info(`Switched to ${activeConv.model}`, { duration: 2000 });
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // TTS: speak the last assistant message when streaming ends (no pending tool calls)
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (!isStreaming && wasStreaming && ttsEnabled && pendingToolCalls.length === 0) {
      const conv = useChatStore.getState().conversations.find((c) => c.id === activeId);
      const assistantMsgs = conv?.messages.filter((m) => m.role === "assistant") ?? [];
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      if (lastMsg?.content && lastMsg.content.length > 20) {
        const plain = lastMsg.content
          .replace(/```[\s\S]*?```/g, "code block")
          .replace(/[#*`_~[\]()>]/g, "")
          .slice(0, 3000);
        speechSynthesis.cancel();
        speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
      }
    }
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Use in Chat" from model library: select the model and switch to chat view
  function handleUseModel(id: string) {
    setSelectedModel(id);
    setView("chat");
    toast.success(`Using ${id}`);
  }

  useEffect(() => {
    void initOllama();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd+K / Ctrl+K global shortcut for the ConversationSearch overlay — used
  // to live in ChatSidebar's own keydown listener; that component no longer
  // renders in the Nucleus shell, so the shortcut moved up here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the model selector in sync when providers change in Settings (enabling
  // a provider, saving a model list) without an app restart. initOllama only
  // reads providers once at boot; this merges provider models live, preserving
  // the discovered Ollama names (refs without "::") already in the list.
  const providerConfigs = useProvidersStore((s) => s.providers);
  useEffect(() => {
    const providerModels = providerConfigs
      .filter((p) => p.enabled && p.models.length > 0)
      .flatMap((p) => p.models.map((m) => formatModelRef(p.id, m)));
    const current = useChatStore.getState().availableModels;
    const ollamaNames = current.filter((m) => !m.includes("::"));
    const merged = [...ollamaNames, ...providerModels];
    const same =
      merged.length === current.length && merged.every((m, i) => m === current[i]);
    if (!same) setModels(merged);
  }, [providerConfigs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a VALID model selected whenever the model list changes.
  //
  // Selection used to be set in exactly one place — initOllama, which runs
  // once on mount — so any path that left `selectedModel` empty or pointing at
  // a model that no longer exists stranded the app with no model and no way to
  // recover but a restart (the Nucleus island simply renders blank). That
  // happens more than you'd think: a provider gets disabled, a model is
  // deleted from Ollama, the persisted selection predates a model list that no
  // longer contains it, or (in dev) an HMR reload re-creates the store after
  // initOllama has already run.
  //
  // Runs on every availableModels change and only acts when the current pick
  // is missing or invalid, so it never fights an explicit user choice.
  useEffect(() => {
    if (availableModels.length === 0) return;
    if (selectedModel && availableModels.includes(selectedModel)) return;
    setSelectedModel(availableModels[0]);
  }, [availableModels, selectedModel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Boot the global task-queue runner once — it drains pending tasks (queued
  // via send_task_to_tab) through the headless agent runtime unattended, and
  // watches for workspace-open so tasks queued before a workspace existed
  // start automatically once one is available.
  useEffect(() => {
    startTaskRunner();
    // WP6.4a: reports IPC-submitted tasks' running/done/error status back to
    // Rust (ipc_report_task_result) so an external caller polling
    // GET /task/{id} can see the outcome — see startIpcResultReporter's doc
    // comment above. Idempotent, like startTaskRunner.
    startIpcResultReporter();
    // Background scheduler (fires job-due events → headless runs), MCP
    // auto-connect (reconnect enabled servers on launch), and the tray's
    // close-to-tray setting sync. All idempotent.
    initScheduler();
    initMcpAutoConnect();
    initTrayIntegration();
    // Past-session search (WP4.3): index existing conversations once on
    // mount, then re-sync (debounced) whenever they change, so the search
    // overlay / search_past_sessions tool can see chat history too.
    void syncConversationsToFts();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useChatStore.subscribe(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void syncConversationsToFts(), 2000);
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, []);

  // Auto-restore the most recently used project on launch (Tauri desktop only —
  // browser mode has no stable path to reopen without the picker dialog).
  useEffect(() => {
    if (!isTauriEnv() || dirHandle) return;
    const last = useWorkspacesStore.getState().recent[0];
    if (!last) return;
    void (async () => {
      try {
        const ws = await openWorkspaceByPath(last.path);
        setWorkspace(ws.handle, ws.path, ws.name);
        toast.info(`Resumed workspace: ${ws.name}`, { duration: 2000 });
      } catch {
        useWorkspacesStore.getState().removeRecent(last.path);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-register any Settings > Privacy & Security "known folder" grants (Downloads,
  // Desktop, etc.) with the Rust confinement layer on launch — REGISTERED_ROOTS is
  // in-memory only and resets every process start, but the user's choice persists
  // in useAgentStore, so this replays it silently rather than requiring re-toggling.
  useEffect(() => {
    if (!isTauriEnv()) return;
    for (const path of Object.values(useAgentStore.getState().extraRoots)) {
      if (path) void invoke("register_workspace_root", { path }).catch(() => {});
    }
  }, []);

  // ─── Quick-invoke overlay (WP5.3) + result widget (WP5.4) ─────────────────
  //
  // The overlay webview (src/overlay/QuickInvoke.tsx) is a dumb input box —
  // it only emits a `quick-invoke` event with { prompt, mode } and never runs
  // any agent logic itself. This is where the actual work happens: "chat"
  // mode surfaces the main window and sends the prompt through the normal
  // handleSend path (via handleSendRef so we never call a stale closure);
  // "widget" mode fires a headless run via runHeadlessTask and reports
  // progress/outcome through the `quick-result` event to the result widget
  // (src/result/ResultWidget.tsx) instead — the main window is never shown.
  // Guarded by isTauriEnv() like the rest of the file's Tauri-only effects, so
  // browser dev mode never tries to subscribe.
  useEffect(() => {
    if (!isTauriEnv()) return;
    // hasRegion (WP7.1): true when the user circled a screen region via the
    // annotate overlay before submitting. See QUICK_INVOKE_REGION_PREAMBLE
    // below for why the handlers need this flag at all.
    const unlistenPromise = listen<{ prompt: string; mode: "chat" | "widget"; hasRegion?: boolean }>(
      "quick-invoke",
      (event) => {
        const { prompt, mode, hasRegion } = event.payload;
        if (mode === "chat") {
          void handleQuickInvokeChat(prompt, hasRegion ?? false);
        } else {
          void handleQuickInvokeWidget(prompt, hasRegion ?? false);
        }
      }
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Quick-invoke result-widget follow-up (WP7.3) ──────────────────────────
  //
  // The result widget (src/result/ResultWidget.tsx) stays as dumb as the
  // overlay above: once a quick-invoke "widget" answer is showing, a
  // follow-up question or the "Open in chat →" button just emits
  // `quick-followup` with the original prompt/answer and (if the user typed
  // one) a follow-up — it never touches the chat store or handleSend itself.
  // This is where the real work happens, same split as quick-invoke. Guarded
  // by isTauriEnv() and cleaned up on unmount like every other listener here.
  useEffect(() => {
    if (!isTauriEnv()) return;
    const unlistenPromise = listen<{ prompt: string; answer: string; followUp: string }>(
      "quick-followup",
      (event) => {
        const { prompt, answer, followUp } = event.payload;
        void handleQuickFollowup(prompt, answer, followUp);
      }
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Local IPC listener (WP5.4, result retrieval added WP6.4a) ────────────
  //
  // src-tauri/src/ipc.rs runs a loopback-only HTTP listener (127.0.0.1:41777,
  // bearer-token gated) so other local programs — the primary planned
  // consumer is the Python phone-agent (Telegram bridge) — can hand LocalMind
  // a task. The Rust side only validates the token/body and emits this
  // `ipc-task` event; it never executes anything itself. This is the ONLY
  // place that event is consumed, and all it does is push the task into the
  // existing task queue via the same `enqueue()` the send_task_to_tab tool
  // uses (see src/store/taskQueue.ts) — so an IPC-submitted task is subject
  // to exactly the same task-runner concurrency limit, SAFE_QUEUE_ALLOWLIST,
  // and workspace confinement as any other queued task (taskRunner.ts).
  // Reads live state via .getState() rather than closured component state,
  // same stale-closure care as the quick-invoke listener above. Unlike
  // quick-invoke, this DOES toast: the main window is the right place to
  // surface it, and a task silently appearing in the queue from an external
  // program is worse than a notification.
  //
  // WP6.4a: the event payload now also carries `id` — the id Rust generated
  // and already returned to the external caller in the `POST /task` HTTP
  // response, for later polling via `GET /task/{id}`. It's stored ON the
  // queued task as `externalId` (persisted with it, so a webview reload can't
  // orphan an in-flight task) and startIpcResultReporter reports the eventual
  // outcome back under it.
  useEffect(() => {
    if (!isTauriEnv()) return;
    const unlistenPromise = listen<{
      id: string;
      task: string;
      targetView?: string;
      expectSideEffects?: boolean;
    }>(
      "ipc-task",
      (event) => {
        const { id, task, targetView, expectSideEffects } = event.payload;
        // Validate against the real AppView list here (the Rust side passes
        // through whatever the caller sent, or "chat", without validating —
        // src/types/app.ts is the single source of truth for AppView).
        const view: AppView = APP_VIEWS.includes(targetView as AppView)
          ? (targetView as AppView)
          : "chat";
        // expectSideEffects comes from the sender (Rust defaults it to false
        // for IPC — see TaskRequest in ipc.rs). Conversational senders like the
        // Telegram relay would otherwise have every answered question reported
        // as a failure by the headless runtime's no-side-effects guard.
        useTaskQueueStore.getState().enqueue(view, task, view, id, expectSideEffects ?? false);
        const label = task.slice(0, 60) + (task.length > 60 ? "…" : "");
        toast.info(`Task received from an external program: "${label}"`);

        // taskRunner.processNextPending() silently leaves a task pending when
        // no workspace is open (it can't register a confinement root without
        // one) and waits for the workspacePath subscription to retrigger. In
        // the app that's fine — the queue banner shows it. Over IPC it's a
        // black hole: the caller gets 202, then polls "queued" forever with no
        // way to learn why. Report the reason so a remote client can say
        // something actionable instead of hanging.
        if (!useAgentStore.getState().workspacePath) {
          void invoke("ipc_report_task_result", {
            id,
            status: "queued",
            summary:
              "Waiting — no workspace folder is open in LocalMind, so queued tasks can't start. Open a folder in the app; this task will run automatically once you do.",
          }).catch((err) => {
            console.error("[ipc] no-workspace notice failed:", err);
          });
        }
      }
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleQuickInvokeChat(prompt: string, hasRegion: boolean): Promise<void> {
    // Surfacing the window is best-effort and must NEVER block the send. These
    // three calls each need their own capability permission in
    // capabilities/default.json (core:window:allow-show / allow-unminimize /
    // allow-set-focus — core:default does NOT include them), and a missing one
    // rejects. Left unguarded, that rejection reaches main.tsx's global
    // unhandledrejection handler, which replaces #root with a red error screen
    // — i.e. a permissions typo takes down the whole app instead of just
    // failing to raise the window. Swallow it and still deliver the prompt.
    try {
      const win = getCurrentWindow();
      await win.show();
      await win.unminimize();
      await win.setFocus();
    } catch (err) {
      console.error("[quick-invoke] could not surface the main window:", err);
    }
    setView("chat");
    // WP7.1: prepend the region preamble so the model knows to call
    // take_screenshot for the circled crop — see
    // QUICK_INVOKE_REGION_PREAMBLE's doc comment above for why this is the
    // only way it finds out. This does mean the preamble shows up as part of
    // the visible chat message (handleSend's `text` arg is both what's sent
    // and what's displayed) — an acceptable tradeoff for a one-line, clearly
    // worded sentence versus a bigger refactor to separate "sent" from
    // "shown" text.
    const task = hasRegion ? QUICK_INVOKE_REGION_PREAMBLE + prompt : prompt;
    // forceNewConversation=true: quick-invoke always starts a fresh
    // conversation rather than appending to whatever chat happens to be
    // active. handleSendRef.current is always the latest handleSend closure
    // (refreshed every render, see the assignment above), so this reads
    // current selectedModel/agentMode/etc. even though this listener itself
    // was registered once on mount.
    void handleSendRef.current?.(task, false, true);
  }

  // Handles `quick-followup` from the result widget (WP7.3): surfaces the
  // main window, seeds a NEW conversation with the widget's Q&A as history,
  // and — if the user typed a follow-up rather than just clicking "Open in
  // chat →" — sends it through the normal handleSend path so it appends to
  // that same conversation. Mirrors handleQuickInvokeChat above.
  async function handleQuickFollowup(prompt: string, answer: string, followUp: string): Promise<void> {
    // Same best-effort surfacing as handleQuickInvokeChat, same reason: each
    // call needs its own window-permission grant, and an unguarded rejection
    // here would reach main.tsx's global unhandledrejection handler and wipe
    // #root instead of just failing to raise the window.
    try {
      const win = getCurrentWindow();
      await win.show();
      await win.unminimize();
      await win.setFocus();
    } catch (err) {
      console.error("[quick-followup] could not surface the main window:", err);
    }
    setView("chat");

    // Seed a brand-new conversation rather than appending to whatever chat
    // happens to be active — the widget's answer came from a headless
    // quick-invoke run with no conversation of its own, so there is nothing
    // sensible for it to append to. useModelSelectionStore.getState() (not
    // the component's closured `selectedModel`) mirrors handleQuickInvokeWidget's
    // read-live-state pattern above.
    const model = useModelSelectionStore.getState().selectedModel;
    const convId = newConversation(model);
    // newConversation() sets activeId synchronously in the zustand store (see
    // store/chat.ts), but handleSend reads `activeId` from THIS component's
    // closured useChatStore() hook value, which only refreshes on the next
    // React render — so the id is passed to it explicitly below instead. Only
    // ChatMessage's actual fields (role/content[/images]) are needed — see
    // lib/ollama.ts; there's no id/timestamp on this type.
    addMessage(convId, { role: "user", content: prompt });
    addMessage(convId, { role: "assistant", content: answer });

    if (!followUp) return; // "Open in chat →" — nothing more to send.

    // Pass `convId` EXPLICITLY (handleSend's 4th arg) rather than relying on
    // handleSendRef's closured `activeId` catching up. The earlier draft
    // deferred this call by a macrotask and hoped React had committed the
    // store update by then — but React schedules its own work through the
    // scheduler package (MessageChannel), so the ordering between that and a
    // setTimeout(0) is an implementation detail, not a guarantee. Losing that
    // race would silently file the follow-up in the previously-active chat.
    // The override makes the target unambiguous and removes the timing
    // question entirely.
    void handleSendRef.current?.(followUp, false, false, convId);
  }

  // KM4d: "Ask about this in chat" from the Study tab's concept graph (and any
  // future similar entry point) — see store/chatSeed.ts's doc comment for why
  // this is a store-watched effect rather than a prop threaded down through
  // KnowledgeHub/ConceptGraph. Mirrors handleQuickFollowup just above: fresh
  // conversation, explicit convId (not the closured activeId), forceAgentMode
  // true so the model can actually call search_knowledge rather than just
  // streaming plain text.
  const pendingChatSeed = useChatSeedStore((s) => s.pending);
  useEffect(() => {
    if (!pendingChatSeed) return;
    const { systemPrompt, question } = pendingChatSeed;
    useChatSeedStore.getState().clearSeed();
    const model = useModelSelectionStore.getState().selectedModel;
    const convId = newConversation(model);
    updateSystemPrompt(convId, systemPrompt);
    setView("chat");
    void handleSendRef.current?.(question, true, false, convId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChatSeed]);

  // Best-effort wrapper around invoke("show_result_widget"): this crosses the
  // Rust boundary (a missing capability permission would reject), and left
  // unguarded a rejection here would hit main.tsx's global unhandledrejection
  // handler and wipe #root — same hazard as the window-surfacing calls in
  // handleQuickInvokeChat above. Swallow and log instead.
  //
  // `compact` selects which of the two sizes Rust resizes/re-anchors the
  // window to: true while a run is in flight (small loading pill, no prompt
  // text, no counter — nothing worth a big empty card), false for the final
  // done/error card. Always call this BEFORE emitting the matching
  // `quick-result` payload so the window is already the right size (and
  // re-anchored bottom-right) by the time the new content would render.
  async function showResultWidget(compact: boolean): Promise<void> {
    try {
      await invoke("show_result_widget", { compact });
    } catch (err) {
      console.error("[quick-invoke] show_result_widget failed:", err);
    }
  }

  // Fire a `quick-result` event for the result widget to render. Wrapped the
  // same way the overlay wraps its `quick-invoke` emit — logged, not thrown,
  // so a transient IPC failure can never crash the caller.
  function emitQuickResult(payload: { status: "running" | "done" | "error"; prompt: string; text?: string }): void {
    void emit("quick-result", payload).catch((err) =>
      console.error("[quick-invoke] quick-result emit failed:", err)
    );
  }

  async function handleQuickInvokeWidget(prompt: string, hasRegion: boolean): Promise<void> {
    // Read live store state rather than this component's (possibly stale,
    // mount-time) closured values — mirrors the exact pattern taskRunner.ts /
    // scheduler.ts use for their headless runs.
    const workspacePath = useAgentStore.getState().workspacePath;
    if (!workspacePath) {
      // This is a final error, not a running state, so it goes straight to
      // the expanded card rather than the compact pill. Reports through the
      // widget, not a toast — the main window is never surfaced for this
      // mode, so a toast would go unseen.
      await showResultWidget(false);
      emitQuickResult({
        status: "error",
        prompt,
        text: "Quick invoke needs a workspace — open a workspace folder first, then try again.",
      });
      return;
    }
    const modelRef = useModelSelectionStore.getState().selectedModel;
    const hardware = useModelStore.getState().hardware;
    const numCtxOverride = useSettingsStore.getState().numCtxOverride;

    await showResultWidget(true);
    // Widget display always shows the user's original, undecorated prompt —
    // only the `task` string handed to runHeadlessTask below gets the WP7.1
    // region preamble prepended. Keeping emitQuickResult's `prompt` clean
    // means the widget never shows the model-facing instructions as if the
    // user had typed them.
    emitQuickResult({ status: "running", prompt });
    const task = hasRegion ? QUICK_INVOKE_REGION_PREAMBLE + prompt : prompt;

    try {
      const { record, transcript } = await runHeadlessTask({
        workspacePath,
        modelRef,
        task,
        hardware,
        numCtxOverride,
        currentView: "chat",
        origin: "quick-invoke",
        agentBuildMode: true,
        // SAFE_QUEUE_ALLOWLIST (task queue, WP2.1) plus the read-only
        // screen-observation tools — see QUICK_INVOKE_ALLOWLIST's definition
        // above for why. Still never run_command/install_deps/git_add/
        // git_commit, and never the system-acting tools (set_clipboard,
        // focus_window, open_application) without a human present.
        toolAllowlist: QUICK_INVOKE_ALLOWLIST,
        // Deliberately FALSE, unlike taskRunner/scheduler. Those fire tasks
        // the user authored specifically to change something, so a run that
        // mutates nothing is a real failure (headlessRunner forces
        // outcome:"error" when expectSideEffects && !hadSideEffects). A
        // quick-invoke prompt is arbitrary free text typed a second ago —
        // "what's in my README", "how big is the build" — and answering it
        // without touching a file is a correct outcome, not a failure.
        expectSideEffects: false,
      });
      // The result widget is the only surface for this mode now — no OS
      // notification, no toast (WP5.4). Grow to the full card before
      // delivering the content that needs the room to show it in.
      await showResultWidget(false);
      // `transcript`, NOT `record.summary` — summary is hard-capped at 500
      // chars by headlessRunner (it exists to label a row in the Logs tab),
      // which chopped real answers off mid-sentence in the widget. The widget
      // is the ONLY place this text is ever shown for a quick invoke, so it
      // gets the full answer; its body already scrolls. Fall back to summary
      // if the transcript came back empty.
      const answer = transcript.trim() || record.summary;
      if (record.outcome === "error") {
        emitQuickResult({ status: "error", prompt, text: answer });
      } else {
        emitQuickResult({ status: "done", prompt, text: answer });
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      await showResultWidget(false);
      emitQuickResult({ status: "error", prompt, text: message });
    }
  }

  async function initOllama() {
    const providers = useProvidersStore.getState().providers;
    const providerModels = providers
      .filter((p) => p.enabled && p.models.length > 0)
      .flatMap((p) => p.models.map((m) => formatModelRef(p.id, m)));

    // Retry connecting — Ollama may still be booting after auto-start
    const MAX_ATTEMPTS = 15;
    const RETRY_MS = 1500;
    let ollamaModels: import("./lib/ollama").OllamaModel[] = [];
    let connected = false;

    setOllamaError("Starting Ollama…");

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        ollamaModels = await listModels();
        connected = true;
        break;
      } catch {
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    }

    if (!connected) {
      if (providerModels.length > 0) {
        setModels(providerModels);
        setSelectedModel(providerModels[0]);
        setOllamaError(null);
        toast.info(`Ollama offline — ${providerModels.length} provider model${providerModels.length !== 1 ? "s" : ""} available`);
      } else {
        setOllamaError("Cannot reach Ollama at localhost:11434 — is it installed?");
      }
      return;
    }

    const ollamaNames = ollamaModels.map((m) => m.name);
    const all = [...ollamaNames, ...providerModels];
    setModels(all);
    // Keep the restored choice if that model still exists; only fall back to
    // the first entry when there's nothing valid to keep. Overwriting
    // unconditionally (the previous behavior) meant an explicit pick was
    // silently replaced on every launch — and since this store is the
    // `primary` model role, that quietly changed which model ran every agent
    // task and scheduled job.
    if (all.length > 0) {
      const restored = useModelSelectionStore.getState().selectedModel;
      if (!restored || !all.includes(restored)) setSelectedModel(all[0]);
    }
    setOllamaError(null);

    // Probe real tool/vision capabilities from Ollama in the background —
    // never blocks model-list loading; supportsNativeTools()/isVisionModel()
    // fall back to their name heuristics until this resolves.
    void probeAllModels(ollamaNames);

    const provCount = providerModels.length;
    toast.success(
      `Ollama ready — ${ollamaNames.length} local model${ollamaNames.length !== 1 ? "s" : ""}` +
      (provCount > 0 ? ` + ${provCount} provider model${provCount !== 1 ? "s" : ""}` : "")
    );

    // Auto-pull nomic-embed-text for vector memory if not already installed
    const EMBED_MODEL = "nomic-embed-text";
    const hasEmbedModel = ollamaNames.some((n) => n.startsWith(EMBED_MODEL));
    if (!hasEmbedModel) {
      void pullEmbedModelSilently(EMBED_MODEL);
    }
  }

  async function pullEmbedModelSilently(model: string) {
    const toastId = toast.loading(`Pulling ${model} for vector memory…`, { duration: Infinity });
    try {
      for await (const update of pullModel(model)) {
        if (update.done) break;
      }
      toast.dismiss(toastId);
      toast.success(`${model} ready — vector memory enabled`);
      // Refresh model list so it appears in ModelManager
      const refreshed = await listModels();
      const ollamaNames = refreshed.map((m) => m.name);
      const currentAll = useChatStore.getState().availableModels;
      const providers = currentAll.filter((m) => m.includes("::"));
      setModels([...ollamaNames, ...providers]);
    } catch {
      toast.dismiss(toastId);
      // Non-fatal: vector memory falls back to keyword search
    }
  }

  // ─── Agent: open directory picker ────────────────────────────────────────

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

  // ─── Normal send (non-agent) ──────────────────────────────────────────────

  async function handleSend(
    text: string,
    forceAgentMode = false,
    forceNewConversation = false,
    // Explicit target conversation, overriding both `activeId` and
    // `forceNewConversation` (WP7.3). Exists because `activeId` here is a
    // CLOSURED value from this component's useChatStore() hook, refreshed only
    // on the next React render — so an imperative caller that just created a
    // conversation via the store (handleQuickFollowup) cannot rely on this
    // closure knowing about it yet. Timing tricks (deferring the call a
    // macrotask and hoping React has committed) are a race against React's
    // internal scheduler; passing the id is not.
    conversationIdOverride?: string,
  ) {
    if (!selectedModel) return;

    // Abort any still-in-flight session before starting a new one. Covers the
    // "hit Stop then immediately send" path: without this the old loop can keep
    // running and interleave with (or clobber the streaming state of) the new
    // one, leaving the next message with no visible response. abortRef is only
    // non-null while a session is genuinely live (its finally nulls it).
    if (abortRef.current) abortRef.current.abort();

    // Model recommendation — only toast if the suggestion is new
    const rec = recommendModel(text, attachedImages.length > 0, availableModels, selectedModel, hardware);
    if (rec) {
      const recKey = `${rec.model}:${rec.taskLabel}`;
      if (lastRecRef.current !== recKey) {
        lastRecRef.current = recKey;
        toast(`Switch to ${rec.model}?`, {
          description: `Better suited for ${rec.reason}`,
          duration: 10000,
          action: {
            label: "Switch",
            onClick: () => setSelectedModel(rec.model),
          },
        });
      }
    }

    // forceNewConversation (quick-invoke "open in chat", see the effect below)
    // always starts a fresh conversation instead of appending to whatever's
    // currently active.
    let convId = conversationIdOverride ?? (forceNewConversation ? null : activeId);
    if (!convId) convId = newConversation(selectedModel);
    activeConvIdRef.current = convId;

    // Build user message — inject images if present
    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      ...(attachedImages.length > 0 ? { images: [...attachedImages] } : {}),
    };
    addMessage(convId, userMsg);
    setAttachedImages([]);

    // Snapshot history after adding the user message
    let history = useChatStore
      .getState()
      .conversations.find((c) => c.id === convId)!.messages;

    // Prepend system prompt if set
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId)!;
    if (conv.systemPrompt) {
      history = [{ role: "system", content: conv.systemPrompt }, ...history];
    }

    // Web search: fetch results and inject as a system message
    if (webSearchEnabled) {
      setIsSearching(true);
      try {
        const ctx = await searchWeb(text);
        history = [
          ...history.slice(0, -1),
          { role: "system", content: ctx.formatted },
          history[history.length - 1],
        ];
      } catch (err) {
        console.warn("Web search failed, continuing without it:", err);
      } finally {
        setIsSearching(false);
      }
    }

    // Auto-escalate clearly-actionable messages to the agent even when the
    // manual toggle is off. Normal chat sends the model ZERO tools, so a
    // capable local model can only narrate ("go to the Settings tab…") instead
    // of acting — the exact "it tells me how instead of doing it" failure. The
    // instant heuristic (no model round-trip, so casual chat stays fast) flags
    // requests with a file/path reference or a build verb; on a confident
    // "build" we run the agent and flip the visible toggle on.
    let useAgent = agentMode || forceAgentMode;
    if (!useAgent && supportsNativeTools(selectedModel) && heuristicIntent(text) === "build") {
      useAgent = true;
      setAgentMode(true);
      toast.info("Acting on this — agent mode on", { duration: 2000 });
    }

    if (useAgent) {
      // Fresh agent task — require approval again from scratch.
      autoApproveRemainingRef.current = false;
      // Route conversational/meta messages (e.g. "what can you do?") to the
      // restricted agent so they get a direct answer instead of resuming the
      // open folder's stale todos/plan. A queued task (forceAgentMode) is
      // always a real build task — skip classification. When we auto-escalated
      // above, the heuristic already judged this a build task, so skip the
      // (model-round-trip) classifier and go straight to building.
      const conversational =
        forceAgentMode || (!agentMode)
          ? false
          : (await classifyIntent(text, selectedModel)) === "chat";
      await runAgentLoop(convId, history, conversational);
    } else {
      // Give the model baseline awareness of LocalMind/workspace/hardware —
      // without this, normal chat has zero context and acts like a generic chatbot.
      let memoryBlock: string | undefined;
      try {
        memoryBlock = formatMemoriesForContext(await searchMemory(text, 3, 0.35)) || undefined;
      } catch {
        memoryBlock = undefined;
      }
      const identity = buildIdentitySystemPrompt(selectedModel, hardware, dirHandle?.name ?? null, workspacePath, memoryBlock);
      await runNormalChat(convId, [{ role: "system", content: identity }, ...history]);
    }
  }

  // Refresh on every render (not inside an effect) so it's always the latest
  // closure by the time the quick-invoke listener (mounted once, below) fires.
  handleSendRef.current = handleSend;

  // ─── Normal (non-agent) streaming ────────────────────────────────────────

  async function runNormalChat(convId: string, history: ChatMessage[]) {
    addMessage(convId, { role: "assistant", content: "" });
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const chunk of streamChatForModel(selectedModel, history, controller.signal)) {
        appendToLastMessage(convId, chunk);
      }
      const updatedConv = useChatStore.getState().conversations.find((c) => c.id === convId)!;
      if (updatedConv.title === "New Chat") {
        const words = history[history.length - 1].content
          .trim()
          .split(/\s+/)
          .slice(0, 6)
          .join(" ");
        updateTitle(
          convId,
          words +
            (history[history.length - 1].content.trim().split(/\s+/).length > 6 ? "…" : "")
        );
      }
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name !== "AbortError") appendToLastMessage(convId, `\n\n*[Error: ${e.message}]*`);
    } finally {
      // Only clear shared state if we still own it — a newer session may have
      // replaced abortRef after a Stop-then-resend, and must not be clobbered.
      if (abortRef.current === controller) {
        setStreaming(false);
        abortRef.current = null;
      }
    }
  }

  // ─── Agent loop ───────────────────────────────────────────────────────────

  async function runAgentLoop(convId: string, history: ChatMessage[], conversational = false) {
    const mcpTools = useMcpStore.getState().getEnabledTools();
    const enabledTools = await assembleSessionTools({ dirHandle, toolsEnabled, mcpTools });

    const toolsSupported = supportsNativeTools(selectedModel);
    const effectiveHardware = vramOverride != null && hardware ? { ...hardware, vramGb: vramOverride } : hardware;

    addMessage(convId, { role: "assistant", content: "" });
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const sessionResult = await runAgentSession(history, {
        modelRef: selectedModel,
        hardware: effectiveHardware,
        numCtxOverride,
        dirHandle,
        workspacePath,
        workspaceName: dirHandle?.name ?? null,
        currentView: "chat",
        tools: enabledTools,
        agentBuildMode: true,
        autoApproveAll: false,
        toolsSupported,
        maxRounds: DEFAULT_MAX_ROUNDS,
        conversational,

        onTextDelta: (chunk) => {
          appendToLastMessage(convId, chunk);
        },

        onTextReplace: (cleanText) => {
          setLastMessageContent(convId, cleanText);
        },

        onToolCallStart: () => {},

        onApprovalNeeded: (call) => {
          if (autoApproveRemainingRef.current) return Promise.resolve(true);
          setPendingToolCalls([call]);
          return new Promise<boolean>((resolve) => {
            approvalResolverRef.current = resolve;
            controller.signal.addEventListener("abort", () => resolve(false), { once: true });
          });
        },

        onToolCallResolved: (call, _label, _result, _summary, toolContent) => {
          addMessage(convId, {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: call.name, arguments: call.args } }],
          });
          addMessage(convId, { role: "tool", content: toolContent });
        },

        onRoundStart: (round) => {
          if (round > 1) addMessage(convId, { role: "assistant", content: "" });
        },

        signal: controller.signal,
      });

      if (sessionResult.hitRoundLimit) {
        addMessage(convId, {
          role: "assistant",
          content: `Reached the ${DEFAULT_MAX_ROUNDS}-round limit. Ask me to continue if needed.`,
        });
      }

      // Auto-title
      const updatedConv = useChatStore.getState().conversations.find((c) => c.id === convId);
      if (updatedConv?.title === "New Chat") {
        const firstUserMsg = updatedConv.messages.find((m) => m.role === "user");
        if (firstUserMsg) {
          const words = firstUserMsg.content.trim().split(/\s+/).slice(0, 6).join(" ");
          updateTitle(
            convId,
            words + (firstUserMsg.content.trim().split(/\s+/).length > 6 ? "…" : "")
          );
        }
      }
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name !== "AbortError") appendToLastMessage(convId, `\n\n*[Error: ${e.message}]*`);
    } finally {
      // Only clear shared state if we still own it — a newer session started by
      // a Stop-then-resend must not have its streaming/abort state clobbered by
      // this (older) session's late cleanup.
      if (abortRef.current === controller) {
        setStreaming(false);
        clearPendingToolCalls();
        abortRef.current = null;
      }
    }
  }

  // ─── Approve pending tool call ───────────────────────────────────────────

  function handleApproveAll() {
    clearPendingToolCalls();
    autoApproveRemainingRef.current = true;
    approvalResolverRef.current?.(true);
    approvalResolverRef.current = null;
  }

  // ─── Deny the pending tool call ──────────────────────────────────────────

  function handleDenyCall() {
    clearPendingToolCalls();
    approvalResolverRef.current?.(false);
    approvalResolverRef.current = null;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="relative h-screen w-full bg-background overflow-hidden">
      {/* Paper grain overlay — subtle fractal-noise texture from the Nucleus
          design reference. Must paint ON TOP (a negative z-index puts it under
          every opaque surface, i.e. invisible); `pointer-events-none` is what
          keeps it from intercepting clicks. */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          zIndex: 200,
          opacity: 0.02,
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='250' height='250'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")",
          backgroundSize: "250px 250px",
        }}
      />
      <Toaster
        position="top-right"
        theme="system"
        gap={8}
        toastOptions={{
          duration: 3500,
          classNames: {
            toast:
              "!bg-card !border !border-border !text-foreground !shadow-md !rounded-lg !font-sans",
            title: "!text-foreground !text-sm !font-medium",
            description: "!text-muted-foreground !text-xs",
            actionButton: "!bg-primary !text-primary-foreground !rounded-md !text-xs",
            cancelButton: "!bg-muted !text-muted-foreground !rounded-md !text-xs",
            closeButton: "!bg-transparent !border-border !text-muted-foreground",
            success: "!border-l-2 !border-l-emerald-500",
            error: "!border-l-2 !border-l-destructive",
            info: "!border-l-2 !border-l-primary",
          },
        }}
      />

      {/* ── THE MORPHING ISLAND ── floating pill shell, replaces the old
          sidebar + main-column layout. Ported from designs/src/App.tsx. */}
      <div style={islandStyle}>
        {!isIslandExpanded && (
          <div className="flex items-center justify-center h-full px-5 gap-2">
            <span className="text-white/90 text-[11px] font-medium tracking-wide">LocalMind</span>
          </div>
        )}

        {isIslandExpanded && (
          <>
            {/* Windowed / fullscreen toggle — pinned to the island's top-right
                corner, visible across all 15 views (lives in the shell here,
                not per-view). CSS/layout fullscreen only — no Tauri window
                APIs are touched. */}
            <button
              type="button"
              onClick={() => setIsFullscreen((v) => !v)}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              // z-40: must clear the Nucleus row (z-30), which spans the full
              // island width at this same vertical band and would otherwise
              // swallow the click.
              className="absolute top-3 right-3 z-40 size-7 rounded-full flex items-center justify-center text-black/30 hover:text-black/60 hover:bg-black/5 transition-colors"
            >
              {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </button>

            <Nucleus
              view={view}
              onViewChange={setView}
              selectedModel={selectedModel}
              isStreaming={isStreaming}
              isSearching={isSearching}
              agentMode={agentMode}
              onToggleChatSidebar={() => setChatSidebarOpen((v) => !v)}
            />

            {/* Hairline divider */}
            <div className="mx-4 mt-3 border-t border-black/[0.05] shrink-0" />

            {/* Content area — relative so the chat view's side panels (chat
                sidebar / file tree / preview) can size themselves as real
                flex siblings without fighting the island's adaptive width
                for space (the island itself widens instead, see
                expandedWidth/openChatPanelCount above). */}
            <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
              {view === "chat" ? (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Persistent chat sidebar — real flex sibling on the left,
                leftmost of the chat-view panels (recent chats/new chat,
                model switching, MCP). Toggled via the Nucleus's history icon
                (onToggleChatSidebar); replaces the old slide-over ChatDrawer. */}
            {chatSidebarOpen && (
              <div className="w-64 shrink-0 border-r bg-card overflow-hidden">
                <ChatSidePanel selectedModel={selectedModel} onModelChange={setSelectedModel} />
              </div>
            )}

            {/* File tree — a real flex sibling on the left of the chat column
                (not an absolute overlay) whenever it's toggled on; the island
                widens to make room for it (see expandedWidth/chatPanelsOpen
                above), exactly like the pre-island layout did. */}
            {showFileTree && dirHandle && (
              <div className="w-56 shrink-0 border-r bg-card overflow-hidden">
                <FileTree
                  dirHandle={dirHandle}
                  onOpenFile={(handle, path) => setPreviewFile({ handle, path })}
                  onOpenDir={() => void handleOpenDir()}
                />
              </div>
            )}

            <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
              {/* Top bar */}
              <div className="h-14 border-b bg-card px-4 flex items-center justify-between shrink-0">
                <h2 className="text-sm font-medium truncate">
                  {activeConv?.title ?? "AI Chat"}
                </h2>
                <div className="flex items-center gap-0.5">
                  {/* File tree toggle */}
                  {dirHandle && (
                    <button
                      type="button"
                      onClick={() => setShowFileTree((v) => !v)}
                      title={showFileTree ? "Hide file tree" : "Show file tree"}
                      className={`size-8 flex items-center justify-center rounded-md transition-colors ${
                        showFileTree
                          ? "text-primary bg-accent"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent"
                      }`}
                    >
                      <FolderTree className="size-4" />
                    </button>
                  )}
                  {/* Research feature ideas */}
                  {dirHandle && (
                    <button
                      type="button"
                      onClick={() => {
                        setAgentMode(true);
                        const steering = featureIdeasSteering.trim();
                        void handleSend(
                          `Research new feature ideas for LocalMind. Use web_search/web_fetch to see ` +
                          `what similar tools (Claude Code, Cursor, other local-LLM agent apps) are ` +
                          `doing well. Re-read the "About LocalMind" section of your system prompt ` +
                          `so you don't suggest things that already exist.\n` +
                          (steering ? `Steering from the user: ${steering}\n` : "") +
                          `Then pick the 5 best, most concrete features and, for EACH one, call the ` +
                          `propose_feature tool with a title, motivation, proposed_files, ` +
                          `acceptance_criteria, size_guess (S/M/L), and a detailed body. These become ` +
                          `individually reviewable specs under Settings → Feature Proposals. Do NOT ` +
                          `write FEATURE_IDEAS.md — use propose_feature so each idea can be approved on its own.`,
                          true
                        );
                      }}
                      title="Research feature ideas and draft them as reviewable proposals (Settings → Feature Proposals)"
                      className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      <Lightbulb className="size-4" />
                    </button>
                  )}
                  {/* TTS toggle */}
                  <button
                    type="button"
                    onClick={() => {
                      const next = !ttsEnabled;
                      setTtsEnabled(next);
                      if (!next) speechSynthesis.cancel();
                    }}
                    title={ttsEnabled ? "Text-to-speech ON — click to disable" : "Enable text-to-speech"}
                    className={`size-8 flex items-center justify-center rounded-md transition-colors ${
                      ttsEnabled
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                  >
                    {ttsEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                  </button>
                  {activeId && (
                    <button
                      type="button"
                      onClick={() => setSystemPromptOpen(true)}
                      title="Edit system prompt"
                      className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      <SlidersHorizontal className="size-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Error banner */}
              {ollamaError && (
                <div className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-destructive text-xs shrink-0">
                  <AlertCircle className="size-3.5 shrink-0" />
                  {ollamaError}
                </div>
              )}

              <ChatMessages messages={activeConv?.messages ?? []} isStreaming={isStreaming} />

              {/* Pending tool call approvals */}
              {pendingToolCalls.length > 0 && (
                <div className="border-t bg-card px-4 py-3 space-y-2 shrink-0 max-h-64 overflow-y-auto">
                  <div className="text-xs font-medium text-foreground mb-1">
                    Tool call awaiting approval
                  </div>
                  {pendingToolCalls.map((call) => (
                    <ToolCallCard
                      key={call.id}
                      call={call}
                      onApprove={() => void handleApproveAll()}
                      onDeny={() => handleDenyCall()}
                    />
                  ))}
                </div>
              )}

              <QueuedTaskBanner
                view="chat"
                onStart={(task) => {
                  setAgentMode(true);
                  void handleSend(task, true);
                }}
              />

              <ChatInput
                onSend={(text) => void handleSend(text)}
                onStop={() => abortRef.current?.abort()}
                isStreaming={isStreaming}
                isSearching={isSearching}
                disabled={!selectedModel}
                webSearchEnabled={webSearchEnabled}
                onToggleWebSearch={() => setWebSearchEnabled((v) => !v)}
                agentMode={agentMode}
                onToggleAgentMode={() => {
                  const next = !agentMode;
                  setAgentMode(next);
                  toast.info(next ? "Agent mode ON — model can use tools" : "Agent mode OFF", { duration: 2500 });
                }}
                agentToolbarSlot={
                  <AgentToolbar
                    enabled={toolsEnabled}
                    onToggle={(name) => setToolEnabled(name, !toolsEnabled[name])}
                    dirHandle={dirHandle}
                    onOpenDir={() => void handleOpenDir()}
                  />
                }
                attachedImages={attachedImages}
                onAttachImages={(b64s) => setAttachedImages((prev) => [...prev, ...b64s])}
                onRemoveImage={(i) =>
                  setAttachedImages((prev) => prev.filter((_, idx) => idx !== i))
                }
              />
            </div>

            {/* File preview panel — read-only widget so the agent's file work
                (or anything the user browses via the tree) can be viewed inline
                without switching to the Code tab / Monaco. Real flex sibling
                on the right of the chat column, like the tree above. */}
            {previewFile && (
              <div className="w-96 shrink-0 border-l bg-card overflow-hidden">
                <FilePreviewPanel
                  handle={previewFile.handle}
                  path={previewFile.path}
                  onClose={() => setPreviewFile(null)}
                />
              </div>
            )}
          </div>
              ) : null}

              {/* Code Editor — always mounted after first visit so agent loops survive tab switches */}
              {(view === "code" || mountedViews.has("code")) && (
                <div className={view === "code" ? "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden" : "hidden"}>
                  <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading editor…</div>}>
                    <CodeEditor selectedModel={selectedModel} isActive={view === "code"} />
                  </Suspense>
                </div>
              )}

              {/* Other views fully unmount on tab switch (no mountedViews
                  persistence, unlike chat/code above) — safe to key by view
                  for a subtle re-entry animation using the existing msgIn
                  keyframe (already defined globally, see src/index.css). */}
              {view !== "chat" && view !== "code" && (
                <div key={view} className="flex-1 min-h-0 flex flex-col overflow-hidden" style={{ animation: "msgIn 0.25s cubic-bezier(0.34, 1.2, 0.64, 1)" }}>
                  {view === "docs" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading editor…</div>}>
                      <DocEditor />
                    </Suspense>
                  ) : view === "terminal" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading terminal…</div>}>
                      <Terminal />
                    </Suspense>
                  ) : view === "agents" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading agents…</div>}>
                      <SubagentManager />
                    </Suspense>
                  ) : view === "research" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <DeepResearch selectedModel={selectedModel} />
                    </Suspense>
                  ) : view === "study" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <KnowledgeHub />
                    </Suspense>
                  ) : view === "image" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading editor…</div>}>
                      <ImageEditor selectedModel={selectedModel} />
                    </Suspense>
                  ) : view === "skills" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <SkillRegistry />
                    </Suspense>
                  ) : view === "workflows" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <Workflows />
                    </Suspense>
                  ) : view === "history" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <HistoryView />
                    </Suspense>
                  ) : view === "benchmarks" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <BenchmarkRunner selectedModel={selectedModel} />
                    </Suspense>
                  ) : view === "compare" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <Compare />
                    </Suspense>
                  ) : view === "memory" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <MemoryView />
                    </Suspense>
                  ) : view === "logs" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <AgentLogs />
                    </Suspense>
                  ) : view === "settings" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <AppSettings />
                    </Suspense>
                  ) : (
                    <ModelManager onUseModel={handleUseModel} />
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <ConversationSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(id) => { selectConversation(id); setView("chat"); setSearchOpen(false); }}
        onSelectPastSession={() => setView("logs")}
      />

      {/* System prompt dialog */}
      {activeId && (
        <SystemPromptDialog
          open={systemPromptOpen}
          onClose={() => setSystemPromptOpen(false)}
          convId={activeId}
        />
      )}

      {/* First-run welcome — explains the workspace concept and tab set,
          since a brand-new user otherwise lands in an empty chat view with
          no orientation at all. */}
      {!hasCompletedOnboarding && <Onboarding ollamaError={ollamaError} />}
    </div>
  );
}
