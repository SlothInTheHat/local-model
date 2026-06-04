import { useState, useRef, useEffect } from "react";
import {
  Search, Trash2, Download, FileText, Loader2,
  CheckCircle2, Globe, GitBranch, Layers,
  MessageSquare, Send, Square, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { runResearch } from "../lib/research";
import { useResearchStore } from "../store/research";
import { streamChat } from "../lib/ollama";

interface Props { selectedModel: string; }

// ─── Blob URL hook ────────────────────────────────────────────────────────────

function useHtmlBlobUrl(html: string | undefined): string | null {
  const urlRef = useRef<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!html || html.length < 50) { setUrl(null); return; }

    const interceptor = `<script>
(function(){
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(a){var h=a.getAttribute('href');
      if(h&&(h.startsWith('http')||h.startsWith('//'))){ e.preventDefault(); window.open(h,'_blank','noopener,noreferrer'); }}
  },true);
})();
<\/script>`;

    const injected = html.includes("<head")
      ? html.replace(/(<head[^>]*>)/i, `$1${interceptor}`)
      : interceptor + html;

    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const blobUrl = URL.createObjectURL(new Blob([injected], { type: "text/html" }));
    urlRef.current = blobUrl;
    setUrl(blobUrl);

    return () => { if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; } };
  }, [html]);

  return url;
}

// ─── Progress stepper ─────────────────────────────────────────────────────────

function ProgressView({ phase, queriesCompleted, queriesTotal }: { phase: string; queriesCompleted: number; queriesTotal: number }) {
  const steps = [
    { label: "Plan", icon: <Layers className="size-3.5" /> },
    { label: "Search", icon: <Globe className="size-3.5" /> },
    { label: "Gap analysis", icon: <Search className="size-3.5" /> },
    { label: "Follow-ups", icon: <GitBranch className="size-3.5" /> },
    { label: "Extract", icon: <FileText className="size-3.5" /> },
    { label: "Write", icon: <FileText className="size-3.5" /> },
  ];

  const stepIndex =
    phase.startsWith("Planning") ? 0
    : phase.startsWith("Searching") ? 1
    : phase.startsWith("Analys") ? 2
    : phase.startsWith("Running") ? 3
    : phase.startsWith("Extracting") ? 4
    : 5;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8 p-12">
      <div className="flex items-center gap-3">
        <Loader2 className="size-6 animate-spin text-primary" />
        <span className="text-base font-medium">{phase}</span>
      </div>

      <div className="flex items-center gap-0">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center">
            <div className={`flex flex-col items-center gap-1 w-20 ${i <= stepIndex ? "opacity-100" : "opacity-30"}`}>
              <div className={`size-8 rounded-full flex items-center justify-center border-2 transition-all ${
                i < stepIndex ? "bg-green-500 border-green-500 text-white"
                : i === stepIndex ? "bg-primary border-primary text-primary-foreground animate-pulse"
                : "bg-background border-border text-muted-foreground"
              }`}>
                {i < stepIndex ? <CheckCircle2 className="size-3.5" /> : step.icon}
              </div>
              <span className="text-[10px] text-center text-muted-foreground leading-tight">{step.label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`w-6 h-0.5 mb-4 ${i < stepIndex ? "bg-green-500" : "bg-border"}`} />
            )}
          </div>
        ))}
      </div>

      {queriesTotal > 0 && (
        <div className="text-center space-y-2">
          <div className="text-3xl font-bold text-primary">{queriesCompleted} <span className="text-lg font-normal text-muted-foreground">/ {queriesTotal}</span></div>
          <div className="text-xs text-muted-foreground">searches complete</div>
          <div className="w-64 h-1.5 bg-border rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${queriesTotal ? (queriesCompleted / queriesTotal) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground max-w-sm text-center">
        Deep research: 12 parallel searches + Wikipedia enrichment + gap analysis + structured notes extraction + academic synthesis. Expect 3–5 minutes for thorough topics.
      </p>
    </div>
  );
}

// ─── Research chat panel ──────────────────────────────────────────────────────

