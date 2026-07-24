/**
 * Background logger for coding agent sessions.
 * Stores every tool call, result, and text response in IndexedDB.
 * Sessions can be exported as a structured analysis prompt for Claude.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCallEvent {
  type: "tool_call";
  name: string;
  args: Record<string, unknown>;
}
export interface ToolResultEvent {
  type: "tool_result";
  name: string;
  output: string;
  error?: string;
  durationMs: number;
}
export interface AgentTextEvent {
  type: "agent_text";
  content: string;
}
export interface RoundEvent {
  type: "round";
  round: number;
}

export type LogEvent = ToolCallEvent | ToolResultEvent | AgentTextEvent | RoundEvent;

export interface LoggedEvent {
  timestamp: number;
  data: LogEvent;
}

export interface AgentSession {
  id: string;
  startTime: number;
  endTime?: number;
  prompt: string;
  model: string;
  workspace?: string;
  events: LoggedEvent[];
  completed: boolean;
  rounds: number;
  /** Groups multiple per-message sessions under one parent conversation in
   *  the Logs tab (AgentLogs.tsx) — absent for pre-migration records, which
   *  just render as their own single-session group. */
  conversationId?: string;
}

// ─── IndexedDB storage ────────────────────────────────────────────────────────

const DB_NAME = "localmind-agent-logs";
const STORE = "sessions";
const MAX_SESSIONS = 100;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeSession(session: AgentSession): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllSessions(): Promise<AgentSession[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const sessions = (req.result as AgentSession[]).sort(
        (a, b) => b.startTime - a.startTime
      );
      resolve(sessions);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function pruneOldSessions(): Promise<void> {
  const all = await getAllSessions();
  if (all.length <= MAX_SESSIONS) return;
  const toDelete = all.slice(MAX_SESSIONS);
  for (const s of toDelete) await deleteSession(s.id);
}

// ─── In-memory buffer (flushed on each event) ────────────────────────────────

const activeSessions = new Map<string, AgentSession>();

// ─── Public API ───────────────────────────────────────────────────────────────

export function startSession(prompt: string, model: string, workspace?: string, conversationId?: string): string {
  const id = crypto.randomUUID();
  const session: AgentSession = {
    id,
    startTime: Date.now(),
    prompt,
    model,
    workspace,
    events: [],
    completed: false,
    rounds: 0,
    conversationId,
  };
  activeSessions.set(id, session);
  void writeSession(session);
  void pruneOldSessions();
  return id;
}

function appendEvent(sessionId: string, data: LogEvent): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  session.events.push({ timestamp: Date.now(), data });
  if (data.type === "round") session.rounds = data.round;
  void writeSession(session);
}

export function logRound(sessionId: string, round: number): void {
  appendEvent(sessionId, { type: "round", round });
}

export function logToolCall(sessionId: string, name: string, args: Record<string, unknown>): void {
  appendEvent(sessionId, { type: "tool_call", name, args });
}

export function logToolResult(
  sessionId: string,
  name: string,
  output: string,
  error: string | undefined,
  durationMs: number
): void {
  appendEvent(sessionId, { type: "tool_result", name, output: output.slice(0, 2000), error, durationMs });
}

export function logAgentText(sessionId: string, content: string): void {
  // Coalesce consecutive agent_text events
  const session = activeSessions.get(sessionId);
  if (!session) return;
  const last = session.events[session.events.length - 1];
  if (last?.data.type === "agent_text") {
    (last.data as AgentTextEvent).content += content;
    void writeSession(session);
  } else {
    appendEvent(sessionId, { type: "agent_text", content });
  }
}

export function endSession(sessionId: string, completed: boolean): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  session.endTime = Date.now();
  session.completed = completed;
  void writeSession(session);
  activeSessions.delete(sessionId);
}

// ─── Analysis export ──────────────────────────────────────────────────────────

export function formatSessionForAnalysis(session: AgentSession): string {
  const dur = session.endTime
    ? `${Math.round((session.endTime - session.startTime) / 1000)}s`
    : "incomplete";
  const lines: string[] = [
    `# Agent Session Analysis`,
    ``,
    `**Model:** ${session.model}`,
    `**Workspace:** ${session.workspace ?? "none"}`,
    `**Duration:** ${dur}`,
    `**Rounds:** ${session.rounds}`,
    `**Completed:** ${session.completed ? "yes" : "no"}`,
    ``,
    `## Initial Prompt`,
    session.prompt,
    ``,
    `## Event Trace`,
  ];

  let currentRound = 0;
  let toolCallStart = 0;

  for (const ev of session.events) {
    const d = ev.data;
    if (d.type === "round") {
      currentRound = d.round;
      lines.push(``, `### Round ${currentRound}`);
    } else if (d.type === "agent_text" && d.content.trim()) {
      lines.push(`**Agent:** ${d.content.trim().slice(0, 500)}`);
    } else if (d.type === "tool_call") {
      toolCallStart = ev.timestamp;
      const argSummary = Object.entries(d.args)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`)
        .join(", ");
      lines.push(`- **CALL** \`${d.name}(${argSummary})\``);
    } else if (d.type === "tool_result") {
      const elapsed = ev.timestamp - toolCallStart;
      if (d.error) {
        lines.push(`  → **ERROR** [${elapsed}ms]: ${d.error}`);
        if (d.output) lines.push(`  → output: ${d.output.slice(0, 200)}`);
      } else {
        const preview = d.output.slice(0, 200).replace(/\n/g, "↵");
        lines.push(`  → **OK** [${elapsed}ms]: ${preview}${d.output.length > 200 ? "…" : ""}`);
      }
    }
  }

  lines.push(
    ``,
    `---`,
    ``,
    `## Analysis Request`,
    ``,
    `Please analyze this agent session and identify:`,
    `1. **Inefficiencies** — unnecessary or redundant tool calls (e.g., reading the same file twice, searching when it already has the info)`,
    `2. **Missed reads** — files the agent modified without reading first, or should have read for context`,
    `3. **Error handling gaps** — tool failures the agent ignored or handled poorly`,
    `4. **Prompt compliance issues** — places where the agent didn't follow its system instructions`,
    `5. **System prompt improvements** — specific wording changes that would fix the issues you found`,
    `6. **Overall assessment** — did the agent solve the task effectively? What was the main bottleneck?`,
  );

  return lines.join("\n");
}
