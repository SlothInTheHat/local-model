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
import { useEffect, useRef, useState } from "react";
import {
  Plus, Trash2, Upload, Search, FileText, Check, GraduationCap, ExternalLink,
  Network, ChevronDown, ChevronRight, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useKnowledgeStore, type DocRow } from "../store/knowledge";
import { pickUploadFiles } from "../lib/knowledge/ingest";
import { searchMemory } from "../lib/vectorMemory";
import { openSourceFile } from "../lib/openFile";
import type { MemoryEntry } from "../store/memory";
import type { IngestProgress } from "../lib/knowledge/types";
import type { ChunkRef, GraphProgress, KbEdge, KbNode } from "../lib/knowledge/graph";

type SearchResult = { entry: MemoryEntry; score: number; rawScore: number };

/** Matches KM3's tool-facing anchor format exactly — see vectorMemory.ts's
 *  formatMemoriesForContext for the sibling implementation used in chat context. */
function citationAnchor(entry: MemoryEntry): string {
  const parts = [entry.collection, entry.sourceUri].filter(Boolean).join("/");
  return `[${[parts, entry.location].filter(Boolean).join(" ")}]`;
}

/** Same anchor shape as citationAnchor above, for a KM4a ChunkRef (which
 *  doesn't carry its own `collection` field — every ChunkRef in a class's
 *  concept graph belongs to that class by construction, so the collection id
 *  is threaded in by the caller instead). */
function chunkRefAnchor(ref: ChunkRef, collectionId: string): string {
  const parts = [collectionId, ref.sourceUri].filter(Boolean).join("/");
  return `[${[parts, ref.location].filter(Boolean).join(" ")}]`;
}

/** Human label for the live buildGraph() progress line (KM4a). */
function graphProgressLabel(p: GraphProgress): string {
  switch (p.phase) {
    case "reading":
      return "Reading chunks…";
    case "extracting":
      return `Extracting concepts — ${p.done}/${p.total}`;
    case "saving":
      return "Saving concept map…";
    case "done":
      return "Concept map ready";
    case "error":
      return p.error ?? "Failed";
  }
}

function progressLabel(p: IngestProgress): string {
  if (p.phase === "error") return `${p.file} — ${p.error ?? "failed"}`;
  if (p.phase === "embedding") return `Embedding ${p.file} — ${p.done}/${p.total}`;
  if (p.phase === "extracting") return `Extracting ${p.file}…`;
  if (p.phase === "reading") return `Reading ${p.file}…`;
  return `${p.file} done`;
}

