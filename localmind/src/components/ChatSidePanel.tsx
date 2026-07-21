import { useState } from "react";
import { ChevronDown, ChevronUp, Plug } from "lucide-react";
import { RecentChatsPanel } from "./ChatSidebar";
import { ModelSelector } from "./ModelSelector";
import { McpSettings } from "./McpSettings";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";

interface Props {
  selectedModel: string;
  onModelChange: (model: string) => void;
}

/**
 * Persistent left panel for the chat view (real flex sibling inside the
 * island, not an overlay — same treatment as FileTree). Replaces the old
 * slide-over ChatDrawer. Composes three pieces that used to live in the
 * retired ChatSidebar.tsx aside:
 *   - RecentChatsPanel (new-chat button, search filter, capped list) reused
 *     verbatim — its cap/filter/"+N more" logic is untouched here.
 *   - ModelSelector (compact) for switching models without leaving chat.
 *   - McpSettings, collapsed behind a toggle exactly like the old sidebar.
 */
export function ChatSidePanel({ selectedModel, onModelChange }: Props) {
  const [showMcp, setShowMcp] = useState(false);

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3">
          <RecentChatsPanel selectedModel={selectedModel} />
        </div>

        <Separator className="my-1" />

        <div className="px-3 pb-2">
          <span className="text-xs text-muted-foreground mb-1.5 block">Model</span>
          <ModelSelector value={selectedModel} onChange={onModelChange} compact />
        </div>

        <Separator className="my-1" />

        <div className="p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowMcp((v) => !v)}
            className="w-full justify-start gap-2 mb-2 text-muted-foreground hover:text-foreground"
          >
            <Plug className="size-3.5" />
            <span className="text-xs font-medium">Integrations (MCP)</span>
            <span className="ml-auto">
              {showMcp ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </span>
          </Button>
          {showMcp && <McpSettings />}
        </div>
      </ScrollArea>
    </div>
  );
}
