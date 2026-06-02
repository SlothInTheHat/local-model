import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { cn } from "./ui/utils";
import type { ChatMessage } from "../lib/ollama";

interface Props {
  messages: ChatMessage[];
  isStreaming: boolean;
}

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
      <div className="w-full px-6 py-6 space-y-6">
        {messages.map((msg, i) => (
          <MessageRow
            key={i}
            msg={msg}
            isLast={i === messages.length - 1}
            isStreaming={isStreaming}
          />
        ))}
        {/* Anchor element — we scroll the container directly instead */}
        <div className="h-px" />
      </div>
    </div>
  );
}

function ToolResultChip({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  // Extract tool name from "[Tool result: <name>]" prefix
  const match = content.match(/^\[Tool result:\s*([^\]]+)\]/);
  const label = match ? match[1].trim() : "Tool result";
  const body = match ? content.slice(match[0].length).trim() : content;

  return (
    <div className="inline-flex flex-col max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted text-muted-foreground hover:text-foreground transition-colors border border-border w-fit"
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
        <pre className="mt-1 text-xs bg-muted border rounded p-2 overflow-x-auto max-w-full whitespace-pre-wrap font-mono text-muted-foreground">
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

function MessageRow({
  msg,
  isLast,
  isStreaming,
}: {
  msg: ChatMessage;
  isLast: boolean;
  isStreaming: boolean;
}) {
  const [showFull, setShowFull] = useState(false);
  const isUser = msg.role === "user";

  // Tool result system messages — render as collapsible chip
  if (msg.role === "system" && msg.content.startsWith("[Tool result:")) {
    return (
      <div className="flex justify-center">
        <ToolResultChip content={msg.content} />
      </div>
    );
  }

  // Generic system messages — subtle gray banner
  if (msg.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-muted-foreground bg-muted rounded px-3 py-1 border italic max-w-2xl">
          {msg.content}
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex gap-3 justify-end">
        <div className="flex-1 max-w-2xl space-y-1 text-right">
          <div className="text-xs text-muted-foreground">You</div>
          <Card className="inline-block text-left">
            <CardContent className="p-3">
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
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
            </CardContent>
          </Card>
        </div>
        <div className="size-8 rounded-full bg-accent border flex items-center justify-center shrink-0 mt-5">
          <span className="text-[10px] font-semibold text-accent-foreground">ME</span>
        </div>
      </div>
    );
  }

  const { text: displayContent, clamped } = clamp(msg.content ?? "");
  const rendered = showFull ? sanitize(msg.content ?? "") : displayContent;

  return (
    <div className="flex gap-3">
      <div className="size-8 rounded-full bg-primary flex items-center justify-center shrink-0 mt-5">
        <Brain className="size-4 text-primary-foreground" />
      </div>
      <div className="flex-1 space-y-1 min-w-0 overflow-hidden">
        <div className="text-xs text-muted-foreground">LocalMind Assistant</div>
        <div className="prose prose-sm max-w-none prose-pre:bg-muted prose-pre:border prose-code:text-foreground prose-p:my-1.5 prose-headings:font-medium overflow-hidden">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {rendered || " "}
          </ReactMarkdown>
          {isLast && isStreaming && (
            <span className="inline-block w-0.5 h-4 bg-foreground/40 animate-pulse ml-0.5 align-middle" />
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
    </div>
  );
}
