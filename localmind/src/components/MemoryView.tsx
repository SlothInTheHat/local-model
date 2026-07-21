import { useEffect, useState } from "react";
import { Brain, Plus, Trash2, Search, Tag, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { toast } from "sonner";
import { useMemoryStore } from "../store/memory";
import { addMemory, searchMemory } from "../lib/vectorMemory";
import type { MemoryEntry } from "../store/memory";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

export function MemoryView() {
  const { entries, embedModel, removeEntry, setEmbedModel, loadFromDb } = useMemoryStore();

  // Memories now live in SQLite (WP1.4), hydrated lazily on first use by
  // addMemory/searchMemory. This tab needs them visible even if the user
  // opens it before ever searching or adding, so trigger hydration here too
  // (loadFromDb is idempotent — a no-op once already hydrated).
  useEffect(() => {
    void loadFromDb();
  }, [loadFromDb]);

  const [addText, setAddText] = useState("");
  const [addTags, setAddTags] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ entry: MemoryEntry; score: number }> | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const [editModel, setEditModel] = useState(embedModel);
  const [showSettings, setShowSettings] = useState(false);

  async function handleAdd() {
    if (!addText.trim()) return;
    setIsAdding(true);
    try {
      const tags = addTags.split(",").map((t) => t.trim()).filter(Boolean);
      await addMemory(addText.trim(), tags, "user");
      setAddText("");
      setAddTags("");
      setShowAddForm(false);
      toast.success("Memory saved");
    } catch (err) {
      toast.error(`Could not embed: ${(err as Error).message}. Is Ollama running with ${embedModel}?`);
    } finally {
      setIsAdding(false);
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    setIsSearching(true);
    try {
      const results = await searchMemory(searchQuery.trim(), 10, 0.3);
      setSearchResults(results);
    } catch (err) {
      toast.error(`Search failed: ${(err as Error).message}`);
    } finally {
      setIsSearching(false);
    }
  }

  function handleDelete(id: string) {
    removeEntry(id);
    if (searchResults) {
      setSearchResults((prev) => prev?.filter((r) => r.entry.id !== id) ?? null);
    }
    toast.success("Memory deleted");
  }

  const displayed = searchResults
    ? searchResults.map((r) => r.entry)
    : entries;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="border-b bg-card px-4 py-3 flex items-center gap-3 shrink-0">
        <Brain className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Vector Memory</h2>
        <span className="text-xs text-muted-foreground">{entries.length} memor{entries.length === 1 ? "y" : "ies"}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Settings
          </button>
          <Button size="sm" onClick={() => setShowAddForm((v) => !v)} className="h-7 text-xs gap-1">
            <Plus className="size-3" /> Add memory
          </Button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b bg-muted/30 px-4 py-3 shrink-0 space-y-2">
          <p className="text-xs font-medium text-foreground">Embedding model</p>
          <p className="text-[10px] text-muted-foreground">
            Must be installed in Ollama. Recommended: <code>nomic-embed-text</code> or <code>mxbai-embed-large</code>.
            Run <code>ollama pull nomic-embed-text</code> to install.
          </p>
          <div className="flex gap-2">
            <Input
              value={editModel}
              onChange={(e) => setEditModel(e.target.value)}
              className="text-xs h-7 flex-1"
              placeholder="nomic-embed-text"
            />
            <Button size="sm" className="h-7 text-xs" onClick={() => { setEmbedModel(editModel); toast.success(`Embed model set to ${editModel}`); }}>
              Save
            </Button>
          </div>
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <div className="border-b bg-muted/20 px-4 py-3 shrink-0 space-y-2">
          <Textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="What should the agent remember? e.g. 'User prefers TypeScript over JavaScript'"
            className="text-sm resize-none"
            rows={3}
          />
          <div className="flex gap-2 items-center">
            <Tag className="size-3 text-muted-foreground shrink-0" />
            <Input
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
              placeholder="Tags (comma-separated, optional)"
              className="text-xs h-7 flex-1"
            />
            <Button size="sm" className="h-7 text-xs" onClick={() => void handleAdd()} disabled={isAdding || !addText.trim()}>
              {isAdding ? "Embedding…" : "Save"}
            </Button>
            <button type="button" onClick={() => setShowAddForm(false)} className="text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Search bar */}
      <div className="border-b px-4 py-2 flex gap-2 items-center shrink-0">
        <Search className="size-3.5 text-muted-foreground shrink-0" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
          placeholder="Search memories… (Enter)"
          className="text-xs h-7 flex-1 border-0 focus-visible:ring-0 bg-transparent"
        />
        {searchQuery && (
          <button type="button" onClick={() => { setSearchQuery(""); setSearchResults(null); }} className="text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
          </button>
        )}
        {isSearching && <span className="text-xs text-muted-foreground">Searching…</span>}
        {searchResults && (
          <span className="text-xs text-muted-foreground">{searchResults.length} result{searchResults.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Memory list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
            <Brain className="size-8 text-muted-foreground/40" />
            {entries.length === 0 ? (
              <>
                <p className="text-sm text-muted-foreground">No memories yet</p>
                <p className="text-xs text-muted-foreground">
                  Add facts, preferences, and context that the agent should remember across conversations.
                  Requires <code className="text-[10px]">nomic-embed-text</code> installed in Ollama.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No memories matched your search</p>
            )}
          </div>
        ) : (
          <div className="divide-y">
            {displayed.map((entry) => {
              const result = searchResults?.find((r) => r.entry.id === entry.id);
              return (
                <div key={entry.id} className="px-4 py-3 hover:bg-muted/30 group transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground leading-snug">{entry.text}</p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {entry.tags.map((tag) => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                        <span className="text-[10px] text-muted-foreground">{relativeTime(entry.createdAt)}</span>
                        {entry.source === "agent" && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100">agent</span>
                        )}
                        {result && (
                          <span className="text-[10px] text-green-600">
                            {Math.round(result.score * 100)}% match
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(entry.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0 mt-0.5"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
