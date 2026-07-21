import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { modelDisplayName } from "../lib/chatProvider";
import { supportsNativeTools } from "../lib/modelCapabilities";
import type { AppView } from "../types/app";

// ─── Mode chip config ──────────────────────────────────────────────────────
// Text-only chips (no icons), matching the Nucleus design reference exactly.
// 6 primary modes always visible; the rest live behind "More".

const PRIMARY: AppView[] = ["chat", "code", "research", "models", "memory", "settings"];
const MORE: AppView[] = ["docs", "terminal", "agents", "study", "image", "skills", "benchmarks", "compare", "logs"];

const MODE_LABEL: Record<AppView, string> = {
  chat: "Chat",
  code: "Code",
  docs: "Docs",
  models: "Models",
  terminal: "Terminal",
  agents: "Agents",
  research: "Research",
  study: "Study",
  settings: "Settings",
  image: "Image",
  skills: "Skills",
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

interface NucleusProps {
  view: AppView;
  onViewChange: (v: AppView) => void;
  selectedModel: string;
  isStreaming: boolean;
  isSearching: boolean;
  agentMode: boolean;
  onToggleDrawer: () => void;
}

export function Nucleus({
  view,
  onViewChange,
  selectedModel,
  isStreaming,
  isSearching,
  agentMode,
  onToggleDrawer,
}: NucleusProps) {
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click (ported from the design reference).
  useEffect(() => {
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const busy = isStreaming || isSearching;
  const statusLabel = isSearching ? "Searching" : agentMode ? "Working" : "Thinking";
  const label = MODE_LABEL[view] ?? "Chat";
  const isMoreView = MORE.includes(view);
  const toolsOn = !!selectedModel && supportsNativeTools(selectedModel);

  return (
    <div className="relative flex justify-center px-4 pt-3.5 pb-0 shrink-0" ref={ref}>
      {/* Recent-chats drawer toggle — sits beside the Nucleus, absolutely
          positioned so it never throws off the pill's own centering. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleDrawer();
        }}
        title="Recent chats"
        className="absolute left-4 top-[18px] size-7 rounded-full flex items-center justify-center text-black/30 hover:text-black/60 hover:bg-black/5 transition-colors"
      >
        <History className="size-3.5" />
      </button>

      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          transition: "width 0.45s cubic-bezier(0.34, 1.4, 0.64, 1)",
          width: open ? "100%" : busy ? "190px" : "162px",
          cursor: "pointer",
        }}
        className="bg-[#0A0A0A] rounded-full overflow-hidden select-none"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
      >
        {open ? (
          <div className="flex flex-col gap-1 px-2 py-2">
            <div className="flex flex-wrap items-center justify-center gap-0.5">
              {PRIMARY.map((v) => (
                <button
                  key={v}
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewChange(v);
                    setOpen(false);
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
          <div className="flex items-center justify-center gap-2.5 px-5 py-2.5">
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
                <span className="text-white/35 text-[11px] font-mono">
                  {selectedModel ? modelDisplayName(selectedModel) : "no model"}
                </span>
              </>
            )}
          </div>
        )}
      </div>
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
