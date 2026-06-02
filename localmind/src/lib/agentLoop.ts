import type { ChatMessage } from "./ollama";
import type { ToolDef, ToolCall } from "./tools";

const BASE_URL = "http://localhost:11434";

export interface AgentEvent {
  type: "text_delta" | "tool_calls" | "done" | "error";
  content?: string;      // for text_delta
  toolCalls?: ToolCall[]; // for tool_calls
  error?: string;         // for error
}

interface OllamaToolCall {
  function: {
    name: string;
    // Ollama sometimes sends arguments as a JSON string rather than a parsed object
    arguments: Record<string, unknown> | string;
  };
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
 * Core agentic loop. Sends messages to Ollama with tool definitions,
 * streams text deltas, and yields tool_calls when the model requests tools.
 * The caller (App.tsx) is responsible for approval and execution.
 */
export async function* runAgentTurn(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal
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
      }),
      signal,
    });
  } catch (err) {
    const e = err as Error;
    yield { type: "error", error: e.message };
    return;
  }

  if (!response.ok) {
    yield { type: "error", error: `Ollama returned ${response.status}` };
    return;
  }

  if (!response.body) {
    yield { type: "error", error: "No response body from Ollama" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  // Accumulate tool_calls across streamed chunks
  const accumulatedToolCalls: OllamaToolCall[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);

    for (const line of lines) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Text delta
      const msg = json["message"] as Record<string, unknown> | undefined;
      if (msg) {
        const textContent = msg["content"] as string | undefined;
        if (textContent) {
          yield { type: "text_delta", content: textContent };
        }

        // Accumulate tool_calls from streamed message
        const toolCalls = msg["tool_calls"] as OllamaToolCall[] | undefined;
        if (toolCalls && toolCalls.length > 0) {
          accumulatedToolCalls.push(...toolCalls);
        }
      }

      if (json["done"]) {
        // If we have accumulated tool calls, yield them
        if (accumulatedToolCalls.length > 0) {
          const mapped: ToolCall[] = accumulatedToolCalls.map((tc) => ({
            id: crypto.randomUUID(),
            name: tc.function.name as ToolCall["name"],
            args: parseArgs(tc.function.arguments),
          }));
          yield { type: "tool_calls", toolCalls: mapped };
        } else {
          yield { type: "done" };
        }
        return;
      }
    }
  }

  // End of stream without explicit done
  if (accumulatedToolCalls.length > 0) {
    const mapped: ToolCall[] = accumulatedToolCalls.map((tc) => ({
      id: crypto.randomUUID(),
      name: tc.function.name as ToolCall["name"],
      args: parseArgs(tc.function.arguments),
    }));
    yield { type: "tool_calls", toolCalls: mapped };
  } else {
    yield { type: "done" };
  }
}
