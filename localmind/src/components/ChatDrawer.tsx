import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { RecentChatsPanel } from "./ChatSidebar";

interface Props {
  open: boolean;
  onClose: () => void;
  selectedModel: string;
}

/**
 * Slide-over panel for Recent Chats — replaces the old sidebar's chat list.
 * Reuses RecentChatsPanel (ChatSidebar.tsx) verbatim: search filter,
 * MAX_VISIBLE_CHATS cap, "+N more" button, ConversationItem rows.
 */
export function ChatDrawer({ open, onClose, selectedModel }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute inset-y-0 left-0 z-20 w-64 max-w-[85%] bg-card border-r border-black/[0.08] flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.1)]"
      style={{ animation: "msgIn 0.22s cubic-bezier(0.34, 1.2, 0.64, 1)" }}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-black/[0.05] shrink-0">
        <span className="text-xs font-medium text-foreground">Recent Chats</span>
        <button
          type="button"
          onClick={onClose}
          className="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        <RecentChatsPanel selectedModel={selectedModel} onAfterSelect={onClose} />
      </div>
    </div>
  );
}
