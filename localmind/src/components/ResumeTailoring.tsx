import React, { Suspense, useEffect, useRef, useState } from "react";
import { Send, Square, ChevronDown, ChevronUp, Upload, FolderOpen, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { FileTree } from "./FileTree";
import { ResumeDiffView } from "./ResumeDiffView";
import { openWorkspace, readFileFromHandle, writeFileToHandle, isTauriEnv } from "../lib/fileSystem";
import { supportsNativeTools } from "../lib/modelCapabilities";
import { useAgentStore } from "../store/agent";
import { useModelStore } from "../store/models";
import { useSettingsStore } from "../store/settings";
import { useKnowledgeStore } from "../store/knowledge";
import { pickUploadFiles } from "../lib/knowledge/ingest";
import { assembleSessionTools } from "../lib/capabilityRegistry";
import { runAgentSession, DEFAULT_MAX_ROUNDS } from "../lib/agentRuntime";
import type { ChatMessage } from "../lib/ollama";
import type { ToolName } from "../lib/tools";
import { commitAfterToolCall } from "../lib/shadowGit";
import { registerLocalMindMonacoThemes } from "../lib/monacoThemes";
import { registerLatexLanguage } from "../lib/monacoLatex";
import { ToolIcon } from "./ToolCallCard";
import {
  startSession, endSession, logRound, logToolCall, logToolResult, logAgentText,
} from "../lib/agentLogger";
import type { editor as MonacoEditorNS } from "monaco-editor";

const MonacoEditor = React.lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default }))
);

const RESUME_ESSENTIAL_TOOLS = new Set<ToolName>([
  "read_file", "web_fetch", "search_resume_knowledge", "propose_resume_edit", "switch_view",
]);

const RESUME_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  tex: "latex", bib: "latex", md: "markdown", txt: "plaintext",
};

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return RESUME_EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

type PendingDiff = { path: string; original: string; modified: string; summary: string } | null;

interface AiMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolError?: boolean;
  toolResult?: string;
  toolArgs?: Record<string, unknown>;
}

interface ResumeTailoringProps {
  selectedModel: string;
  isActive?: boolean;
}

