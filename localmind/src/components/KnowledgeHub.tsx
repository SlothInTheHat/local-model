/**
 * KM2 — Knowledge Hub UI.
 *
 * Replaces the old branching-chat StudyMode with a per-class knowledge base
 * manager: create/delete "classes" (collections), upload documents into one,
 * watch ingest progress, browse/delete ingested documents, and run cited
 * semantic search scoped to the selected class. All data plumbing (SQLite via
 * Tauri commands) already exists in useKnowledgeStore (src/store/knowledge.ts)
 * and the ingest pipeline (src/lib/knowledge/ingest.ts) — this component is
 * purely presentational + local UI state (selected class, doc list, search).
 */
import { useEffect, useState } from "react";
import { Plus, Trash2, Upload, Search, FileText, Check, GraduationCap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useKnowledgeStore, type DocRow } from "../store/knowledge";
import { pickUploadFiles } from "../lib/knowledge/ingest";
import { searchMemory } from "../lib/vectorMemory";
import type { MemoryEntry } from "../store/memory";
import type { IngestProgress } from "../lib/knowledge/types";

type SearchResult = { entry: MemoryEntry; score: number; rawScore: number };

/** Matches KM3's tool-facing anchor format exactly — see vectorMemory.ts's
 *  formatMemoriesForContext for the sibling implementation used in chat context. */
function citationAnchor(entry: MemoryEntry): string {
  const parts = [entry.collection, entry.sourceUri].filter(Boolean).join("/");
  return `[${[parts, entry.location].filter(Boolean).join(" ")}]`;
}

function progressLabel(p: IngestProgress): string {
  if (p.phase === "error") return `${p.file} — ${p.error ?? "failed"}`;
  if (p.phase === "embedding") return `Embedding ${p.file} — ${p.done}/${p.total}`;
  if (p.phase === "extracting") return `Extracting ${p.file}…`;
  if (p.phase === "reading") return `Reading ${p.file}…`;
  return `${p.file} done`;
}

