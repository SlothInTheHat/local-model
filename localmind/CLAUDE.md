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

## Architecture

### Views (`src/types/app.ts`)
`AppView` now has 15 top-level tabs (chat, code, docs, models, terminal, agents, research, study, settings, image, skills, benchmarks, compare, memory, logs) — see `APP_VIEWS` and `VIEW_DESCRIPTIONS` in `src/types/app.ts` for the current, authoritative list rather than a hardcoded count here. `App.tsx` owns view state and routes to the corresponding view component per tab (several lazy-loaded, e.g. `CodeEditor`/Monaco, `DocEditor`/Tiptap).

### Agent capabilities
The agent's self-description (tabs + tools + MCP status) is generated at runtime, not hand-written — see `src/lib/capabilityRegistry.ts` (`buildCapabilityBlock`) as the single source of truth. Tool gating (Plan-mode allowance, approval requirements) is metadata-driven via `planModeAllowed`/`requiresApproval` on each `ToolDef` in `src/lib/tools.ts`, resolved by `resolveToolPolicy` in `src/lib/agentRuntime.ts`.

### Data flow
`App.tsx` is the single orchestrator. It owns `selectedModel`, `agentMode`, `attachedImages`, and `systemPromptOpen` as local state, and wires them into every child. All Ollama API calls originate here via two paths:
1. **Normal chat** → `streamChat()` async generator (yields string tokens)
2. **Agent loop** → `runAgentTurn()` async generator (yields `AgentEvent`; pauses on `tool_calls` for user approval)

### Stores (Zustand)
| Store | Persisted | Purpose |
|-------|-----------|---------|
| `useChatStore` | ✅ localStorage (`localmind-chat`) | Conversations, messages (capped at 200/conv), `systemPrompt` per conv, available models |
| `useModelStore` | ✅ localStorage | Hardware scan results, VRAM override, pull progress |
| `useSettingsStore` | ✅ localStorage (`localmind-settings`) | Default system prompt, `agentAutoApproveReads`, theme |
| `useAgentStore` | ❌ ephemeral | `FileSystemDirectoryHandle` (non-serializable), `toolsEnabled`, `pendingToolCalls` |

### Ollama API (`src/lib/ollama.ts`)
All calls target `http://localhost:11434`. Three async generators:
- `streamChat(model, messages, signal?)` → `string` chunks via `/api/chat`
- `pullModel(name, signal?)` → `PullUpdate` progress via `/api/pull`
- `runAgentTurn(model, messages, tools, signal?)` → `AgentEvent` via `/api/chat` with Ollama `tools` field (in `src/lib/agentLoop.ts`)

### Agent / tool use (`src/lib/tools.ts`, `src/lib/agentLoop.ts`)
`runAgentTurn` streams from Ollama with a `tools` array. When the model emits `tool_calls` in the response, it yields a `{type:"tool_calls"}` event and returns — it never auto-executes. `App.tsx` surfaces `ToolCallCard` components for user approval, then calls `executeTool()` for each approved call and continues the loop via `handleContinueAgent()`.

Tools use the browser **File System Access API** — `dirHandle` in `useAgentStore` holds the user-granted `FileSystemDirectoryHandle`. Path traversal with `..` is rejected at execution time.

Tool support is model-dependent. `supportsNativeTools()` in `src/lib/modelCapabilities.ts` gates which models get the `tools` field (llama3.1/3.2, mistral-nemo, qwen2.5, command-r).

### Styling
Tailwind v4 via `@tailwindcss/vite`. The design system uses **CSS custom properties** defined in `src/index.css` — always use semantic tokens (`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`) rather than hardcoded colors or `zinc-*` classes. The `cn()` helper from `src/components/ui/utils.ts` merges Tailwind classes.

### shadcn/ui components
Primitive components live in `src/components/ui/` (button, card, badge, input, textarea, separator, scroll-area, progress). They consume the CSS variable tokens and are not auto-generated — edit them directly.

### Bundle splitting
Monaco and Tiptap are lazy-loaded via `React.lazy` in `App.tsx`. `vite.config.ts` has manual `manualChunks` that keep monaco, tiptap, docx, mathjs, radix, and markdown renderer in separate chunks. React is bundled into the main app chunk (~102 KB gzipped) by Vite 7.

### Web search proxy
`/ddg-search` in dev is proxied to `https://api.duckduckgo.com` via Vite to avoid CORS. In the packaged Tauri app, the native webview fetches directly.
