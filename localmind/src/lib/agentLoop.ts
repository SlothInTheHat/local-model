import type { ChatMessage } from "./ollama";
import type { ToolDef, ToolCall } from "./tools";

const BASE_URL = "http://localhost:11434";

export interface AgentEvent {
  type: "text_delta" | "tool_calls" | "done" | "error";
  content?: string;       // for text_delta
  toolCalls?: ToolCall[]; // for tool_calls
  error?: string;         // for error
  /** true when tool calls were parsed from text blocks, not from the native API */
  fromText?: boolean;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface AgentTurnOptions {
  /** Ollama context window size (num_ctx). Omitted = Ollama default (2048). */
  numCtx?: number;
}

function parseArgs(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return raw;
}

function toOllamaTool(def: ToolDef) {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

/**
 * Fallback parser for models that emit tool calls as text instead of using
 * the native Ollama tool-call API.
 *
 * Priority order:
 * 1. JSON blocks with {name, arguments} format  →  any tool call
 * 2. Inline JSON objects with the same format
 * 3. Shell code blocks (```sh / ```bash / etc.)  →  run_command
 *
 * Returns the extracted ToolCalls and the text with those blocks stripped.
 */

const SHELL_LANGS = new Set([
  "sh", "bash", "shell", "zsh", "fish",
  "cmd", "bat", "batch",
  "powershell", "ps1", "pwsh",
  "pip",           // treat ```pip blocks as shell commands
]);

function extractTextToolCalls(text: string): { calls: ToolCall[]; cleanText: string } {
  const calls: ToolCall[] = [];

  // ── Pass 1: JSON blocks with {name, arguments} ────────────────────────────
  const jsonBlockRe = /```(?:json|tool_call|tool)?\s*\n([\s\S]*?)\n```/g;
  const stripped1 = text.replace(jsonBlockRe, (fullMatch, inner: string) => {
    const trimmed = inner.trim();
    if (!trimmed.startsWith("{")) return fullMatch;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const name = obj["name"] as string | undefined;
      if (typeof name !== "string" || !name) return fullMatch;
      const rawArgs = obj["arguments"] ?? obj["args"] ?? obj["parameters"] ?? {};
      calls.push({
        id: crypto.randomUUID(),
        name,
        args: parseArgs(rawArgs as Record<string, unknown> | string),
      });
      return "";
    } catch {
      return fullMatch;
    }
  });

  if (calls.length > 0) return { calls, cleanText: stripped1.trim() };

  // ── Pass 2: Inline JSON {name, arguments} objects ─────────────────────────
  const inlineRe = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|args|parameters)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  const stripped2 = text.replace(inlineRe, (fullMatch, name: string, argsStr: string) => {
    try {
      const args = JSON.parse(argsStr) as Record<string, unknown>;
      calls.push({ id: crypto.randomUUID(), name, args });
      return "";
    } catch {
      return fullMatch;
    }
  });

  if (calls.length > 0) return { calls, cleanText: stripped2.trim() };

  // ── Pass 3: Shell code blocks → run_command ───────────────────────────────
  // Match ```sh / ```bash / ```cmd / etc. blocks and convert each to a run_command call.
  const shellLangPattern = [...SHELL_LANGS].join("|");
  const shellBlockRe = new RegExp(
    "```(?:" + shellLangPattern + ")\\s*\\n([\\s\\S]*?)\\n```",
    "g"
  );
  const stripped3 = text.replace(shellBlockRe, (fullMatch, cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return fullMatch;
    // Split multi-command blocks on blank lines into separate calls
    const segments = trimmed.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      calls.push({
        id: crypto.randomUUID(),
        name: "run_command",
        args: { cmd: seg },
      });
    }
    return "";
  });

  if (calls.length > 0) return { calls, cleanText: stripped3.trim() };

  return { calls: [], cleanText: text };
}

/**
 * Core agentic loop. Sends messages to Ollama with tool definitions,
 * streams text deltas, and yields tool_calls when the model requests tools.
 *
 * Supports two tool call modes:
 * 1. Native Ollama tool-call API (message.tool_calls in the response)
 * 2. Text-based fallback: JSON code blocks in the model's text response
 *
 * The caller (App.tsx / CodeEditor) handles approval and execution.
 */
export async function* runAgentTurn(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
  options?: AgentTurnOptions
): AsyncGenerator<AgentEvent> {
  const ollamaTools = tools.map(toOllamaTool);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: ollamaTools,
        stream: true,
        ...(options?.numCtx ? { options: { num_ctx: options.numCtx } } : {}),
      }),
      signal,
    });
  } catch (err) {
    yield { type: "error", error: (err as Error).message };
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const msg = body ? `Ollama ${response.status}: ${body.slice(0, 300)}` : `Ollama returned ${response.status}`;
    yield { type: "error", error: msg };
    return;
  }
  if (!response.body) {
    yield { type: "error", error: "No response body from Ollama" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulatedToolCalls: OllamaToolCall[] = [];
  let accumulatedText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);

    for (const line of lines) {
      let json: Record<string, unknown>;
      try { json = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const msg = json["message"] as Record<string, unknown> | undefined;
      if (msg) {
        const textContent = msg["content"] as string | undefined;
        if (textContent) {
          accumulatedText += textContent;
          yield { type: "text_delta", content: textContent };
        }

        const toolCalls = msg["tool_calls"] as OllamaToolCall[] | undefined;
        if (toolCalls && toolCalls.length > 0) {
          accumulatedToolCalls.push(...toolCalls);
        }
      }

      if (json["done"]) {
        if (accumulatedToolCalls.length > 0) {
          // ── Native tool calls from the API ──────────────────────────────
          const mapped: ToolCall[] = accumulatedToolCalls.map((tc) => ({
            id: crypto.randomUUID(),
            name: tc.function.name,
            args: parseArgs(tc.function.arguments),
          }));
          yield { type: "tool_calls", toolCalls: mapped };
        } else {
          // ── Fallback: look for JSON tool call blocks in the text ────────
          const { calls, cleanText } = extractTextToolCalls(accumulatedText);
          if (calls.length > 0) {
            // Signal the caller to replace the assistant text with the clean version
            // before showing tool chips
            yield { type: "text_delta", content: `\x00CLEAN:${cleanText}` };
            yield { type: "tool_calls", toolCalls: calls, fromText: true };
          } else {
            yield { type: "done" };
          }
        }
        return;
      }
    }
  }

  // End of stream without explicit done message
  if (accumulatedToolCalls.length > 0) {
    const mapped: ToolCall[] = accumulatedToolCalls.map((tc) => ({
      id: crypto.randomUUID(),
      name: tc.function.name,
      args: parseArgs(tc.function.arguments),
    }));
    yield { type: "tool_calls", toolCalls: mapped };
  } else {
    const { calls, cleanText } = extractTextToolCalls(accumulatedText);
    if (calls.length > 0) {
      yield { type: "text_delta", content: `\x00CLEAN:${cleanText}` };
      yield { type: "tool_calls", toolCalls: calls, fromText: true };
    } else {
      yield { type: "done" };
    }
  }
}
