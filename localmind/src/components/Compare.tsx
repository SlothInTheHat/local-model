import { useRef, useState } from "react";
import { Eye, EyeOff, Send, Square, RotateCcw } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "./ui/utils";
import { useChatStore } from "../store/chat";
import { streamChatForModel, providerLabel, isOllamaModel } from "../lib/chatProvider";
import { supportsNativeTools } from "../lib/modelCapabilities";

interface PanelState {
  model: string;
  response: string;
  streaming: boolean;
  done: boolean;
  error: string | null;
  tokenCount: number;
  durationMs: number | null;
}

const PANEL_LABELS = ["A", "B", "C", "D"];

function ModelBadge({ model }: { model: string }) {
  if (isOllamaModel(model)) return null;
  return (
    <span className="text-[9px] px-1 py-0.5 rounded bg-violet-100 text-violet-700 border border-violet-200">
      {providerLabel(model)}
    </span>
  );
}

export function Compare() {
  const { availableModels } = useChatStore();
  const [panelCount, setPanelCount] = useState(2);
  const [blind, setBlind] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [voted, setVoted] = useState<number | null>(null);

  const initPanel = (i: number): PanelState => ({
    model: availableModels[i] ?? availableModels[0] ?? "",
    response: "",
    streaming: false,
    done: false,
    error: null,
    tokenCount: 0,
    durationMs: null,
  });

  const [panels, setPanels] = useState<PanelState[]>([initPanel(0), initPanel(1)]);
  const aborts = useRef<AbortController[]>([]);

  const isRunning = panels.some((p) => p.streaming);
  const allDone = panels.every((p) => p.done || !!p.error);

  function updatePanel(i: number, patch: Partial<PanelState>) {
    setPanels((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  function setPanelModel(i: number, model: string) {
    updatePanel(i, { model });
  }

  function addPanel() {
    if (panelCount >= 4) return;
    setPanels((prev) => [...prev, initPanel(prev.length)]);
    setPanelCount((n) => n + 1);
  }

  function removePanel() {
    if (panelCount <= 2) return;
    aborts.current[panelCount - 1]?.abort();
    setPanels((prev) => prev.slice(0, -1));
    setPanelCount((n) => n - 1);
  }

  async function runComparison() {
    if (!prompt.trim()) return;
    setVoted(null);
    setRevealed(false);

    const messages = [
      ...(systemPrompt.trim() ? [{ role: "system" as const, content: systemPrompt.trim() }] : []),
      { role: "user" as const, content: prompt.trim() },
    ];

    aborts.current = panels.map(() => new AbortController());

    // Reset all panels
    setPanels((prev) =>
      prev.map((p) => ({ ...p, response: "", streaming: true, done: false, error: null, tokenCount: 0, durationMs: null }))
    );

    await Promise.allSettled(
      panels.map(async (panel, i) => {
        if (!panel.model) {
          updatePanel(i, { streaming: false, error: "No model selected" });
          return;
        }
        const start = Date.now();
        let count = 0;
        try {
          for await (const chunk of streamChatForModel(panel.model, messages, aborts.current[i].signal)) {
            count += chunk.length;
            setPanels((prev) =>
              prev.map((p, idx) =>
                idx === i ? { ...p, response: p.response + chunk, tokenCount: count } : p
              )
            );
          }
          updatePanel(i, { streaming: false, done: true, durationMs: Date.now() - start });
        } catch (err) {
          const e = err as Error;
          if (e.name !== "AbortError") {
            updatePanel(i, { streaming: false, error: e.message });
          } else {
            updatePanel(i, { streaming: false });
          }
        }
      })
    );
  }

  function stop() {
    aborts.current.forEach((a) => a.abort());
    setPanels((prev) => prev.map((p) => ({ ...p, streaming: false })));
  }

  function reset() {
    stop();
    setPanels((prev) => prev.map((p) => ({ ...p, response: "", done: false, error: null, durationMs: null })));
    setVoted(null);
    setRevealed(false);
    setPrompt("");
  }

  const colClass =
    panelCount === 2 ? "grid-cols-2" :
    panelCount === 3 ? "grid-cols-3" :
    "grid-cols-4";

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="border-b bg-card px-4 py-2 flex items-center gap-3 shrink-0">
        <h2 className="text-sm font-medium">Compare Models</h2>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={() => setShowSystem((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showSystem ? "Hide system prompt" : "System prompt"}
          </button>
          <button
            type="button"
            onClick={() => setBlind((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors",
              blind ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground border-border hover:text-foreground"
            )}
          >
            {blind ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            {blind ? "Blind ON" : "Blind OFF"}
          </button>
          {panelCount < 4 && (
            <button type="button" onClick={addPanel} className="text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded px-2 py-1">
              + Panel
            </button>
          )}
          {panelCount > 2 && (
            <button type="button" onClick={removePanel} className="text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded px-2 py-1">
              – Panel
            </button>
          )}
          {(allDone || panels.some((p) => p.response)) && (
            <button type="button" onClick={reset} className="text-muted-foreground hover:text-foreground">
              <RotateCcw className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* System prompt (collapsible) */}
      {showSystem && (
        <div className="border-b px-4 py-2 bg-muted/30 shrink-0">
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="System prompt (optional)…"
            className="text-xs h-16 resize-none"
          />
        </div>
      )}

      {/* Model selectors */}
      <div className={`grid ${colClass} gap-0 border-b shrink-0`}>
        {panels.map((panel, i) => (
          <div key={i} className={cn("px-3 py-2 flex items-center gap-2", i > 0 && "border-l")}>
            {blind && !revealed ? (
              <span className="text-sm font-semibold text-foreground">Model {PANEL_LABELS[i]}</span>
            ) : (
              <>
                <select
                  value={panel.model}
                  onChange={(e) => setPanelModel(i, e.target.value)}
                  disabled={isRunning}
                  className="flex-1 text-xs border rounded px-2 py-1 bg-background appearance-none focus:outline-none focus:ring-1 focus:ring-ring/50"
                >
                  {availableModels.length === 0 && <option value="">No models</option>}
                  {availableModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <ModelBadge model={panel.model} />
                {supportsNativeTools(panel.model) && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 border border-green-200">tools</span>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Response panels */}
      <div className={`grid ${colClass} flex-1 min-h-0`}>
        {panels.map((panel, i) => (
          <div key={i} className={cn("flex flex-col min-h-0 overflow-hidden", i > 0 && "border-l")}>
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              {panel.error ? (
                <p className="text-xs text-red-500">{panel.error}</p>
              ) : panel.response ? (
                <pre className="text-xs font-mono whitespace-pre-wrap text-foreground leading-relaxed">
                  {panel.response}
                  {panel.streaming && <span className="animate-pulse">▌</span>}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {panel.streaming ? "Generating…" : "Response will appear here"}
                </p>
              )}
            </div>

            {/* Footer: stats + vote */}
            {(panel.done || panel.error) && (
              <div className="border-t px-3 py-1.5 flex items-center gap-2 shrink-0">
                {panel.durationMs !== null && (
                  <span className="text-[10px] text-muted-foreground">
                    {(panel.durationMs / 1000).toFixed(1)}s · {panel.tokenCount} chars
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  {allDone && !voted && (
                    <button
                      type="button"
                      onClick={() => { setVoted(i); if (blind) setRevealed(true); }}
                      className="text-[10px] px-2 py-0.5 rounded border border-primary text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
                    >
                      👍 Best
                    </button>
                  )}
                  {voted === i && (
                    <span className="text-[10px] text-green-600 font-medium">✓ Winner</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Prompt input */}
      <div className="border-t bg-card px-4 py-3 shrink-0 flex gap-2 items-end">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !isRunning) {
              e.preventDefault();
              void runComparison();
            }
          }}
          placeholder="Enter a prompt to compare across models… (Enter to send)"
          className="flex-1 text-sm resize-none"
          rows={2}
          disabled={isRunning}
        />
        {isRunning ? (
          <Button size="sm" variant="outline" onClick={stop} className="shrink-0">
            <Square className="size-3.5 mr-1" /> Stop
          </Button>
        ) : (
          <Button size="sm" onClick={() => void runComparison()} disabled={!prompt.trim()} className="shrink-0">
            <Send className="size-3.5 mr-1" /> Compare
          </Button>
        )}
      </div>
    </div>
  );
}
