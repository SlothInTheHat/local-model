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

export interface RunningModel {
  name: string;
  /** Total size of the loaded model, in bytes. */
  size: number;
  /** How much of `size` is resident in GPU VRAM, in bytes. 0 means fully on CPU. */
  size_vram: number;
}

/** GET /api/ps — models currently loaded in memory (empty if nothing has run
 *  recently). Per-model size_vram vs size is Ollama's own signal for whether
 *  that model is running on GPU, partially offloaded, or CPU-only. */
export async function listRunningModels(): Promise<RunningModel[]> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/ps`);
  if (!res.ok) throw new Error(`Ollama not reachable: ${res.status}`);
  const data = await res.json();
  return data.models ?? [];
}

/**
 * Forces Ollama to load `model` into memory with a minimal (1-token)
 * generation, so a listRunningModels() call right after reflects it
 * immediately — /api/ps is otherwise empty whenever nothing has generated
 * recently, which is most of the time between actual chat messages. Used by
 * the Models tab's "Check GPU now" button so GPU-usage status doesn't depend
 * on the user happening to be mid-conversation.
 */
export async function probeModelLoad(model: string): Promise<void> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "hi", stream: false, options: { num_predict: 1 } }),
  });
  if (!res.ok) throw new Error(`Ollama not reachable: ${res.status}`);
  await res.json(); // drain the body; the generated text itself is irrelevant
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

/**
 * How long a streaming request may produce NOTHING before we declare the
 * server wedged.
 *
 * Ollama can enter a zombie state: the process is alive, the port accepts
 * connections, `/api/ps` still lists the model in VRAM — but inference never
 * completes and the HTTP request simply never returns. Observed directly:
 * `say hi` to an already-loaded 7B returned nothing in 45s (HTTP 000). With no
 * client-side timeout, a caller waits forever. The consequences cascade: an
 * unattended task sits in "running" indefinitely, and because the request
 * never settles, `finally { release() }` never runs and the single-flight
 * generation gate is held forever — silently stopping the scheduler and task
 * queue too.
 *
 * 180s is deliberately generous: it must not fire during a legitimate cold
 * model load, which can take a minute or more on CPU. The goal isn't a tight
 * bound, it's converting "hangs until the app is restarted" into "fails with
 * an actionable message."
 */
export const STREAM_STALL_TIMEOUT_MS = 180_000;

/**
 * Wraps an optional caller signal with an inactivity watchdog. Call `bump()`
 * whenever progress is made (headers received, a chunk read); if `ms` elapses
 * with no bump, the returned signal aborts.
 *
 * Distinguishes its own timeout from a caller-initiated abort via
 * `isStalled()`, so a user pressing Stop doesn't get reported as a server
 * hang.
 */
export function createStallWatchdog(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);
  if (signal?.aborted) controller.abort();

  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, ms);
  };
  bump();

  return {
    signal: controller.signal,
    bump,
    isStalled: () => stalled,
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    },
  };
}

/** Error thrown when a stream produced nothing for STREAM_STALL_TIMEOUT_MS. */
export function stallError(where: string): Error {
  return new Error(
    `${where} stopped responding (no data for ${Math.round(STREAM_STALL_TIMEOUT_MS / 1000)}s). ` +
      "Ollama can wedge with the port still open and the model still loaded — " +
      "restarting Ollama usually clears it.",
  );
}

export async function* streamChat(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<string> {
  const watchdog = createStallWatchdog(signal, STREAM_STALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: watchdog.signal,
    });
    watchdog.bump();

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
      watchdog.bump(); // progress — restart the inactivity clock

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
  } catch (err) {
    // Only translate OUR abort into a stall error — a caller-initiated abort
    // (user pressed Stop) must keep propagating as an abort, not be
    // misreported as a wedged server.
    if (watchdog.isStalled()) throw stallError("Ollama");
    throw err;
  } finally {
    watchdog.dispose();
  }
}
