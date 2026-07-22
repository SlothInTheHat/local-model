/**
 * KM4b — interactive visual concept graph.
 *
 * The visual, Obsidian-style companion to KM4a's cited concept LIST
 * (KnowledgeHub.tsx's "Concept Map" → List view): the same `getGraph()` data
 * (KbNode[]/KbEdge[] — src/lib/knowledge/graph.ts), rendered as a node-link
 * diagram instead of a flat list, with click-to-select, drag, and pan/zoom.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────
 * Positions come from a hand-rolled force simulation (src/lib/knowledge/
 * graphLayout.ts — repulsion + spring + centering gravity, pure functions,
 * unit-tested in isolation there). This component's only job on top of that
 * math is to drive a `requestAnimationFrame` loop and STOP it once the
 * layout settles (kinetic energy under a small epsilon) or a hard tick cap
 * is hit — see the `useEffect` below. A perpetual 60fps loop previously
 * caused a real laptop-overheating problem in this app; this component
 * never leaves one running against an idle screen. The simulation only
 * (re)runs when the `nodes`/`edges` props change (a fresh/rebuilt graph),
 * and `cancelAnimationFrame` fires both when the loop stops on its own and
 * on unmount.
 *
 * ─── Interaction ─────────────────────────────────────────────────────────
 *  - Click a node → select it. Its edges + directly-connected neighbors
 *    highlight; everything else dims. A detail panel (right overlay) shows
 *    the concept's relationships (outgoing/incoming, each connected concept
 *    name clickable to re-select it) and its source citations — each
 *    citation is a `[collection/sourceUri location]` anchor (same shape as
 *    KM3/KnowledgeHub.tsx's `citationAnchor`/`chunkRefAnchor`) that expands
 *    inline to the exact cited passage (mirrors ChatMessages.tsx's
 *    `resolveCitationSnippet`, duplicated locally per this codebase's
 *    established small-helper-duplication pattern — see graph.ts's own
 *    isTauri()/invoke() doc comment for the precedent).
 *  - Drag a node to reposition it — only once the layout has settled, so a
 *    drag never fights the simulation for ownership of a node's position
 *    (the documented, simpler fallback from this task's spec); dragging
 *    just writes that one node's position directly, no sim restart needed.
 *  - Wheel to zoom (centered on the pointer), drag empty background to pan
 *    — both implemented as a `transform` on a `<g>` layered on top of the
 *    settled layout's fit-to-bounds `viewBox`, so panning/zooming never
 *    triggers a viewBox recompute (which would otherwise fight the user's
 *    own framing).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { useMemoryStore } from "../store/memory";
import { openSourceFile } from "../lib/openFile";
import type { ChunkRef, KbEdge, KbNode } from "../lib/knowledge/graph";
import {
  ALPHA_DECAY,
  ALPHA_MIN,
  computeViewBox,
  DEFAULT_SIM_PARAMS,
  seedPositions,
  stepSimulation,
  viewBoxToString,
  type PositionMap,
  type SimEdge,
  type ViewBox,
} from "../lib/knowledge/graphLayout";

/** Kinetic-energy threshold under which the layout counts as settled — see
 *  graphLayout.ts's module doc comment ("Why an alpha cooling schedule") for
 *  why alpha decay (not just this epsilon) is what actually guarantees the
 *  loop gets here instead of idling in a low-amplitude limit cycle. */
const SETTLE_ENERGY_EPSILON = 0.05;
/** Absolute hard stop regardless of energy — the actual load-bearing
 *  guarantee against the RAF loop ever running forever. Empirically, even a
 *  300-node/1200-edge graph (this app's documented upper bound) settles by
 *  tick ~260, well under this cap — see this work's report for measured
 *  tick counts across graph sizes. */
const MAX_SIM_TICKS = 300;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
/** Padding (simulation-space units) around the settled layout's bounding
 *  box when computing the fit-to-bounds viewBox. */
const VIEWBOX_PADDING = 60;

/** Same anchor shape as KnowledgeHub.tsx's chunkRefAnchor/citationAnchor and
 *  citationsRehype.ts's `[collection/sourceUri location]` token — duplicated
 *  locally rather than importing a sibling component's private helper. */
