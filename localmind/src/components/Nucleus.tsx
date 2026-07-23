import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, History } from "lucide-react";
import { modelDisplayName, parseModelRef, providerLabel } from "../lib/chatProvider";
import { supportsNativeTools } from "../lib/modelCapabilities";
import { useChatStore } from "../store/chat";
import { useModelSelectionStore } from "../store/modelSelection";
import type { AppView } from "../types/app";

// ─── Mode chip config ──────────────────────────────────────────────────────
// Text-only chips (no icons), matching the Nucleus design reference exactly.
// 6 primary modes always visible; the rest live behind "More".

const PRIMARY: AppView[] = ["chat", "code", "research", "models", "memory", "settings"];
const MORE: AppView[] = ["docs", "terminal", "agents", "study", "image", "skills", "workflows", "history", "benchmarks", "compare", "logs"];

const MODE_LABEL: Record<AppView, string> = {
  chat: "Chat",
  code: "Code",
  docs: "Docs",
  models: "Models",
  terminal: "Terminal",
  agents: "Agents",
  research: "Research",
  study: "Knowledge",
  settings: "Settings",
  image: "Image",
  skills: "Skills",
  workflows: "Workflows",
  history: "History",
  benchmarks: "Benchmarks",
  compare: "Compare",
  memory: "Memory",
  logs: "Logs",
};

function chipClass(active: boolean): string {
  return `px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors duration-150 ${
    active ? "bg-white text-[#0A0A0A]" : "text-white/50 hover:text-white/90"
  }`;
}

// Hover-intent timing. The open delay is deliberately unhurried: the pill is
// the app's primary chrome, so expanding it on a merely-passing pointer is
// disruptive, and the collapsed state holds the clickable model name (see the
// model button's mouse handlers, which cancel a pending expand so the name
// doesn't vanish out from under the pointer on its way to a click).
const OPEN_DELAY_MS = 225;
const CLOSE_DELAY_MS = 250;

interface NucleusProps {
  view: AppView;
  onViewChange: (v: AppView) => void;
  selectedModel: string;
  isStreaming: boolean;
  isSearching: boolean;
  agentMode: boolean;
  onToggleChatSidebar: () => void;
}

