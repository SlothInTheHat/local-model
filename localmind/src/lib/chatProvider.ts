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

// ─── OpenAI-compatible streaming chat ────────────────────────────────────────

export async function* streamChatOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal
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
    body: JSON.stringify({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`${res.status}: ${body}`);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

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
        const content = delta?.["content"] as string | undefined;
        if (content) yield content;
      } catch { /* skip */ }
    }
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
    return { role: m.role, content: m.content };
  });

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: oaiMessages, tools: oaiTools, stream: true }),
      signal,
    });
  } catch (err) {
    yield { type: "error", error: (err as Error).message };
    return;
  }

  if (!res.ok) {
    yield { type: "error", error: `Provider error ${res.status}` };
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

  const flushToolCalls = (): ToolCall[] =>
    Object.values(toolAccum).map((c) => ({
      id: c.id || crypto.randomUUID(),
      name: c.name,
      args: (() => { try { return JSON.parse(c.args) as Record<string, unknown>; } catch { return {}; } })(),
    }));

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

      const content = delta["content"] as string | undefined;
      if (content) yield { type: "text_delta", content };

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
        const calls = flushToolCalls();
        if (calls.length > 0) yield { type: "tool_calls", toolCalls: calls };
        return;
      }
      if (finish === "stop") {
        yield { type: "done" };
        return;
      }
    }
  }
  // Stream ended without explicit [DONE]
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
  signal?: AbortSignal
): AsyncGenerator<string> {
  const { providerId, modelName } = parseModelRef(modelRef);
  if (providerId === "ollama") {
    yield* streamChatOllama(modelName, messages, signal);
    return;
  }
  const cfg = resolveProvider(providerId);
  if (!cfg) throw new Error(`Provider "${providerId}" not configured`);
  yield* streamChatOpenAI(cfg.baseUrl, cfg.apiKey, modelName, messages, signal);
}

export async function* runAgentTurnForModel(
  modelRef: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
  options?: AgentTurnOptions
): AsyncGenerator<AgentEvent> {
  const { providerId, modelName } = parseModelRef(modelRef);
  if (providerId === "ollama") {
    yield* runAgentTurnOllama(modelName, messages, tools, signal, options);
    return;
  }
  const cfg = resolveProvider(providerId);
  if (!cfg) throw new Error(`Provider "${providerId}" not configured`);
  yield* runAgentTurnOpenAI(cfg.baseUrl, cfg.apiKey, modelName, messages, tools, signal);
}