function ResearchChat({
  reportId,
  topic,
  researchContext,
  selectedModel,
  onClose,
}: {
  reportId: string;
  topic: string;
  researchContext: string;
  selectedModel: string;
  onClose: () => void;
}) {
  const { reports, addChatMessage, appendToLastChat } = useResearchStore();
  const report = reports.find((r) => r.id === reportId);
  const messages = report?.chatMessages ?? [];

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send() {
    const text = input.trim();
    if (!text || !selectedModel || isStreaming) return;

    addChatMessage(reportId, { role: "user", content: text });
    addChatMessage(reportId, { role: "assistant", content: "" });
    setInput("");
    setIsStreaming(true);
    abortRef.current = new AbortController();

    const history = [
      {
        role: "system" as const,
        content: `You are a research assistant helping the user understand and discuss a deep research report.

RESEARCH TOPIC: "${topic}"

RESEARCH CONTEXT (notes and report content):
${researchContext.slice(0, 10000)}

Answer questions thoroughly, citing specific evidence from the research. If asked for opinions, distinguish clearly between what the research says and your synthesis. When the user asks to summarise the discussion, provide a comprehensive summary including both the key findings and the conversation.`,
      },
      ...messages.filter((m) => m.content).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: text },
    ];

    try {
      for await (const chunk of streamChat(selectedModel, history, abortRef.current.signal)) {
        appendToLastChat(reportId, chunk);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        appendToLastChat(reportId, `\n\n*[Error: ${(e as Error).message}]*`);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="w-80 shrink-0 border-l flex flex-col bg-card">
      {/* Header */}
      <div className="px-3 py-2.5 border-b flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-primary" />
          <span className="text-sm font-medium">Discuss Research</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="size-4" />
        </button>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {messages.length === 0 && (
            <div className="text-xs text-muted-foreground space-y-2">
              <p className="font-medium">Ask anything about this research:</p>
              {[
                "What are the strongest counterarguments?",
                "Summarise the key disagreements between perspectives",
                "What evidence is most reliable here?",
                "What are the biggest unknowns?",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="block w-full text-left px-2 py-1.5 rounded bg-muted hover:bg-accent text-xs transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "user" ? (
                <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-3 py-2 text-xs max-w-[85%]">
                  {msg.content}
                </div>
              ) : (
                <div className="text-xs text-foreground max-w-full prose prose-xs dark:prose-invert">
                  {msg.content
                    ? <ReactMarkdown>{msg.content}</ReactMarkdown>
                    : <span className="animate-pulse text-muted-foreground">▌</span>
                  }
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-3 border-t space-y-2 shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Ask about the research…"
          disabled={isStreaming || !selectedModel}
          rows={2}
          className="w-full text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring resize-none disabled:opacity-50"
        />
        <div className="flex gap-1.5">
          {isStreaming ? (
            <Button size="sm" variant="destructive" className="flex-1 h-7 text-xs gap-1" onClick={() => abortRef.current?.abort()}>
              <Square className="size-3" /> Stop
            </Button>
          ) : (
            <Button size="sm" className="flex-1 h-7 text-xs gap-1" onClick={() => void send()} disabled={!input.trim() || !selectedModel}>
              <Send className="size-3" /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Export helpers ───────────────────────────────────────────────────────────

function exportHtml(report: { htmlOutput: string; topic: string }) {
  const blob = new Blob([report.htmlOutput], { type: "text/html" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${report.topic.slice(0, 40).replace(/[^a-z0-9]/gi, "-")}.html`;
  a.click();
}

function exportCombinedMd(report: { topic: string; createdAt: number; queriesCompleted: number; sources: string[]; researchContext: string; chatMessages: { role: string; content: string }[] }) {
  const date = new Date(report.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const lines: string[] = [
    `# ${report.topic}`,
    ``,
    `**Deep Research Report** | LocalMind | ${date} | ${report.queriesCompleted} sources searched`,
    ``,
    `---`,
    ``,
    `## Research Notes & Findings`,
    ``,
    report.researchContext.replace(/^# Research Report:.*\n/m, "").trim(),
    ``,
  ];

  if (report.sources.length > 0) {
    lines.push(`## Sources`, ``);
    report.sources.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push(``);
  }

  if (report.chatMessages.length > 0) {
    lines.push(`---`, ``, `## Research Discussion`, ``);
    report.chatMessages.forEach((m) => {
      if (m.role === "user") {
        lines.push(`**Question:** ${m.content}`, ``);
      } else {
        lines.push(m.content, ``);
      }
    });
  }

  lines.push(`---`, ``, `*Research conducted using ${report.queriesCompleted} web searches across multiple angles.*`);
  lines.push(`*Generated by LocalMind Deep Research.*`);

  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${report.topic.slice(0, 40).replace(/[^a-z0-9]/gi, "-")}-report.md`;
  a.click();
}

// ─── Main component ───────────────────────────────────────────────────────────

export function DeepResearch({ selectedModel }: Props) {
  const { reports, activeReportId, addReport, updateReport, deleteReport, selectReport } = useResearchStore();
  const [topic, setTopic] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const activeReport = reports.find((r) => r.id === activeReportId) ?? null;
  const previewUrl = useHtmlBlobUrl(activeReport?.status === "done" ? activeReport.htmlOutput : undefined);
  const isGenerating = activeReport?.status === "generating";

  async function startResearch() {
    const t = topic.trim();
    if (!t || !selectedModel || isRunning) return;
    const id = crypto.randomUUID();
    addReport({ id, topic: t, createdAt: Date.now(), htmlOutput: "", researchContext: "", chatMessages: [], sections: [], sources: [], status: "generating", phase: "Starting…", queriesCompleted: 0, queriesTotal: 0 });
    setTopic("");
    setIsRunning(true);
    abortRef.current = new AbortController();
    try {
      for await (const patch of runResearch(t, selectedModel, abortRef.current.signal)) {
        updateReport(id, patch);
      }
    } catch (e) {
      const msg = (e as Error).name === "AbortError" ? "Cancelled" : (e as Error).message;
      updateReport(id, { status: "error", error: msg, phase: "Error" });
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-52 border-r bg-card flex flex-col shrink-0">
        <div className="p-3 border-b">
          <h2 className="text-sm font-semibold">Deep Research</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">Academic multi-source synthesis</p>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {reports.length === 0 && (
              <p className="text-xs text-muted-foreground px-2 py-4 text-center">Enter a topic below to begin.</p>
            )}
            {reports.map((r) => (
              <button key={r.id} onClick={() => selectReport(r.id)}
                className={`w-full text-left px-2 py-2 rounded text-xs transition-colors flex items-start gap-1.5 group ${r.id === activeReportId ? "bg-accent text-accent-foreground" : "hover:bg-accent text-foreground/70 hover:text-foreground"}`}>
                {r.status === "generating"
                  ? <Loader2 className="size-3 shrink-0 mt-0.5 animate-spin text-amber-500" />
                  : r.status === "error"
                  ? <span className="text-destructive font-bold text-xs shrink-0">!</span>
                  : <FileText className="size-3 shrink-0 mt-0.5 text-primary" />}
                <span className="truncate flex-1 leading-tight">{r.topic}</span>
                <button onClick={(e) => { e.stopPropagation(); deleteReport(r.id); }}
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0">
                  <Trash2 className="size-3" />
                </button>
              </button>
            ))}
          </div>
        </ScrollArea>
        <Separator />
        <div className="p-2 space-y-1.5">
          <textarea value={topic} onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void startResearch(); } }}
            placeholder="Enter a research topic…" disabled={isRunning} rows={3}
            className="w-full text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring resize-none disabled:opacity-50" />
          {isRunning
            ? <Button size="sm" variant="destructive" className="w-full h-7 text-xs" onClick={() => abortRef.current?.abort()}>Stop</Button>
            : <Button size="sm" className="w-full h-7 text-xs gap-1" onClick={() => void startResearch()} disabled={!topic.trim() || !selectedModel}>
                <Search className="size-3" /> Research
              </Button>}
          {!selectedModel && <p className="text-[10px] text-amber-600">Select a model first</p>}
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {!activeReport ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
            <div className="size-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Search className="size-8 text-primary" />
            </div>
            <div>
              <h3 className="text-base font-semibold">Deep Research</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                Runs 12+ parallel searches, Wikipedia full-text enrichment, gap analysis, structured notes extraction, then writes an academic HTML report. Then chat about the findings.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mt-1 w-64">
              <span>📡 12+ web searches</span>
              <span>📖 Wikipedia full text</span>
              <span>🔍 Gap analysis round</span>
              <span>📊 Charts & statistics</span>
              <span>🎓 Academic structure</span>
              <span>💬 Chat & discuss</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0">
            {/* Report area */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Header */}
              <div className="h-12 border-b px-4 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  {isGenerating && <Loader2 className="size-4 animate-spin text-primary shrink-0" />}
                  <h2 className="text-sm font-semibold truncate">{activeReport.topic}</h2>
                  {activeReport.status === "done" && (
                    <span className="text-[10px] text-green-600 shrink-0 border border-green-200 bg-green-50 px-1.5 py-0.5 rounded-full">
                      {activeReport.queriesCompleted} sources
                    </span>
                  )}
                </div>
                {activeReport.status === "done" && (
                  <div className="flex gap-1.5 shrink-0">
                    <Button size="sm" variant={showChat ? "secondary" : "outline"} className="h-7 text-xs gap-1"
                      onClick={() => setShowChat((v) => !v)}>
                      <MessageSquare className="size-3" />
                      {(activeReport.chatMessages?.length ?? 0) > 0 ? `Discuss (${Math.ceil((activeReport.chatMessages?.length ?? 0) / 2)})` : "Discuss"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
                      onClick={() => exportCombinedMd(activeReport)}>
                      <Download className="size-3" /> Export .md
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1"
                      onClick={() => exportHtml(activeReport)}>
                      <Download className="size-3" /> .html
                    </Button>
                  </div>
                )}
              </div>

              {/* Content */}
              {isGenerating ? (
                <ProgressView phase={activeReport.phase ?? ""} queriesCompleted={activeReport.queriesCompleted ?? 0} queriesTotal={activeReport.queriesTotal ?? 0} />
              ) : activeReport.status === "error" ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center space-y-2">
                    <p className="font-medium text-destructive">Research failed</p>
                    <p className="text-sm text-muted-foreground">{activeReport.error}</p>
                  </div>
                </div>
              ) : previewUrl ? (
                <iframe key={previewUrl} src={previewUrl}
                  sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                  className="flex-1 w-full" style={{ border: "none" }} title="Research Report" />
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                  <Loader2 className="size-4 animate-spin mr-2" /> Preparing report…
                </div>
              )}
            </div>

            {/* Chat panel */}
            {showChat && activeReport.status === "done" && (
              <ResearchChat
                reportId={activeReport.id}
                topic={activeReport.topic}
                researchContext={activeReport.researchContext ?? ""}
                selectedModel={selectedModel}
                onClose={() => setShowChat(false)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
