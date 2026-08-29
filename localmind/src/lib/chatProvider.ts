/**
 * Provider-aware chat dispatch.
 * Model refs use the format: `providerId::modelName` for non-Ollama providers.
 * Plain model names (no `::`) are assumed to be Ollama.
 */
import type { ChatMessage } from "./ollama";
import { streamChat as streamChatOllama } from "./ollama";
import { runAgentTurn as runAgentTurnOllama } from "./agentLoop";
import type { AgentEvent, AgentTurnOptions } from "./agentLoop";
import type { ToolDef, ToolCall } from "./tools";
import { useProvidersStore } from "../store/providers";
import { acquireGeneration } from "./generationGate";
import { createThinkSplitter } from "./thinkingStream";

export type { AgentTurnOptions };

// ─── Ref helpers ─────────────────────────────────────────────────────────────

export function parseModelRef(ref: string): { providerId: string; modelName: string } {
  const sep = ref.indexOf("::");
  if (sep === -1) return { providerId: "ollama", modelName: ref };
  return { providerId: ref.slice(0, sep), modelName: ref.slice(sep + 2) };
}

export function formatModelRef(providerId: string, modelName: string): string {
  return providerId === "ollama" ? modelName : `${providerId}::${modelName}`;
}

/** Short model name for display (strips provider prefix). */
export function modelDisplayName(ref: string): string {
  return parseModelRef(ref).modelName;
}

/** Provider label for badges. */
export function providerLabel(ref: string): string {
  const { providerId } = parseModelRef(ref);
  const labels: Record<string, string> = {
    ollama: "Ollama",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    llamacpp: "llama.cpp",
  };
  return labels[providerId] ?? providerId;
}

export function isOllamaModel(ref: string): boolean {
  return parseModelRef(ref).providerId === "ollama";
}

/**
 * Turn a failed OpenAI-compatible response into a concise, human-readable
 * message. Reads the JSON error body (OpenRouter/OpenAI both send
 * `{error:{message}}`) instead of surfacing a bare status code, and
 * special-cases 429 — the most common failure under an agent loop's rapid
 * back-to-back requests, especially on free-tier models.
 */
async function describeProviderError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  let detail = "";
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    detail = (typeof json.error === "string" ? json.error : json.error?.message) ?? json.message ?? "";
  } catch {
    detail = body.trim();
  }
  detail = detail.slice(0, 300);

  if (res.status === 429) {
    return `Provider is rate-limiting this request (429)${detail ? `: ${detail}` : ""} — common on free-tier models when an agent loop fires requests back-to-back; wait a moment, or switch to a paid/local model.`;
  }
  return detail ? `Provider error ${res.status}: ${detail}` : `Provider error ${res.status}`;
}

// ─── OpenAI-compatible streaming chat ────────────────────────────────────────

/**
 * Convert one ChatMessage into an OpenAI-compatible message body.
 *
 * The two APIs disagree about images in exactly the way most likely to fail
 * silently:
 *   - Ollama  → a sibling `images: string[]` field of RAW base64
 *   - OpenAI  → the image lives INSIDE `content` as a parts array, and the
 *               url must be a `data:` URI
 *
 * Before this existed, the OpenAI path mapped `{role, content}` and dropped
 * `images` on the floor — so pointing the `vision` role at an OpenRouter model
 * sent the prompt with NO image and the model answered from imagination. It
 * looked like a bad model rather than a missing field, which is the worst
 * kind of bug to debug.
 *
 * Messages without images keep the plain-string `content` shape, so nothing
 * about existing text-only calls changes.
 */
