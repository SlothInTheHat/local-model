/**
 * KM4b — pure force-directed layout math for the interactive concept graph
 * (src/components/ConceptGraph.tsx).
 *
 * Deliberately factored out of the React component so it's unit-testable
 * without a DOM/React harness (see the scratchpad smoke test referenced in
 * this work's report) and so the component itself only has to worry about
 * wiring a `requestAnimationFrame` loop around these calls, not the physics.
 *
 * ─── The model ───────────────────────────────────────────────────────────────
 * A minimal, deliberately simple force simulation — good enough for the
 * tens-to-low-hundreds of nodes a class's concept graph produces, not a
 * general-purpose graph-layout library:
 *  - Coulomb-like REPULSION between every pair of nodes (O(n^2) — fine at
 *    these sizes; MAX_NODES in graph.ts caps this at 300).
 *  - Spring ATTRACTION along each edge toward a rest length.
 *  - Mild centering GRAVITY pulling every node toward the layout's center, so
 *    disconnected components don't drift off to infinity.
 *  - COLLISION resolution: a direct position correction (not a force) that
 *    pushes any two nodes whose circles overlap apart along their separation
 *    axis. This is what actually fixes visual overlap on dense graphs —
 *    repulsion alone pushes nodes apart proportional to 1/distance^2, which
 *    is too weak at close range on a 200-300 node graph to fully separate
 *    circles before gravity/springs pull the system back together. See the
 *    "why a position correction, not a force" note on the collision pass
 *    itself for why this can't undermine the settle guarantee.
 *  - Velocity damping each tick so the system loses energy and settles.
 *
 * `stepSimulation` is pure: given a position/velocity map and the current
 * tick's forces, it returns a NEW map plus the tick's total kinetic energy.
 * The caller (ConceptGraph.tsx) drives the RAF loop and decides when to stop
 * — by convention, when energy drops under a small epsilon or a hard tick
 * cap is hit (see ConceptGraph.tsx's SETTLE_ENERGY_EPSILON / MAX_SIM_TICKS).
 * This module has no opinion on stopping; it just reports energy so the
 * caller can decide.
 *
 * ─── Scaling spread with graph size ─────────────────────────────────────────
 * `DEFAULT_SIM_PARAMS` is tuned for a modest (~40-node) graph. Dropping a
 * 300-node graph into the same fixed-size canvas with the same repulsion/
 * gravity piles everything into a dense central blob — there just isn't
 * room. `computeSimParams(nodeCount)` scales canvas size and repulsion UP and
 * centering gravity DOWN together, proportional to sqrt(nodeCount), so a
 * graph with N times as many nodes gets roughly sqrt(N) times the linear
 * space to spread into (matching how area needs to grow with node count to
 * keep density — and therefore overlap — roughly constant). Callers should
 * seed initial positions with the SAME scaled width/height (seedPositions
 * already takes width/height as parameters, so no change was needed there —
 * just pass it computeSimParams's scaled dimensions instead of the fixed
 * DEFAULT_SIM_PARAMS ones).
 *
 * ─── Why an `alpha` cooling schedule (not just velocity damping) ───────────
 * An earlier version of this simulation relied on velocity damping alone
 * (each tick's velocity multiplied by a constant < 1) to bleed off energy.
 * That is NOT enough to guarantee settling: whenever a node sits at a
 * slightly-off-equilibrium spot, the un-shrunk repulsion/spring forces push
 * it right back out again next tick, damping knocks it back, and the system
 * lands in a low-amplitude limit cycle that never drops below a small
 * epsilon (confirmed empirically — energy plateaued around ~2 instead of
 * trending to ~0, even after 300 ticks). The fix (standard in force-directed
 * layout implementations, e.g. d3-force's `alpha`) is to also shrink the
 * FORCES themselves over time via a caller-supplied `alpha` that decays tick
 * over tick — so however small a residual oscillation remains, the forces
 * driving it are eventually scaled down to nothing and the system is
 * mathematically guaranteed to settle, not just empirically likely to.
 */