export function KnowledgeHub() {
  const { collections, ingesting, progress, loadCollections, createCollection, deleteCollection, listDocs, deleteDoc, ingest } =
    useKnowledgeStore();

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newClassName, setNewClassName] = useState("");
  const [creating, setCreating] = useState(false);

  const [docs, setDocs] = useState<DocRow[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [pickerNotice, setPickerNotice] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [copiedAnchor, setCopiedAnchor] = useState<string | null>(null);

  const selected = collections.find((c) => c.id === selectedId) ?? null;

  async function refreshDocs(id: string) {
    setDocsLoading(true);
    try {
      const rows = await listDocs(id);
      setDocs(rows);
    } catch (err) {
      toast.error(`Failed to load documents: ${(err as Error).message}`);
    } finally {
      setDocsLoading(false);
    }
  }

  useEffect(() => {
    if (selectedId) {
      void refreshDocs(selectedId);
      setResults(null);
      setQuery("");
    } else {
      setDocs([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function handleCreateClass() {
    const label = newClassName.trim();
    if (!label) return;
    setCreating(true);
    try {
      await createCollection(label);
      setNewClassName("");
      toast.success(`Created "${label}"`);
    } catch (err) {
      toast.error(`Could not create class: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteClass(id: string, label: string) {
    if (!window.confirm(`Delete "${label}"? This removes all of its documents and notes.`)) return;
    try {
      await deleteCollection(id);
      if (selectedId === id) setSelectedId(null);
      toast.success(`Deleted "${label}"`);
    } catch (err) {
      toast.error(`Could not delete class: ${(err as Error).message}`);
    }
  }

  async function handleUpload() {
    if (!selectedId) return;
    setPickerNotice(null);
    let paths: string[] | null;
    try {
      paths = await pickUploadFiles();
    } catch (err) {
      setPickerNotice((err as Error).message);
      return;
    }
    if (!paths || paths.length === 0) return;
    try {
      await ingest(selectedId, paths, () => {});
      await refreshDocs(selectedId);
      toast.success(`Ingested ${paths.length} file${paths.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(`Ingest failed: ${(err as Error).message}`);
    }
  }

  async function handleDeleteDoc(docId: string) {
    if (!selectedId) return;
    try {
      await deleteDoc(docId);
      await refreshDocs(selectedId);
      toast.success("Document deleted");
    } catch (err) {
      toast.error(`Could not delete document: ${(err as Error).message}`);
    }
  }

  async function handleSearch() {
    const q = query.trim();
    if (!selectedId) return;
    if (!q) { setResults(null); return; }
    setSearching(true);
    try {
      const hits = await searchMemory(q, 8, 0.3, { collection: selectedId, includeKnowledge: true });
      setResults(hits);
    } catch (err) {
      toast.error(`Search failed: ${(err as Error).message}`);
    } finally {
      setSearching(false);
    }
  }

  async function copyAnchor(anchor: string) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(anchor);
    } catch {
      await navigator.clipboard.writeText(anchor);
    }
    setCopiedAnchor(anchor);
    setTimeout(() => setCopiedAnchor((cur) => (cur === anchor ? null : cur)), 1200);
  }

  return (
    <div className="flex h-full">
      {/* Left: classes */}
      <aside className="w-64 border-r bg-card flex flex-col shrink-0">
        <div className="p-3 border-b">
          <span className="text-xs font-semibold text-foreground">Classes</span>
          <div className="mt-2 flex gap-1.5">
            <Input
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateClass(); }}
              placeholder="New class name…"
              className="h-7 text-xs flex-1"
            />
            <Button
              size="icon"
              className="size-7 shrink-0"
              onClick={() => void handleCreateClass()}
              disabled={creating || !newClassName.trim()}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {collections.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-6 text-center">
              Create your first class to start building a knowledge base.
            </p>
          ) : (
            <div className="p-2 space-y-0.5">
              {collections.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-md text-xs flex items-center gap-2 group transition-colors ${
                    c.id === selectedId
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60 text-foreground/80 hover:text-foreground"
                  }`}
                >
                  <GraduationCap className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate flex-1">{c.label}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {c.docCount} doc{c.docCount === 1 ? "" : "s"}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleDeleteClass(c.id, c.label); }}
                    className="opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0"
                    title="Delete class"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Right: selected class */}
      {!selected ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
          <div className="size-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <GraduationCap className="size-8 text-primary" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Knowledge Hub</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              {collections.length === 0
                ? "Create your first class to start building a knowledge base."
                : "Pick a class on the left to upload notes and search them."}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="border-b px-4 py-3 flex items-center gap-3 shrink-0">
            <h2 className="text-sm font-medium truncate">{selected.label}</h2>
            <span className="text-xs text-muted-foreground">
              {selected.docCount} doc{selected.docCount === 1 ? "" : "s"}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {ingesting && progress && (
                <span className="text-xs text-muted-foreground max-w-[280px] truncate">
                  {progressLabel(progress)}
                </span>
              )}
              <Button size="sm" className="h-7 text-xs gap-1" onClick={() => void handleUpload()} disabled={ingesting}>
                <Upload className="size-3.5" />
                {ingesting ? "Ingesting…" : "Upload"}
              </Button>
            </div>
          </div>

          {pickerNotice && (
            <div className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground shrink-0">
              {pickerNotice}
            </div>
          )}

          {/* Documents */}
          <div className="border-b px-4 py-3 shrink-0 max-h-56 overflow-y-auto">
            <p className="text-[11px] font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Documents</p>
            {docsLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : docs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No documents yet — upload a PDF, markdown, text, or image file.</p>
            ) : (
              <div className="space-y-1">
                {docs.map((d) => (
                  <div
                    key={d.docId}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/40 group text-xs"
                  >
                    <FileText className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1">{d.sourceUri}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}
                    </span>
                    <button
                      onClick={() => void handleDeleteDoc(d.docId)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      title="Delete document"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search */}
          <div className="border-b px-4 py-2 flex gap-2 items-center shrink-0">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
              placeholder={`Search ${selected.label}'s notes… (Enter)`}
              className="text-xs h-7 flex-1 border-0 focus-visible:ring-0 bg-transparent"
            />
            <Button size="sm" className="h-7 text-xs" onClick={() => void handleSearch()} disabled={searching || !query.trim()}>
              {searching ? "Searching…" : "Search"}
            </Button>
          </div>

          {/* Results */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            {results === null ? (
              <p className="text-xs text-muted-foreground text-center py-8">
                Search this class's notes to see cited passages here.
              </p>
            ) : results.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">
                No matching passages in this class's notes.
              </p>
            ) : (
              <div className="space-y-2">
                {results.map((r, i) => {
                  const anchor = citationAnchor(r.entry);
                  return (
                    <div key={r.entry.id ?? i} className="rounded-lg border bg-card px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <button
                          onClick={() => void copyAnchor(anchor)}
                          className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-muted text-foreground/80 hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-1"
                          title="Copy citation"
                        >
                          {copiedAnchor === anchor ? <Check className="size-3" /> : null}
                          {copiedAnchor === anchor ? "Copied" : anchor}
                        </button>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {Math.round(r.score * 100)}% match
                        </span>
                      </div>
                      <p className="text-sm text-foreground leading-snug whitespace-pre-wrap">{r.entry.text}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
