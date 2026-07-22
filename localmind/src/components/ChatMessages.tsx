import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Brain, ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { Markdown } from "./Markdown";
import type { ChatMessage } from "../lib/ollama";
import { useMemoryStore } from "../store/memory";
import { openSourceFile } from "../lib/openFile";

interface Props {
  messages: ChatMessage[];
  isStreaming: boolean;
}

// Organic blob bubble radii — cycled by message position, from the Nucleus
// design reference (designs/src/App.tsx USER_R / AI_R).
const USER_R = ["20px 20px 3px 20px", "22px 20px 5px 20px", "20px 24px 3px 20px"];
const AI_R = ["3px 20px 20px 20px", "5px 22px 20px 20px", "3px 20px 24px 20px"];
const MSG_IN_ANIMATION = "msgIn 0.28s cubic-bezier(0.34, 1.3, 0.64, 1)";

export function ChatMessages({ messages, isStreaming }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // true = keep scrolling to the bottom as content streams in
  const atBottomRef = useRef(true);
  const prevLengthRef = useRef(0);

  // Scroll handler: stop auto-scroll when the user scrolls up
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distFromBottom < 80;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const newMessage = messages.length !== prevLengthRef.current;
    prevLengthRef.current = messages.length;

    // New message added → snap back to bottom regardless of scroll position
    if (newMessage) atBottomRef.current = true;

    if (atBottomRef.current) {
      // Instant scroll during streaming so we don't fight smooth animations
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center gap-3 text-center px-6"
      >
        <div className="size-12 rounded-full bg-primary flex items-center justify-center">
          <Brain className="size-6 text-primary-foreground" />
        </div>
        <div>
          <p className="font-medium text-foreground">How can I help you?</p>
          <p className="text-sm text-muted-foreground mt-1">
            Ask anything — running fully offline via Ollama
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 min-h-0 overflow-y-auto"
    >
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {messages.map((msg, i) => {
          // Tool-result rows carry no name of their own — the preceding
          // assistant message is the empty `tool_calls` carrier that named it.
          const toolName =
            msg.role === "tool" ? messages[i - 1]?.tool_calls?.[0]?.function?.name : undefined;
          return (
            <MessageRow
              key={i}
              msg={msg}
              index={i}
              isLast={i === messages.length - 1}
              isStreaming={isStreaming}
              toolName={toolName}
            />
          );
        })}
        {/* Anchor element — we scroll the container directly instead */}
        <div className="h-px" />
      </div>
    </div>
  );
}

// role:"tool" content is the raw string the model sees back — either a tool's
// output, or one of stuckDetector.ts's internal nudges / agentRuntime.ts's
// denial message. Give those a plain-English label instead of shouting the
// raw bracketed text in the chat transcript; the full text stays on expand.
function toolChipLabel(content: string, toolName?: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("[BLOCKED")) return "Blocked";
  if (trimmed.startsWith("[SAME ERROR")) return "Retry guard";
  if (trimmed === "Tool call denied by user.") return "Denied";
  return toolName || "Tool result";
}

