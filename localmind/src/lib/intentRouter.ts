import type { ChatMessage } from "./ollama";
import { streamChatForModel } from "./chatProvider";

/**
 * Routes a chat-tab message (in agent mode) between two handlers:
 * - "chat": a conversational/meta question → answer directly, no coding-loop
 *   scaffolding, no stale project-state injection (the "restricted agent").
 * - "build": a real file/project task → the full coding agent.
 *
 * Strategy: a fast deterministic heuristic catches the obvious cases with no
 * latency; only genuinely ambiguous messages fall through to a one-shot model
 * classification. On any uncertainty or failure we bias toward "build" so a
 * real coding task is never downgraded to a tool-less chat.
 */
export type Intent = "chat" | "build";

/** Imperative verbs that signal the user wants something done to the project. */
const BUILD_VERBS = /\b(add|create|make|build|implement|fix|debug|refactor|rewrite|write|edit|update|change|modify|patch|install|run|delete|remove|rename|move|generate|set up|setup|scaffold|deploy|test|commit|push)\b/i;

/** Path / code references — a strong signal the message is about files. */
const PATH_HINT = /(\.[a-z]{1,5}\b|\/|\bsrc\b|\bcomponent|\bfunction\b|\bclass\b|node_modules|package\.json)/i;

/** Question / meta openers — a strong signal the message is conversational. */
const CHAT_OPENER = /^\s*(what|what's|whats|how|who|why|when|where|which|can you|could you|do you|are you|is there|tell me|explain|describe|list|show me your|help me understand)\b/i;

/** References to LocalMind's own meta (capabilities/features/tabs/tools). */
const META_SUBJECT = /\b(your (capabilities|features|abilities|tools|tabs|functions)|capabilities|what can you do|who are you|what are you)\b/i;

/**
 * Heuristic pass. Returns an Intent when confident, or null when ambiguous
 * (caller should then fall back to the model).
 */
export function heuristicIntent(text: string): Intent | null {
  const t = text.trim();
  if (!t) return "chat";

  const hasBuildVerb = BUILD_VERBS.test(t);
  const hasPath = PATH_HINT.test(t);
  const looksMeta = META_SUBJECT.test(t);
  const looksQuestion = CHAT_OPENER.test(t) || t.endsWith("?");

  // Strong BUILD: explicit file/path reference, or a build verb without a
  // meta subject (e.g. "add a footer", "fix the navbar").
  if (hasPath) return "build";
  if (hasBuildVerb && !looksMeta) return "build";

  // Strong CHAT: meta question about the app/agent itself, or a plain
  // question with no build verb.
  if (looksMeta) return "chat";
  if (looksQuestion && !hasBuildVerb) return "chat";

  // Ambiguous — let the model decide.
  return null;
}

const SYSTEM_PROMPT = `You are an intent classifier for a coding-assistant app. Classify the user's message into exactly one category:
- BUILD: the user wants you to create, modify, debug, run, or inspect files/code in their project.
- CHAT: the user is asking a question, having a conversation, or asking about the assistant's own capabilities/features — no file or project work is required.
Reply with exactly one word: BUILD or CHAT.`;

/**
 * Classify a message's intent. Heuristic first; model fallback only when the
 * heuristic is unsure. Defaults to "build" on any model error so coding tasks
 * are never lost.
 */
export async function classifyIntent(
  text: string,
  modelRef: string,
  signal?: AbortSignal,
): Promise<Intent> {
  const quick = heuristicIntent(text);
  if (quick) return quick;

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text.slice(0, 1000) },
    ];
    let out = "";
    for await (const chunk of streamChatForModel(modelRef, messages, signal)) {
      out += chunk;
      if (out.length > 40) break; // one word is plenty; stop early
    }
    return /\bchat\b/i.test(out) && !/\bbuild\b/i.test(out) ? "chat" : "build";
  } catch {
    return "build";
  }
}
