/**
 * Single-flight generation gate.
 *
 * A 16GB-class card runs one Ollama generation comfortably; two concurrent
 * generations (e.g. an interactive chat plus a scheduler/task-queue headless
 * run) plus the embedding model plus a 14B model's KV cache is what was
 * observed causing VRAM thrash and mid-stream connection drops. This module
 * tracks how many generations are currently in flight so unattended callers
 * (scheduler.ts, taskRunner.ts) can defer instead of piling on.
 *
 * Embeddings (vectorMemory.ts embedText) are deliberately NOT gated here —
 * they're small, fast requests to a tiny model and not a meaningful
 * contributor to the VRAM pressure that causes instability.
 */

let activeGenerations = 0;

/**
 * Call at the start of a generation. Returns a release function that MUST be
 * called exactly once (typically from a `finally` block) when the generation
 * ends, including on early termination (caller stops iterating an async
 * generator, abort, or error) — the counter must never leak.
 */
export function acquireGeneration(): () => void {
  activeGenerations++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeGenerations = Math.max(0, activeGenerations - 1);
  };
}

/** True if at least one generation is currently in flight. */
export function isGenerationBusy(): boolean {
  return activeGenerations > 0;
}
