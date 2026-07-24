import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus, Sparkles, Send } from "lucide-react";
import { cn } from "./ui/utils";

export interface PresetAction {
  key: string;
  label: string;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  onComment: () => void;
  onCustomPrompt: (instruction: string) => void;
  presets: PresetAction[];
  onClose: () => void;
}

/**
 * Google-Docs-style right-click menu for a text selection: comment, a free-form
 * "Ask AI" prompt (not just fixed presets), and the existing preset AI actions.
 * Positioned at the click coordinates, clamped so it doesn't render off-screen.
 */
export function DocSelectionMenu({ x, y, onComment, onCustomPrompt, presets, onClose }: Props) {
  const [asking, setAsking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  useEffect(() => {
    if (asking) inputRef.current?.focus();
  }, [asking]);

  function submitPrompt() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onCustomPrompt(trimmed);
    onClose();
  }

  // Clamp so the menu doesn't render off the right/bottom edge of the window.
  const width = 220;
  const estimatedHeight = asking ? 90 : 40 + presets.length * 28 + 40;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - estimatedHeight - 8);

  return createPortal(
    <div
      ref={menuRef}
      style={{ left, top, width }}
      className="fixed z-50 bg-card border border-border rounded-md shadow-lg py-1 text-xs"
    >
      {asking ? (
        <div className="p-1.5 flex items-center gap-1">
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitPrompt();
              }
            }}
            placeholder="What should AI do to this text?"
            className="flex-1 min-w-0 text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={submitPrompt}
            disabled={!prompt.trim()}
            className="size-6 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
          >
            <Send className="size-3" />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => {
              onComment();
              onClose();
            }}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-foreground hover:bg-accent transition-colors"
          >
            <MessageSquarePlus className="size-3.5" /> Comment
          </button>
          <button
            type="button"
            onClick={() => setAsking(true)}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-foreground hover:bg-accent transition-colors"
          >
            <Sparkles className="size-3.5" /> Ask AI…
          </button>
          {presets.length > 0 && (
            <>
              <div className="h-px bg-border my-1" />
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => {
                    p.onClick();
                    onClose();
                  }}
                  className={cn("w-full text-left px-3 py-1.5 text-foreground hover:bg-accent transition-colors")}
                >
                  {p.label}
                </button>
              ))}
            </>
          )}
        </>
      )}
    </div>,
    document.body
  );
}