export function KnowledgeHub() {
  const {
    collections, ingesting, progress, buildingGraph, graphProgress,
    loadCollections, createCollection, deleteCollection, listDocs, deleteDoc, ingest,
    buildGraph, getGraph,
  } = useKnowledgeStore();

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

  // ─── KM4a: concept map (right-pane "Concept Map" tab) ───────────────────
  const [rightView, setRightView] = useState<"search" | "concepts">("search");
  const [kbNodes, setKbNodes] = useState<KbNode[]>([]);
  const [kbEdges, setKbEdges] = useState<KbEdge[]>([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  // Tracks the in-flight buildGraph() call's AbortController so the Cancel
  // button has something to abort — see graph.ts's module doc comment for
  // what "cancel" actually does (stops future batches, still saves partial work).
  const buildAbortRef = useRef<AbortController | null>(null);

  const selected = collections.find((c) => c.id === selectedId) ?? null;

  async function refreshGraph(id: string) {
    setKbLoading(true);
    try {
      const { nodes, edges } = await getGraph(id);
      setKbNodes(nodes);
      setKbEdges(edges);
    } catch (err) {
      toast.error(`Failed to load concept map: ${(err as Error).message}`);
    } finally {
      setKbLoading(false);
    }
  }

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
    // Switching classes mid-build would otherwise keep extracting into the
    // previously-selected class's graph — abort any in-flight build first.
    buildAbortRef.current?.abort();
    buildAbortRef.current = null;
    if (selectedId) {
      void refreshDocs(selectedId);
      void refreshGraph(selectedId);
      setResults(null);
      setQuery("");
    } else {
      setDocs([]);
      setKbNodes([]);
      setKbEdges([]);
    }
    setRightView("search");
    setExpandedNodeId(null);
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

  // "Open source file" (KM4): shared by the document list's "Open" button and
  // the search result cards' "Open file" affordance. Not available for
  // documents ingested before source_path was captured — callers only render
  // the button when a sourcePath is present.
  async function handleOpenSourceFile(sourcePath: string) {
    try {
      await openSourceFile(sourcePath);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleBuildGraph() {
    if (!selectedId) return;
    const controller = new AbortController();
    buildAbortRef.current = controller;
    try {
      const result = await buildGraph(selectedId, () => {}, controller.signal);
      await refreshGraph(selectedId);
      if (controller.signal.aborted) {
        toast(`Build cancelled — kept ${result.nodes} concepts, ${result.edges} relations extracted so far`);
      } else {
        toast.success(`Concept map built — ${result.nodes} concepts, ${result.edges} relations`);
      }
    } catch (err) {
      toast.error(`Could not build concept map: ${(err as Error).message}`);
    } finally {
      buildAbortRef.current = null;
    }
  }

  function handleCancelBuild() {
    buildAbortRef.current?.abort();
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
                    {d.sourcePath && (
                      <button
                        onClick={() => void handleOpenSourceFile(d.sourcePath!)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                        title="Open file"
                      >
                        <ExternalLink className="size-3" />
                      </button>
                    )}
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

          {/* Passages / Concept Map tabs (KM4a) */}
          <div className="border-b px-4 pt-2 flex items-center gap-1 shrink-0">
            <button
              onClick={() => setRightView("search")}
              className={`px-2.5 py-1.5 rounded-t-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
                rightView === "search"
                  ? "bg-card text-foreground border border-b-card"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Search className="size-3.5" /> Passages
            </button>
            <button
              onClick={() => setRightView("concepts")}
              className={`px-2.5 py-1.5 rounded-t-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
                rightView === "concepts"
                  ? "bg-card text-foreground border border-b-card"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Network className="size-3.5" /> Concept Map
              {kbNodes.length > 0 && (
                <span className="text-[10px] text-muted-foreground">({kbNodes.length})</span>
              )}
            </button>
          </div>

          {rightView === "search" ? (
            <>
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
                            <div className="flex items-center gap-1.5 min-w-0">
                              <button
                                onClick={() => void copyAnchor(anchor)}
                                className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-muted text-foreground/80 hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-1"
                                title="Copy citation"
                              >
                                {copiedAnchor === anchor ? <Check className="size-3" /> : null}
                                {copiedAnchor === anchor ? "Copied" : anchor}
                              </button>
                              {r.entry.sourcePath && (
                                <button
                                  onClick={() => void handleOpenSourceFile(r.entry.sourcePath!)}
                                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                                  title="Open file"
                                >
                                  <ExternalLink className="size-3" />
                                </button>
                              )}
                            </div>
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
            </>
          ) : (
            <ConceptMapPanel
              collectionId={selected.id}
              nodes={kbNodes}
              edges={kbEdges}
              loading={kbLoading}
              building={buildingGraph}
              progress={graphProgress}
              expandedNodeId={expandedNodeId}
              onToggleExpand={(id) => setExpandedNodeId((cur) => (cur === id ? null : id))}
              onBuild={() => void handleBuildGraph()}
              onCancel={handleCancelBuild}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── KM4a: Concept Map panel ─────────────────────────────────────────────────
//
// A cited concept LIST, not a visual graph — the interactive node/edge
// visualization is a separate later task (KM4b). This proves extraction
// works end-to-end and is citeable: each concept shows how many relations it
// has and a few of its source citations, and expanding it shows its full
// relation list plus every source chunk it was extracted from.

interface ConceptMapPanelProps {
  collectionId: string;
  nodes: KbNode[];
  edges: KbEdge[];
  loading: boolean;
  building: boolean;
  progress: GraphProgress | null;
  expandedNodeId: string | null;
  onToggleExpand: (nodeId: string) => void;
  onBuild: () => void;
  onCancel: () => void;
}

/** Max source citation badges shown on a collapsed node row before "+N more". */
const COLLAPSED_CITATION_LIMIT = 3;

function ConceptMapPanel({
  collectionId, nodes, edges, loading, building, progress,
  expandedNodeId, onToggleExpand, onBuild, onCancel,
}: ConceptMapPanelProps) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        <Button size="sm" className="h-7 text-xs gap-1" onClick={onBuild} disabled={building}>
          <Network className="size-3.5" />
          {building ? "Building…" : nodes.length > 0 ? "Rebuild concept map" : "Build concept map"}
        </Button>
        {building && (
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onCancel}>
            <X className="size-3.5" /> Cancel
          </Button>
        )}
        {building && progress && (
          <span className="text-xs text-muted-foreground truncate">{graphProgressLabel(progress)}</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">
        Reads every document in this class with the digest model to find concepts and the relationships between
        them — can take a while for large classes.
      </p>

      {loading ? (
        <p className="text-xs text-muted-foreground text-center py-8">Loading concept map…</p>
      ) : nodes.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8">
          No concept map yet — build one to see cited concepts across this class's notes.
        </p>
      ) : (
        <div className="space-y-1.5">
          {nodes.map((node) => {
            const outgoing = edges.filter((e) => e.sourceId === node.id);
            const incoming = edges.filter((e) => e.targetId === node.id);
            const connectionCount = outgoing.length + incoming.length;
            const expanded = expandedNodeId === node.id;

            return (
              <div key={node.id} className="rounded-lg border bg-card">
                <button
                  onClick={() => onToggleExpand(node.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left"
                >
                  {expanded ? (
                    <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-sm font-medium flex-1 truncate">{node.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {connectionCount} connection{connectionCount === 1 ? "" : "s"}
                  </span>
                </button>

                {!expanded && node.chunkRefs.length > 0 && (
                  <div className="px-3 pb-2 flex flex-wrap gap-1">
                    {node.chunkRefs.slice(0, COLLAPSED_CITATION_LIMIT).map((ref, i) => (
                      <span key={i} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-foreground/70">
                        {chunkRefAnchor(ref, collectionId)}
                      </span>
                    ))}
                    {node.chunkRefs.length > COLLAPSED_CITATION_LIMIT && (
                      <span className="text-[10px] text-muted-foreground">
                        +{node.chunkRefs.length - COLLAPSED_CITATION_LIMIT} more
                      </span>
                    )}
                  </div>
                )}

                {expanded && (
                  <div className="px-3 pb-2.5 space-y-2 border-t pt-2">
                    {connectionCount === 0 ? (
                      <p className="text-xs text-muted-foreground">No relations found for this concept.</p>
                    ) : (
                      <div className="space-y-1">
                        {outgoing.map((e) => (
                          <p key={e.id} className="text-xs text-foreground/80">
                            — {e.label} → {nodeById.get(e.targetId)?.name ?? e.targetId}
                          </p>
                        ))}
                        {incoming.map((e) => (
                          <p key={e.id} className="text-xs text-foreground/80">
                            ← {e.label} — {nodeById.get(e.sourceId)?.name ?? e.sourceId}
                          </p>
                        ))}
                      </div>
                    )}
                    {node.chunkRefs.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                          Sources
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {node.chunkRefs.map((ref, i) => (
                            <span
                              key={i}
                              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-foreground/70"
                            >
                              {chunkRefAnchor(ref, collectionId)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
