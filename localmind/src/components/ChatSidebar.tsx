import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Trash2,
  MessageSquare,
  Library,
  Brain,
  Cpu,
  HardDrive,
  MemoryStick,
  Settings,
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
  const { conversations, activeId, newConversation, selectConversation, deleteConversation, renameConversation } =
    useChatStore();
  const { hardware } = useModelStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [showMcp, setShowMcp] = useState(false);

  const filteredConversations = searchQuery.trim()
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.messages.some((m) =>
            m.content.toLowerCase().includes(searchQuery.toLowerCase())
          )
      )
    : conversations;

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

  const navItems: { id: AppView; icon: React.ReactNode; label: string }[] = [
    { id: "chat", icon: <MessageSquare className="size-4" />, label: "Chat" },
    { id: "research", icon: <Microscope className="size-4" />, label: "Deep Research" },
    { id: "study", icon: <BookOpen className="size-4" />, label: "Study Mode" },
    { id: "code", icon: <Code2 className="size-4" />, label: "Code Editor" },
    { id: "docs", icon: <FileText className="size-4" />, label: "Doc Editor" },
    { id: "models", icon: <Library className="size-4" />, label: "Model Library" },
    { id: "terminal", icon: <TerminalSquare className="size-4" />, label: "Terminal" },
    { id: "agents", icon: <Bot className="size-4" />, label: "Subagents" },
    { id: "settings", icon: <CircleUser className="size-4" />, label: "Profile & Settings" },
  ];

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
        {/* Navigation */}
        <div className="p-3 space-y-0.5">
          {navItems.map((item) => (
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
          <div className="p-3 space-y-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground px-1">Recent Chats</span>
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                onClick={() => newConversation(selectedModel)}
              >
                <Plus className="size-3" />
              </Button>
            </div>

            <input
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
            {filteredConversations.map((c) => (
              <ConversationItem
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onSelect={() => selectConversation(c.id)}
                onDelete={() => deleteConversation(c.id)}
                onRename={(title) => renameConversation(c.id, title)}
              />
            ))}
          </div>
        )}

        <Separator className="my-1" />

        {/* MCP Integrations section */}
        <div className="p-3">
          <button
            onClick={() => setShowMcp((v) => !v)}
            className="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
          >
            <Plug className="size-3.5" />
            <span className="font-medium">Integrations (MCP)</span>
            <span className="ml-auto text-[10px]">{showMcp ? "▲" : "▼"}</span>
          </button>
          {showMcp && <McpSettings />}
        </div>
      </ScrollArea>

      {/* System info footer */}
      <div className="p-3 border-t space-y-2">
        <WorkspaceSelector />
        {hardware ? (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Cpu className="size-3 shrink-0" />
              <span className="truncate">{hardware.cpuThreads} CPU threads</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <HardDrive className="size-3 shrink-0" />
              <span className="truncate">
                {hardware.gpuName === "Unknown GPU" ? "GPU unknown" : hardware.gpuName}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MemoryStick className="size-3 shrink-0" />
              <span>{hardware.ramGb} GB RAM</span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Cpu className="size-3" />
            <span>Hardware not scanned</span>
          </div>
        )}
        <div className="flex gap-1.5 mt-1">
          <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => onViewChange("models")}>
            <Library className="size-3 mr-1.5" />
            Models
          </Button>
          <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => onViewChange("settings")}>
            <Settings className="size-3 mr-1.5" />
            Settings
          </Button>
        </div>
      </div>
    </aside>
  );
}

function ConversationItem({
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
