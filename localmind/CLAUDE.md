# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend development (no Rust required)
npm run dev          # Vite dev server at localhost:1420

# Type-check without emitting
npx tsc --noEmit

# Production build
npm run build        # tsc + vite build

# Full desktop app (requires Rust — install from rustup.rs first)
npm run tauri dev
npm run tauri build
```

> Rust 1.96.0 is installed. Use `npm run tauri dev` or `npm run tauri build` for the full desktop app.

## Testing

```bash
node tests/confinement.test.mjs   # JS-side path-classification assertions for create_folder etc.
cd src-tauri && cargo test --lib  # Rust-side workspace-confinement unit tests (path containment, `&&` command translation)
```

Most `fs_*`/`run_command` confinement behavior can only be exercised inside the running app (the native `__TAURI__` bridge isn't reachable from plain Node) — `tests/confinement.test.mjs` documents the manual refusal cases to verify inside `npm run tauri dev`.

## Architecture

### Views (`src/types/app.ts`)
`AppView` now has 15 top-level tabs (chat, code, docs, models, terminal, agents, research, study, settings, image, skills, benchmarks, compare, memory, logs) — see `APP_VIEWS` and `VIEW_DESCRIPTIONS` in `src/types/app.ts` for the current, authoritative list rather than a hardcoded count here. `App.tsx` owns view state and routes to the corresponding view component per tab (several lazy-loaded, e.g. `CodeEditor`/Monaco, `DocEditor`/Tiptap).

### Agent capabilities
The agent's self-description (tabs + tools + MCP status) is generated at runtime, not hand-written — see `src/lib/capabilityRegistry.ts` (`buildCapabilityBlock`) as the single source of truth. Tool gating (Plan-mode allowance, approval requirements) is metadata-driven via `planModeAllowed`/`requiresApproval` on each `ToolDef` in `src/lib/tools.ts`, resolved by `resolveToolPolicy` in `src/lib/agentRuntime.ts`.

### Data flow
`App.tsx` is the single orchestrator. It owns `selectedModel`, `agentMode`, `attachedImages`, and `systemPromptOpen` as local state, and wires them into every child. All Ollama API calls originate here via two paths:
1. **Normal chat** → `streamChat()` async generator (yields string tokens)
2. **Agent loop** → `runAgentSession()` (`src/lib/agentRuntime.ts`) — the actual multi-round orchestrator (see below); it internally drives per-round streaming via `agentLoop.ts`'s lower-level `runAgentTurn()` primitive, which callers don't invoke directly.

### Stores (Zustand)
| Store | Persisted | Purpose |
|-------|-----------|---------|
| `useChatStore` | ✅ localStorage (`localmind-chat`) | Conversations, messages (capped at 200/conv), `systemPrompt` per conv, available models |
| `useModelStore` | ✅ localStorage | Hardware scan results, VRAM override, pull progress |
| `useSettingsStore` | ✅ localStorage (`localmind-settings`) | Default system prompt, `agentAutoApproveReads`, theme |
| `useAgentStore` | ❌ ephemeral | `FileSystemDirectoryHandle` (non-serializable), `toolsEnabled`, `pendingToolCalls` |

### Ollama API (`src/lib/ollama.ts`)
All calls target `http://localhost:11434`. Key async generators:
- `streamChat(model, messages, signal?)` → `string` chunks via `/api/chat`
- `pullModel(name, signal?)` → `PullUpdate` progress via `/api/pull`
- `runAgentTurn(model, messages, tools, signal?)` (`src/lib/agentLoop.ts`) → `AgentEvent` via `/api/chat` with Ollama's `tools` field — one round of streaming + tool-call detection, called internally by `runAgentSession`, not by UI code directly.

### Agent runtime (`src/lib/agentRuntime.ts` — `runAgentSession`)
The real entry point for tool-using sessions (Chat agent mode, Code tab, headless/scheduled runs). A round loop (bounded by `maxRounds`/`DEFAULT_MAX_ROUNDS`) that, each round:
1. Rebuilds a `RuntimeState`-derived "Current state" block (todos read fresh from `.localmind/todos.json`, file tree, project/global memory, and — since the structured-resource-tracking work — a "Resources acquired this session" list and a late-recency "Recent errors" block, both populated mechanically from `ToolResult.resource`/`.error`, never LLM-generated).
2. Retrieves a per-round candidate tool set (see below) keyed on the current objective — the in-progress/pending todo's text plus the most recent acquired resource, not the original request text pinned for the whole session.
3. Streams one round via `runAgentTurn`, executes approved tool calls, updates `RuntimeState`, and loops.
`capabilityDenialGuard` appends a high-recency, explicitly-named list of available-but-possibly-refused tools at the very end of the round's system prompt — small local models have been observed hallucinating "I can't do that" for tools that were actually retrieved and available; end-of-prompt recency measurably fixes this more reliably than mid-prompt wording.