/** A node's position + velocity in simulation space. */
export interface SimPosition {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Keyed by node id (KbNode.id). */
export type PositionMap = Record<string, SimPosition>;

/** Simulation-facing edge shape — just the two endpoint ids, since the
 *  physics doesn't care about a KbEdge's label/citations. */
export interface SimEdge {
  sourceId: string;
  targetId: string;
}

export interface SimParams {
  /** Simulation-space width/height the centering gravity pulls toward the
   *  middle of — independent of the SVG's actual on-screen pixel size
   *  (computeViewBox fits whatever the simulation produces afterward). */
  width: number;
  height: number;
  /** Coulomb-like repulsion constant between every node pair. */
  repulsion: number;
  /** Rest length an edge's spring settles toward. */
  springLength: number;
  /** Spring stiffness (how hard an edge pulls/pushes to reach springLength). */
  springStrength: number;
  /** Centering-gravity strength (fraction of distance-to-center applied as
   *  acceleration each tick). */
  gravity: number;
  /** Velocity multiplier applied each tick (0..1) — the system's main energy
   *  loss, and therefore central to guaranteeing it eventually settles. */
  damping: number;
  /** Hard cap on a node's speed (units/tick) after damping. Plain explicit-
   *  Euler integration with an uncapped speed is numerically unstable for
   *  stiff inverse-square repulsion — two nodes that start close together
   *  can otherwise get flung apart so hard in one tick that they overshoot
   *  into an even-worse configuration next tick, compounding tick over tick
   *  instead of settling (this is exactly what an early, unclamped version
   *  of this simulation did — energy grew for ~10 ticks before the run's
   *  hard cap silently papered over it). Clamping speed keeps every tick's
   *  displacement bounded, which is what actually makes the "energy trends
   *  toward zero" guarantee hold in practice, not just in the stable case. */
  maxSpeed: number;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  width: 900,
  height: 640,
  // Repulsion and springLength bumped up (from 1800/120) and gravity bumped
  // down (from 0.02) versus this simulation's original tuning: the old
  // values kept small graphs tidy but let large ones collapse into a dense
  // central blob (weak repulsion relative to gravity + a short spring rest
  // length effectively told every node "stay near the middle, and near your
  // neighbors"). These values give nodes more room to breathe; big graphs
  // additionally get these scaled further by computeSimParams below.
  repulsion: 2600,
  springLength: 150,
  springStrength: 0.02,
  gravity: 0.012,
  damping: 0.72,
  maxSpeed: 16,
};

/** Node count `DEFAULT_SIM_PARAMS` above is tuned for — `computeSimParams`
 *  scales relative to this, so a graph at/under this size behaves exactly
 *  like the tuned defaults (spread multiplier clamped to a 1x floor). */
const BASE_NODE_COUNT = 40;

/**
 * Scale `DEFAULT_SIM_PARAMS` for a graph of `nodeCount` nodes: canvas size
 * and repulsion scale UP, centering gravity scales DOWN, together — all by
 * `sqrt(nodeCount / BASE_NODE_COUNT)` — so larger graphs get proportionally
 * more room instead of piling onto the same fixed-size canvas (see this
 * module's doc comment, "Scaling spread with graph size"). Graphs at or
 * below `BASE_NODE_COUNT` get the unscaled defaults back unchanged (the
 * multiplier is floored at 1), so this is a pure size-up for bigger graphs,
 * never a size-down for small ones.
 *
 * Callers should seed initial positions using this SAME scaled width/height
 * (pass them to `seedPositions`) so nodes start already spread across the
 * larger canvas rather than needing the simulation to slowly push them out
 * from a small starting cluster.
 */
export function computeSimParams(nodeCount: number): SimParams {
  const spread = Math.max(1, Math.sqrt(nodeCount / BASE_NODE_COUNT));
  return {
    ...DEFAULT_SIM_PARAMS,
    width: DEFAULT_SIM_PARAMS.width * spread,
    height: DEFAULT_SIM_PARAMS.height * spread,
    repulsion: DEFAULT_SIM_PARAMS.repulsion * spread,
    gravity: DEFAULT_SIM_PARAMS.gravity / spread,
  };
}

/** Keyed by node id — a node's visual circle radius, used by the collision
 *  pass below to know how much space around each node's center to keep
 *  clear of other nodes. */
export type RadiusMap = Record<string, number>;

/**
 * Degree (connection count) of every node in `nodeIds`, counting each edge
 * once per endpoint. Shared by the collision pass (via `nodeRadiusForDegree`
 * — bigger/more-connected nodes get a bigger circle, and therefore need more
 * clearance) and by ConceptGraph.tsx's circle sizing and label-priority
 * ordering, so both "how big is this node drawn" and "how much room does the
 * layout give it" agree with each other.
 */
export function computeDegree(nodeIds: string[], edges: SimEdge[]): Record<string, number> {
  const degree: Record<string, number> = {};
  for (const id of nodeIds) degree[id] = 0;
  for (const e of edges) {
    degree[e.sourceId] = (degree[e.sourceId] ?? 0) + 1;
    degree[e.targetId] = (degree[e.targetId] ?? 0) + 1;
  }
  return degree;
}

/** Visual circle radius for a node with the given degree — the single
 *  source of truth for "how big is this node drawn", shared between the
 *  collision pass (which needs it to keep circles from overlapping) and
 *  ConceptGraph.tsx's rendering (which needs the same number so what's
 *  collision-resolved matches what's drawn). Degree-scaled so well-connected
 *  concepts read as visually more prominent, capped so a hub node in a
 *  300-node graph doesn't dominate the canvas. */
export function nodeRadiusForDegree(degree: number): number {
  return Math.min(20, 6 + Math.sqrt(degree) * 3.2);
}

/** Extra gap (world/simulation units), on top of two nodes' own radii,
 *  enforced by the collision pass — so circles get visible breathing room
 *  rather than merely not-quite-touching. */
export const COLLISION_PADDING = 6;

/** Multiplied into `alpha` once per tick by the caller's loop (ConceptGraph
 *  .tsx and the scratchpad smoke test both use this same constant) — alpha
 *  starts at 1 and decays geometrically, so forces (and therefore energy)
 *  are driven toward zero regardless of any residual limit-cycle jitter.
 *  Tuned empirically so a ~50-node graph settles in well under the ~300-tick
 *  hard cap (see this work's report for measured tick counts). */
export const ALPHA_DECAY = 0.985;
/** Alpha never needs to be tracked below this — treat it (and therefore the
 *  forces it scales) as zero. */
export const ALPHA_MIN = 0.001;

/** Deterministic pseudo-random unit value (0..1) derived from a string —
 *  used to seed initial node positions off `KbNode.id` so a graph's layout
 *  looks the same across renders/reloads instead of jittering randomly on
 *  every remount (a plain `Math.random()` seed would otherwise make the
 *  "same" graph look like a different diagram every time the panel is
 *  revisited, which reads as broken). Not cryptographic — just a cheap,
 *  well-distributed string hash. */
export function hashStringToUnit(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Seed initial positions for `nodeIds` deterministically: spread around a
 * circle centered in `width`x`height`, with each node's angle/radius
 * perturbed by its own id hash so nodes don't all land at neat, suspiciously
 * regular polygon vertices (which the repulsion/spring forces would then
 * have to fight symmetric ties to break out of).
 */
export function seedPositions(nodeIds: string[], width: number, height: number): PositionMap {
  const positions: PositionMap = {};
  const cx = width / 2;
  const cy = height / 2;
  const baseRadius = Math.min(width, height) / 3;
  const n = Math.max(nodeIds.length, 1);
  nodeIds.forEach((id, i) => {
    const seed = hashStringToUnit(id);
    const angle = (i / n) * Math.PI * 2 + seed * Math.PI * 0.5;
    const radius = baseRadius * (0.5 + 0.5 * seed);
    positions[id] = {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });
  return positions;
}

/**
 * Advance the simulation by one tick. Pure — takes a position map and
 * returns a brand-new one (plus this tick's total kinetic energy) without
 * mutating its input, so callers/tests can freely diff/compare ticks.
 *
 * `alpha` (0..1, default 1) scales every force computed this tick — the
 * caller is expected to decay it tick over tick (see ALPHA_DECAY / the
 * module doc comment's "cooling schedule" section) so the simulation is
 * guaranteed to settle rather than merely likely to.
 *
 * `pinnedIds`, if given, holds node ids whose position must NOT move this
 * tick (velocity zeroed) — used by the component to let a user's in-progress
 * drag win over the simulation without restarting the whole layout.
 *
 * `radii`, if given, enables the collision-resolution pass: any pair of
 * nodes whose circles (radius from this map, plus COLLISION_PADDING) overlap
 * get pushed apart along their separation axis. Omit it to skip collision
 * entirely (e.g. a caller that doesn't care about visual circle sizes).
 */
export function stepSimulation(
  positions: PositionMap,
  nodeIds: string[],
  edges: SimEdge[],
  params: SimParams,
  alpha = 1,
  pinnedIds?: ReadonlySet<string>,
  radii?: RadiusMap,
): { positions: PositionMap; energy: number } {
  const fx: Record<string, number> = {};
  const fy: Record<string, number> = {};
  for (const id of nodeIds) {
    fx[id] = 0;
    fy[id] = 0;
  }

  // Repulsion — every pair, O(n^2).
  for (let i = 0; i < nodeIds.length; i++) {
    const a = nodeIds[i];
    const pa = positions[a];
    if (!pa) continue;
    for (let j = i + 1; j < nodeIds.length; j++) {
      const b = nodeIds[j];
      const pb = positions[b];
      if (!pb) continue;
      let dx = pa.x - pb.x;
      let dy = pa.y - pb.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.01) {
        // Two nodes landed (near-)exactly on top of each other — nudge them
        // apart deterministically (off their ids) rather than dividing by
        // ~zero, which would blow the force up toward Infinity/NaN.
        dx = (hashStringToUnit(a + b) - 0.5) * 0.1;
        dy = (hashStringToUnit(b + a) - 0.5) * 0.1;
        distSq = 0.01;
      }
      const dist = Math.sqrt(distSq);
      const force = params.repulsion / distSq;
      const fxi = (dx / dist) * force;
      const fyi = (dy / dist) * force;
      fx[a] += fxi;
      fy[a] += fyi;
      fx[b] -= fxi;
      fy[b] -= fyi;
    }
  }

  // Spring attraction along edges.
  for (const e of edges) {
    const pa = positions[e.sourceId];
    const pb = positions[e.targetId];
    if (!pa || !pb) continue; // dangling endpoint — nothing to attract
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const displacement = dist - params.springLength;
    const force = params.springStrength * displacement;
    const fxi = (dx / dist) * force;
    const fyi = (dy / dist) * force;
    fx[e.sourceId] += fxi;
    fy[e.sourceId] += fyi;
    fx[e.targetId] -= fxi;
    fy[e.targetId] -= fyi;
  }

  // Centering gravity.
  const cx = params.width / 2;
  const cy = params.height / 2;
  for (const id of nodeIds) {
    const p = positions[id];
    if (!p) continue;
    fx[id] += (cx - p.x) * params.gravity;
    fy[id] += (cy - p.y) * params.gravity;
  }

  // Integrate + damp. `alpha` shrinks the forces (the caller's cooling
  // schedule — see module doc comment); damping additionally bleeds off
  // whatever velocity is left each tick. Together they guarantee `energy`
  // trends toward (and below) the stop epsilon instead of oscillating
  // forever in a limit cycle.
  const next: PositionMap = {};
  let energy = 0;
  for (const id of nodeIds) {
    const p = positions[id];
    if (!p) continue;
    if (pinnedIds?.has(id)) {
      next[id] = { x: p.x, y: p.y, vx: 0, vy: 0 };
      continue;
    }
    let vx = (p.vx + fx[id] * alpha) * params.damping;
    let vy = (p.vy + fy[id] * alpha) * params.damping;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > params.maxSpeed) {
      const scale = params.maxSpeed / speed;
      vx *= scale;
      vy *= scale;
    }
    next[id] = { x: p.x + vx, y: p.y + vy, vx, vy };
    energy += vx * vx + vy * vy;
  }

  // Collision resolution — direct position correction, O(n^2) like the
  // repulsion pass above (fine at this scale). Runs AFTER integration, on
  // `next`'s freshly-computed positions, and pushes any overlapping pair
  // apart along their separation axis until their circles (radius + radius +
  // COLLISION_PADDING) no longer intersect.
  //
  // Why a position correction and not just another force added to fx/fy:
  // a force only changes velocity, which repulsion already does — and
  // repulsion's 1/distance^2 falloff is exactly why overlap happens in the
  // first place (it gets weak fast, so once two nodes are already close,
  // repulsion alone can't finish separating them against spring/gravity
  // pulling back). A position correction fixes overlap directly, on the
  // spot, regardless of how weak the force-based repulsion is at that
  // distance.
  //
  // Why this doesn't reintroduce the limit-cycle/non-settling problem the
  // alpha cooling schedule was built to solve (see this module's top doc
  // comment): the correction is scaled by `alpha`, which the caller decays
  // toward 0 every tick. So as the layout cools, the correction shrinks
  // along with every other force, and by the time alpha is negligible the
  // system's behavior is governed purely by the already-proven-to-settle
  // integrate-and-damp loop above. It also never touches vx/vy, so it can't
  // inject velocity (and therefore can't inflate the `energy` this function
  // reports) — a node whose position gets nudged here shows up as a change
  // in relative distances for NEXT tick's forces, not as extra kinetic
  // energy THIS tick.
  if (radii) {
    for (let i = 0; i < nodeIds.length; i++) {
      const a = nodeIds[i];
      const pa = next[a];
      if (!pa) continue;
      const aPinned = pinnedIds?.has(a) ?? false;
      const ra = radii[a] ?? 0;
      for (let j = i + 1; j < nodeIds.length; j++) {
        const b = nodeIds[j];
        const pb = next[b];
        if (!pb) continue;
        const bPinned = pinnedIds?.has(b) ?? false;
        if (aPinned && bPinned) continue; // neither is allowed to move — nothing to do
        const rb = radii[b] ?? 0;
        const minDist = ra + rb + COLLISION_PADDING;

        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue; // circles don't overlap — nothing to do

        let dist = Math.sqrt(distSq);
        if (dist < 0.01) {
          // Exactly (or near-exactly) coincident — same deterministic
          // nudge-off-zero trick as the repulsion pass above, so we don't
          // divide by ~zero.
          dx = (hashStringToUnit(a + b) - 0.5) * 0.1;
          dy = (hashStringToUnit(b + a) - 0.5) * 0.1;
          dist = 0.1;
        }

        // Split the overlap evenly between both nodes (unless one is
        // pinned, in which case the OTHER absorbs the full correction so the
        // pair still separates), scaled by alpha (see the "why this doesn't
        // reintroduce the limit-cycle problem" note above).
        const overlap = minDist - dist;
        const share = aPinned || bPinned ? 1 : 0.5;
        const push = (overlap / dist) * share * alpha;
        const cx = dx * push;
        const cy = dy * push;
        if (!aPinned) {
          pa.x += cx;
          pa.y += cy;
        }
        if (!bPinned) {
          pb.x -= cx;
          pb.y -= cy;
        }
      }
    }
  }

  return { positions: next, energy };
}

export interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** Bound every listed node's current position with `padding` on all sides,
 *  for use as an SVG `viewBox`. Falls back to a small fixed box when there
 *  are no positions to bound (empty graph), so callers never have to special
 *  -case a degenerate viewBox string. */
export function computeViewBox(positions: PositionMap, nodeIds: string[], padding = 60): ViewBox {
  const pts = nodeIds.map((id) => positions[id]).filter((p): p is SimPosition => !!p);
  if (pts.length === 0) return { minX: 0, minY: 0, width: 400, height: 300 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    minX: minX - padding,
    minY: minY - padding,
    width: Math.max(maxX - minX + padding * 2, 40),
    height: Math.max(maxY - minY + padding * 2, 40),
  };
}

export function viewBoxToString(vb: ViewBox): string {
  return `${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`;
}

/**
 * ─── Community detection (KM4b cluster coloring) ───────────────────────────
 *
 * Groups nodes into "communities" (densely-interconnected clusters) via
 * label propagation — a simple, near-linear-time algorithm that needs no
 * tuning parameter for cluster count (unlike e.g. k-means): every node
 * starts in its own community, then on each iteration every node adopts
 * whichever community is most common among its immediate neighbors. Nodes in
 * a dense cluster quickly converge on a shared label (each is surrounded
 * mostly by cluster-mates); nodes bridging two clusters have no consistent
 * majority and settle onto whichever side happens to win locally. This is
 * exactly the "related concepts end up the same color" behavior ConceptGraph
 * .tsx wants, and it composes with the force layout for free: nodes in the
 * same community are usually already spatially close (shared edges pull them
 * together), so color and position reinforce the same grouping instead of
 * fighting each other.
 *
 * Pure and deterministic: given the same `nodeIds`/`edges`, this always
 * returns the same grouping, regardless of input array order or JS Map
 * iteration order —
 *  - node processing order is a lexical sort of `nodeIds`, computed once, up
 *    front, and reused for every iteration (not the caller-supplied order,
 *    which e.g. graph.ts's DB fetch order isn't itself guaranteed stable
 *    across reloads);
 *  - a node's initial community is its index in that SAME lexical sort, so
 *    two runs over an identically-shaped graph start from identical labels;
 *  - a neighbor-majority tie is broken by the LOWEST surviving community
 *    label (not neighbor iteration order, insertion order, or anything else
 *    incidental);
 *  - iteration halts as soon as a full pass makes zero changes ("stable"),
 *    or after MAX_ITERATIONS regardless (a label-propagation run can in
 *    theory oscillate between two labels forever on a symmetric graph — the
 *    hard cap guarantees this function always returns, mirroring the sim's
 *    own MAX_SIM_TICKS hard-stop philosophy, even though this pass is
 *    otherwise unrelated to — and never invoked from — the RAF/velocity/
 *    energy settle loop).
 *
 * Isolated nodes (degree 0) have no neighbors to adopt a label from, so they
 * simply keep their own distinct initial community — never merged into
 * whatever community happens to be numbered similarly.
 *
 * Output communities are renumbered to a dense `0..k-1` range, ordered by
 * each community's lexically-smallest member id, so the returned indices
 * themselves are also deterministic (not raw surviving propagation labels,
 * which can retain arbitrary large-ish numbers). Callers that want a
 * meaningful ranking (e.g. "8 biggest categories get real colors, the rest
 * fold to gray" — see ConceptGraph.tsx) should re-rank by community SIZE
 * themselves; this function only guarantees a stable grouping, not a size
 * order.
 */
const COMMUNITY_MAX_ITERATIONS = 20;

export function detectCommunities(nodeIds: string[], edges: SimEdge[]): Map<string, number> {
  // Undirected adjacency — a community is a structural cluster, and edge
  // direction (KbEdge's subject->object relation) doesn't bear on "these two
  // concepts co-occur densely", so both endpoints count as each other's
  // neighbor.
  const neighbors = new Map<string, string[]>();
  for (const id of nodeIds) neighbors.set(id, []);
  for (const e of edges) {
    if (!neighbors.has(e.sourceId) || !neighbors.has(e.targetId)) continue; // dangling endpoint — ignore
    neighbors.get(e.sourceId)!.push(e.targetId);
    neighbors.get(e.targetId)!.push(e.sourceId);
  }

  // Fixed, input-order-independent processing order (see doc comment above).
  const sortedIds = [...nodeIds].sort();
  let community = new Map<string, number>();
  sortedIds.forEach((id, i) => community.set(id, i));

  // SYNCHRONOUS updates: every node's new label for this iteration is
  // computed purely from the PREVIOUS iteration's snapshot (`community`),
  // and all of them are committed together at the end of the pass (`next`)
  // — no node ever sees another node's already-updated label mid-pass.
  //
  // This isn't just a style choice: an earlier version of this function
  // updated `community` in place as it walked `sortedIds`, so a later node
  // in the fixed processing order could see an EARLIER node's brand-new
  // label from the same pass. Combined with a deterministic fixed order
  // (needed for reproducibility) and "ties broken by lowest label", that
  // produced a real bug on exactly the two-dense-clusters-plus-one-bridge
  // shape this function is meant to separate: cluster A's ids sort before
  // cluster B's, so A's nodes always hold numerically lower labels; every
  // node in cluster A collapses onto its lowest member's label within the
  // FIRST pass (since ties are broken toward the lowest value), and by the
  // time the single bridge node in cluster B is reached in that same pass,
  // it sees one already-collapsed, numerically-tiny label from cluster A
  // tied against its still-fragmented (all-distinct) cluster-B neighbors —
  // and the tie-break's "prefer lowest" rule picks cluster A's label every
  // time, merging the two clusters into one community on the spot. Freezing
  // reads to a stable snapshot for the whole pass (this version) avoids that
  // cascade: cluster B's members converge toward EACH OTHER in the same
  // pass cluster A converges toward itself, so the bridge is genuinely
  // outvoted by its five same-cluster neighbors well before it could be
  // swayed by a single cross-cluster tie. See this work's smoke test for the
  // regression case that caught this.
  for (let iter = 0; iter < COMMUNITY_MAX_ITERATIONS; iter++) {
    const next = new Map(community);
    let changed = false;
    for (const id of sortedIds) {
      const adj = neighbors.get(id)!;
      if (adj.length === 0) continue; // isolated node — nothing to propagate from, keeps its own community

      // Tally each neighbor's label as of the START of this iteration.
      const counts = new Map<number, number>();
      for (const nb of adj) {
        const c = community.get(nb)!;
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }

      // Most-common label among neighbors; ties broken by the lowest label
      // value — deterministic regardless of the (insertion-ordered, and
      // therefore neighbor-list-order-dependent) Map iteration order below.
      let bestLabel = community.get(id)!;
      let bestCount = 0;
      for (const [label, count] of counts) {
        if (count > bestCount || (count === bestCount && label < bestLabel)) {
          bestLabel = label;
          bestCount = count;
        }
      }
      if (bestLabel !== community.get(id)) {
        next.set(id, bestLabel);
        changed = true;
      }
    }
    community = next;
    if (!changed) break; // stable — every node already agrees with its neighbor majority
  }

  // Renumber to a dense, deterministic 0..k-1 range (see doc comment).
  const groups = new Map<number, string[]>();
  for (const id of sortedIds) {
    const label = community.get(id)!;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(id);
  }
  // Each group's member list was built while walking `sortedIds` in lexical
  // order, so its first entry is already that group's lexically-smallest
  // member — use it directly as the sort key instead of re-scanning.
  const orderedLabels = [...groups.keys()].sort((a, b) => groups.get(a)![0].localeCompare(groups.get(b)![0]));

  const result = new Map<string, number>();
  orderedLabels.forEach((label, denseIndex) => {
    for (const id of groups.get(label)!) result.set(id, denseIndex);
  });
  return result;
}
