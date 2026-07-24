/**
 * WP6.2a — Named model roles.
 *
 * Today's Ollama call sites mostly hardcode `primary` (the user's selected
 * chat model). This module introduces a small set of roles so cheap/
 * specialized work can go to a more appropriate model instead of always
 * loading the big primary one:
 *  - `primary` — the user's selected chat model (src/store/modelSelection.ts).
 *    Never re-implemented here — this module just reads it.
 *  - `digest`  — a small, cheap model for background summarization work
 *    (e.g. session memory distillation).
 *  - `vision`  — a model that can actually see images, for screenshot/image
 *    tool calls (consumed by a follow-up work package, not this one).
 *  - `embed`   — whatever model src/lib/vectorMemory.ts already uses for
 *    embeddings. Re-exported here, not re-decided.
 *
 * Every role can be pinned by the user in Settings (see src/store/settings.ts
 * `modelRoles`); absent a pin, it's auto-selected. Stores are read via
 * `.getState()` rather than hooks, matching the module-level access pattern
 * used by src/lib/taskRunner.ts and src/lib/scheduler.ts (this file is a
 * library, not a component — it has no render lifecycle to subscribe with).
 */
import type { ChatMessage } from "./ollama";
import { useModelSelectionStore } from "../store/modelSelection";
import { useSettingsStore } from "../store/settings";
import { useChatStore } from "../store/chat";
import { useMemoryStore } from "../store/memory";
import { isVisionModel, knownParamCount } from "./modelCapabilities";
import { streamChatForModel } from "./chatProvider";
/**
 * Hard cap on a digest response so a rambling model can't stall the round.
 * Lives here, next to the `digest()` seam that enforces it — importing it from
 * vectorMemory made these two modules a real import cycle for the sake of one
 * number.
 */
export const DIGEST_MAX_CHARS = 2000;

export type ModelRole = "primary" | "digest" | "vision" | "embed" | "knowledge" | "router";

export interface RoleResolution {
  model: string | null;
  /**
   * "pinned"   — user explicitly chose this model for the role in Settings.
   * "auto"     — no pin (or the pin went stale), auto-selected normally.
   * "fallback" — auto-selection had nothing suitable, degraded to `primary`
   *              (currently only happens for `digest`).
   * "none"     — nothing usable at all (e.g. no vision model installed).
   */
  source: "pinned" | "auto" | "fallback" | "none";
}

/**
 * Name substrings identifying Ollama embedding-only models, which can't run
 * chat completions and must never be auto-picked for a chat-shaped role like
 * `digest`. `nomic-embed-text` is the default configured `embedModel` (see
 * src/store/memory.ts) and is already excluded by identity below; this list
 * additionally guards against *other* installed embedding models (e.g. a
 * user has both nomic-embed-text and mxbai-embed-large pulled, but only one
 * is the active `embedModel`) sneaking into the digest candidate pool.
 */
function isEmbedOnlyModel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("nomic-embed") || lower.includes("all-minilm") || lower.includes("mxbai");
}

/** Ascending by known parameter count; models with no probed count sort last
 *  (prefer a model we *know* is small over an unprobed unknown). */
function byParamCountAscending(a: string, b: string): number {
  const pa = knownParamCount(a);
  const pb = knownParamCount(b);
  if (pa == null && pb == null) return 0;
  if (pa == null) return 1;
  if (pb == null) return -1;
  return pa - pb;
}

/** A pinned override, but only if the model is still actually available —
 *  a pinned model can be deleted from Ollama after the pin was set. */
function resolvePinned(role: ModelRole): string | null {
  const pinned = useSettingsStore.getState().modelRoles[role];
  if (!pinned) return null;
  const available = useChatStore.getState().availableModels;
  if (!available.includes(pinned)) return null; // stale pin — fall through to auto
  return pinned;
}

function autoResolvePrimary(): string | null {
  return useModelSelectionStore.getState().selectedModel || null;
}

function autoResolveDigest(): string | null {
  const available = useChatStore.getState().availableModels;
  const embedModel = useMemoryStore.getState().embedModel;
  const candidates = available.filter((m) => m !== embedModel && !isEmbedOnlyModel(m));
  if (candidates.length === 0) return null;
  return [...candidates].sort(byParamCountAscending)[0] ?? null;
}

/**
 * Vision models below this parameter count are only used as a last resort.
 *
 * "Smallest wins" is the right default for `digest` (summarizing text is easy)
 * but it is actively wrong for vision. Measured on this machine against a
 * trivial 64x64 black-bar-on-white PNG:
 *
 *   moondream (1.8B)  30s  → answered "!!!"  — unusable
 *   llava:13b        145s  → "a thick black line... vertical"  — correct
 *   gemma3:12b       399s  → "a vertical rectangle... black on white" — correct
 *
 * A sub-2B VLM cannot reliably read a dense screen, and returning confident
 * garbage is worse than being slow: the primary model has no way to tell a
 * bad description from a good one and will happily reason on top of it. So
 * small models are ranked last, not first, and only picked if they're all
 * that's installed.
 */
const MIN_VIABLE_VISION_PARAMS = 2_000_000_000;

