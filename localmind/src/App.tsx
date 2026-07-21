import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, SlidersHorizontal, Volume2, VolumeX, Lightbulb, FolderTree } from "lucide-react";
import { toast, Toaster } from "sonner";
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
import { startTaskRunner } from "./lib/taskRunner";
import { initScheduler } from "./lib/scheduler";
import { initMcpAutoConnect } from "./lib/mcpAutoConnect";
import { initTrayIntegration } from "./lib/trayIntegration";
import { syncConversationsToFts } from "./lib/sessionSearch";
import { QueuedTaskBanner } from "./components/QueuedTaskBanner";
import { Nucleus } from "./components/Nucleus";
import { ChatDrawer } from "./components/ChatDrawer";
import { ConversationSearch } from "./components/ConversationSearch";
import { ChatMessages } from "./components/ChatMessages";
import { ChatInput } from "./components/ChatInput";
import { ModelManager } from "./components/ModelManager";
import { AgentToolbar } from "./components/AgentToolbar";
import { ToolCallCard } from "./components/ToolCallCard";
import { SystemPromptDialog } from "./components/SystemPromptDialog";
import { FileTree } from "./components/FileTree";
import { FilePreviewPanel } from "./components/FilePreviewPanel";
import { lazy, Suspense } from "react";
import { VIEW_WIDTH } from "./types/app";

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
const StudyMode = lazy(() =>
  import("./components/StudyMode").then((m) => ({ default: m.StudyMode }))
);
const ImageEditor = lazy(() =>
  import("./components/ImageEditor").then((m) => ({ default: m.ImageEditor }))
);
const SkillRegistry = lazy(() =>
  import("./components/SkillRegistry").then((m) => ({ default: m.SkillRegistry }))
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
  const { numCtxOverride, featureIdeasSteering } = useSettingsStore();

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
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);

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

  const isIslandExpanded = pillState === "expanded";
  const isIslandCompact = pillState === "compact";
  const isWideView = VIEW_WIDTH[view] === "wide";

  const islandStyle: CSSProperties = {
    position: "fixed",
    top: "18px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 50,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    width: isIslandExpanded
      ? isWideView
        ? "min(1400px, calc(100vw - 24px))"
        : "min(580px, calc(100vw - 24px))"
      : isIslandCompact
      ? "160px"
      : "0px",
    height: isIslandExpanded ? "calc(100vh - 36px)" : isIslandCompact ? "40px" : "0px",
    borderRadius: isIslandExpanded ? "26px" : "9999px",
    background: isIslandExpanded ? "var(--card)" : "#0A0A0A",
    border: isIslandExpanded ? "1px solid rgba(0,0,0,0.09)" : "1px solid transparent",
    boxShadow: isIslandExpanded
      ? "0 8px 60px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)"
      : "0 2px 16px rgba(0,0,0,0.18)",
    transition: [
      "width 0.65s cubic-bezier(0.34, 1.12, 0.64, 1)",
      "height 0.65s cubic-bezier(0.34, 1.12, 0.64, 1)",
      "border-radius 0.65s cubic-bezier(0.34, 1.12, 0.64, 1)",
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

  // Boot the global task-queue runner once — it drains pending tasks (queued
  // via send_task_to_tab) through the headless agent runtime unattended, and
  // watches for workspace-open so tasks queued before a workspace existed
  // start automatically once one is available.
  useEffect(() => {
    startTaskRunner();
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
    if (all.length > 0) setSelectedModel(all[0]);
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

  async function handleSend(text: string, forceAgentMode = false) {
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

    let convId = activeId;
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
            <Nucleus
              view={view}
              onViewChange={setView}
              selectedModel={selectedModel}
              isStreaming={isStreaming}
              isSearching={isSearching}
              agentMode={agentMode}
              onToggleDrawer={() => setChatDrawerOpen((v) => !v)}
            />

            {/* Hairline divider */}
            <div className="mx-4 mt-3 border-t border-black/[0.05] shrink-0" />

            {/* Content area — relative so the chat drawer (and, within the
                chat view, the file tree / preview flyouts) can overlay it
                without fighting the island's adaptive width for space. */}
            <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
              {view === "chat" ? (
          <div className="relative flex flex-1 min-h-0 overflow-hidden">
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

              {/* Agent toolbar */}
              {agentMode && (
                <AgentToolbar
                  enabled={toolsEnabled}
                  onToggle={(name) => setToolEnabled(name, !toolsEnabled[name])}
                  dirHandle={dirHandle}
                  onOpenDir={() => void handleOpenDir()}
                />
              )}

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
                attachedImages={attachedImages}
                onAttachImages={(b64s) => setAttachedImages((prev) => [...prev, ...b64s])}
                onRemoveImage={(i) =>
                  setAttachedImages((prev) => prev.filter((_, idx) => idx !== i))
                }
              />
            </div>

            {/* File tree — narrow-view adaptation: the island's adaptive width
                (580px for chat) can't fit a side-by-side tree + chat + preview
                layout like the old wide sidebar shell could, so this and the
                preview panel below slide over the chat as flyouts instead of
                claiming permanent width. Toggle/open behavior is unchanged. */}
            {showFileTree && dirHandle && (
              <div className="absolute inset-y-0 left-0 z-10 w-56 max-w-[70%] border-r bg-card overflow-hidden shadow-[4px_0_20px_rgba(0,0,0,0.08)]">
                <FileTree
                  dirHandle={dirHandle}
                  onOpenFile={(handle, path) => setPreviewFile({ handle, path })}
                  onOpenDir={() => void handleOpenDir()}
                />
              </div>
            )}

            {/* File preview panel — read-only widget so the agent's file work
                (or anything the user browses via the tree) can be viewed inline
                without switching to the Code tab / Monaco. */}
            {previewFile && (
              <div className="absolute inset-y-0 right-0 z-10 w-96 max-w-[85%] overflow-hidden shadow-[-4px_0_20px_rgba(0,0,0,0.08)]">
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
                      <StudyMode selectedModel={selectedModel} />
                    </Suspense>
                  ) : view === "image" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading editor…</div>}>
                      <ImageEditor selectedModel={selectedModel} />
                    </Suspense>
                  ) : view === "skills" ? (
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
                      <SkillRegistry />
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

              {/* Recent-chats drawer — overlays whichever view is currently
                  visible; toggled by the icon button next to the Nucleus. */}
              <ChatDrawer
                open={chatDrawerOpen}
                onClose={() => setChatDrawerOpen(false)}
                selectedModel={selectedModel}
              />
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
    </div>
  );
}
