import type { HardwareInfo } from "./hardware";

/**
 * Ollama defaults to num_ctx=2048 when not specified, which silently truncates
 * long agent system prompts + history. Pick a much larger default based on
 * available VRAM so the model actually sees its full context.
 */
export function recommendedNumCtx(hardware: HardwareInfo | null): number {
  const vram = hardware?.vramGb ?? 0;
  if (vram >= 16) return 16384;
  if (vram >= 6) return 8192;
  return 4096;
}

export function resolveNumCtx(hardware: HardwareInfo | null, override: number | null): number {
  if (override && override > 0) return override;
  return recommendedNumCtx(hardware);
}
