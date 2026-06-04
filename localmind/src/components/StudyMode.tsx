import { useRef, useState } from "react";
import { Plus, Trash2, ArrowLeft, Layers, Send, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { StudyBranchTree } from "./StudyBranchTree";
import { useStudyStore } from "../store/study";
import { streamChat } from "../lib/ollama";
import { useSettingsStore } from "../store/settings";
import type { ChatMessage } from "../lib/ollama";

interface Props {
  selectedModel: string;
}

export function StudyMode({ selectedModel }: Props) {
  const {
    sessions,
    activeSessionId,
    newSession,
    deleteSession,
    selectSession,
    addMessage,
    appendToLastMessage,
    diveDeeperOn,
    setActiveBranch,
  } = useStudyStore();
  const { defaultSystemPrompt } = useSettingsStore();

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [diveTopic, setDiveTopic] = useState<{ messageIndex: number } | null>(null);
  const [diveTopicInput, setDiveTopicInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeBranch = activeSession?.branches.find((b) => b.id === activeSession.activeBranchId) ?? null;
  const rootBranchId = activeSession?.branches[0]?.id ?? "";

  // Build breadcrumb path to current branch
  function buildBreadcrumb() {
    if (!activeSession || !activeBranch) return [];
    const path: string[] = [];
    let current: string | null = activeBranch.id;
    while (current) {
      const branch = activeSession.branches.find((b) => b.id === current);
      if (!branch) break;
      path.unshift(branch.topic);
      current = branch.parentBranchId;
    }
    return path;
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !activeSessionId || !activeBranch || !selectedModel || isStreaming) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    addMessage(activeSessionId, activeBranch.id, userMsg);
    setInput("");
    setIsStreaming(true);
    abortRef.current = new AbortController();

    const history: ChatMessage[] = [
      { role: "system", content: `${defaultSystemPrompt}\n\nYou are in Study Mode. The student is exploring: "${activeBranch.topic}". Give clear, educational responses. End each response with a "---" separator.` },
      ...activeBranch.messages,
      userMsg,
    ];

    addMessage(activeSessionId, activeBranch.id, { role: "assistant", content: "" });

    try {
      for await (const chunk of streamChat(selectedModel, history, abortRef.current.signal)) {
        appendToLastMessage(activeSessionId, activeBranch.id, chunk);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        appendToLastMessage(activeSessionId, activeBranch.id, `\n\n*[Error: ${(e as Error).message}]*`);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function handleDiveDeeper(messageIndex: number) {
    setDiveTopic({ messageIndex });
    setDiveTopicInput("");
  }

  function confirmDiveDeeper() {
    const topic = diveTopicInput.trim();
    if (!topic || !activeSessionId || !activeBranch || !diveTopic) return;
    diveDeeperOn(activeSessionId, activeBranch.id, diveTopic.messageIndex, topic);
    setDiveTopic(null);
    setDiveTopicInput("");
  }

  function goBack() {
    if (!activeSession || !activeBranch?.parentBranchId) return;
    setActiveBranch(activeSession.id, activeBranch.parentBranchId);
  }

  const breadcrumb = buildBreadcrumb();

  return (
    <div className="flex h-full">
      {/* Left: sessions list */}
      <aside className="w-48 border-r bg-card flex flex-col shrink-0">
        <div className="p-3 border-b flex items-center justify-between">
          <span className="text-xs font-semibold">Study Sessions</span>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => { const id = newSession("New Session"); void id; }}
          >
            <Plus className="size-3" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-0.5">
            {sessions.length === 0 && (
              <p className="text-xs text-muted-foreground px-2 py-3 text-center">No sessions yet</p>
            )}
            {sessions.map((sess) => (
              <button
                key={sess.id}
                onClick={() => selectSession(sess.id)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1 group transition-colors ${
                  sess.id === activeSessionId
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent text-foreground/70 hover:text-foreground"
                }`}
              >
                <span className="truncate flex-1">{sess.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteSession(sess.id); }}
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </button>
              </button>
            ))}
          </div>
        </ScrollArea>
      </aside>

      {!activeSession ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
          <div className="size-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Layers className="size-8 text-primary" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Study Mode</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Have a main conversation, then dive deeper into any sub-topic and come back. Navigate branches in the tree panel.
            </p>
          </div>
          <Button onClick={() => newSession("New Session")}>
            <Plus className="size-4 mr-2" />
            New Study Session
          </Button>
        </div>
      ) : (
        <>
          {/* Center: branch tree */}
          <div className="w-52 border-r flex flex-col shrink-0">
            <div className="p-2.5 border-b">
              <span className="text-xs font-medium text-foreground">Branch Tree</span>
            </div>
            <ScrollArea className="flex-1">
              <StudyBranchTree
                branches={activeSession.branches}
                activeBranchId={activeSession.activeBranchId}
                rootId={rootBranchId}
                onSelect={(id) => setActiveBranch(activeSession.id, id)}
              />
            </ScrollArea>
          </div>

          {/* Right: active branch chat */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Header with breadcrumb */}
            <div className="h-12 border-b px-4 flex items-center gap-2 shrink-0">
              {activeBranch?.parentBranchId && (
                <button
                  onClick={goBack}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="size-4" />
                </button>
              )}
              <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
                {breadcrumb.map((label, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span>/</span>}
                    <span className={i === breadcrumb.length - 1 ? "text-foreground font-medium" : ""}>{label}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1">
              <div className="px-6 py-4 space-y-4 max-w-2xl mx-auto">
                {activeBranch?.messages.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Ask anything about <strong>{activeBranch.topic}</strong>
                  </p>
                )}
                {activeBranch?.messages.map((msg, i) => (
                  <div key={i} className={`flex flex-col gap-1 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                    {msg.role === "user" ? (
                      <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2 text-sm max-w-[80%]">
                        {msg.content}
                      </div>
                    ) : (
                      <div className="w-full">
                        <div className="prose prose-sm dark:prose-invert max-w-none text-foreground text-sm">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                        {msg.role === "assistant" && msg.content && !isStreaming && (
                          <button
                            onClick={() => handleDiveDeeper(i)}
                            className="mt-2 text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Layers className="size-3" />
                            Dive deeper →
                          </button>
                        )}
                        {diveTopic?.messageIndex === i && (
                          <div className="mt-2 flex gap-1">
                            <input
                              autoFocus
                              value={diveTopicInput}
                              onChange={(e) => setDiveTopicInput(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") confirmDiveDeeper(); if (e.key === "Escape") setDiveTopic(null); }}
                              placeholder="What do you want to explore? (Enter to confirm)"
                              className="flex-1 text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
                            />
                            <Button size="sm" className="h-7 text-xs" onClick={confirmDiveDeeper}>Go</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDiveTopic(null)}>✕</Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>

            <Separator />

            {/* Input */}
            <div className="p-3 flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); }
                }}
                placeholder={selectedModel ? `Ask about ${activeBranch?.topic ?? "this topic"}…` : "Select a model first"}
                disabled={isStreaming || !selectedModel}
                rows={2}
                className="flex-1 text-sm px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-ring resize-none disabled:opacity-50"
              />
              {isStreaming ? (
                <Button variant="destructive" size="icon" className="self-end" onClick={() => abortRef.current?.abort()}>
                  <Square className="size-4" />
                </Button>
              ) : (
                <Button size="icon" className="self-end" onClick={() => void sendMessage()} disabled={!input.trim() || !selectedModel}>
                  <Send className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