function chunkRefAnchor(ref: ChunkRef, collectionId: string): string {
  const parts = [collectionId, ref.sourceUri].filter(Boolean).join("/");
  return `[${[parts, ref.location].filter(Boolean).join(" ")}]`;
}

/** Mirrors ChatMessages.tsx's resolveCitationSnippet (not exported there):
 *  resolve a KM4a ChunkRef to the exact word-for-word passage it cites by
 *  matching the hydrated memory store's "knowledge" rows for this
 *  collection/sourceUri, allowing a citation's location to be a PREFIX of a
 *  chunk's stored location (a cited passage can span two adjacent chunks
 *  split at ingestion time). Hydrates the store first if needed. */
async function resolveChunkSnippet(
  collectionId: string,
  ref: ChunkRef,
): Promise<{ text: string; sourcePath?: string }> {
  const store = useMemoryStore.getState();
  if (!store.hydrated) await store.loadFromDb();
  const entries = useMemoryStore.getState().entries;
  const matches = entries.filter(
    (e) =>
      e.source === "knowledge" &&
      e.collection === collectionId &&
      e.sourceUri === ref.sourceUri &&
      (e.location === ref.location || (ref.location !== "" && !!e.location?.startsWith(ref.location))),
  );
  matches.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  if (matches.length === 0) {
    return { text: "(Couldn't find this passage — the document may have been deleted or re-ingested.)" };
  }
  return {
    text: matches.slice(0, 2).map((m) => m.text).join("\n\n"),
    sourcePath: matches[0].sourcePath,
  };
}

interface DragState {
  nodeId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

interface PanState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startTx: number;
  startTy: number;
}

export interface ConceptGraphProps {
  collectionId: string;
  nodes: KbNode[];
  edges: KbEdge[];
}