function autoResolveVision(): string | null {
  const available = useChatStore.getState().availableModels;
  const candidates = available.filter((m) => isVisionModel(m));
  if (candidates.length === 0) return null;

  const viable = candidates.filter((m) => {
    const params = knownParamCount(m);
    // Unprobed (null) models are given the benefit of the doubt — an unknown
    // size is not evidence of being tiny.
    return params === null || params >= MIN_VIABLE_VISION_PARAMS;
  });

  // Among viable models, smallest still wins — it's the fastest of the ones
  // that actually work. Only if nothing clears the floor do we fall back to
  // the tiny ones rather than reporting "no vision model installed".
  const pool = viable.length > 0 ? viable : candidates;
  return [...pool].sort(byParamCountAscending)[0] ?? null;
}

function autoResolveEmbed(): string | null {
  return useMemoryStore.getState().embedModel || null;
}

/**
 * Unpinned default is deliberately just `primary` — unlike `digest` (which
 * auto-picks a small model) there's no safe automatic guess for "stronger
 * model for knowledge-base questions" (auto-picking the single largest
 * installed model could silently load something far slower than the user
 * expects). This role only changes behavior once the user explicitly pins a
 * model to it in Settings; until then a knowledge-flavored question runs on
 * the same model as everything else, exactly like before this role existed.
 */
function autoResolveKnowledge(): string | null {
  return autoResolvePrimary();
}

/**
 * Unlike every other role, `router` has NO auto-fallback to `primary` — it's
 * either explicitly pinned (delegating tool-calling rounds to that model,
 * see runAgentSession's routing phase in agentRuntime.ts) or the feature is
 * simply off. Falling back to primary would make the router "delegate" to
 * itself, a silent no-op that only adds latency for nothing.
 */
function autoResolveRouter(): string | null {
  return null;
}

export function resolveRoleWithReason(role: ModelRole): RoleResolution {
  // `embed` is deliberately never pinnable through settings.modelRoles: the
  // model actually used for embeddings is owned solely by src/store/memory.ts
  // `embedModel` (already user-configurable via Memory settings). Consulting
  // a second pin here would create a value nothing that actually calls
  // embedText() would agree with — a silent second source of truth.
  if (role === "embed") {
    const model = autoResolveEmbed();
    return model ? { model, source: "auto" } : { model: null, source: "none" };
  }

  const pinned = resolvePinned(role);
  if (pinned) return { model: pinned, source: "pinned" };

  switch (role) {
    case "primary": {
      const model = autoResolvePrimary();
      return model ? { model, source: "auto" } : { model: null, source: "none" };
    }
    case "vision": {
      const model = autoResolveVision();
      return model ? { model, source: "auto" } : { model: null, source: "none" };
    }
    case "digest": {
      const model = autoResolveDigest();
      if (model) return { model, source: "auto" };
      // No suitable small model installed — degrade to primary rather than
      // skip digest work entirely; a digest on the big model still beats none.
      const fallback = autoResolvePrimary();
      return fallback ? { model: fallback, source: "fallback" } : { model: null, source: "none" };
    }
    case "knowledge": {
      const model = autoResolveKnowledge();
      return model ? { model, source: "auto" } : { model: null, source: "none" };
    }
    case "router": {
      const model = autoResolveRouter();
      return model ? { model, source: "auto" } : { model: null, source: "none" };
    }
  }
}

export function resolveRole(role: ModelRole): string | null {
  return resolveRoleWithReason(role).model;
}

/**
 * Cheap heuristic for "this message is asking about the user's class notes /
 * uploaded knowledge-base documents" — used to route a chat-agent turn to the
 * `knowledge` role instead of `primary` when the user has pinned a stronger
 * model there. Deliberately generous: a false positive just means an
 * unnecessary-but-harmless model switch for that one turn, not a wrong
 * answer, so this errs toward matching rather than narrowly requiring exact
 * phrasing (see the observed failure this role was added for: a small model
 * reached for grep_files instead of search_knowledge on "what do my class
 * notes say about X" and gave up after an empty result).
 */
const KNOWLEDGE_QUERY_RE = /\b(my|our|the) (class |lecture )?notes\b|\bclass notes\b|\blecture notes\b|\bmy (readings?|slides|textbook|coursework)\b|\baccording to (my|the) (notes|readings|textbook|slides)\b/i;

export function looksLikeKnowledgeQuery(text: string): boolean {
  return KNOWLEDGE_QUERY_RE.test(text);
}

/**
 * The seam: run a one-shot system+user prompt against the `digest` role and
 * return the accumulated text, hard-capped at DIGEST_MAX_CHARS. Every caller
 * of this is a best-effort background nicety (e.g. session memory
 * distillation) — failures of any kind (no digest model resolvable, network
 * error, aborted signal) resolve to `null`, never a thrown exception.
 */
export async function digest(
  system: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const model = resolveRole("digest");
  if (!model) return null;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];

  let out = "";
  try {
    for await (const chunk of streamChatForModel(model, messages, signal)) {
      out += chunk;
      if (out.length > DIGEST_MAX_CHARS) break;
    }
  } catch {
    return null;
  }
  return out;
}
