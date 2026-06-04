import { useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { useChatStore } from "../store/chat";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (convId: string) => void;
}

export function ConversationSearch({ open, onClose, onSelect }: Props) {
  const { conversations } = useChatStore();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const results = query.trim()
    ? conversations
        .filter(
          (c) =>
            c.title.toLowerCase().includes(query.toLowerCase()) ||
            c.messages.some((m) => m.content.toLowerCase().includes(query.toLowerCase()))
        )
        .slice(0, 8)
    : conversations.slice(0, 8);

  function handleSelect(id: string) {
    onSelect(id);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && results[selected]) { handleSelect(results[selected].id); }
    if (e.key === "Escape") onClose();
  }

  function highlight(text: string, q: string): React.ReactNode {
    if (!q.trim()) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-primary/20 text-foreground rounded">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  }

  function getSnippet(convId: string): string | null {
    const q = query.toLowerCase().trim();
    if (!q) return null;
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return null;
    const msg = conv.messages.find((m) => m.content.toLowerCase().includes(q));
    if (!msg) return null;
    const idx = msg.content.toLowerCase().indexOf(q);
    const start = Math.max(0, idx - 30);
    const end = Math.min(msg.content.length, idx + q.length + 60);
    return (start > 0 ? "…" : "") + msg.content.slice(start, end) + (end < msg.content.length ? "…" : "");
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search conversations…"
            className="flex-1 text-sm bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">Esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {results.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">No conversations found</p>
          )}
          {results.map((conv, i) => {
            const snippet = getSnippet(conv.id);
            return (
              <button
                key={conv.id}
                onClick={() => handleSelect(conv.id)}
                onMouseEnter={() => setSelected(i)}
                className={`w-full text-left px-4 py-3 flex flex-col gap-0.5 transition-colors ${
                  i === selected ? "bg-accent" : "hover:bg-accent/50"
                }`}
              >
                <span className="text-sm font-medium text-foreground truncate">
                  {highlight(conv.title, query)}
                </span>
                {snippet && (
                  <span className="text-xs text-muted-foreground truncate">
                    {highlight(snippet, query)}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {conv.messages.length} messages · {new Date(conv.createdAt).toLocaleDateString()}
                </span>
              </button>
            );
          })}
        </div>

        <div className="px-4 py-2 border-t text-[10px] text-muted-foreground flex gap-3">
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