function ToolResultChip({ content, label: labelOverride }: { content: string; label?: string }) {
  const [expanded, setExpanded] = useState(false);

  // Extract tool name from "[Tool result: <name>]" prefix (legacy system-message shape)
  const match = content.match(/^\[Tool result:\s*([^\]]+)\]/);
  const label = labelOverride ?? (match ? match[1].trim() : "Tool result");
  const body = match ? content.slice(match[0].length).trim() : content;

  return (
    <div className="inline-flex flex-col max-w-full">
      {/* Chrome-free: these are transcript asides, not content. No surface or
          border — just quiet text that stays out of the conversation's way. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-1 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
        )}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <span className="font-mono">{label}</span>
      </button>
      {expanded && body && (
        <pre className="mt-1 mb-1 text-xs overflow-x-auto max-w-full whitespace-pre-wrap font-mono text-muted-foreground/80">
          {sanitize(body).slice(0, 8000)}
          {body.length > 8000 && "\n…(truncated)"}
        </pre>
      )}
    </div>
  );
}

const MAX_DISPLAY_LEN = 12_000;

function sanitize(text: string): string {
  // Remove null bytes and other non-printable control characters (keep newlines/tabs)
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function clamp(text: string): { text: string; clamped: boolean } {
  const s = sanitize(text);
  if (s.length <= MAX_DISPLAY_LEN) return { text: s, clamped: false };
  return { text: s.slice(0, MAX_DISPLAY_LEN), clamped: true };
}

// ─── Clickable citation popover ────────────────────────────────────────────
//
// citationsRehype.ts (a pure, store-free rehype plugin used by Markdown.tsx)
// turns inline citations like `[test/Sp26_Lec18_post.pdf p.45]` into
// `<span class="km-citation" data-cite-collection/-file/-location>` markup.
// This file — which is main-app-only and free to use Zustand stores — is
// where clicking one of those spans actually resolves to the word-for-word
// passage it refers to, by looking up the matching "knowledge" memory row(s)
// that the Knowledge Hub ingested it from.

/** State for the popover shown when a citation span is clicked. `text` starts
 *  as a "Loading…" placeholder (lookup is async — it may need to hydrate the
 *  memory store first) and is replaced once resolution finishes. */
interface CitePopoverState {
  collection: string;
  file: string;
  location: string;
  text: string;
  // "Open source file" (KM4): the matched entry's full original path, if it
  // has one (undefined for documents ingested before source_path existed —
  // the popover's "Open file" button simply doesn't render in that case).
  sourcePath?: string;
}

/**
 * Resolve the exact passage a citation refers to by searching the memory
 * store for "knowledge" rows matching `collection` + `sourceUri` (file).
 * Location matching allows a citation's location to be a prefix of a chunk's
 * stored location (e.g. citing "p.45" should also surface a chunk stored as
 * "p.45 (cont.)" when a cited passage was split across adjacent chunks at
 * ingestion time). Matches are sorted by `chunkIndex` and up to the first
 * two are joined with a blank line, since a single cited location can still
 * span two adjacent chunks.
 *
 * Ensures the store is hydrated first — `loadFromDb()` is idempotent and a
 * no-op once `hydrated` is true, so this is safe to call on every click.
 *
 * Also returns the first match's `sourcePath` (KM4 "open source file") so
 * the popover can offer an "Open file" button — undefined if the document
 * was ingested before that column existed, or no match was found.
 */
async function resolveCitationSnippet(
  collection: string,
  file: string,
  location: string,
): Promise<{ text: string; sourcePath?: string }> {
  const store = useMemoryStore.getState();
  if (!store.hydrated) {
    await store.loadFromDb();
  }
  const entries = useMemoryStore.getState().entries;
  const matches = entries.filter(
    (e) =>
      e.source === "knowledge" &&
      e.collection === collection &&
      e.sourceUri === file &&
      (e.location === location || (location !== "" && !!e.location?.startsWith(location)))
  );
  matches.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  if (matches.length === 0) {
    return { text: "(Couldn't find this passage — the document may have been deleted or re-ingested.)" };
  }
  return {
    text: matches
      .slice(0, 2)
      .map((m) => m.text)
      .join("\n\n"),
    sourcePath: matches[0].sourcePath,
  };
}

const MessageRow = memo(function MessageRow({
  msg,
  index,
  isLast,
  isStreaming,
  toolName,
}: {
  msg: ChatMessage;
  index: number;
  isLast: boolean;
  isStreaming: boolean;
  toolName?: string;
}) {
  const [showFull, setShowFull] = useState(false);
  const isUser = msg.role === "user";

  // Hooks must run unconditionally before any early return — rows are keyed by
  // array index, so a slot's role can change on chat swap and the hook count
  // must stay constant across renders.
  const { text: displayContent, clamped } = useMemo(() => clamp(msg.content ?? ""), [msg.content]);
  const rendered = useMemo(
    () => (showFull ? sanitize(msg.content ?? "") : displayContent),
    [showFull, msg.content, displayContent],
  );
  // Citation-popover state (clicking a `.km-citation` span in the assistant
  // branch below sets this). Placed here — with showFull/displayContent/
  // rendered — so the hook count stays constant across renders regardless of
  // which early return (system/tool/user/assistant) this row takes.
  const [citePopover, setCitePopover] = useState<CitePopoverState | null>(null);

  // Tool result system messages — render as collapsible chip
  if (msg.role === "system" && msg.content.startsWith("[Tool result:")) {
    return (
      <div className="flex justify-start">
        <ToolResultChip content={msg.content} />
      </div>
    );
  }

  // Generic system messages — subtle gray banner
  if (msg.role === "system") {
    return (
      <div className="flex justify-start">
        <div className="text-xs text-muted-foreground bg-muted rounded px-3 py-1 border italic max-w-2xl">
          {msg.content}
        </div>
      </div>
    );
  }

  // Tool results (and internal agent-loop nudges, which also arrive as
  // role:"tool" — see toolChipLabel) — collapsed chip, never a prose bubble.
  if (msg.role === "tool") {
    return (
      <div className="flex justify-start">
        <ToolResultChip content={msg.content} label={toolChipLabel(msg.content, toolName)} />
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          style={{ borderRadius: USER_R[index % 3], animation: MSG_IN_ANIMATION }}
          className="inline-block max-w-2xl text-left px-4 py-2.5 bg-primary text-primary-foreground"
        >
          <p className="text-sm whitespace-pre-wrap leading-[1.65]">{msg.content}</p>
          {msg.images && msg.images.length > 0 && (
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {msg.images.map((b64, i) => (
                <img
                  key={i}
                  src={`data:image/png;base64,${b64}`}
                  alt={`Attachment ${i + 1}`}
                  className="size-16 object-cover rounded border border-border"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Only role:"assistant" reaches here. App.tsx pushes blank-content assistant
  // messages as scaffolding: the onRoundStart placeholder for round > 1, and
  // the empty tool_calls carrier (its tool name now surfaces on the chip
  // above instead). Render nothing for those — UNLESS this is the live
  // "thinking" placeholder (last message, still streaming), which keeps the
  // bouncing-dot indicator below.
  const isBlank = !msg.content?.trim();
  if (isBlank && !(isLast && isStreaming)) {
    return null;
  }

  // Waiting for the first token: the placeholder assistant message has been
  // added (content === "") but nothing has streamed in yet. Show the design's
  // bouncing-dot indicator instead of an empty markdown block.
  const isThinking = isLast && isStreaming && !msg.content?.trim();

  // Citation click handling: citationsRehype.ts (via Markdown.tsx) has
  // already rewritten every `[collection/file location]` token into a
  // `<span class="km-citation" data-cite-*>`. We don't need per-span
  // listeners — a single delegated click handler on the wrapping div below
  // catches bubbled clicks and checks whether they landed on (or inside) one
  // of those spans via `.closest()`.
  function handleCiteClick(e: MouseEvent<HTMLDivElement>) {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".km-citation");
    if (!el) return;
    const collection = el.dataset.citeCollection ?? "";
    const file = el.dataset.citeFile ?? "";
    const location = el.dataset.citeLocation ?? "";
    // Show a synchronous "Loading…" placeholder immediately (lookup below is
    // async — it may need to hydrate the memory store first), then replace
    // it once resolution finishes. Guard against a second, newer click
    // having already replaced the popover by the time this resolves.
    setCitePopover({ collection, file, location, text: "Loading…" });
    resolveCitationSnippet(collection, file, location).then(({ text, sourcePath }) => {
      setCitePopover((prev) =>
        prev && prev.collection === collection && prev.file === file && prev.location === location
          ? { collection, file, location, text, sourcePath }
          : prev,
      );
    });
  }

  // "Open source file" (KM4): hand the citation popover's resolved
  // sourcePath to the opener plugin. Not a hook — plain async handler, safe
  // to define per-render like handleCiteClick above.
  async function handleOpenSourceFile(sourcePath: string) {
    try {
      await openSourceFile(sourcePath);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open file");
    }
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-2xl min-w-0 space-y-1">
        <div
          style={{ borderRadius: AI_R[index % 3], animation: MSG_IN_ANIMATION }}
          className={cn(
            "bg-bubble border border-border overflow-hidden",
            isThinking
              ? "px-4 py-3 inline-block"
              : "px-4 py-2.5 prose prose-sm max-w-none prose-pre:bg-muted prose-pre:border prose-code:text-foreground prose-p:my-1.5 prose-headings:font-medium"
          )}
        >
          {isThinking ? (
            <div className="flex gap-1.5 items-center h-4">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="block w-1.5 h-1.5 rounded-full bg-muted-foreground/40"
                  style={{ animation: "nbounce 1s ease-in-out infinite", animationDelay: `${i * 0.14}s` }}
                />
              ))}
            </div>
          ) : (
            <>
              <div onClick={handleCiteClick}>
                <Markdown>{rendered || " "}</Markdown>
              </div>
              {isLast && isStreaming && (
                <span className="inline-block w-0.5 h-4 bg-foreground/40 animate-pulse ml-0.5 align-middle" />
              )}
            </>
          )}
        </div>
        {clamped && !showFull && (
          <button
            type="button"
            onClick={() => setShowFull(true)}
            className="text-xs text-primary hover:underline"
          >
            Show full response ({Math.round((msg.content?.length ?? 0) / 1000)}K chars)…
          </button>
        )}
      </div>

      {/* Citation popover: a centered, dismissible card showing the exact
          passage a clicked `[collection/file location]` citation refers to.
          Backdrop click or the ✕ button both dismiss it. */}
      {citePopover && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setCitePopover(null)}
        >
          <div
            className="w-full max-w-lg max-h-[70vh] flex flex-col bg-popover border border-border rounded-xl shadow-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border shrink-0">
              <span className="font-mono text-xs text-muted-foreground truncate">
                {citePopover.collection}/{citePopover.file}
                {citePopover.location ? ` ${citePopover.location}` : ""}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {/* KM4: only shown when this citation resolved to a chunk that
                    has a full source path on file (post-KM4 ingests) — older
                    documents have no path to open, so the button is simply
                    absent rather than shown disabled. */}
                {citePopover.sourcePath && (
                  <button
                    type="button"
                    onClick={() => void handleOpenSourceFile(citePopover.sourcePath!)}
                    title="Open source file"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                    Open file
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCitePopover(null)}
                  aria-label="Close"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
            <div className="px-4 py-3 max-h-[50vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {citePopover.text}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