export function Nucleus({
  view,
  onViewChange,
  selectedModel,
  isStreaming,
  isSearching,
  agentMode,
  onToggleChatSidebar,
}: NucleusProps) {
  const [open, setOpen] = useState(false);
  // Set by a click — keeps the chip row open regardless of hover state until
  // the user clicks again or clicks outside, so it doesn't collapse while the
  // pointer is merely passing over a gap on its way to a chip.
  const [pinned, setPinned] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const availableModels = useChatStore((s) => s.availableModels);
  const setSelectedModel = useModelSelectionStore((s) => s.setSelectedModel);

  // The pill sizes to its content rather than to fixed pixel widths: a long
  // model ref (e.g. "openrouter::moonshotai/kimi-k2") clipped at a hardcoded
  // width, and expanding to the island's full width dwarfed six short chips.
  // The inner content lays out at max-content so it is never squeezed by the
  // outer element we are about to size from it.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  // Models grouped by provider so local Ollama models read distinctly from
  // OpenRouter/OpenAI ones in the picker.
  const groupedModels = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const m of availableModels) {
      const { providerId } = parseModelRef(m);
      const bucket = groups.get(providerId);
      if (bucket) bucket.push(m);
      else groups.set(providerId, [m]);
    }
    // Local models first — they're the app's default and most-used path.
    return [...groups.entries()].sort(([a], [b]) =>
      a === "ollama" ? -1 : b === "ollama" ? 1 : a.localeCompare(b),
    );
  }, [availableModels]);

  function clearOpenTimer() {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }
  function clearCloseTimer() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  // Close on outside-click (ported from the design reference) — also resets
  // the pin and the model picker so nothing is left open behind the pointer.
  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        clearOpenTimer();
        clearCloseTimer();
        setOpen(false);
        setPinned(false);
        setModelPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // Clean up any in-flight timers on unmount.
  useEffect(() => {
    return () => {
      clearOpenTimer();
      clearCloseTimer();
    };
  }, []);

  function handlePillMouseEnter() {
    clearCloseTimer();
    if (open || modelPickerOpen) return;
    clearOpenTimer();
    openTimerRef.current = setTimeout(() => {
      setOpen(true);
      openTimerRef.current = null;
    }, OPEN_DELAY_MS);
  }

  function handlePillMouseLeave() {
    clearOpenTimer();
    if (pinned) return;
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  }

  function handlePillClick() {
    clearOpenTimer();
    clearCloseTimer();
    setOpen((prev) => {
      const next = !prev;
      setPinned(next);
      return next;
    });
  }

  function handleModelButtonClick(e: React.MouseEvent) {
    e.stopPropagation();
    clearOpenTimer();
    clearCloseTimer();
    setModelPickerOpen((v) => !v);
  }

  const busy = isStreaming || isSearching;
  const statusLabel = isSearching ? "Searching" : agentMode ? "Working" : "Thinking";
  const label = MODE_LABEL[view] ?? "Chat";
  const isMoreView = MORE.includes(view);
  const toolsOn = !!selectedModel && supportsNativeTools(selectedModel);
  // The "More" tray holds 9 chips, which genuinely need the island's width;
  // every other state sizes to its own content.
  const expandedFull = open && (showMore || isMoreView);

  // Re-measure whenever anything that changes the pill's content changes.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el) setContentWidth(el.offsetWidth);
  }, [open, showMore, isMoreView, busy, statusLabel, label, selectedModel, toolsOn]);

  return (
    // Fixed-height row: the pill is absolutely positioned inside it so that
    // expanding (which adds a chip row, and a second one under "More") floats
    // over the content below instead of pushing the whole view down.
    <div className="relative shrink-0 px-4 pt-3.5 pb-0 h-[50px] z-30" ref={ref}>
      {/* Chat sidebar toggle — sits beside the Nucleus, absolutely positioned
          so it never throws off the pill's own centering. Toggles the
          persistent left panel (recent chats/model/MCP) in the chat view. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleChatSidebar();
        }}
        title="Toggle chat sidebar"
        className="absolute left-4 top-[18px] size-7 rounded-full flex items-center justify-center text-black/30 hover:text-black/60 hover:bg-black/5 transition-colors"
      >
        <History className="size-3.5" />
      </button>

      <div
        onMouseEnter={handlePillMouseEnter}
        onMouseLeave={handlePillMouseLeave}
        onClick={handlePillClick}
        style={{
          // Absolute so growth never reflows the view beneath the island.
          position: "absolute",
          top: "14px",
          left: "50%",
          transform: "translateX(-50%)",
          // Pronounced symmetric overshoot (1.55) for a springy open/close.
          // The longer 0.6s duration keeps it from reading as a snap — the
          // original snappy feel came from a short duration, not the bounce.
          transition: "width 0.6s cubic-bezier(0.34, 1.55, 0.64, 1)",
          width: expandedFull ? "calc(100% - 32px)" : contentWidth ? `${contentWidth}px` : "auto",
          maxWidth: "calc(100% - 32px)",
          cursor: "pointer",
        }}
        className="bg-[#0A0A0A] rounded-full overflow-hidden select-none"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && handlePillClick()}
      >
        {open ? (
          <div
            ref={contentRef}
            className={`flex flex-col gap-1 px-2 py-2 ${expandedFull ? "w-full" : "w-max"}`}
          >
            <div className="flex flex-wrap items-center justify-center gap-0.5">
              {PRIMARY.map((v) => (
                <button
                  key={v}
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewChange(v);
                    setOpen(false);
                    setPinned(false);
                  }}
                  className={chipClass(v === view)}
                >
                  {MODE_LABEL[v]}
                </button>
              ))}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMore((s) => !s);
                }}
                className={`${chipClass(showMore || isMoreView)} relative`}
              >
                More
                {isMoreView && !showMore && (
                  <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-400" />
                )}
              </button>
            </div>
            {(showMore || isMoreView) && (
              <div className="flex flex-wrap items-center justify-center gap-0.5 pt-1 border-t border-white/10">
                {MORE.map((v) => (
                  <button
                    key={v}
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewChange(v);
                      setOpen(false);
                      setPinned(false);
                    }}
                    className={chipClass(v === view)}
                  >
                    {MODE_LABEL[v]}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div ref={contentRef} className="flex items-center justify-center gap-2.5 px-5 py-2.5 w-max">
            {busy ? (
              <>
                <span className="text-white/70 text-[11px] tracking-wide">{statusLabel}</span>
                <PulseDots />
              </>
            ) : (
              <>
                <span className="text-white text-[11px] font-medium tracking-wide">{label}</span>
                <span className="w-px h-3 bg-white/20" />
                <span
                  title={toolsOn ? "Native tool use supported" : "No native tool use"}
                  className={`size-1.5 rounded-full ${toolsOn ? "bg-emerald-400" : "bg-white/20"}`}
                />
                <button
                  type="button"
                  onClick={handleModelButtonClick}
                  // Pointing at the model name cancels a pending expand — the
                  // name only exists in the collapsed state, so letting the
                  // pill expand here would unmount the button mid-click.
                  // Leaving it re-arms the expand so normal hover still works.
                  onMouseEnter={clearOpenTimer}
                  onMouseLeave={handlePillMouseEnter}
                  title="Switch model"
                  className="text-white/35 hover:text-white/70 text-[11px] font-mono transition-colors"
                >
                  {selectedModel ? modelDisplayName(selectedModel) : "no model"}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Model picker popover — rendered as a sibling of the pill (not a
          descendant) because the pill has overflow-hidden, which would clip
          it. Anchored to the Nucleus row so it stays centered under the pill
          regardless of the pill's current width. */}
      {modelPickerOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 min-w-[200px] max-w-[280px] max-h-64 overflow-y-auto rounded-2xl bg-[#0A0A0A] border border-white/10 shadow-lg py-1.5"
        >
          {availableModels.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-white/40">No models available</div>
          ) : (
            groupedModels.map(([providerId, models]) => (
              <div key={providerId}>
                <div className="px-3 pt-2 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-white/40">
                  {providerId === "ollama" ? "Local" : providerLabel(models[0])}
                </div>
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedModel(m);
                      setModelPickerOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] font-mono transition-colors ${
                      m === selectedModel ? "bg-white/10 text-white" : "text-white/70 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <span className="truncate">{modelDisplayName(m)}</span>
                    {m === selectedModel && <Check className="size-3 shrink-0" />}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function PulseDots() {
  return (
    <div className="flex gap-[3px] items-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block w-1 h-1 rounded-full bg-white"
          style={{ animation: "ndot 1.4s ease-in-out infinite", animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </div>
  );
}