export function ResumeTailoring({ selectedModel, isActive = true }: ResumeTailoringProps) {
  const { dirHandle, workspacePath, setWorkspace } = useAgentStore();
  const { hardware, vramOverride } = useModelStore();
  const { codeEditorTheme, numCtxOverride } = useSettingsStore();
  const { collections, ingesting, progress, ingest } = useKnowledgeStore();
  const effectiveHardware = vramOverride != null && hardware ? { ...hardware, vramGb: vramOverride } : hardware;

  const [currentPath, setCurrentPath] = useState<string>("");
  const [fileContent, setFileContent] = useState<string>("");
  const [treeVersion, setTreeVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  const [pendingDiff, setPendingDiff] = useState<PendingDiff>(null);

  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [showKnowledge, setShowKnowledge] = useState(false);

  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [chatPrompt, setChatPrompt] = useState<string>("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [agentRound, setAgentRound] = useState(0);
  const [currentActivity, setCurrentActivity] = useState<string | null>(null);
  const [expandedToolIndices, setExpandedToolIndices] = useState<Set<number>>(new Set());

  const [pendingApproval, setPendingApproval] = useState<{ name: string; args: Record<string, unknown> } | null>(null);
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);

  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aiBottomRef = useRef<HTMLDivElement>(null);
  const logSessionRef = useRef<string | null>(null);

  const resumeCollection = collections.find((c) => c.id === "Resume") ?? null;

  useEffect(() => {
    if (isActive) {
      setTimeout(() => editorRef.current?.layout(), 50);
    }
  }, [isActive]);

  // Background-knowledge collection: ensure a dedicated "Resume" collection
  // exists, isolated from class/study collections. Desktop-only.
  useEffect(() => {
    if (!isTauriEnv()) {
      setKnowledgeError("Background knowledge requires the desktop app.");
      return;
    }
    (async () => {
      try {
        await useKnowledgeStore.getState().loadCollections();
        const has = useKnowledgeStore.getState().collections.some((c) => c.id === "Resume");
        if (!has) await useKnowledgeStore.getState().createCollection("Resume");
      } catch (err) {
        setKnowledgeError((err as Error).message);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    try {
      const text = await readFileFromHandle(dirHandle, path);
      setCurrentPath(path);
      setFileContent(text);
      toast.success(`Opened ${path.split("/").pop()}`);
    } catch (err) {
      toast.error(`Could not open file: ${(err as Error).message}`);
    }
  }

  async function handleSave() {
    if (!dirHandle || !currentPath) return;
    setSaveStatus("saving");
    try {
      await writeFileToHandle(dirHandle, currentPath, fileContent);
      setSaveStatus("saved");
      toast.success(`Saved ${currentPath.split("/").pop()}`);
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
      setSaveStatus("idle");
    }
  }

  async function handleAcceptDiff() {
    if (!pendingDiff || !dirHandle) return;
    try {
      await writeFileToHandle(dirHandle, pendingDiff.path, pendingDiff.modified);
      if (pendingDiff.path === currentPath) setFileContent(pendingDiff.modified);
      if (workspacePath) {
        void commitAfterToolCall(workspacePath, "propose_resume_edit", [pendingDiff.path], "resume");
      }
      setTreeVersion((v) => v + 1);
      toast.success(`Saved ${pendingDiff.path.split("/").pop()}`);
      setPendingDiff(null);
    } catch (err) {
      toast.error(`Could not save proposed edit: ${(err as Error).message}`);
    }
  }

  function handleRejectDiff() {
    setPendingDiff(null);
  }

  async function handleUploadResumeDocs() {
    setKnowledgeError(null);
    let paths: string[] | null;
    try {
      paths = await pickUploadFiles();
    } catch (err) {
      setKnowledgeError((err as Error).message);
      return;
    }
    if (!paths || paths.length === 0) return;
    try {
      await ingest("Resume", paths, () => {});
      toast.success(`Ingested ${paths.length} file${paths.length === 1 ? "" : "s"} into Resume knowledge`);
    } catch (err) {
      toast.error(`Ingest failed: ${(err as Error).message}`);
    }
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

  async function handleChatSend() {
    const prompt = chatPrompt.trim();
    if (!prompt || !selectedModel || isChatStreaming) return;
    setChatPrompt("");
    setAgentRound(0);

    const userMsg: AiMessage = { role: "user", content: prompt };
    setAiMessages((prev) => [...prev, userMsg, { role: "assistant", content: "" }]);
    setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    setIsChatStreaming(true);
    setCurrentActivity(null);
    abortRef.current = new AbortController();
    logSessionRef.current = startSession(prompt, selectedModel, dirHandle?.name);

    const toolsSupported = supportsNativeTools(selectedModel);
    const RESUME_TOOLS = await assembleSessionTools({ dirHandle, essentialOnly: RESUME_ESSENTIAL_TOOLS });

    const history: ChatMessage[] = [
      ...aiMessages.flatMap((m): ChatMessage[] => {
        if (m.role === "user") return [{ role: "user", content: m.content }];
        if (m.role === "assistant") {
          if (!m.content) return [];
          return [{ role: "assistant", content: m.content }];
        }
        if (m.role === "tool" && m.toolName && m.toolArgs !== undefined) {
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
        if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
        return msgs;
      });
      setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
    };

    const setLastAssistantError = (msg: string) => {
      setAiMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, content: msg };
        else msgs.push({ role: "assistant", content: msg });
        return msgs;
      });
    };

    let hadSideEffects = false;
    const toolStartTimes = new Map<string, number>();

    try {
      const sessionResult = await runAgentSession(history, {
        modelRef: selectedModel,
        hardware: effectiveHardware,
        numCtxOverride,
        dirHandle,
        workspacePath,
        workspaceName: dirHandle?.name ?? null,
        currentView: "resume",
        tools: RESUME_TOOLS,
        agentBuildMode: true,
        autoApproveAll: false,
        toolsSupported,
        maxRounds: DEFAULT_MAX_ROUNDS,
        promptSurface: "resume",
        suppressStaleProjectState: true,
        getCurrentOpenFile: () =>
          currentPath && fileContent ? { path: currentPath, content: fileContent, language: detectLanguage(currentPath) } : null,

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
          setAiMessages((prev) => {
            const msgs = [...prev];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant" && !last.content) msgs.pop();
            return [...msgs, { role: "tool", content: label, toolName: call.name, toolArgs: call.args }];
          });
          setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
          if (logSessionRef.current) logToolCall(logSessionRef.current, call.name, call.args);
          toolStartTimes.set(call.id, Date.now());
        },

        onApprovalNeeded: (call) => requestApproval(call.name, call.args),

        onToolCallResolved: (call, label, result, summary) => {
          const toolMs = Date.now() - (toolStartTimes.get(call.id) ?? Date.now());
          toolStartTimes.delete(call.id);

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

          if (!result.error && call.name === "propose_resume_edit") {
            const proposedPath = normalizePath(String(call.args["path"] ?? ""));
            const newContent = call.args["new_content"] != null ? String(call.args["new_content"]) : "";
            const proposedSummary = call.args["summary"] != null ? String(call.args["summary"]) : "Proposed resume edit";
            if (proposedPath && proposedPath === normalizePath(currentPath)) {
              setPendingDiff({ path: proposedPath, original: fileContent, modified: newContent, summary: proposedSummary });
            } else {
              setAiMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `(Proposed edit targets "${proposedPath}", but the open file is "${currentPath || "none"}" — open that file to review it.)`,
                },
              ]);
            }
          }
        },

        onRoundStart: (round) => {
          setAgentRound(round);
          if (logSessionRef.current) logRound(logSessionRef.current, round);
          if (round > 1) setAiMessages((prev) => [...prev, { role: "assistant", content: "" }]);
        },

        onActivity: setCurrentActivity,

        signal: abortRef.current.signal,
      });

      hadSideEffects = sessionResult.hadSideEffects;

      if (sessionResult.hitRoundLimit) {
        setAiMessages((prev) => [...prev, {
          role: "assistant",
          content: `Reached the ${DEFAULT_MAX_ROUNDS}-round limit. Ask me to continue if needed.`,
        }]);
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") setLastAssistantError(`Error: ${e.message}`);
    } finally {
      setIsChatStreaming(false);
      setCurrentActivity(null);
      abortRef.current = null;
      if (logSessionRef.current) {
        endSession(logSessionRef.current, hadSideEffects);
        logSessionRef.current = null;
      }
    }
  }

  const pathParts = currentPath ? currentPath.split("/") : [];
  const diffActiveForCurrent = pendingDiff !== null && normalizePath(pendingDiff.path) === normalizePath(currentPath);

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
            onRefresh={() => setTreeVersion((v) => v + 1)}
          />
        </div>

        {/* Center: editor / diff pane */}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="h-10 border-b bg-card px-3 flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground flex-1 min-w-0 overflow-hidden">
              {dirHandle && (
                <span className="text-foreground font-medium truncate shrink-0">{dirHandle.name}</span>
              )}
              {pathParts.map((part, i) => (
                <React.Fragment key={i}>
                  <span className="shrink-0">/</span>
                  <span className={i === pathParts.length - 1 ? "text-foreground font-medium truncate" : "truncate"}>
                    {part}
                  </span>
                </React.Fragment>
              ))}
              {!currentPath && <span className="italic">No file open</span>}
            </div>
            <Button
              size="sm" variant="outline"
              className="text-xs h-7 px-2 shrink-0"
              onClick={() => void handleSave()}
              disabled={!currentPath || saveStatus === "saving" || diffActiveForCurrent}
            >
              <Save className="size-3 mr-1" />
              {saveStatus === "saved" ? "Saved!" : saveStatus === "saving" ? "Saving…" : "Save"}
            </Button>
          </div>

          {diffActiveForCurrent && pendingDiff ? (
            <ResumeDiffView
              original={pendingDiff.original}
              modified={pendingDiff.modified}
              language={detectLanguage(pendingDiff.path)}
              summary={pendingDiff.summary}
              onAccept={() => void handleAcceptDiff()}
              onReject={handleRejectDiff}
            />
          ) : (
            <div className="flex flex-col flex-1 min-w-0">
              {pendingDiff && (
                <div className="px-3 py-1.5 bg-warning/10 text-warning text-[11px] border-b border-warning/30 shrink-0">
                  An AI-proposed edit is waiting for review on "{pendingDiff.path.split("/").pop()}" — open that file to Accept or Reject it.
                </div>
              )}
              <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading editor…</div>}>
                <MonacoEditor
                  height="100%"
                  language={detectLanguage(currentPath)}
                  value={fileContent}
                  theme={codeEditorTheme === "dark" ? "localmind-dark" : "localmind-light"}
                  onChange={(v) => setFileContent(v ?? "")}
                  beforeMount={(monacoInstance) => {
                    registerLocalMindMonacoThemes(monacoInstance);
                    registerLatexLanguage(monacoInstance);
                  }}
                  onMount={(ed) => {
                    editorRef.current = ed;
                    ed.addCommand(2048 | 49 /* Ctrl+S */, () => void handleSave());
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    fixedOverflowWidgets: true,
                  }}
                />
              </Suspense>
            </div>
          )}
        </div>

        {/* Right: chat panel */}
        <div className="w-[300px] shrink-0 border-l bg-card flex flex-col">
          <div className="px-3 py-2 border-b text-xs font-medium text-foreground flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <span>Resume Assistant</span>
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
                  Round {agentRound}/{DEFAULT_MAX_ROUNDS}
                </span>
              )}
            </div>
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

          {/* Background knowledge widget */}
          <div className="border-b shrink-0">
            <button
              type="button"
              onClick={() => setShowKnowledge((v) => !v)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <FolderOpen className="size-2.5" />
              <span>Background knowledge</span>
              <span className="text-muted-foreground/70">
                ({resumeCollection?.docCount ?? 0} doc{(resumeCollection?.docCount ?? 0) === 1 ? "" : "s"})
              </span>
              <span className="ml-auto">{showKnowledge ? <ChevronDown className="size-2.5" /> : <ChevronUp className="size-2.5" />}</span>
            </button>
            {showKnowledge && (
              <div className="px-3 pb-2 space-y-1.5">
                {knowledgeError ? (
                  <p className="text-[10px] text-muted-foreground italic">{knowledgeError}</p>
                ) : (
                  <>
                    <p className="text-[10px] text-muted-foreground">
                      Extra projects/experience not on the current resume — kept isolated from class/study collections.
                    </p>
                    <Button
                      size="sm" variant="outline" className="text-xs h-6 gap-1 w-full"
                      onClick={() => void handleUploadResumeDocs()}
                      disabled={ingesting}
                    >
                      <Upload className="size-2.5" />
                      {ingesting ? (progress ? progressShortLabel(progress) : "Ingesting…") : "Upload document"}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>

          {isChatStreaming && (
            <div className="px-3 py-1.5 border-b bg-muted/30 flex items-center gap-2 shrink-0">
              <span className="size-1.5 rounded-full bg-success animate-pulse shrink-0" />
              <span className="text-[10px] text-muted-foreground truncate">{currentActivity ?? "Thinking…"}</span>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
            {aiMessages.length === 0 && (
              <p className="text-xs text-muted-foreground italic">Paste a job listing or URL to tailor this resume…</p>
            )}
            {aiMessages.map((msg, i) => {
              if (msg.role === "tool") {
                const isExpanded = expandedToolIndices.has(i);
                const hasResult = !!msg.toolResult;
                const isPending = !hasResult && !msg.toolError && isChatStreaming;
                const toolName = msg.toolName ?? "";
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
                        {msg.toolResult.length > 4000 ? msg.toolResult.slice(0, 4000) + "\n…(truncated)" : msg.toolResult}
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

          {pendingApproval && (
            <div className="mx-3 mb-1 rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-2 shrink-0">
              <p className="text-xs font-medium text-warning">
                {pendingApproval.name === "switch_view"
                  ? `Switch tab to: ${String(pendingApproval.args["view"] ?? "")}`
                  : `Run: ${pendingApproval.name}`}
              </p>
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

          <div className="p-3 border-t space-y-2">
            <Textarea
              value={chatPrompt}
              onChange={(e) => setChatPrompt(e.target.value)}
              placeholder={selectedModel ? "Paste a job listing or ask for a tailoring pass…" : "No model selected"}
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
              {isChatStreaming && (
                <Button size="sm" variant="outline" className="text-xs h-7 px-2"
                  onClick={() => abortRef.current?.abort()}>
                  <Square className="size-3" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function progressShortLabel(p: { phase: string; file: string; done?: number; total?: number }): string {
  if (p.phase === "embedding" && p.done !== undefined && p.total !== undefined) return `${p.file} ${p.done}/${p.total}`;
  return p.file || "Ingesting…";
}
