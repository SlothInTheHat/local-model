import type { HardwareInfo } from "./hardware";
import { knownParamCount } from "./modelCapabilities";
import type { ChatMessage } from "./ollama";

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

/** Models at or above this size get the large-model num_ctx cap below. */
const LARGE_MODEL_PARAMS = 12_000_000_000; // 12B

/** Strips a `provider::modelName` ref down to the bare Ollama model name
 *  (matches the format chatProvider.ts's parseModelRef produces/consumes;
 *  duplicated locally to avoid a cross-module dependency for one split). */
function bareModelName(modelRef: string): string {
  const sep = modelRef.indexOf("::");
  return sep === -1 ? modelRef : modelRef.slice(sep + 2);
}

/**
 * `modelRef` is optional so existing callers that don't have a model handy
 * keep working — they just get the VRAM-tier default unchanged. Pass it
 * whenever available so large models get capped correctly.
 */
export function resolveNumCtx(
  hardware: HardwareInfo | null,
  override: number | null,
  modelRef?: string
): number {
  if (override && override > 0) return override;

  const base = recommendedNumCtx(hardware);
  const vramGb = hardware?.vramGb ?? 0;

  // A 14B q4 model (~9-10GB weights) plus its KV cache at num_ctx=16384, plus
  // the embedding model, plus any concurrent generation, is what pushed a
  // 16GB card into VRAM thrash/OOM (observed: Ollama connection drops
  // mid-stream). Cap large models to 8192 on cards that top out at 16GB.
  // Unknown param count (not yet probed, or an old Ollama without
  // `model_info`) keeps the existing VRAM-tier behavior unchanged.
  if (modelRef && vramGb <= 16) {
    const paramCount = knownParamCount(bareModelName(modelRef));
    if (paramCount != null && paramCount >= LARGE_MODEL_PARAMS) {
      return Math.min(base, 8192);
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// WP4.1 — context budget + compaction
//
// Long agent sessions resend the full system prompt + entire message history
// every round for up to DEFAULT_MAX_ROUNDS rounds. On small num_ctx this
// silently overflows Ollama's context window (invisible truncation, then
// "history bleed" where stale early content hijacks later requests). The
// helpers below give runAgentSession a cheap way to estimate the projected
// token load each round and fold old history into a compact work-log stub
// before that happens.
// ---------------------------------------------------------------------------

/**
 * Heuristic token estimate — ~4 chars/token holds up well enough for a budget
 * check (we don't have the model's actual tokenizer available in the
 * renderer). Deliberately NOT an LLM call: this runs every round.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Per-message overhead (role wrapper, chat-template delimiters) — loose. */
const PER_MESSAGE_TOKEN_OVERHEAD = 4;

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + PER_MESSAGE_TOKEN_OVERHEAD;
    if (m.tool_calls) {
      for (const call of m.tool_calls) {
        total += estimateTokens(call.function.name);
        total += estimateTokens(JSON.stringify(call.function.arguments ?? {}));
      }
    }
  }
  return total;
}

/** Fraction of numCtx at which mid-loop compaction kicks in. */
export const COMPACTION_BUDGET_RATIO = 0.7;

/** Messages to keep intact at the tail — ~3 assistant/tool pairs. */
const RETAINED_TAIL_MESSAGES = 6;

/** Cap on the folded work-log's own size, so it can't itself blow the budget. */
const WORK_LOG_TOKEN_CAP = 1500;

export const COMPACTED_WORK_LOG_PREFIX =
  "[Compacted work log — older steps summarized to fit context]";

/** Per-tool-result cap applied uniformly to what enters `history` (item 3). */
export const TOOL_OUTPUT_CHAR_CAP = 6000;
const TOOL_OUTPUT_HEAD_CHARS = 3000;
const TOOL_OUTPUT_TAIL_CHARS = 1500;

/**
 * Elides the middle of an oversized tool result before it's added to history.
 * The full, untrimmed result still reaches the UI (callers pass the original
 * `result` object to onToolCallResolved separately) — only the string that
 * re-enters the model's context is capped here.
 */
export function capToolOutput(content: string): string {
  if (content.length <= TOOL_OUTPUT_CHAR_CAP) return content;
  const head = content.slice(0, TOOL_OUTPUT_HEAD_CHARS);
  const tail = content.slice(-TOOL_OUTPUT_TAIL_CHARS);
  const elided = content.length - TOOL_OUTPUT_HEAD_CHARS - TOOL_OUTPUT_TAIL_CHARS;
  return `${head}\n\n…[elided ${elided} chars]…\n\n${tail}`;
}

function shortArgs(args: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(args ?? {});
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

function oneLine(text: string, cap: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, cap);
}

export interface CompactionOutcome {
  history: ChatMessage[];
  compacted: boolean;
  foldedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Checks whether `[systemPrompt + stateBlock + history]` is projected to
 * exceed COMPACTION_BUDGET_RATIO of numCtx, and if so, folds the oldest
 * history entries into a single synthetic work-log message.
 *
 * Cut-boundary rule: the retained tail must start at an assistant or user/
 * system message, NEVER at a `role: "tool"` message — a tool result with no
 * preceding assistant tool_calls message is rejected by Ollama/OpenAI-style
 * APIs. History is built in { assistant(tool_calls), tool } pairs (see
 * agentRuntime.ts), so we take the natural tail-window cut point and, if it
 * happens to land mid-pair (on the `tool` half), nudge it forward one message
 * to the start of the next pair. The folded prefix becomes plain text, so
 * pairing no longer matters for it.
 *
 * Idempotent-friendly: if the fold prefix already starts with a prior
 * work-log message (COMPACTED_WORK_LOG_PREFIX), its bullets are merged into
 * the new one instead of nesting "[Compacted work log...]" inside itself.
 */
export function compactHistoryIfOverBudget(
  systemPrompt: string,
  stateBlock: string,
  history: ChatMessage[],
  numCtx: number,
): CompactionOutcome {
  const overhead = estimateTokens(systemPrompt) + estimateTokens(stateBlock);
  const tokensBefore = overhead + estimateMessagesTokens(history);
  const budget = numCtx * COMPACTION_BUDGET_RATIO;

  if (tokensBefore <= budget || history.length <= RETAINED_TAIL_MESSAGES) {
    return { history, compacted: false, foldedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  let cutIndex = history.length - RETAINED_TAIL_MESSAGES;
  while (cutIndex < history.length && history[cutIndex].role === "tool") cutIndex++;

  if (cutIndex <= 0 || cutIndex >= history.length) {
    // Nothing safe to fold (either everything would be retained, or every
    // remaining message is an orphaned tool result) — leave history as-is
    // rather than risk an invalid sequence.
    return { history, compacted: false, foldedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const toFold = history.slice(0, cutIndex);
  const tail = history.slice(cutIndex);

  // Merge with a prior work-log message rather than nesting one inside another.
  let existingBullets = "";
  let pairs = toFold;
  if (toFold[0]?.role === "user" && toFold[0].content.startsWith(COMPACTED_WORK_LOG_PREFIX)) {
    existingBullets = toFold[0].content.slice(COMPACTED_WORK_LOG_PREFIX.length).replace(/^\n+/, "");
    pairs = toFold.slice(1);
  }

  const newBullets: string[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const msg = pairs[i];
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const call = msg.tool_calls[0];
      const next = pairs[i + 1];
      let resultSnippet = "";
      if (next?.role === "tool") {
        resultSnippet = oneLine(next.content, 120);
        i++; // consume the paired tool message so it's not emitted again below
      }
      newBullets.push(`- called ${call.function.name}(${shortArgs(call.function.arguments)}) → ${resultSnippet}`);
    } else if (msg.content) {
      newBullets.push(`- (${msg.role}) ${oneLine(msg.content, 100)}`);
    }
  }

  let bulletsText = [existingBullets, ...newBullets].filter(Boolean).join("\n");
  if (estimateTokens(bulletsText) > WORK_LOG_TOKEN_CAP) {
    const lines = bulletsText.split("\n");
    let dropped = false;
    while (lines.length > 1 && estimateTokens(lines.join("\n")) > WORK_LOG_TOKEN_CAP) {
      lines.shift();
      dropped = true;
    }
    bulletsText = (dropped ? "…(earlier entries dropped)\n" : "") + lines.join("\n");
  }

  const workLogMessage: ChatMessage = {
    role: "user",
    content: `${COMPACTED_WORK_LOG_PREFIX}\n${bulletsText}`,
  };

  const newHistory = [workLogMessage, ...tail];
  const tokensAfter = overhead + estimateMessagesTokens(newHistory);

  return { history: newHistory, compacted: true, foldedCount: toFold.length, tokensBefore, tokensAfter };
}
