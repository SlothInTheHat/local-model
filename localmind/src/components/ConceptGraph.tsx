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
 *    — both implemented as a `transform` on a `<g>` layered on top of a
 *    fit-to-bounds `viewBox`, so panning/zooming never triggers a viewBox
 *    recompute (which would otherwise fight the user's own framing). That
 *    `viewBox` is fit TWICE per graph, never on every pan/zoom: once
 *    immediately from the SEEDED positions (so the very first frame already
 *    frames the whole graph — see the `useEffect` below), and once more when
 *    the layout settles (tightening the frame to the final positions). Pan/
 *    zoom transform is reset to identity whenever the graph itself changes,
 *    so a leftover zoom from a previous graph can never mis-frame a new one.
 *
 * ─── Cluster coloring (related concepts share a color) ───────────────────
 * `detectCommunities` (graphLayout.ts) groups nodes into structural clusters
 * via label propagation, purely from graph topology (no positions involved,
 * so this is `useMemo`'d on `nodes`/`edges` only, independent of the RAF
 * settle loop). `communityColorMap` below ranks those communities by size
 * and assigns the biggest 8 a fixed palette slot (`--kb-cat-1`..`--kb-cat-8`
 * in src/index.css) in size order — everything past the 8th, and every
 * trivial size-1 singleton, falls back to the app's muted-ink token
 * ("Other"). Same-community nodes already tend to sit near each other from
 * the force layout (shared edges pull them together), so color and position
 * reinforce the same grouping — this spatial secondary encoding is exactly
 * why using more than the usual ~3 "safe" categorical hues reads fine here.
 * Only a node's CIRCLE fill is ever colored this way; label text stays
 * `var(--foreground)` (ink) like every other label in the app, and edges
 * stay `var(--border)` — color marks concepts, not relationships or text.
 *
 * ─── Progressive labels (only big nodes labeled until you zoom in) ───────
 * A real ~300-node graph with every node always labeled renders as
 * illegible text soup — labels overlap each other just as badly as
 * unresolved node circles did (see graphLayout.ts's collision pass for that
 * half of the fix). Labels here are chosen by a greedy, SCREEN-space
 * placement (`computeVisibleLabels` below): sort nodes by degree
 * (descending — the "big"/important nodes win first pick), walk that order
 * projecting each node's center through the CURRENT pan/zoom transform, and
 * keep a label only if its estimated bounding box doesn't overlap a label
 * already placed. On top of that greedy overlap test, an explicit zoom-
 * dependent degree-rank CAP (`labelRankCapForScale`) limits how many nodes
 * are even eligible to enter that pass in the first place — at the default
 * zoomed-out view only the top ~10 highest-degree nodes are eligible at all,
 * growing as the user zooms in — because the overlap test alone still let
 * too many technically-non-overlapping labels through on a dense graph (see
 * that function's own doc comment). Zoom in and nodes also spread further
 * apart on screen (while label text itself stays a CONSTANT on-screen size —
 * see the per-label `scale(1 / transform.scale)` counter-transform below,
 * without which zooming would grow both label text AND node spacing together
 * and never declutter anything), so progressively more labels fit without
 * colliding, on top of progressively more being rank-cap-eligible.
 * This is intentionally NOT recomputed every animation frame — it's driven
 * by user interaction (pan/zoom/select/hover), not the settle loop, so it's
 * a `useMemo` keyed on those inputs, gated to skip entirely while the sim is
 * still moving nodes every tick (see its own comment below).
 * Selected/hovered nodes and the selected node's direct neighbors always
 * get a label regardless of this culling, so a user can always identify a
 * specific concept by clicking or hovering it even when its label would
 * otherwise be culled at the current zoom level.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { ExternalLink, X, RotateCw, Send } from "lucide-react";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { useMemoryStore } from "../store/memory";
import { openSourceFile } from "../lib/openFile";
import { Markdown } from "./Markdown";
import { useChatSeedStore } from "../store/chatSeed";
import type { ChunkRef, KbEdge, KbNode } from "../lib/knowledge/graph";
import { generateNodeSummary, getNodeSummaries } from "../lib/knowledge/graph";
import {
  ALPHA_DECAY,
  ALPHA_MIN,
  computeDegree,
  computeSimParams,
  computeViewBox,
  detectCommunities,
  nodeRadiusForDegree,
  seedPositions,
  stepSimulation,
  viewBoxToString,
  type PositionMap,
  type SimEdge,
  type SimPosition,
  type ViewBox,
} from "../lib/knowledge/graphLayout";

/** Kinetic-energy threshold under which the layout counts as settled — see
 *  graphLayout.ts's module doc comment ("Why an alpha cooling schedule") for
 *  why alpha decay (not just this epsilon) is what actually guarantees the
 *  loop gets here instead of idling in a low-amplitude limit cycle. */
const SETTLE_ENERGY_EPSILON = 0.05;
/** Absolute hard stop regardless of energy — the actual load-bearing
 *  guarantee against the RAF loop ever running forever. Raised from 300 to
 *  400 alongside adding the collision-resolution pass (graphLayout.ts) —
 *  spreading + de-overlapping a dense 300-node graph takes a bit longer to
 *  settle than the old (denser/more-overlapped, only apparently faster to
 *  settle) layout did. Empirically, a 300-node/1200-edge graph still settles
 *  well under this cap — see this work's report for measured tick counts
 *  across graph sizes. The cap itself remains hard: whatever happens, the
 *  RAF loop stops here. */
const MAX_SIM_TICKS = 400;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
/** Padding (simulation-space units) around the settled layout's bounding
 *  box when computing the fit-to-bounds viewBox. */
const VIEWBOX_PADDING = 60;

/** A label's base height as a FRACTION of the current fit-viewBox width —
 *  NOT a fixed SVG-unit size. This is the fix for "labels are illegibly tiny
 *  until I zoom way in": a fixed font size in viewBox units renders at
 *  `fontUnits * (svgPixelWidth / viewBox.width)` screen pixels, and a real
 *  ~300-node graph's fit viewBox is thousands of units wide — so a fixed 14–18
 *  unit font came out to a handful of screen pixels at the default (fit) zoom
 *  and only looked readable once the user had zoomed most of the way in. Sizing
 *  the font as a fraction of the viewBox width instead makes a label a CONSTANT
 *  fraction of the visible frame (≈ this value × the SVG's pixel width on
 *  screen) regardless of how big the graph is or how far it's zoomed — because
 *  the per-label `scale(1/transform.scale)` counter-transform in the JSX
 *  already holds the net label scale at 1 in viewBox units, so only this
 *  viewBox-relative base drives the on-screen size. 0.016 ≈ a ~14px label on a
 *  ~900px-wide panel. */
const LABEL_VIEW_WIDTH_FRACTION = 0.016;
/** How many of the highest-degree ("hub") concepts always keep a visible
 *  label — at every zoom level and even while the layout is still settling.
 *  Small enough that a fit-zoom view reads as "the graph's main topics", not a
 *  wall of text; everything past this is subject to the zoom-dependent greedy
 *  declutter pass (computeVisibleLabels). */
const IMPORTANT_LABEL_COUNT = 10;
/** Rough average glyph width, as a fraction of font size, used to estimate
 *  a label's on-screen bounding box for the greedy overlap-avoidance pass
 *  (computeVisibleLabels) — not exact per-character metrics (no canvas
 *  measureText available outside a DOM effect), just "good enough to decide
 *  whether two labels are fighting for the same screen space", per this
 *  work's spec. */
const LABEL_CHAR_WIDTH_FACTOR = 0.58;
/** Extra breathing room (screen/SVG-user units) required between two
 *  candidate labels' estimated bounding boxes for both to be considered
 *  non-overlapping. */
const LABEL_GAP = 3;

/** Label font size (in viewBox units) for a node of the given degree, given
 *  the viewBox-relative base `unit` (= fitViewBox.width × LABEL_VIEW_WIDTH_
 *  FRACTION — see that constant). Grows modestly (capped at +45%) with degree
 *  so the most-connected concepts read as slightly more prominent, mirroring
 *  nodeRadiusForDegree's own degree-scaling. */
function labelFontSize(degree: number, unit: number): number {
  return unit * (1 + Math.min(0.45, Math.sqrt(degree) * 0.06));
}

/** Fix 3 — "still too many labels when zoomed out": the greedy screen-space
 *  overlap test above (computeVisibleLabels) alone isn't a strong enough
 *  declutter rule on its own — at low zoom, a real ~300-node graph still has
 *  enough screen-space room between SOME pairs of close-degree nodes that
 *  dozens of labels squeeze in without technically overlapping, reading as a
 *  wall of text rather than "just the big hubs". This adds an explicit,
 *  zoom-dependent cap: at a given `transform.scale`, only the top-K
 *  highest-degree nodes are even ELIGIBLE to be considered for a label at
 *  all (before the overlap test ever runs on them) — everyone past the top-K
 *  is skipped outright, regardless of how much free space is around them.
 *  K starts small (~10) at the default zoomed-out view (scale 1) and grows
 *  as the user zooms in, so progressively more concepts become eligible
 *  (and then still have to win the overlap test to actually get a label).
 *  This is on top of, not instead of, the bigger base font size (Fix 2) —
 *  bigger label boxes independently mean fewer of the K-eligible candidates
 *  fit anyway. */
const LABEL_RANK_CAP_AT_SCALE_1 = 10;
/** Extra eligible-for-labeling nodes unlocked per unit of zoom beyond 1x —
 *  tuned so zooming in a couple steps meaningfully opens up more labels
 *  without needing to zoom all the way to MAX_ZOOM to see anything past the
 *  handful of biggest hubs. */
const LABEL_RANK_CAP_GROWTH_PER_SCALE = 14;

function labelRankCapForScale(scale: number): number {
  return Math.round(LABEL_RANK_CAP_AT_SCALE_1 + Math.max(0, scale - 1) * LABEL_RANK_CAP_GROWTH_PER_SCALE);
}

/** Fix 4 — cluster coloring. Number of fixed categorical palette slots
 *  (`--kb-cat-1`..`--kb-cat-8` in src/index.css) — the standard "top-N
 *  categories get real colors, the rest fold to a neutral bucket" rule, so a
 *  300-node graph with dozens of tiny communities doesn't run out of
 *  distinguishable hues (and so the same 8 colors are reused consistently
 *  across different graphs instead of a palette that grows with community
 *  count). */
const MAX_COLORED_COMMUNITIES = 8;
/** Communities at/under this member count never get a real palette color
 *  even if they'd otherwise rank in the top MAX_COLORED_COMMUNITIES — a
 *  size-1 "community" is just an otherwise-unconnected node that happened to
 *  get its own label from detectCommunities, not a meaningful cluster worth
 *  a dedicated color. */
const MIN_COMMUNITY_SIZE_FOR_COLOR = 2;
/** Fallback color for every community that isn't one of the top 8 (or is a
 *  trivial singleton) — the app's existing muted-ink token, so "Other" reads
 *  as deliberately neutral rather than like a 9th miscolored category. */
const OTHER_COMMUNITY_COLOR = "var(--muted-foreground)";

/**
 * Rank `communities` (nodeId -> community index, from detectCommunities) by
 * SIZE descending, and assign the largest `MAX_COLORED_COMMUNITIES` a fixed
 * palette slot in that rank order (`--kb-cat-1` = biggest community, `--kb
 * -cat-2` = second-biggest, ...) — never cycled, so a graph with more than 8
 * real clusters doesn't repeat a color onto two unrelated communities. Every
 * other community (rank > 8, or a size-1 singleton regardless of rank) maps
 * to `OTHER_COMMUNITY_COLOR`. Ties in size are broken by the community
 * index itself (ascending) — arbitrary but deterministic, matching
 * detectCommunities' own "same input, same output" guarantee, so the same
 * graph always colors the same way across renders.
 */
function communityColorMap(communities: Map<string, number>): Map<number, string> {
  const sizes = new Map<number, number>();
  for (const c of communities.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);

  const ranked = [...sizes.entries()]
    .filter(([, size]) => size >= MIN_COMMUNITY_SIZE_FOR_COLOR)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_COLORED_COMMUNITIES);

  const colorByCommunity = new Map<number, string>();
  ranked.forEach(([communityId], rank) => {
    colorByCommunity.set(communityId, `var(--kb-cat-${rank + 1})`);
  });
  return colorByCommunity;
}

/** Node circle fill for the given community id — a real palette color for
 *  the top 8 (by size), OTHER_COMMUNITY_COLOR for everyone else. Labels
 *  never use this — see the JSX's node `<text>`, always var(--foreground). */
function nodeFillForCommunity(colorByCommunity: Map<number, string>, communityId: number | undefined): string {
  if (communityId == null) return OTHER_COMMUNITY_COLOR;
  return colorByCommunity.get(communityId) ?? OTHER_COMMUNITY_COLOR;
}

interface LabelBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/**
 * Greedy, screen-space label placement — the core of the "only big nodes
 * labeled until you zoom in" behavior (see module doc comment).
 *
 * Projects each node's center through the CURRENT pan/zoom `transform`
 * (`transform.tx + p.x * transform.scale`, matching exactly how each
 * label's on-screen position works out once rendered — see the per-label
 * `scale(1 / transform.scale)` counter-transform in the JSX, which is what
 * makes a label's own SIZE stay constant in real screen pixels while node
 * SPACING still grows with zoom; without that counter-scale, labels and
 * spacing would grow together and zooming would never declutter anything).
 * Estimates each label's bounding box from its name length and degree-scaled
 * font size (no DOM text measurement available outside an effect — a rough
 * estimate is what this task's spec calls for), then greedily keeps a label
 * only if it doesn't overlap one already placed, walking nodes in
 * DESCENDING degree order so the most important/connected concepts get
 * first pick of the available screen space.
 *
 * `alwaysShow` ids (selected node + its neighbors + hovered) are placed
 * first, unconditionally, before the greedy degree-ordered pass runs over
 * everyone else — so a label the user explicitly asked to see is never
 * skipped for overlapping something else, and other labels are placed
 * around it instead.
 */
function computeVisibleLabels(
  nodes: KbNode[],
  positions: PositionMap,
  transform: { scale: number; tx: number; ty: number },
  degree: Map<string, number>,
  alwaysShow: ReadonlySet<string>,
  unit: number,
): Set<string> {
  const visible = new Set<string>();
  const placed: LabelBox[] = [];

  function boxFor(p: SimPosition, name: string, deg: number): LabelBox {
    const fontSize = labelFontSize(deg, unit);
    const r = nodeRadiusForDegree(deg);
    const screenX = transform.tx + p.x * transform.scale;
    const screenY = transform.ty + p.y * transform.scale;
    // Matches the JSX's rendered label placement: centered horizontally over
    // the node, with its baseline sitting just ABOVE the node's on-screen top
    // edge (transform.scale * r) plus a font-proportional gap.
    const width = name.length * fontSize * LABEL_CHAR_WIDTH_FACTOR;
    const height = fontSize * 1.3;
    const baselineY = screenY - (transform.scale * r + unit * 0.5);
    return {
      minX: screenX - width / 2 - LABEL_GAP,
      maxX: screenX + width / 2 + LABEL_GAP,
      minY: baselineY - height - LABEL_GAP,
      maxY: baselineY + LABEL_GAP,
    };
  }

  for (const n of nodes) {
    if (!alwaysShow.has(n.id)) continue;
    const p = positions[n.id];
    if (!p) continue;
    visible.add(n.id);
    placed.push(boxFor(p, n.name, degree.get(n.id) ?? 0));
  }

  // Fix 3: cap the CANDIDATE pool itself to the top-K highest-degree nodes
  // (K depends on current zoom — see labelRankCapForScale) before the greedy
  // overlap pass ever runs — so a low-zoom view can't fill up with labels
  // just because there happened to be screen-space room for them; only the
  // biggest/most-connected concepts are even in the running.
  const rankCap = labelRankCapForScale(transform.scale);
  const rest = nodes
    .filter((n) => !alwaysShow.has(n.id) && positions[n.id])
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name))
    .slice(0, rankCap);

  for (const n of rest) {
    const p = positions[n.id]!;
    const box = boxFor(p, n.name, degree.get(n.id) ?? 0);
    if (placed.some((existing) => boxesOverlap(existing, box))) continue;
    visible.add(n.id);
    placed.push(box);
  }

  return visible;
}

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
  /** Display name of the class (e.g. "Intro to Statistics") — collectionId
   *  itself is an opaque id, not something worth putting in front of the
   *  model or the "Ask about this" prompt. */
  collectionLabel: string;
  nodes: KbNode[];
  edges: KbEdge[];
}

