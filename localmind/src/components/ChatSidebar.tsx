import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Trash2,
  MessageSquare,
  Library,
  Brain,
  Cpu,
  Code2,
  FileText,
  TerminalSquare,
  Bot,
  Microscope,
  BookOpen,
  Download,
  MoreHorizontal,
  Search,
  Plug,
  CircleUser,
  ImageIcon,
  BookMarked,
  BarChart2,
  Columns2,
  ScrollText,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { McpSettings } from "./McpSettings";
import { cn } from "./ui/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { ModelSelector } from "./ModelSelector";
import { useChatStore, type Conversation } from "../store/chat";
import { useModelStore } from "../store/models";
import { supportsNativeTools } from "../lib/modelCapabilities";
import type { AppView } from "../types/app";

interface Props {
  view: AppView;
  onViewChange: (v: AppView) => void;
  selectedModel: string;
  onModelChange: (m: string) => void;
  onOpenSearch: () => void;
}

export function ChatSidebar({ view, onViewChange, selectedModel, onModelChange, onOpenSearch }: Props) {
  const { hardware } = useModelStore();

  const [showMcp, setShowMcp] = useState(false);

  // Cmd+K / Ctrl+K global shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenSearch]);

  type NavItem = { id: AppView; icon: React.ReactNode; label: string };

  const primaryItems: NavItem[] = [
    { id: "chat",     icon: <MessageSquare className="size-4" />, label: "Chat" },
    { id: "code",     icon: <Code2 className="size-4" />,         label: "Code Editor" },
    { id: "research", icon: <Microscope className="size-4" />,    label: "Deep Research" },
    { id: "models",   icon: <Library className="size-4" />,       label: "Model Library" },
    { id: "memory",   icon: <Brain className="size-4" />,         label: "Memory" },
    { id: "settings", icon: <CircleUser className="size-4" />,    label: "Settings" },
  ];

  const moreItems: NavItem[] = [
    { id: "compare",    icon: <Columns2 className="size-4" />,       label: "Compare Models" },
    { id: "study",      icon: <BookOpen className="size-4" />,        label: "Study Mode" },
    { id: "docs",       icon: <FileText className="size-4" />,        label: "Doc Editor" },
    { id: "image",      icon: <ImageIcon className="size-4" />,       label: "Image Editor" },
    { id: "skills",     icon: <BookMarked className="size-4" />,      label: "Skill Registry" },
    { id: "benchmarks", icon: <BarChart2 className="size-4" />,       label: "Benchmarks" },
    { id: "terminal",   icon: <TerminalSquare className="size-4" />,  label: "Terminal" },
    { id: "agents",     icon: <Bot className="size-4" />,             label: "Subagents" },
    { id: "logs",       icon: <ScrollText className="size-4" />,      label: "Logs" },
  ];

  // Auto-expand "More" if the current view is in the secondary list
  const isMoreView = moreItems.some((i) => i.id === view);
  const [showMore, setShowMore] = useState(isMoreView);

  return (
    <aside className="w-64 border-r bg-card flex flex-col h-full shrink-0">
      {/* Logo */}
      <div className="p-4 border-b">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <Brain className="size-5 text-primary-foreground" />
          </div>
          <div>
            <div className="text-sm font-medium leading-tight">LocalMind</div>
            <div className="text-xs text-muted-foreground">v0.3.0</div>
          </div>
          {/* Cmd+K hint */}
          <button
            onClick={onOpenSearch}
            className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            title="Search conversations (⌘K)"
          >
            <Search className="size-3" />
            <kbd className="px-1 py-0.5 rounded bg-muted border border-border">⌘K</kbd>
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {/* Primary navigation */}
        <div className="p-3 space-y-0.5">
          {primaryItems.map((item) => (
            <Button
              key={item.id}
              variant={view === item.id ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              onClick={() => onViewChange(item.id)}
            >
              {item.icon}
              {item.label}
            </Button>
          ))}

          {/* More / secondary nav toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowMore((v) => !v)}
            className="w-full justify-start gap-2 mt-1 text-muted-foreground hover:text-foreground"
          >
            {showMore ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            <span className="text-xs">{showMore ? "Less" : "More"}</span>
            {isMoreView && !showMore && (
              <span className="ml-auto size-1.5 rounded-full bg-primary" />
            )}
          </Button>

          {showMore && (
            <div className="space-y-0.5 pt-0.5">
              {moreItems.map((item) => (
                <Button
                  key={item.id}
                  variant={view === item.id ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                  onClick={() => onViewChange(item.id)}
                >
                  {item.icon}
                  {item.label}
                </Button>
              ))}
            </div>
          )}
        </div>

        {/* Model selector */}
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-muted-foreground">Active Model</span>
            {selectedModel && (
              <span
                className={cn(
                  "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                  supportsNativeTools(selectedModel)
                    ? "bg-green-100 text-green-700"
                    : "bg-amber-100 text-amber-700"
                )}
              >
                {supportsNativeTools(selectedModel) ? "tools on" : "no tools"}
              </span>
            )}
          </div>
          <ModelSelector value={selectedModel} onChange={onModelChange} compact />
        </div>

        <Separator className="my-1" />

        {/* Chat list (only in chat view) */}
        {view === "chat" && (
          <div className="p-3">
            <RecentChatsPanel selectedModel={selectedModel} />
          </div>
        )}

        <Separator className="my-1" />

        {/* MCP Integrations section */}
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

      {/* System info footer */}
      <div className="p-3 border-t space-y-2">
        <WorkspaceSelector />
        {hardware ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <Cpu className="size-3 shrink-0" />
            <span className="truncate">
              {hardware.cpuThreads}c · {hardware.gpuName === "Unknown GPU" ? "GPU unknown" : hardware.gpuName} · {hardware.ramGb}GB
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Cpu className="size-3" />
            <span>Hardware not scanned</span>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * Recent-chats list: search filter, MAX_VISIBLE_CHATS cap, "+N more — search
 * to find them" button, and ConversationItem rows. Lifted out of the retired
 * sidebar layout so both the old aside (unused, kept for reference) and the
 * new Nucleus chat drawer (see ChatDrawer.tsx) share the exact same logic.
 */
export function RecentChatsPanel({
  selectedModel,
  onAfterSelect,
}: {
  selectedModel: string;
  onAfterSelect?: () => void;
}) {
  const { conversations, activeId, newConversation, selectConversation, deleteConversation, renameConversation } =
    useChatStore();
  const [searchQuery, setSearchQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const searching = searchQuery.trim().length > 0;
  const filteredConversations = searching
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.messages.some((m) =>
            m.content.toLowerCase().includes(searchQuery.toLowerCase())
          )
      )
    : conversations;

  // Cap the resting list — a long chat history otherwise dominates the panel.
  // Search always shows every match (never capped).
  const MAX_VISIBLE_CHATS = 8;
  const visibleConversations = searching
    ? filteredConversations
    : filteredConversations.slice(0, MAX_VISIBLE_CHATS);
  const hiddenChatCount = searching ? 0 : conversations.length - visibleConversations.length;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground px-1">Recent Chats</span>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={() => {
            newConversation(selectedModel);
            onAfterSelect?.();
          }}
        >
          <Plus className="size-3" />
        </Button>
      </div>

      <input
        ref={filterInputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Filter chats…"
        className="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
      />

      {filteredConversations.length === 0 && (
        <p className="text-xs text-muted-foreground px-3 py-2">
          {searchQuery ? "No results" : "No chats yet"}
        </p>
      )}
      {visibleConversations.map((c) => (
        <ConversationItem
          key={c.id}
          conv={c}
          active={c.id === activeId}
          onSelect={() => {
            selectConversation(c.id);
            onAfterSelect?.();
          }}
          onDelete={() => deleteConversation(c.id)}
          onRename={(title) => renameConversation(c.id, title)}
        />
      ))}
      {hiddenChatCount > 0 && (
        <button
          type="button"
          onClick={() => filterInputRef.current?.focus()}
          className="w-full text-left px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          +{hiddenChatCount} more — search to find them
        </button>
      )}
    </div>
  );
}

export function ConversationItem({
  conv,
  active,
  onSelect,
  onDelete,
  onRename,
}: {
  conv: Conversation;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(conv.title);
  const [showMenu, setShowMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setEditValue(conv.title);
    setEditing(true);
    setShowMenu(false);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commitEdit() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conv.title) {
      onRename(trimmed);
    }
    setEditing(false);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(conv, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${conv.title.replace(/[^a-z0-9]/gi, "-").slice(0, 40)}.json`;
    a.click();
    setShowMenu(false);
  }

  function exportMarkdown() {
    const lines = [`# ${conv.title}\n`];
    conv.messages.forEach((m) => {
      if (m.role === "system") return;
      lines.push(`**${m.role === "user" ? "You" : "Assistant"}**: ${m.content}\n`);
    });
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${conv.title.replace(/[^a-z0-9]/gi, "-").slice(0, 40)}.md`;
    a.click();
    setShowMenu(false);
  }

  if (editing) {
    return (
      <div className="px-1">
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
          className="w-full text-xs px-2 py-1 rounded border border-ring bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    );
  }

  return (
    <div className="relative group">
      <button
        onClick={onSelect}
        onDoubleClick={startEdit}
        className={cn(
          "w-full text-left px-3 py-2 rounded-md text-xs transition-colors flex items-center justify-between",
          active
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent text-foreground/70 hover:text-foreground"
        )}
      >
        <span className="truncate flex-1">{conv.title}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0 ml-1">
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
            className="p-0.5 hover:text-foreground transition-colors"
          >
            <MoreHorizontal className="size-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-0.5 hover:text-destructive transition-colors"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </button>

      {showMenu && (
        <div className="absolute right-0 top-full z-20 mt-0.5 w-36 bg-card border border-border rounded-md shadow-lg overflow-hidden">
          <button onClick={startEdit} className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors">Rename</button>
          <button onClick={exportMarkdown} className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors flex items-center gap-2">
            <Download className="size-3" /> Export .md
          </button>
          <button onClick={exportJson} className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors flex items-center gap-2">
            <Download className="size-3" /> Export .json
          </button>
          <button onClick={() => { onDelete(); setShowMenu(false); }} className="w-full text-left px-3 py-1.5 text-xs text-destructive hover:bg-accent transition-colors">Delete</button>
        </div>
      )}
    </div>
  );
}
