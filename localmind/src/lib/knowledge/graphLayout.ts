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
  repulsion: 1800,
  springLength: 120,
  springStrength: 0.02,
  gravity: 0.02,
  damping: 0.72,
  maxSpeed: 14,
};

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
 */
export function stepSimulation(
  positions: PositionMap,
  nodeIds: string[],
  edges: SimEdge[],
  params: SimParams,
  alpha = 1,
  pinnedIds?: ReadonlySet<string>,
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