function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content };
  }
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: "text", text: m.content }] : []),
      ...m.images.map((b64) => ({
        // Tolerate a value that already carries a data: prefix — callers
        // shouldn't have to know which convention this layer wants.
        type: "image_url",
        image_url: { url: b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}` },
      })),
    ],
  };
}

export async function* streamChatOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onThinking?: (chunk: string) => void
): AsyncGenerator<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (baseUrl.includes("openrouter")) {
    headers["HTTP-Referer"] = "https://localmind.app";
    headers["X-Title"] = "LocalMind";
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    // max_tokens: without an explicit value, the provider applies its own
    // silent default (varies by model, sometimes as low as ~1000) — observed
    // live as a quick-invoke answer cut off mid-word with no error at all,
    // just a response that stopped. A generous ceiling here doesn't
    // encourage longer answers (the model isn't rewarded for using more of
    // it), it just gives one room to finish the sentence it's already on.
    body: JSON.stringify({
      model,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(await describeProviderError(res));
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const splitter = createThinkSplitter();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      const raw = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
      try {
        const json = JSON.parse(raw) as Record<string, unknown>;
        const delta = (json["choices"] as Array<Record<string, unknown>>)?.[0]
          ?.["delta"] as Record<string, unknown> | undefined;
        const nativeReasoning = (delta?.["reasoning_content"] ?? delta?.["reasoning"]) as string | undefined;
        if (nativeReasoning) onThinking?.(nativeReasoning);
        const content = delta?.["content"] as string | undefined;
        if (content) {
          const { text, thinking } = splitter.push(content);
          if (thinking) onThinking?.(thinking);
          if (text) yield text;
        }
      } catch { /* skip */ }
    }
  }
  {
    const { text, thinking } = splitter.flush();
    if (thinking) onThinking?.(thinking);
    if (text) yield text;
  }
}

// ─── OpenAI-compatible agent turn (with streaming tool calls) ─────────────────

interface OAIToolDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export async function* runAgentTurnOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal
): AsyncGenerator<AgentEvent> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (baseUrl.includes("openrouter")) {
    headers["HTTP-Referer"] = "https://localmind.app";
    headers["X-Title"] = "LocalMind";
  }

  const oaiTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  // Convert our internal message format to OpenAI format
  const oaiMessages = messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant" as const,
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: `call_${i}`,
          type: "function",
          function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
        })),
      };
    }
    if (m.role === "tool") {
      // OpenAI requires tool_call_id; use a placeholder
      return { role: "tool" as const, content: m.content, tool_call_id: "call_0" };
    }
    // Same image conversion as the plain-chat path — otherwise attaching an
    // image in agent mode with a provider model silently sends text only.
    return toOpenAIMessage(m);
  });

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      // See streamChatOpenAI's identical max_tokens comment above — same
      // silent-truncation risk applies to agent-mode tool-calling rounds.
      body: JSON.stringify({ model, messages: oaiMessages, tools: oaiTools, stream: true, max_tokens: 4096 }),
      signal,
    });
  } catch (err) {
    yield { type: "error", error: (err as Error).message };
    return;
  }

  if (!res.ok) {
    yield { type: "error", error: await describeProviderError(res) };
    return;
  }
  if (!res.body) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const toolAccum: Record<number, { id: string; name: string; args: string }> = {};
  const splitter = createThinkSplitter();

  const flushToolCalls = (): ToolCall[] =>
    Object.values(toolAccum).map((c) => ({
      id: c.id || crypto.randomUUID(),
      name: c.name,
      args: (() => { try { return JSON.parse(c.args) as Record<string, unknown>; } catch { return {}; } })(),
    }));

  const flushSplitter = function* (): Generator<AgentEvent> {
    const { text, thinking } = splitter.flush();
    if (thinking) yield { type: "thinking_delta", content: thinking };
    if (text) yield { type: "text_delta", content: text };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "data: [DONE]") {
        yield* flushSplitter();
        const calls = flushToolCalls();
        if (calls.length > 0) yield { type: "tool_calls", toolCalls: calls };
        else yield { type: "done" };
        return;
      }
      const raw = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
      let json: Record<string, unknown>;
      try { json = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }

      const choice = (json["choices"] as Array<Record<string, unknown>>)?.[0];
      const delta = choice?.["delta"] as Record<string, unknown> | undefined;
      if (!delta) continue;

      // Native reasoning field — DeepSeek's own API (and several
      // OpenAI-compatible reasoning-model routes, e.g. via OpenRouter) send
      // reasoning separately as `reasoning_content`/`reasoning` rather than
      // inline in `content`.
      const nativeReasoning = (delta["reasoning_content"] ?? delta["reasoning"]) as string | undefined;
      if (nativeReasoning) yield { type: "thinking_delta", content: nativeReasoning };

      const content = delta["content"] as string | undefined;
      if (content) {
        const { text, thinking } = splitter.push(content);
        if (thinking) yield { type: "thinking_delta", content: thinking };
        if (text) yield { type: "text_delta", content: text };
      }

      const tds = delta["tool_calls"] as OAIToolDelta[] | undefined;
      if (tds) {
        for (const td of tds) {
          if (!toolAccum[td.index]) toolAccum[td.index] = { id: "", name: "", args: "" };
          if (td.id) toolAccum[td.index].id = td.id;
          if (td.function?.name) toolAccum[td.index].name += td.function.name;
          if (td.function?.arguments) toolAccum[td.index].args += td.function.arguments;
        }
      }

      const finish = choice?.["finish_reason"] as string | undefined;
      if (finish === "tool_calls") {
        yield* flushSplitter();
        const calls = flushToolCalls();
        if (calls.length > 0) yield { type: "tool_calls", toolCalls: calls };
        return;
      }
      if (finish === "stop") {
        yield* flushSplitter();
        yield { type: "done" };
        return;
      }
    }
  }
  // Stream ended without explicit [DONE]
  yield* flushSplitter();
  const calls = flushToolCalls();
  if (calls.length > 0) yield { type: "tool_calls", toolCalls: calls };
  else yield { type: "done" };
}

// ─── Unified dispatch ─────────────────────────────────────────────────────────

function resolveProvider(providerId: string) {
  return useProvidersStore.getState().providers.find((p) => p.id === providerId);
}

export async function* streamChatForModel(
  modelRef: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onThinking?: (chunk: string) => void
): AsyncGenerator<string> {
  // Held for the generator's entire lifetime: incremented on first .next()
  // (generator bodies don't execute until iteration starts), released in
  // `finally` so it fires exactly once even if the consumer stops iterating
  // early (e.g. a `for await` `break`/abort triggers this generator's
  // `.return()`, which runs pending `finally` blocks) or the stream throws.
  const release = acquireGeneration();
  try {
    const { providerId, modelName } = parseModelRef(modelRef);
    if (providerId === "ollama") {
      yield* streamChatOllama(modelName, messages, signal, onThinking);
      return;
    }
    const cfg = resolveProvider(providerId);
    if (!cfg) throw new Error(`Provider "${providerId}" not configured`);
    yield* streamChatOpenAI(cfg.baseUrl, cfg.apiKey, modelName, messages, signal, onThinking);
  } finally {
    release();
  }
}

export async function* runAgentTurnForModel(
  modelRef: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
  options?: AgentTurnOptions
): AsyncGenerator<AgentEvent> {
  // See streamChatForModel above for the acquire/release lifetime contract.
  const release = acquireGeneration();
  try {
    const { providerId, modelName } = parseModelRef(modelRef);
    if (providerId === "ollama") {
      yield* runAgentTurnOllama(modelName, messages, tools, signal, options);
      return;
    }
    const cfg = resolveProvider(providerId);
    if (!cfg) throw new Error(`Provider "${providerId}" not configured`);
    yield* runAgentTurnOpenAI(cfg.baseUrl, cfg.apiKey, modelName, messages, tools, signal);
  } finally {
    release();
  }
}
