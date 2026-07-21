import { getOllamaBaseUrl } from "./ollama";

/**
 * Probed model capabilities, keyed by exact model name string.
 * Hydrated from localStorage on module load and written back on every
 * successful probe. Ground truth comes from Ollama's `/api/show` endpoint
 * (`capabilities` array, e.g. ["completion","tools","vision"]) on modern
 * Ollama versions. Older Ollama builds omit `capabilities` entirely — in
 * that case we simply never populate the cache for that model and callers
 * fall back to the name-based heuristics below.
 */
interface ProbedCaps {
  tools?: boolean;
  vision?: boolean;
  /**
   * Raw parameter count from /api/show's `model_info["general.parameter_count"]`
   * (e.g. 14_768_307_200 for qwen3:14b, 7_615_616_512 for qwen2.5:7b — verified
   * live against Ollama). Used by contextSize.ts to cap num_ctx for large
   * models on borderline-VRAM cards.
   */
  paramCount?: number;
}

const CACHE_KEY = "localmind-model-caps";
const capsCache: Map<string, ProbedCaps> = new Map();

function loadCache(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, ProbedCaps>;
    for (const [name, caps] of Object.entries(obj)) {
      capsCache.set(name, caps);
    }
  } catch {
    // Corrupt/missing localStorage entry — start with an empty cache.
  }
}
loadCache();

function persistCache(): void {
  try {
    const obj: Record<string, ProbedCaps> = {};
    for (const [name, caps] of capsCache.entries()) obj[name] = caps;
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    // Ignore quota/serialization errors — cache stays in-memory only.
  }
}

/** Extracts the raw parameter count from an /api/show response, if present. */
function extractParamCount(json: unknown): number | null {
  const modelInfo = (json as { model_info?: Record<string, unknown> } | undefined)?.model_info;
  if (!modelInfo) return null;
  const v = modelInfo["general.parameter_count"];
  return typeof v === "number" ? v : null;
}

/**
 * Probes Ollama's `/api/show` for a single model's real capabilities and
 * updates the in-memory + localStorage cache. Never throws: network errors,
 * missing models, and old-Ollama responses without a `capabilities` field
 * all result in the cache being left untouched for that model name (so
 * callers fall back to the heuristic).
 */
export async function probeModelCapabilities(name: string): Promise<void> {
  try {
    const res = await fetch(`${getOllamaBaseUrl()}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    });
    if (!res.ok) return;
    const json = await res.json();
    const capabilities: string[] | undefined = json?.capabilities;
    const paramCount = extractParamCount(json);
    if (!capabilities && paramCount == null) return; // old Ollama — no ground truth available

    // Merge onto whatever's already cached rather than clobbering: an older
    // probe may have set `tools`/`vision` from `capabilities` while this
    // response has `model_info` but no `capabilities` field (or vice versa).
    const existing = capsCache.get(name);
    const updated: ProbedCaps = { ...existing };
    if (capabilities) {
      updated.tools = capabilities.includes("tools");
      updated.vision = capabilities.includes("vision");
    }
    if (paramCount != null) updated.paramCount = paramCount;
    capsCache.set(name, updated);
    persistCache();
  } catch {
    // Swallow — probing is best-effort and must never surface to callers.
  }
}

/**
 * Probes a list of model names, a few at a time (they're cheap metadata
 * calls). Individual failures are swallowed by probeModelCapabilities and
 * never stop the batch.
 */
export async function probeAllModels(names: string[]): Promise<void> {
  const CONCURRENCY = 4;
  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const chunk = names.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map((name) => probeModelCapabilities(name)));
  }
}

/**
 * Returns true if the model supports native tool/function calling.
 * Non-Ollama models (containing "::") use OpenAI-compat format and always support tools.
 * Prefers a probed ground-truth capability (via probeModelCapabilities/probeAllModels);
 * falls back to a name-based heuristic when no probe result is cached yet.
 */
export function supportsNativeTools(modelName: string): boolean {
  // OpenAI-compatible provider models always support tool use
  if (modelName.includes("::")) return true;

  const cached = capsCache.get(modelName);
  if (cached && cached.tools !== undefined) return cached.tools;

  const lower = modelName.toLowerCase();
  return (
    // Meta Llama 3.1+
    lower.includes("llama3.1") || lower.includes("llama 3.1") ||
    lower.includes("llama3.2") || lower.includes("llama 3.2") ||
    lower.includes("llama3.3") || lower.includes("llama 3.3") ||
    lower.includes("llama3.4") || lower.includes("llama 3.4") ||
    // Mistral family
    lower.includes("mistral-nemo") ||
    lower.includes("mistral-large") ||
    lower.includes("devstral") ||
    lower.includes("mixtral") ||
    // Alibaba Qwen
    lower.includes("qwen2.5") ||
    lower.includes("qwen2") ||
    lower.includes("qwen3") ||
    // Cohere
    lower.includes("command-r") ||
    // Nous Research (tool-finetuned)
    lower.includes("hermes3") || lower.includes("hermes-3") ||
    lower.includes("hermes2") || lower.includes("hermes-2") ||
    // IBM Granite 3+
    lower.includes("granite3") || lower.includes("granite-3") ||
    // NVIDIA Nemotron
    lower.includes("nemotron") ||
    // Fireworks FireFunction
    lower.includes("firefunction") ||
    // Google Gemma 2+ via Ollama
    lower.includes("gemma2") || lower.includes("gemma-2") ||
    // xAI Grok
    lower.includes("grok")
  );
}

/**
 * Returns true if the model supports vision / image inputs.
 * Prefers a probed ground-truth capability when available, else falls back
 * to a name-based heuristic.
 */
export function isVisionModel(modelName: string): boolean {
  const cached = capsCache.get(modelName);
  if (cached && cached.vision !== undefined) return cached.vision;

  const lower = modelName.toLowerCase();
  return (
    lower.includes("llava") ||
    lower.includes("bakllava") ||
    lower.includes("moondream") ||
    lower.includes("minicpm") ||
    lower.includes("llama3.2") || lower.includes("llama 3.2") ||
    lower.includes("llama3.2-vision") ||
    lower.includes("llava-llama3") ||
    lower.includes("qwen2-vl") || lower.includes("qwen2.5-vl") ||
    lower.includes("internvl") ||
    lower.includes("phi-3-vision") || lower.includes("phi3-vision") ||
    lower.includes("cogvlm") ||
    lower.includes("pixtral")
  );
}

/**
 * Returns the cached raw parameter count for a model (see `ProbedCaps.paramCount`
 * for the source), or null if the model hasn't been probed yet / the running
 * Ollama version doesn't expose `model_info`. Used by contextSize.ts.
 */
export function knownParamCount(modelName: string): number | null {
  return capsCache.get(modelName)?.paramCount ?? null;
}