### Tool retrieval (`src/lib/toolFilter.ts`, `src/lib/toolBm25.ts`)
~90 built-in tools (`TOOL_DEFINITIONS` in `src/lib/tools.ts`) are too many to hand a small local model every round. Built-ins get a **soft rank+cap**: in-process BM25 (`toolBm25.ts`, no SQLite/network) scores each round's objective string against tool descriptions/aliases, capped at the top ~25, with a protected core tier (`read_file`, `todo_write`, etc., always included) and a recency pin (last round's called tools stay eligible). Embeddings (via Ollama) are a conditional fallback only when BM25 is ambiguous — deliberately not a per-round default, to avoid competing with the primary model for the same local hardware. External/MCP tools keep a separate, unchanged **hard gate** (`filterToolsByRelevance`) requiring them to out-score the best built-in or match a named service. Retrieval is memoized per-round (`RuntimeState.lastRetrievalObjective/Result`) so it only re-runs when the objective actually changes, not every round.

### Agent / tool use (`src/lib/tools.ts`)
Tools use the browser **File System Access API** — `dirHandle` in `useAgentStore` holds the user-granted `FileSystemDirectoryHandle` — plus native `fs_*`/`run_command` Tauri commands confined server-side (Rust) to registered workspace roots. Path traversal with `..` is rejected at execution time on both sides. `ToolResult` carries an optional structured `resource` field (`{kind, path?, url?, id?, label}`) for tools that produce a durable, chainable artifact (downloads, writes, image conversions, rendered plots/tables/canvases) — populated directly from data each handler already computes, feeding the agent-runtime resource tracking above.

Tool gating (Plan-mode allowance, approval requirements) is metadata-driven via `planModeAllowed`/`requiresApproval` on each `ToolDef`, resolved by `resolveToolPolicy` in `agentRuntime.ts`. Tool support in non-agent chat mode is model-dependent — `supportsNativeTools()` in `src/lib/modelCapabilities.ts` gates which models get the `tools` field (llama3.1/3.2, mistral-nemo, qwen2.5, command-r); agent mode itself works with any tool-calling model.

### Model roles (`src/lib/modelRoles.ts`)
Optional, pinned, off-by-default secondary models can participate for specific jobs — `router` (tool-selection help for weak primaries), `vision`, `embed`, `digest`, `knowledge` — each resolved via `resolveRole(name)` and falling back to no-op (never auto-substituted) when unconfigured.

### MCP integrations (`src/lib/mcp.ts`, `mcpPresets.ts`, `mcpAutoConnect.ts`)
External tool servers (Gmail, Drive, Calendar, Canvas, browser control, etc.) are deliberately curated to a handful of vetted presets rather than open server discovery, configured in Settings.

### Shadow git history (`src/lib/shadowGit.ts`)
Every mutating tool call is auto-committed to a separate shadow git repo (`commitAfterToolCall`) so file changes from agent runs are diffable/restorable from the History tab, independent of the user's own git repo (if any).

### Backend (`src-tauri/src/`)
Rust commands behind the Tauri IPC boundary: `os_tools.rs` (window/process control, disk usage, screenshots+OCR, clipboard), `pdf.rs` (merge/text-extract), `transcribe.rs`/`piper.rs` (offline video transcription, TTS — bundled via PyInstaller in packaged builds), `mcp.rs` (MCP server spawning), `git_shadow.rs`, `db.rs` (SQLite), `credential_store.rs`, `ui_automation.rs`. Workspace confinement (`lib.rs`) is enforced here, not just in the frontend: `fs_*` commands and `run_command`'s cwd are refused outside roots registered via `register_workspace_root`; `run_command`'s shell itself is *not* sandboxed beyond that (documented limitation — gated by the UI approval dialog instead).

### Companion: phone-agent
`phone-agent/` (Python, separate `requirements.txt`) is a standalone Telegram bot — not part of the npm/Tauri build. See `phone-agent/README.md` for its own setup.

### Styling
Tailwind v4 via `@tailwindcss/vite`. The design system uses **CSS custom properties** defined in `src/index.css` — always use semantic tokens (`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`) rather than hardcoded colors or `zinc-*` classes. The `cn()` helper from `src/components/ui/utils.ts` merges Tailwind classes.

### shadcn/ui components
Primitive components live in `src/components/ui/` (button, card, badge, input, textarea, separator, scroll-area, progress). They consume the CSS variable tokens and are not auto-generated — edit them directly.

### Bundle splitting
Monaco and Tiptap are lazy-loaded via `React.lazy` in `App.tsx`. `vite.config.ts` has manual `manualChunks` that keep monaco, tiptap, docx, mathjs, radix, and markdown renderer in separate chunks. React is bundled into the main app chunk (~102 KB gzipped) by Vite 7.

### Web search proxy
`/ddg-search` in dev is proxied to `https://api.duckduckgo.com` via Vite to avoid CORS. In the packaged Tauri app, the native webview fetches directly.
