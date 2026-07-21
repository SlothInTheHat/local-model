import type { ChatMessage } from "./ollama";
import { getOllamaBaseUrl } from "./ollama";
import type { ToolDef, ToolCall } from "./tools";

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

/**
 * Extract {name, args} from a parsed JSON object, tolerating the many shapes
 * local models emit: {name|tool|tool_name|function_name, arguments|args|
 * parameters|params|input}, and the OpenAI-style {function:{name, arguments}}.
 */
function extractCallFromObj(obj: Record<string, unknown>): ToolCall | null {
  let name = (obj["name"] ?? obj["tool"] ?? obj["tool_name"] ?? obj["function_name"]) as unknown;
  let rawArgs = obj["arguments"] ?? obj["args"] ?? obj["parameters"] ?? obj["params"] ?? obj["input"];
  const fn = obj["function"];
  if (typeof fn === "object" && fn) {
    const f = fn as Record<string, unknown>;
    if (typeof name !== "string" || !name) name = f["name"];
    if (rawArgs === undefined) rawArgs = f["arguments"] ?? f["params"];
  } else if (typeof fn === "string" && (typeof name !== "string" || !name)) {
    name = fn;
  }
  if (typeof name !== "string" || !name) return null;
  return { id: crypto.randomUUID(), name, args: parseArgs(rawArgs as Record<string, unknown> | string) };
}

/** Parse JSON, repairing the common local-model deviations: unquoted keys and single quotes. */
function lenientJsonParse(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { /* try to repair below */ }
  try {
    const fixed = s
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')   // quote bare keys
      .replace(/'((?:[^'\\]|\\.)*)'/g, '"$1"');                  // single → double quotes
    return JSON.parse(fixed) as Record<string, unknown>;
  } catch { return null; }
}

/** Find balanced top-level {...} JSON object substrings (handles unfenced tool calls). */
function findJsonObjectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { if (depth > 0) { depth--; if (depth === 0 && start !== -1) { spans.push(text.slice(start, i + 1)); start = -1; } } }
  }
  return spans;
}

function extractTextToolCalls(text: string): { calls: ToolCall[]; cleanText: string } {
  const calls: ToolCall[] = [];

  // ── Pass 1: fenced JSON blocks (```json / ```tool / bare ```) ─────────────
  const jsonBlockRe = /```(?:json|tool_call|tool)?\s*\n([\s\S]*?)\n```/g;
  const stripped1 = text.replace(jsonBlockRe, (fullMatch, inner: string) => {
    const trimmed = inner.trim();
    if (!trimmed.startsWith("{")) return fullMatch;
    try {
      const call = extractCallFromObj(JSON.parse(trimmed) as Record<string, unknown>);
      if (!call) return fullMatch;
      calls.push(call);
      return "";
    } catch {
      return fullMatch;
    }
  });

  if (calls.length > 0) return { calls, cleanText: stripped1.trim() };

  // ── Pass 2: bare (unfenced) JSON objects anywhere in the text ─────────────
  // Local models often emit {"tool":"...","params":{...}} or {"name":...} with
  // no code fence. Scan balanced-brace spans and extract any tool-call-shaped one.
  let stripped2 = text;
  for (const span of findJsonObjectSpans(text)) {
    try {
      const call = extractCallFromObj(JSON.parse(span) as Record<string, unknown>);
      if (call) {
        calls.push(call);
        stripped2 = stripped2.replace(span, "");
      }
    } catch {
      // not valid JSON — skip
    }
  }

  if (calls.length > 0) return { calls, cleanText: stripped2.trim() };

  // ── Pass 2.5: function-call syntax  tool_name({ ...args... })  ─────────────
  // Local models often "call" a tool by writing it as code, e.g.
  //   schedule_task({ name: "x", interval: "2m", command: "..." })
  // The identifier is the tool name and the object is the args (repaired for
  // unquoted keys). Unknown names still fail safely downstream (approval/error).
  const fnCallRe = /\b([a-zA-Z_][a-zA-Z0-9_]{2,40})\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
  let stripped25 = text;
  let fm: RegExpExecArray | null;
  while ((fm = fnCallRe.exec(text)) !== null) {
    const obj = lenientJsonParse(fm[2]);
    if (obj) {
      calls.push({ id: crypto.randomUUID(), name: fm[1], args: obj });
      stripped25 = stripped25.replace(fm[0], "");
    }
  }
  if (calls.length > 0) return { calls, cleanText: stripped25.trim() };

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
    response = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
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
