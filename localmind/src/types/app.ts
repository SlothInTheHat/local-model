export type AppView = "chat" | "code" | "docs" | "models" | "terminal" | "agents" | "research" | "study" | "settings" | "image" | "skills" | "benchmarks" | "compare" | "memory" | "logs";

/** All top-level UI tabs/views, used for switch_view / send_task_to_tab validation and prompt rendering. */
export const APP_VIEWS: AppView[] = [
  "chat", "code", "docs", "models", "terminal", "agents", "research",
  "study", "settings", "image", "skills", "benchmarks", "compare", "memory", "logs",
];

/**
 * Adaptive island width per view (Nucleus floating-island shell). "narrow"
 * views are conversational/list-shaped and morph the island to
 * `min(580px, calc(100vw - 24px))`; "wide" views need room for multi-pane
 * layouts (file trees, tables, terminals) and morph to
 * `min(1400px, calc(100vw - 24px))`. Kept next to APP_VIEWS so a new tab
 * can't be added without an explicit width decision.
 */
export const VIEW_WIDTH: Record<AppView, "narrow" | "wide"> = {
  chat: "narrow",
  memory: "narrow",
  research: "narrow",
  study: "wide",
  skills: "narrow",
  agents: "narrow",
  // Settings is the densest screen in the app (workspace, hardware, model,
  // providers, MCP, desktop integration, scheduled jobs, feature proposals);
  // its forms and two-column rows clip at the narrow width.
  settings: "wide",
  code: "wide",
  compare: "wide",
  benchmarks: "wide",
  terminal: "wide",
  logs: "wide",
  image: "wide",
  docs: "wide",
  models: "wide",
};

/**
 * One-line description of each tab. Single source of truth for the "About
 * LocalMind" tab list rendered into system prompts (see capabilityRegistry.ts).
 */
export const VIEW_DESCRIPTIONS: Record<AppView, string> = {
  chat: "conversational chat, optional agent tools",
  code: "Monaco editor + file tree + this agent loop",
  docs: "Tiptap document editor with AI slash commands",
  models: "browse/download Ollama models",
  terminal: "shell terminal",
  agents: "subagent manager (parallel one-off agent tasks)",
  research: "deep research mode (multi-step web research)",
  study: "knowledge hub — per-class document knowledge bases with cited search",
  settings: "app settings (incl. MCP servers + feature-idea steering)",
  image: "image editor with AI chat panel",
  skills: "skill registry browser",
  benchmarks: "model benchmark runner",
  compare: "side-by-side model comparison",
  memory:
    "global cross-project memory browser (semantic search over notes saved with save_global_memory or from this tab — shared by every project, unlike per-project .localmind/memory.md)",
  logs: "agent session logs",
};
