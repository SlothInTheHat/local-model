import { useEffect, useRef, useState } from "react";
import { AlertCircle, SlidersHorizontal, Volume2, VolumeX, Lightbulb } from "lucide-react";
import { toast, Toaster } from "sonner";
import { recommendModel } from "./lib/modelRecommender";
import { listModels, pullModel } from "./lib/ollama";
import type { ChatMessage } from "./lib/ollama";
import { searchWeb } from "./lib/search";
import { runAgentSession, DEFAULT_MAX_ROUNDS } from "./lib/agentRuntime";
import { streamChatForModel, formatModelRef } from "./lib/chatProvider";
import { getToolDefinitions, setSystemInfoContext } from "./lib/tools";
import { supportsNativeTools } from "./lib/modelCapabilities";
import { useModelStore } from "./store/models";
import { useSettingsStore } from "./store/settings";
import { useMcpStore } from "./store/mcp";
import { useProvidersStore } from "./store/providers";
import { openWorkspace } from "./lib/fileSystem";
import { useChatStore } from "./store/chat";
import { useAgentStore } from "./store/agent";
import { useAppViewStore } from "./store/appView";
import { useModelSelectionStore } from "./store/modelSelection";
import { QueuedTaskBanner } from "./components/QueuedTaskBanner";
import { ChatSidebar } from "./components/ChatSidebar";
import { ConversationSearch } from "./components/ConversationSearch";
import { ChatMessages } from "./components/ChatMessages";
import { ChatInput } from "./components/ChatInput";
import { ModelManager } from "./components/ModelManager";
import { AgentToolbar } from "./components/AgentToolbar";
import { ToolCallCard } from "./components/ToolCallCard";
import { SystemPromptDialog } from "./components/SystemPromptDialog";
import { lazy, Suspense } from "react";

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
  const [ttsEnabled, setTtsEnabled] = useState(false);

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

    if (agentMode || forceAgentMode) {
      // Fresh agent task — require approval again from scratch.
      autoApproveRemainingRef.current = false;
      await runAgentLoop(convId, history);
    } else {
      await runNormalChat(convId, history);
    }
  }

  // ─── Normal (non-agent) streaming ────────────────────────────────────────

  async function runNormalChat(convId: string, history: ChatMessage[]) {
    addMessage(convId, { role: "assistant", content: "" });
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      for await (const chunk of streamChatForModel(selectedModel, history, abortRef.current.signal)) {
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
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // ─── Agent loop ───────────────────────────────────────────────────────────

  async function runAgentLoop(convId: string, history: ChatMessage[]) {
    const mcpTools = useMcpStore.getState().getEnabledTools();
    const allTools = getToolDefinitions(mcpTools);
    const enabledTools = allTools.filter(
      (t) => t.name.includes("__") || toolsEnabled[t.name as import("./lib/tools").ToolName]
    );

    const toolsSupported = supportsNativeTools(selectedModel);
    const effectiveHardware = vramOverride != null && hardware ? { ...hardware, vramGb: vramOverride } : hardware;

    addMessage(convId, { role: "assistant", content: "" });
    setStreaming(true);
    abortRef.current = new AbortController();

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
            abortRef.current?.signal.addEventListener("abort", () => resolve(false), { once: true });
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

        signal: abortRef.current.signal,
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
      setStreaming(false);
      clearPendingToolCalls();
      abortRef.current = null;
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
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Toaster position="bottom-right" richColors closeButton />
      <ChatSidebar
        view={view}
        onViewChange={setView}
        selectedModel={selectedModel}
        onModelChange={(m) => { setSelectedModel(m); toast.info(`Model: ${m}`, { duration: 2000 }); }}
        onOpenSearch={() => setSearchOpen(true)}
      />
      <ConversationSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(id) => { selectConversation(id); setView("chat"); setSearchOpen(false); }}
      />

      <div className="flex flex-col flex-1 min-w-0">
        {view === "chat" ? (
          <>
            {/* Top bar */}
            <div className="h-14 border-b bg-card px-4 flex items-center justify-between shrink-0">
              <h2 className="text-sm font-medium truncate">
                {activeConv?.title ?? "AI Chat"}
              </h2>
              <div className="flex items-center gap-0.5">
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
                        `Write a prioritized list of 5-10 concrete next features to ` +
                        `FEATURE_IDEAS.md in the workspace root. For each: a short title, a 1-2 ` +
                        `sentence description, and why it's useful.`,
                        true
                      );
                    }}
                    title="Research new feature ideas and write FEATURE_IDEAS.md to the workspace"
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
          </>
        ) : null}

        {/* Code Editor — always mounted after first visit so agent loops survive tab switches */}
        {(view === "code" || mountedViews.has("code")) && (
          <div className={view === "code" ? "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden" : "hidden"}>
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading editor…</div>}>
              <CodeEditor selectedModel={selectedModel} isActive={view === "code"} />
            </Suspense>
          </div>
        )}

        {view !== "chat" && view !== "code" && (view === "docs" ? (
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
        ))}
      </div>

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