export function ConceptGraph({ collectionId, collectionLabel, nodes, edges }: ConceptGraphProps) {
  const [positions, setPositions] = useState<PositionMap>({});
  const [settled, setSettled] = useState(false);
  const [fitViewBox, setFitViewBox] = useState<ViewBox>(() => computeViewBox({}, []));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
  const [citeOpenKey, setCiteOpenKey] = useState<string | null>(null);
  const [citeSnippets, setCiteSnippets] = useState<Record<string, { text: string; sourcePath?: string }>>({});
  /** KM4c: plain-English per-node summaries — hydrated from kb_node_summaries
   *  once per graph load, then filled in lazily (at most once per node, ever)
   *  as the user clicks nodes that pregeneration didn't already cover. */
  const [nodeSummaries, setNodeSummaries] = useState<Record<string, string>>({});
  const [summaryLoading, setSummaryLoading] = useState<Record<string, boolean>>({});
  const [showRawRelationships, setShowRawRelationships] = useState(false);
  /** KM4d: "Ask about this in chat" free-text input, per current selection. */
  const [askQuestion, setAskQuestion] = useState("");
  /** Node currently under the pointer — always gets a label regardless of
   *  the greedy declutter pass below, so hovering always answers "what's
   *  this node?" even when its label is culled at the current zoom. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const rafRef = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState | null>(null);
  /** KM4c: node ids currently mid-generation — a ref (not state) so it never
   *  needs to be a dependency of the lazy-generation effect below; the effect
   *  still re-runs on `nodeSummaries` changes (to see fresh results), but
   *  this ref is what actually prevents double-firing generateNodeSummary for
   *  the same node from overlapping/duplicate effect invocations. */
  const generatingSummaryRef = useRef<Set<string>>(new Set());

  // ─── Force simulation — settles then STOPS (see module doc comment) ─────
  useEffect(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setSelectedId(null);
    // Fix 1 (cont'd): always reset pan/zoom to identity whenever the graph
    // itself changes (a fresh build, or switching collections) — otherwise a
    // zoom/pan the user left on a PREVIOUS graph would persist and frame the
    // new one wrong even though `fitViewBox` below is computed correctly at
    // identity transform. Combined with the seed-position fit below, this is
    // what guarantees "all nodes visible immediately, no manual zoom" holds
    // for every fresh graph, not just the very first one this component ever
    // renders.
    setTransform({ scale: 1, tx: 0, ty: 0 });
    setSettled(false);
    setCiteOpenKey(null);
    setCiteSnippets({});
    setNodeSummaries({});
    setSummaryLoading({});

    // KM4c: hydrate whatever summaries already exist for this class (from a
    // prior pregeneration or a prior session's on-click generation) in one
    // round trip — never generates anything here, just loads what's cached.
    void getNodeSummaries(collectionId).then((summaries) => {
      const map: Record<string, string> = {};
      for (const [id, s] of summaries) map[id] = s.summary;
      setNodeSummaries(map);
    });

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

    // Params scale up with node count (bigger canvas, stronger repulsion,
    // weaker centering gravity) so a 300-node graph gets room to spread
    // instead of piling onto the same fixed-size canvas a 20-node graph
    // uses — see graphLayout.ts's "Scaling spread with graph size".
    const simParams = computeSimParams(nodeIds.length);
    // Per-node circle radius, degree-scaled — the same formula ConceptGraph
    // uses to actually DRAW each circle (see nodeRadius below), fed to the
    // collision pass so what gets resolved matches what gets rendered.
    const radii: Record<string, number> = {};
    const nodeDegree = computeDegree(nodeIds, simEdges);
    for (const id of nodeIds) radii[id] = nodeRadiusForDegree(nodeDegree[id] ?? 0);

    let pos = seedPositions(nodeIds, simParams.width, simParams.height);
    let alpha = 1;
    let tick = 0;
    setPositions(pos);
    // ─── Fix 1 (nodes off-screen on first open) ───────────────────────────
    // Frame 1's viewBox must already bound the SEEDED layout, not the tiny
    // `computeViewBox({}, [])` fallback `fitViewBox` starts life as (see its
    // useState initializer below). That fallback is a fine placeholder for
    // "no graph yet", but it is NOT a fine viewBox to render actual seeded
    // node positions into: seedPositions spreads nodes across simParams'
    // sqrt(nodeCount)-scaled canvas (thousands of units wide for a 300-node
    // graph), while the fallback box is a fixed 400x300 — every node would
    // render far outside it for the entire settle animation (up to
    // MAX_SIM_TICKS ticks), which is exactly the "must manually zoom out to
    // find them" bug. Fitting to the seed positions immediately means the
    // very first paint already frames the whole graph; the settle callback
    // below re-fits once more to the FINAL positions (tightening the frame
    // now that nodes have spread/settled), but the user is never looking at
    // an empty/wrong box in between.
    setFitViewBox(computeViewBox(pos, nodeIds, VIEWBOX_PADDING));

    function step() {
      const result = stepSimulation(pos, nodeIds, simEdges, simParams, alpha, undefined, radii);
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

  // Shares its formula with graphLayout.ts's collision pass (nodeRadiusForDegree)
  // via computeDegree, so what gets collision-resolved matches what gets
  // drawn and what gets used for label-priority ordering below.
  const degree = useMemo(() => {
    const rec = computeDegree(
      nodes.map((n) => n.id),
      edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId })),
    );
    return new Map(Object.entries(rec));
  }, [nodes, edges]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // ─── Always-on "important" labels ────────────────────────────────────────
  // The highest-degree (most-connected) concepts — the graph's hubs — always
  // get a label, at every zoom level AND while the sim is still running, so
  // the graph never reads as an unlabeled cloud of dots that only sprouts
  // names once you've zoomed in and clicked (the exact complaint this fixes).
  // Computed purely from topology (degree), so it's stable for the life of a
  // graph — it does NOT depend on positions, and therefore never recomputes
  // per RAF tick. Everything past this handful is still subject to the
  // zoom-dependent greedy declutter pass (computeVisibleLabels) below.
  const importantLabelIds = useMemo(() => {
    return [...degree.entries()]
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, IMPORTANT_LABEL_COUNT)
      .map(([id]) => id);
  }, [degree]);

  // Fix 4 — cluster coloring. Recomputed only when the graph itself changes
  // (nodes/edges), never per RAF tick — community structure comes purely
  // from graph TOPOLOGY (detectCommunities doesn't look at positions at
  // all), so it doesn't need to (and shouldn't) recompute while the sim is
  // merely moving nodes around every frame.
  const communities = useMemo(
    () =>
      detectCommunities(
        nodes.map((n) => n.id),
        edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId })),
      ),
    [nodes, edges],
  );
  const colorByCommunity = useMemo(() => communityColorMap(communities), [communities]);

  // Moved above the `nodes.length === 0` early return (below) so hooks are
  // always called in the same order every render — connectedIds feeds the
  // label-visibility memo's "always show" set right after this.
  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;
  const outgoing = selectedId ? edges.filter((e) => e.sourceId === selectedId) : [];
  const incoming = selectedId ? edges.filter((e) => e.targetId === selectedId) : [];
  const connectedIds = new Set<string>();
  if (selectedId) {
    connectedIds.add(selectedId);
    for (const e of outgoing) connectedIds.add(e.targetId);
    for (const e of incoming) connectedIds.add(e.sourceId);
  }

  // KM4c: generate a summary the first time a node is selected that doesn't
  // already have one (pregeneration only covers the highest-degree nodes —
  // see graph.ts's pregenerateHighValueSummaries). Guarded so this only ever
  // fires generateNodeSummary once per node: the nodeSummaries-has-it check
  // covers cross-session persistence, generatingSummaryRef covers the same
  // node being re-selected while its first generation is still in flight.
  useEffect(() => {
    if (!selectedId) return;
    if (nodeSummaries[selectedId] !== undefined) return;
    if (generatingSummaryRef.current.has(selectedId)) return;
    const node = nodeById.get(selectedId);
    if (!node) return;
    generatingSummaryRef.current.add(selectedId);
    setSummaryLoading((prev) => ({ ...prev, [selectedId]: true }));
    void generateNodeSummary(collectionId, node, edges, nodeById).then((summary) => {
      generatingSummaryRef.current.delete(selectedId);
      setSummaryLoading((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
      if (summary) setNodeSummaries((prev) => ({ ...prev, [selectedId]: summary }));
    });
    // nodeById/edges/collectionId change only when the graph itself changes
    // (same reasoning as the settle-loop effect above), so this only
    // re-runs on an actual node (re)selection or a fresh summary landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nodeSummaries]);

  // Clear the "Ask about this" draft whenever the selected node changes —
  // a half-typed question about the previous concept shouldn't linger.
  useEffect(() => setAskQuestion(""), [selectedId]);

  /** KM4d: hands off to App.tsx's chat-seed effect (store/chatSeed.ts) —
   *  starts a fresh chat conversation with an invisible system prompt giving
   *  the concept's explanation and telling the model to search THIS class's
   *  knowledge base, then sends the user's typed question as a normal
   *  visible message. */
  function handleAskInChat(node: KbNode) {
    const question = askQuestion.trim();
    if (!question) return;
    const summary = nodeSummaries[node.id];
    const systemPrompt = [
      `The user is studying "${collectionLabel}" and is asking about the concept "${node.name}".`,
      summary ? `Known explanation of this concept:\n${summary}` : "",
      `Use the search_knowledge tool with collection: "${collectionId}" to find supporting passages from this class's ingested notes before answering, and cite what you find. If nothing relevant turns up, say so and answer from the explanation above instead.`,
    ].filter(Boolean).join("\n\n");
    useChatSeedStore.getState().requestSeed({ systemPrompt, question });
    setAskQuestion("");
  }

  /** Explicit user-triggered re-generation — bypasses the "already have one"
   *  guard the lazy-generation effect above enforces (that guard is what
   *  makes generation happen "at most once" automatically; this button is
   *  the deliberate escape hatch when a student wants a better explanation,
   *  e.g. after noticing the auto-generated one is thin or slightly off). */
  function handleRegenerateSummary(node: KbNode) {
    if (generatingSummaryRef.current.has(node.id)) return;
    generatingSummaryRef.current.add(node.id);
    setSummaryLoading((prev) => ({ ...prev, [node.id]: true }));
    void generateNodeSummary(collectionId, node, edges, nodeById).then((summary) => {
      generatingSummaryRef.current.delete(node.id);
      setSummaryLoading((prev) => {
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
      if (summary) {
        setNodeSummaries((prev) => ({ ...prev, [node.id]: summary }));
      } else {
        toast.error("Could not regenerate explanation — is the local model available?");
      }
    });
  }

  function nodeRadius(id: string): number {
    return nodeRadiusForDegree(degree.get(id) ?? 0);
  }

  // Viewbox-relative label base size — see LABEL_VIEW_WIDTH_FRACTION. Recomputed
  // whenever the fit frame changes (seed fit, then settle fit) so labels stay a
  // constant fraction of the visible frame across graph sizes and zoom levels.
  const labelUnit = fitViewBox.width * LABEL_VIEW_WIDTH_FRACTION;

  // ─── Progressive label declutter (see module doc comment) ────────────────
  // Nodes that must ALWAYS show a label, regardless of the greedy pass below:
  // the graph's hub concepts (importantLabelIds — always, at any zoom), the
  // selected node, its direct neighbors (both in connectedIds), and whatever's
  // currently hovered.
  const alwaysShowLabelIds = useMemo(() => {
    const ids = new Set(connectedIds);
    for (const id of importantLabelIds) ids.add(id);
    if (hoveredId) ids.add(hoveredId);
    return ids;
    // connectedIds is a plain object recomputed every render (not itself a
    // hook), so depend on its actual inputs instead of its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, hoveredId, edges, importantLabelIds]);

  const labelVisibleIds = useMemo(() => {
    // While the sim is still moving nodes every frame, show only the always-on
    // set (hubs + selection + hover) — it doesn't depend on positions, so it's
    // stable and cheap per-tick, and the hub labels are up immediately instead
    // of waiting for the layout to settle. The full greedy overlap pass (which
    // DOES depend on positions) only runs once settled.
    if (!settled) return alwaysShowLabelIds;
    return computeVisibleLabels(nodes, positions, transform, degree, alwaysShowLabelIds, labelUnit);
  }, [settled, nodes, positions, transform, degree, alwaysShowLabelIds, labelUnit]);

  if (nodes.length === 0) return null;

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

          {/* Circles layer — drawn BEFORE the labels layer below so a node
              circle can never paint over a label (that z-order was the "a node
              is covering a label" bug: with circles and labels interleaved
              per-node, a later node's circle painted on top of an earlier
              node's label). */}
          {nodes.map((n) => {
            const p = positions[n.id];
            if (!p) return null;
            const isSelected = selectedId === n.id;
            const dim = selectedId != null && !connectedIds.has(n.id);
            const r = nodeRadius(n.id) * (isSelected ? 1.35 : 1);
            return (
              <circle
                key={n.id}
                cx={p.x}
                cy={p.y}
                r={r}
                fill={nodeFillForCommunity(colorByCommunity, communities.get(n.id))}
                stroke={isSelected ? "var(--foreground)" : "var(--border)"}
                strokeWidth={isSelected ? 2 : 1}
                opacity={dim ? 0.3 : 1}
                className={cn(settled ? "cursor-pointer" : "cursor-default", "transition-opacity duration-150")}
                onPointerDown={(e) => handleNodePointerDown(e, n.id)}
                onPointerEnter={() => setHoveredId(n.id)}
                onPointerLeave={() => setHoveredId((cur) => (cur === n.id ? null : cur))}
              />
            );
          })}

          {/* Labels layer — rendered AFTER every circle, so labels always sit
              ON TOP of all nodes (no node ever covers a label). Each label is
              centered ABOVE its own node, with a card-colored halo (paintOrder:
              stroke) so the text stays legible over edges and other nodes. */}
          {nodes.map((n) => {
            const p = positions[n.id];
            if (!p || !labelVisibleIds.has(n.id)) return null;
            const isSelected = selectedId === n.id;
            const dim = selectedId != null && !connectedIds.has(n.id);
            const deg = degree.get(n.id) ?? 0;
            const r = nodeRadius(n.id) * (isSelected ? 1.35 : 1);
            const fontSize = labelFontSize(deg, labelUnit);
            return (
              // Counter-scaled against the ambient zoom (`scale(1/transform.scale)`)
              // so the label's own on-screen SIZE stays constant regardless of
              // zoom level, while its anchor point (translate(p.x, p.y)) still
              // moves/spreads with zoom like every other node — this is what
              // makes zooming in spread nodes apart and separate their labels.
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y}) scale(${1 / transform.scale})`}
                className="pointer-events-none select-none transition-opacity duration-150"
                opacity={dim ? 0.3 : 1}
              >
                <text
                  x={0}
                  // Baseline placed above the node's on-screen top edge
                  // (transform.scale * r) plus a small gap, so the text sits
                  // physically above the point rather than beside it.
                  y={-(transform.scale * r + labelUnit * 0.5)}
                  fontSize={fontSize}
                  textAnchor="middle"
                  fill="var(--foreground)"
                  stroke="var(--card)"
                  strokeWidth={fontSize * 0.22}
                  style={{ paintOrder: "stroke" }}
                >
                  {n.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {selectedNode && (
        <div className="absolute top-2 right-2 bottom-2 w-80 max-w-[50%] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg flex flex-col overflow-hidden">
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
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Explanation
                </p>
                <button
                  type="button"
                  onClick={() => handleRegenerateSummary(selectedNode)}
                  disabled={!!summaryLoading[selectedNode.id]}
                  title="Regenerate this explanation"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none transition-colors"
                >
                  <RotateCw className={cn("size-3", summaryLoading[selectedNode.id] && "animate-spin")} />
                </button>
              </div>
              {nodeSummaries[selectedNode.id] ? (
                <div className="text-xs text-foreground/90 leading-relaxed [&_p]:my-1 [&_.katex]:text-[0.95em]">
                  <Markdown>{nodeSummaries[selectedNode.id]}</Markdown>
                </div>
              ) : summaryLoading[selectedNode.id] ? (
                <p className="text-xs text-muted-foreground italic animate-pulse">Writing an explanation…</p>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No explanation available (local model unavailable, or nothing to summarize yet).
                </p>
              )}
            </div>

            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Ask about this
              </p>
              <div className="flex items-center gap-1">
                <input
                  value={askQuestion}
                  onChange={(e) => setAskQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAskInChat(selectedNode);
                  }}
                  placeholder="Ask a question in chat…"
                  className="flex-1 min-w-0 text-xs px-2 py-1 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => handleAskInChat(selectedNode)}
                  disabled={!askQuestion.trim()}
                  title="Ask in chat, with this concept as context"
                  className="shrink-0 size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none transition-colors"
                >
                  <Send className="size-3.5" />
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Opens a new chat, pre-loaded with this concept and instructed to search "{collectionLabel}"'s notes.
              </p>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowRawRelationships((v) => !v)}
                className="text-[10px] font-semibold text-muted-foreground hover:text-foreground uppercase tracking-wide mb-1 transition-colors"
              >
                {showRawRelationships ? "▾" : "▸"} Relationship details
              </button>
              {showRawRelationships && (
                outgoing.length === 0 && incoming.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No relations found for this concept.</p>
                ) : (
                  <div className="space-y-1 mt-1">
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
                )
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
