import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Sparkles, Check, X } from "lucide-react";
import { Button } from "./ui/button";

interface Props {
  editor: Editor;
  /** Same positioned ancestor DocFloatingComments uses — keeps this card's
   *  `top` correct regardless of scroll, since both scroll together. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  suggestion: { from: number; to: number; text: string; loading: boolean };
  onAccept: () => void;
  onReject: () => void;
}

/**
 * A pending AI text-action result, shown for explicit Accept/Reject rather
 * than being written into the document immediately — mirrors how the comment
 * thread's "Ask AI" never edits the doc on its own; this closes the one place
 * that still did (the right-click menu's presets/custom prompt).
 */
export function DocAiSuggestionCard({ editor, containerRef, suggestion, onAccept, onReject }: Props) {
  const [top, setTop] = useState(0);
  const wholeDoc = suggestion.from === suggestion.to;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || wholeDoc) {
      setTop(0);
      return;
    }
    try {
      const coords = editor.view.coordsAtPos(suggestion.from);
      setTop(coords.top - container.getBoundingClientRect().top);
    } catch {
      setTop(0);
    }
  }, [editor, containerRef, suggestion.from, wholeDoc]);

  return (
    <div className="w-64 shrink-0 relative">
      <div className="absolute left-0 right-2" style={{ top }}>
        <div className="rounded-lg border border-primary/60 bg-card shadow-md p-2 space-y-1.5 text-xs pointer-events-auto">
          <div className="flex items-center gap-1 text-[10px] font-medium text-primary">
            <Sparkles className="size-2.5" />
            {wholeDoc ? "AI suggestion (whole document)" : "AI suggestion"}
            {suggestion.loading && "…"}
          </div>
          <p className="whitespace-pre-wrap leading-snug text-foreground max-h-48 overflow-y-auto">
            {suggestion.text || "Thinking…"}
          </p>
          {!suggestion.loading && (
            <div className="flex items-center gap-1">
              <Button size="sm" className="h-6 text-[11px] px-2 flex-1 gap-1" onClick={onAccept}>
                <Check className="size-3" /> Accept
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-[11px] px-2 flex-1 gap-1" onClick={onReject}>
                <X className="size-3" /> Reject
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
