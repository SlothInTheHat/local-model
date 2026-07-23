import { useState, useRef } from "react";
import { Plus, Trash2, MoreHorizontal, Download } from "lucide-react";
import { cn } from "./ui/utils";
import { Button } from "./ui/button";
import { useChatStore, type Conversation } from "../store/chat";

/**
 * Recent-chats list: search filter, MAX_VISIBLE_CHATS cap, "+N more — search
 * to find them" button, and ConversationItem rows. Used by the persistent
 * chat-view panel (see ChatSidePanel.tsx).
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