export function ConceptGraph({ collectionId, nodes, edges }: ConceptGraphProps) {
  const [positions, setPositions] = useState<PositionMap>({});
  const [settled, setSettled] = useState(false);
  const [fitViewBox, setFitViewBox] = useState<ViewBox>(() => computeViewBox({}, []));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
  const [citeOpenKey, setCiteOpenKey] = useState<string | null>(null);
  const [citeSnippets, setCiteSnippets] = useState<Record<string, { text: string; sourcePath?: string }>>({});

  const rafRef = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);

  // ─── Force simulation — settles then STOPS (see module doc comment) ─────
  useEffect(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setSelectedId(null);
    setTransform({ scale: 1, tx: 0, ty: 0 });
    setSettled(false);
    setCiteOpenKey(null);
    setCiteSnippets({});

    if (nodes.length === 0) {
      setPositions({});
      setFitViewBox(computeViewBox({}, []));
      return;
    }

    const nodeIds = nodes.map((n) => n.id);
    const nodeIdSet = new Set(nodeIds);
    // Guard against dangling endpoints defensively — aggregateGraph in
    // graph.ts already drops these, but a stale/partial fetch shouldn't be
    // able to crash layout math over an edge whose node isn't in `nodes`.
    const simEdges: SimEdge[] = edges
      .filter((e) => nodeIdSet.has(e.sourceId) && nodeIdSet.has(e.targetId))
      .map((e) => ({ sourceId: e.sourceId, targetId: e.targetId }));

    let pos = seedPositions(nodeIds, DEFAULT_SIM_PARAMS.width, DEFAULT_SIM_PARAMS.height);
    let alpha = 1;
    let tick = 0;
    setPositions(pos);

    function step() {
      const result = stepSimulation(pos, nodeIds, simEdges, DEFAULT_SIM_PARAMS, alpha);
      pos = result.positions;
      alpha = Math.max(ALPHA_MIN, alpha * ALPHA_DECAY);
      tick += 1;
      setPositions(pos);

      if (result.energy < SETTLE_ENERGY_EPSILON || tick >= MAX_SIM_TICKS) {
        // STOP: settle condition met (or hard cap hit) — no further RAF is
        // scheduled, and the final layout is fit-to-bounds exactly once.
        setFitViewBox(computeViewBox(pos, nodeIds, VIEWBOX_PADDING));
        setSettled(true);
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // Re-run only when the graph itself changes (new/rebuilt) — kbNodes/
    // kbEdges in KnowledgeHub.tsx only get a new array reference from an
    // explicit refreshGraph() call, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const n of nodes) d.set(n.id, 0);
    for (const e of edges) {
      d.set(e.sourceId, (d.get(e.sourceId) ?? 0) + 1);
      d.set(e.targetId, (d.get(e.targetId) ?? 0) + 1);
    }
    return d;
  }, [nodes, edges]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  if (nodes.length === 0) return null;

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;
  const outgoing = selectedId ? edges.filter((e) => e.sourceId === selectedId) : [];
  const incoming = selectedId ? edges.filter((e) => e.targetId === selectedId) : [];
  const connectedIds = new Set<string>();
  if (selectedId) {
    connectedIds.add(selectedId);
    for (const e of outgoing) connectedIds.add(e.targetId);
    for (const e of incoming) connectedIds.add(e.sourceId);
  }

  function nodeRadius(id: string): number {
    const deg = degree.get(id) ?? 0;
    return Math.min(20, 6 + Math.sqrt(deg) * 3.2);
  }

  // ─── Drag a node ─────────────────────────────────────────────────────────
  function handleNodePointerDown(e: ReactPointerEvent<SVGCircleElement>, nodeId: string) {
    e.stopPropagation(); // don't also start a background pan
    setSelectedId(nodeId);
    if (!settled) return; // sim still owns positions — let it keep animating
    const p = positions[nodeId];
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      nodeId,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: p.x,
      startY: p.y,
    };
  }

  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      const dxScreen = e.clientX - drag.startClientX;
      const dyScreen = e.clientY - drag.startClientY;
      // Screen-px delta → simulation-space delta, compensating for both the
      // viewBox↔pixel ratio and the current zoom level.
      const dxLocal = (dxScreen * fitViewBox.width) / rect.width / transform.scale;
      const dyLocal = (dyScreen * fitViewBox.height) / rect.height / transform.scale;
      setPositions((prev) => ({
        ...prev,
        [drag.nodeId]: { x: drag.startX + dxLocal, y: drag.startY + dyLocal, vx: 0, vy: 0 },
      }));
      return;
    }

    const pan = panRef.current;
    if (pan && pan.pointerId === e.pointerId) {
      const dxScreen = e.clientX - pan.startClientX;
      const dyScreen = e.clientY - pan.startClientY;
      const dxLocal = (dxScreen * fitViewBox.width) / rect.width;
      const dyLocal = (dyScreen * fitViewBox.height) / rect.height;
      setTransform((prev) => ({ ...prev, tx: pan.startTx + dxLocal, ty: pan.startTy + dyLocal }));
    }
  }

  function handlePointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null;
  }

  // ─── Pan (drag empty background) ─────────────────────────────────────────
  function handleBackgroundPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (dragRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTx: transform.tx,
      startTy: transform.ty,
    };
  }

  // ─── Zoom (wheel, centered on the pointer) ──────────────────────────────
  function handleWheel(e: ReactWheelEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    e.preventDefault();
    // Pointer position in viewBox (pre-transform) space...
    const svgX = fitViewBox.minX + ((e.clientX - rect.left) / rect.width) * fitViewBox.width;
    const svgY = fitViewBox.minY + ((e.clientY - rect.top) / rect.height) * fitViewBox.height;
    // ...and the content-local point that currently renders there, so we can
    // solve for a new tx/ty that keeps THAT point under the cursor at the
    // new scale (standard zoom-at-point math).
    const localX = (svgX - transform.tx) / transform.scale;
    const localY = (svgY - transform.ty) / transform.scale;
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, transform.scale * zoomFactor));
    setTransform({
      scale: newScale,
      tx: svgX - newScale * localX,
      ty: svgY - newScale * localY,
    });
  }

  function toggleCitation(key: string, ref: ChunkRef) {
    setCiteOpenKey((cur) => {
      const next = cur === key ? null : key;
      if (next && !citeSnippets[key]) {
        setCiteSnippets((prev) => ({ ...prev, [key]: { text: "Loading…" } }));
        resolveChunkSnippet(collectionId, ref).then((res) => {
          setCiteSnippets((prev) => ({ ...prev, [key]: res }));
        });
      }
      return next;
    });
  }

  async function handleOpenSourceFile(sourcePath: string) {
    try {
      await openSourceFile(sourcePath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open file");
    }
  }

  return (
    <div className="relative h-full w-full min-h-0 rounded-lg border border-border bg-card overflow-hidden">
      <svg
        ref={svgRef}
        viewBox={viewBoxToString(fitViewBox)}
        className="h-full w-full touch-none cursor-grab active:cursor-grabbing"
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
      >
        <g transform={`translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`}>
          {edges.map((e) => {
            const a = positions[e.sourceId];
            const b = positions[e.targetId];
            if (!a || !b) return null;
            const highlighted = selectedId != null && (e.sourceId === selectedId || e.targetId === selectedId);
            const dim = selectedId != null && !highlighted;
            return (
              <g key={e.id}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="var(--border)"
                  strokeWidth={highlighted ? 1.5 : 1}
                  opacity={dim ? 0.15 : 0.6}
                >
                  <title>{e.label}</title>
                </line>
                {highlighted && (
                  <text
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2}
                    fontSize={10}
                    fill="var(--muted-foreground)"
                    textAnchor="middle"
                    className="select-none"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {nodes.map((n) => {
            const p = positions[n.id];
            if (!p) return null;
            const isSelected = selectedId === n.id;
            const dim = selectedId != null && !connectedIds.has(n.id);
            const r = nodeRadius(n.id) * (isSelected ? 1.35 : 1);
            return (
              <g key={n.id} opacity={dim ? 0.3 : 1}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill="var(--primary)"
                  stroke={isSelected ? "var(--foreground)" : "var(--border)"}
                  strokeWidth={isSelected ? 2 : 1}
                  className={cn(settled ? "cursor-pointer" : "cursor-default")}
                  onPointerDown={(e) => handleNodePointerDown(e, n.id)}
                />
                <text
                  x={p.x + r + 4}
                  y={p.y + 4}
                  fontSize={11}
                  fill="var(--foreground)"
                  className="select-none pointer-events-none"
                >
                  {n.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {selectedNode && (
        <div className="absolute top-2 right-2 bottom-2 w-64 max-w-[45%] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
            <span className="text-sm font-medium truncate flex-1">{selectedNode.name}</span>
            <button
              onClick={() => setSelectedId(null)}
              className="text-muted-foreground hover:text-foreground shrink-0"
              title="Close"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Relationships
              </p>
              {outgoing.length === 0 && incoming.length === 0 ? (
                <p className="text-xs text-muted-foreground">No relations found for this concept.</p>
              ) : (
                <div className="space-y-1">
                  {outgoing.map((e) => (
                    <p key={e.id} className="text-xs text-foreground/80">
                      {selectedNode.name} — {e.label} →{" "}
                      <button className="underline hover:text-foreground" onClick={() => setSelectedId(e.targetId)}>
                        {nodeById.get(e.targetId)?.name ?? e.targetId}
                      </button>
                    </p>
                  ))}
                  {incoming.map((e) => (
                    <p key={e.id} className="text-xs text-foreground/80">
                      <button className="underline hover:text-foreground" onClick={() => setSelectedId(e.sourceId)}>
                        {nodeById.get(e.sourceId)?.name ?? e.sourceId}
                      </button>{" "}
                      — {e.label} → {selectedNode.name}
                    </p>
                  ))}
                </div>
              )}
            </div>

            {selectedNode.chunkRefs.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                  Sources
                </p>
                <div className="space-y-1.5">
                  {selectedNode.chunkRefs.map((ref, i) => {
                    const key = `${selectedNode.id}::${i}`;
                    const anchor = chunkRefAnchor(ref, collectionId);
                    const open = citeOpenKey === key;
                    const snippet = citeSnippets[key];
                    return (
                      <div key={key}>
                        <button
                          onClick={() => toggleCitation(key, ref)}
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-foreground/70 hover:bg-accent hover:text-accent-foreground transition-colors"
                        >
                          {anchor}
                        </button>
                        {open && snippet && (
                          <div className="mt-1 rounded-md border border-border bg-muted/40 px-2 py-1.5">
                            <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-snug">
                              {snippet.text}
                            </p>
                            {snippet.sourcePath && (
                              <button
                                onClick={() => void handleOpenSourceFile(snippet.sourcePath!)}
                                className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                              >
                                <ExternalLink className="size-3" /> Open file
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
