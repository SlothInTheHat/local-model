import { useState, useRef } from "react";
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
} from "lucide-react";
import { WorkspaceSelector } from "./WorkspaceSelector";
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
}

export function ChatSidebar({ view, onViewChange, selectedModel, onModelChange }: Props) {
  const { conversations, activeId, newConversation, selectConversation, deleteConversation, renameConversation } =
    useChatStore();
  const { hardware } = useModelStore();

  const [searchQuery, setSearchQuery] = useState("");

  const filteredConversations = searchQuery.trim()
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.messages.some((m) =>
            m.content.toLowerCase().includes(searchQuery.toLowerCase())
          )
      )
    : conversations;

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
            <div className="text-xs text-muted-foreground">v0.2.0</div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-1">
          <Button
            variant={view === "chat" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            onClick={() => onViewChange("chat")}
          >
            <MessageSquare className="size-4" />
            Chat
          </Button>
          <Button
            variant={view === "code" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            onClick={() => onViewChange("code")}
          >
            <Code2 className="size-4" />
            Code Editor
          </Button>
          <Button
            variant={view === "docs" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            onClick={() => onViewChange("docs")}
          >
            <FileText className="size-4" />
            Doc Editor
          </Button>
          <Button
            variant={view === "models" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            onClick={() => onViewChange("models")}
          >
            <Library className="size-4" />
            Model Library
          </Button>
          <Button
            variant={view === "terminal" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            onClick={() => onViewChange("terminal")}
          >
            <TerminalSquare className="size-4" />
            Terminal
          </Button>
          <Button
            variant={view === "agents" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            onClick={() => onViewChange("agents")}
          >
            <Bot className="size-4" />
            Subagents
          </Button>
        </div>

        {/* Model selector — always visible across all tabs */}
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

            {/* Search */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats…"
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
        <Button
          variant="outline"
          size="sm"
          className="w-full mt-1"
          onClick={() => onViewChange("models")}
        >
          <Settings className="size-3 mr-2" />
          Settings & Models
        </Button>
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
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setEditValue(conv.title);
    setEditing(true);
    // Focus after render
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commitEdit() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conv.title) {
      onRename(trimmed);
    }
    setEditing(false);
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
    <button
      onClick={onSelect}
      onDoubleClick={startEdit}
      className={cn(
        "w-full text-left px-3 py-2 rounded-md text-xs transition-colors flex items-center justify-between group",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent text-foreground/70 hover:text-foreground"
      )}
    >
      <span className="truncate flex-1">{conv.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="opacity-0 group-hover:opacity-100 ml-1 hover:text-destructive transition-all shrink-0"
      >
        <Trash2 className="size-3" />
      </button>
    </button>
  );
}
