import { DEFAULT_OLLAMA_BASE_URL, useSettingsStore } from "../store/settings";

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  images?: string[];
  // Used when role === "assistant" and the model issued tool calls
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

/** Current configured Ollama base URL (no trailing slash), reading live from settings. */
export function getOllamaBaseUrl(): string {
  const url = useSettingsStore.getState().ollamaBaseUrl?.trim();
  return (url ? url : DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
}

export async function listModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/tags`);
  if (!res.ok) throw new Error(`Ollama not reachable: ${res.status}`);
  const data = await res.json();
  return data.models ?? [];
}

export interface PullUpdate {
  status: string;
  percent: number; // 0-100; 0 when status has no progress info
  done?: boolean;  // true only on the final "success" message
}

export async function* pullModel(
  name: string,
  signal?: AbortSignal
): AsyncGenerator<PullUpdate> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal,
  });

  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);
    for (const line of lines) {
      let json: Record<string, unknown>;
      try { json = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (json["error"]) throw new Error(String(json["error"]));
      const percent =
        (json["total"] as number) > 0
          ? Math.round(((json["completed"] as number) / (json["total"] as number)) * 100)
          : 0;
      const status = (json["status"] as string) ?? "";
      const isDone = status === "success";
      yield { status, percent, done: isDone };
      if (isDone) return;
    }
  }
}

export async function deleteModel(name: string): Promise<void> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function* streamChat(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body ? `Ollama ${res.status}: ${body.slice(0, 300)}` : `Ollama returned ${res.status}`);
  }
  if (!res.body) throw new Error("No response body from Ollama");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.message?.content) yield json.message.content;
        if (json.done) return;
      } catch {
        // skip malformed lines
      }
    }
  }
}
