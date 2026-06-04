import { useEffect, useRef, useState } from "react";
import { AlertCircle, SlidersHorizontal } from "lucide-react";
import { toast, Toaster } from "sonner";
import { recommendModel } from "./lib/modelRecommender";
import { listModels, streamChat } from "./lib/ollama";
import type { ChatMessage } from "./lib/ollama";
import { searchWeb } from "./lib/search";
import { runAgentTurn } from "./lib/agentLoop";
import { executeTool, getToolDefinitions, setSystemInfoContext } from "./lib/tools";
import type { ToolResult } from "./lib/tools";
import { useModelStore } from "./store/models";
import { useMcpStore } from "./store/mcp";
import { useProfileStore } from "./store/profile";
import { openWorkspace } from "./lib/fileSystem";
import { useChatStore } from "./store/chat";
import { useAgentStore } from "./store/agent";
import { ChatSidebar } from "./components/ChatSidebar";
import { ConversationSearch } from "./components/ConversationSearch";
import { ChatMessages } from "./components/ChatMessages";
import { ChatInput } from "./components/ChatInput";
import { ModelManager } from "./components/ModelManager";
import { AgentToolbar } from "./components/AgentToolbar";
import { ToolCallCard } from "./components/ToolCallCard";
import { SystemPromptDialog } from "./components/SystemPromptDialog";
import type { AppView } from "./types/app";
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
const AppSettings = lazy(() =>
  import("./components/AppSettings").then((m) => ({ default: m.AppSettings }))
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
    setStreaming,
    updateTitle,
  } = useChatStore();

  const {
    dirHandle,
    toolsEnabled,
    pendingToolCalls,
    setWorkspace,
    setToolEnabled,
    setPendingToolCalls,
    clearPendingToolCalls,
  } = useAgentStore();

  const { hardware } = useModelStore();

  const [view, setView] = useState<AppView>("chat");
  const [selectedModel, setSelectedModel] = useState("");
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);

  // Ref to track current convId across async agent continuations
  const activeConvIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track last recommendation shown to avoid repeating the same toast
  const lastRecRef = useRef<string>("");

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

  // "Use in Chat" from model library: select the model and switch to chat view
  function handleUseModel(id: string) {
    setSelectedModel(id);
    setView("chat");
    toast.success(`Using ${id}`);
  }

  useEffect(() => {
    listModels()
      .then((models) => {
        const names = models.map((m) => m.name);
        setModels(names);
        if (names.length > 0) setSelectedModel(names[0]);
        setOllamaError(null);
        toast.success(`Ollama connected — ${names.length} model${names.length !== 1 ? "s" : ""} available`);
      })
      .catch(() => {
        setOllamaError("Cannot reach Ollama at localhost:11434 — make sure it is running.");
        toast.error("Cannot reach Ollama at localhost:11434");
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function handleSend(text: string) {
    if (!selectedModel) return;

    // Model recommendation — only toast if the suggestion is new
    const rec = recommendModel(text, attachedImages.length > 0, availableModels, selectedModel);
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

    if (agentMode) {
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
      for await (const chunk of streamChat(selectedModel, history, abortRef.current.signal)) {
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

    // Inject a system-level context block so the agent knows its environment
    const profile = useProfileStore.getState();
    const contextLines = [
      `## Runtime context`,
      `- Model: ${selectedModel || "unknown"}`,
      hardware ? [
        `- GPU: ${hardware.gpuName} (${hardware.vramGb} GB VRAM)`,
        `- RAM: ${hardware.ramGb} GB | CPU threads: ${hardware.cpuThreads}`,
      ].join("\n") : "- Hardware: not yet scanned",
      `- Platform: ${navigator.platform}`,
      `- Desktop mode: ${!!(window as unknown as Record<string, unknown>).__TAURI__}`,
      dirHandle ? `- Workspace: ${dirHandle.name}` : "- Workspace: none",
      profile.githubUsername ? `- GitHub: @${profile.githubUsername} (token configured — HTTPS auth is automatic)` : "",
      profile.gitName ? `- Git identity: ${profile.gitName} <${profile.gitEmail}>` : "",
      ``,
      `## Agent behavior`,
      `When the user asks you to explore, understand, or summarize a project or workspace:`,
      `1. Use list_directory to get the file tree.`,
      `2. Then read the actual content of key files — prioritize README.md, CLAUDE.md, package.json,`,
      `   Cargo.toml, pyproject.toml, or any obvious entry-point / config file. Read at least 3-5`,
      `   files before answering so your summary reflects what the code actually does, not just`,
      `   what the filenames suggest.`,
      `3. For deeper questions ("how does X work", "find the bug in Y") use grep_files or read_file`,
      `   to read the relevant source files before answering.`,
      `Never answer a workspace question based solely on a directory listing.`,
    ].join("\n");

    // Prepend context to the first system message, or add one if absent
    const historyWithCtx: ChatMessage[] = history[0]?.role === "system"
      ? [{ role: "system", content: `${history[0].content}\n\n${contextLines}` }, ...history.slice(1)]
      : [{ role: "system", content: contextLines }, ...history];

    addMessage(convId, { role: "assistant", content: "" });
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      for await (const event of runAgentTurn(
        selectedModel,
        historyWithCtx,
        enabledTools,
        abortRef.current.signal
      )) {
        if (event.type === "text_delta" && event.content) {
          appendToLastMessage(convId, event.content);
        } else if (event.type === "tool_calls" && event.toolCalls) {
          // Pause and surface tool calls for approval
          setPendingToolCalls(event.toolCalls);
          setStreaming(false);
          return; // Will resume in handleApproveAll / handleDenyAll
        } else if (event.type === "done") {
          // Auto-title
          const updatedConv = useChatStore
            .getState()
            .conversations.find((c) => c.id === convId);
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
        } else if (event.type === "error") {
          appendToLastMessage(convId, `\n\n*[Agent error: ${event.error ?? "unknown"}]*`);
        }
      }
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name !== "AbortError") appendToLastMessage(convId, `\n\n*[Error: ${e.message}]*`);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // ─── Approve all pending tool calls ──────────────────────────────────────

  async function handleApproveAll() {
    const calls = [...pendingToolCalls];
    clearPendingToolCalls();

    const convId = activeConvIdRef.current ?? activeId;
    if (!convId) return;

    // Execute all tool calls
    const results: ToolResult[] = [];
    for (const call of calls) {
      const result = await executeTool(call, dirHandle);
      results.push(result);

      // Proper Ollama tool continuation format
      addMessage(convId, {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: call.name, arguments: call.args } }],
      });
      addMessage(convId, {
        role: "tool",
        content: result.error ? `Error: ${result.error}` : result.output,
      });
    }

    // Build tool result messages for Ollama format and continue
    await handleContinueAgent(convId, results);
  }

  // ─── Deny a single tool call ──────────────────────────────────────────────

  function handleDenyCall(callId: string) {
    const remaining = pendingToolCalls.filter((c) => c.id !== callId);
    if (remaining.length === 0) {
      clearPendingToolCalls();
      // Add a system note
      const convId = activeConvIdRef.current ?? activeId;
      if (convId) {
        addMessage(convId, {
          role: "system",
          content: "[Tool result: tool_call]\nTool call was denied by the user.",
        });
      }
    } else {
      setPendingToolCalls(remaining);
    }
  }

  // ─── Continue agent after tool results ───────────────────────────────────

  async function handleContinueAgent(convId: string, _results: ToolResult[]) {
    // Rebuild history from store (includes the tool result messages we just added)
    const latestConv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (!latestConv) return;

    let history: ChatMessage[] = latestConv.messages;
    if (latestConv.systemPrompt) {
      history = [{ role: "system", content: latestConv.systemPrompt }, ...history];
    }

    await runAgentLoop(convId, history);
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
                  Tool calls awaiting approval ({pendingToolCalls.length})
                </div>
                {pendingToolCalls.map((call) => (
                  <ToolCallCard
                    key={call.id}
                    call={call}
                    onApprove={() => void handleApproveAll()}
                    onDeny={() => handleDenyCall(call.id)}
                  />
                ))}
              </div>
            )}

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
        ) : view === "code" ? (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading editor…</div>}>
            <CodeEditor selectedModel={selectedModel} />
          </Suspense>
        ) : view === "docs" ? (
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
        ) : view === "settings" ? (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>}>
            <AppSettings />
          </Suspense>
        ) : (
          <ModelManager onUseModel={handleUseModel} />
        )}
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
