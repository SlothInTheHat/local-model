import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { MessageSquare, Check, RotateCcw, Trash2, Sparkles, Send } from "lucide-react";
import { cn } from "./ui/utils";
import type { DocComment } from "../store/docComments";
import { findCommentRange } from "../lib/tiptapComment";

interface Props {
  editor: Editor;
  /** The positioned ancestor both this column and the editor content share —
   *  card `top` values are computed relative to it, so they stay correct
   *  regardless of scroll offset (both scroll together as one unit). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  comments: DocComment[];
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onReply: (id: string, text: string) => void;
  onAskAi: (id: string) => void;
  onJumpTo: (id: string) => void;
  aiThinkingCommentId: string | null;
  /** A comment whose reply box should auto-focus once (typically a
   *  just-created comment) — cleared by the caller after use. */
  focusCommentId?: string | null;
}

const CARD_GAP = 8;

function CommentCard({ comment, onResolve, onDelete, onReply, onAskAi, onJumpTo, aiThinking, autoFocus }: {
  comment: DocComment;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onReply: (id: string, text: string) => void;
  onAskAi: (id: string) => void;
  onJumpTo: (id: string) => void;
  aiThinking: boolean;
  autoFocus?: boolean;
}) {
  const [replyText, setReplyText] = useState("");
  const replyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) replyInputRef.current?.focus();
  }, [autoFocus]);

  function submitReply() {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(comment.id, trimmed);
    setReplyText("");
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm p-2 space-y-1.5 pointer-events-auto text-xs">
      <button
        type="button"
        onClick={() => onJumpTo(comment.id)}
        title="Jump to this text in the document"
        className="text-left w-full text-[10px] text-muted-foreground italic border-l-2 border-primary/50 pl-1.5 line-clamp-2 hover:text-foreground transition-colors"
      >
        "{comment.anchorText}"
      </button>

      {comment.messages.length > 0 && (
        <div className="space-y-1">
          {comment.messages.map((m) => (
            <div key={m.id} className={cn("rounded px-1.5 py-1", m.author === "ai" ? "bg-primary/10" : "bg-accent")}>
              {m.author === "ai" && (
                <div className="flex items-center gap-1 text-[9px] font-medium text-primary mb-0.5">
                  <Sparkles className="size-2.5" /> AI
                </div>
              )}
              <p className="whitespace-pre-wrap leading-snug text-foreground">{m.text}</p>
            </div>
          ))}
        </div>
      )}
      {aiThinking && <div className="rounded px-1.5 py-1 bg-primary/10 text-muted-foreground italic">AI is thinking…</div>}

      {!comment.resolved && (
        <div className="flex items-center gap-1">
          <input
            ref={replyInputRef}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitReply();
              }
            }}
            placeholder="Write your comment…"
            className="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={submitReply}
            disabled={!replyText.trim()}
            className="size-5 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
          >
            <Send className="size-2.5" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onAskAi(comment.id)}
          disabled={aiThinking}
          className="h-5 px-1.5 rounded text-[10px] flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
          title="Ask AI to weigh in"
        >
          <Sparkles className="size-2.5" /> Ask AI
        </button>
        <button
          type="button"
          onClick={() => onResolve(comment.id, !comment.resolved)}
          className="h-5 px-1.5 rounded text-[10px] flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-accent ml-auto"
        >
          {comment.resolved ? <RotateCcw className="size-2.5" /> : <Check className="size-2.5" />}
          {comment.resolved ? "Reopen" : "Resolve"}
        </button>
        <button
          type="button"
          onClick={() => onDelete(comment.id)}
          className="h-5 px-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent"
          title="Delete comment"
        >
          <Trash2 className="size-2.5" />
        </button>
      </div>
    </div>
  );
}

export function DocFloatingComments({ editor, containerRef, comments, onResolve, onDelete, onReply, onAskAi, onJumpTo, aiThinkingCommentId, focusCommentId }: Props) {
  const visible = comments.filter((c) => !c.resolved);
  const [rawTops, setRawTops] = useState<Record<string, number>>({});
  const [stackedTops, setStackedTops] = useState<Record<string, number>>({});
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Pass 1: raw anchor Y position per comment, relative to containerRef.
  useEffect(() => {
    function recompute() {
      const container = containerRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const next: Record<string, number> = {};
      for (const c of visible) {
        const range = findCommentRange(editor, c.id);
        if (!range) continue;
        try {
          const coords = editor.view.coordsAtPos(range.from);
          next[c.id] = coords.top - containerTop;
        } catch {
          // position no longer valid in the current doc — skip
        }
      }
      setRawTops(next);
    }

    recompute();
    editor.on("update", recompute);
    window.addEventListener("resize", recompute);
    return () => {
      editor.off("update", recompute);
      window.removeEventListener("resize", recompute);
    };
    // visible's identity changes whenever comments/resolved state changes, which is what should trigger a recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, visible.map((c) => c.id).join(","), containerRef]);

  // Pass 2: measure actual rendered card heights and push down any that would
  // overlap the previous card, so two comments anchored close together stack
  // instead of overlapping.
  useLayoutEffect(() => {
    const ordered = visible
      .filter((c) => rawTops[c.id] != null)
      .sort((a, b) => rawTops[a.id] - rawTops[b.id]);

    const next: Record<string, number> = {};
    let cursor = -Infinity;
    for (const c of ordered) {
      const raw = rawTops[c.id];
      const top = Math.max(raw, cursor);
      next[c.id] = top;
      const height = cardRefs.current[c.id]?.getBoundingClientRect().height ?? 80;
      cursor = top + height + CARD_GAP;
    }
    setStackedTops(next);
    // Re-run whenever raw positions change or the set of visible comments changes
    // (message counts affect card height, hence spacing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTops, visible.map((c) => `${c.id}:${c.messages.length}:${c.resolved}`).join(",")]);

  return (
    <div className="relative w-64 shrink-0">
      {visible.map((c) => (
        <div
          key={c.id}
          ref={(el) => { cardRefs.current[c.id] = el; }}
          className="absolute left-0 right-2 transition-[top] duration-150"
          style={{ top: stackedTops[c.id] ?? rawTops[c.id] ?? 0 }}
        >
          <CommentCard
            comment={c}
            onResolve={onResolve}
            onDelete={onDelete}
            onReply={onReply}
            onAskAi={onAskAi}
            onJumpTo={onJumpTo}
            aiThinking={aiThinkingCommentId === c.id}
            autoFocus={focusCommentId === c.id}
          />
        </div>
      ))}
      {visible.length === 0 && (
        <div className="sticky top-4 flex items-center gap-1.5 text-[11px] text-muted-foreground p-2">
          <MessageSquare className="size-3.5" />
          No open comments
        </div>
      )}
    </div>
  );
}
