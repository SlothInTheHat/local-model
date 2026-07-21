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

/**
 * How long a single in-flight generation is believed before it's treated as
 * leaked and swept.
 *
 * The counter below used to be a bare number whose contract was "every caller
 * must release exactly once, forever." When that contract broke — an async
 * generator abandoned without being fully iterated, a module reloaded by HMR
 * mid-stream — the count never returned to zero, and `isGenerationBusy()`
 * answered true for the rest of the process's life. The failure is silent and
 * total: taskRunner and scheduler both *defer* on a busy gate, so queued tasks
 * and cron jobs stop running with no error, no toast, and no log line. A task
 * POSTed over IPC was observed sitting at "queued" for 5+ minutes with a
 * workspace open and nothing else running, which is what prompted this.
 *
 * 15 minutes is deliberately generous: a single generation on this hardware
 * has been measured at 399s (gemma3:12b on one small image), so anything
 * shorter risks sweeping a legitimately slow call. The point isn't to be
 * precise — it's that a leak degrades to "recovers in 15 minutes" instead of
 * "background work is dead until restart."
 */
const STALE_GENERATION_MS = 15 * 60 * 1000;

/** Start timestamps of in-flight generations, keyed by a unique token. */
const activeGenerations = new Map<symbol, number>();

/** Drop entries old enough to be presumed leaked. */
function sweepStale(): void {
  const cutoff = Date.now() - STALE_GENERATION_MS;
  for (const [token, startedAt] of activeGenerations) {
    if (startedAt < cutoff) {
      activeGenerations.delete(token);
      console.warn(
        "[generationGate] swept a generation still marked in-flight after " +
          `${Math.round(STALE_GENERATION_MS / 60000)}m — its release() leaked. ` +
          "Background tasks were being deferred until now.",
      );
    }
  }
}

/**
 * Call at the start of a generation. Returns a release function that MUST be
 * called exactly once (typically from a `finally` block) when the generation
 * ends, including on early termination (caller stops iterating an async
 * generator, abort, or error) — the counter must never leak.
 */
export function acquireGeneration(): () => void {
  const token = Symbol("generation");
  activeGenerations.set(token, Date.now());
  return () => {
    // Idempotent by construction now: deleting an absent key is a no-op, so a
    // double-release can't drive the count negative the way the old
    // decrement-with-a-floor could mask.
    activeGenerations.delete(token);
  };
}

/** True if at least one generation is currently in flight. */
export function isGenerationBusy(): boolean {
  sweepStale();
  return activeGenerations.size > 0;
}

/**
 * Diagnostic for the stuck-queue case: how many generations the gate thinks
 * are running, and how long the oldest has been held. If a queued task never
 * starts, check this before suspecting the task runner itself.
 */
export function generationGateState(): { active: number; oldestHeldMs: number | null } {
  sweepStale();
  let oldest: number | null = null;
  for (const startedAt of activeGenerations.values()) {
    if (oldest === null || startedAt < oldest) oldest = startedAt;
  }
  return {
    active: activeGenerations.size,
    oldestHeldMs: oldest === null ? null : Date.now() - oldest,
  };
}
