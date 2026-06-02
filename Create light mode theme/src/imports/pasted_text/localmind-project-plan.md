# LocalMind — Offline AI Desktop App
**Project Plan v1.0**

> A local-first GUI for running, managing, and interacting with Ollama models — with frontier-feature parity.

| Platform | Model Backend | Timeline | Phases |
|----------|---------------|----------|--------|
| Tauri 2 + React/TS | Ollama REST API | ~12–16 weeks | 5 phases |

---

## Project Overview

LocalMind is a privacy-first, offline desktop application that wraps Ollama with a polished GUI. On first launch it scans the host machine's hardware (CPU, GPU VRAM, RAM) and recommends compatible models ranked by capability. It provides a chat interface with document editing, code editing, image generation via local diffusion models, and agent tool-use — mirroring frontier cloud products, entirely offline.

---

## Core Features

| Feature | Description |
|---------|-------------|
| **Hardware Scanner** | Detect GPU VRAM, RAM, CPU threads. Score and rank compatible Ollama models. One-click download. |
| **Chat Interface** | Multi-turn conversations, history, model switching mid-chat, system prompt editor, streaming output. |
| **Document Creation** | Tiptap rich-text editor with AI slash commands. Export to `.docx`, `.md`, `.pdf`. |
| **Code Editor** | Monaco editor, 50+ language syntax highlighting, inline AI completions, diff view, file open/save. |
| **Image Generation** | Local Stable Diffusion via ComfyUI API. Prompt-to-image, model selector, image gallery. |
| **Tool Use / Agents** | File system tools, local web search, calculator, sandboxed code execution. Per-chat enable/disable. |
| **Vision / Multimodal** | Drag-and-drop image attachment for LLaVA / BakLLaVA-class models in chat. |
| **Model Manager** | Browse Ollama model library, download, delete, view quantization info and benchmark scores. |

---

## Phased Roadmap

### Phase 1 — Foundation & Scaffolding `2 weeks`

- Init Tauri 2 + React + TypeScript project with Vite
- Connect to Ollama REST API (`localhost:11434`) with streaming support
- Rust command: scan CPU, RAM, GPU VRAM via `sysinfo` crate
- Model recommendation engine — score by hardware capabilities
- SQLite schema: conversations, models, settings (`sqlx`)
- GitHub Actions matrix build: Windows / macOS / Linux

### Phase 2 — Chat & Model Manager `3 weeks`

- Streaming chat UI with Markdown + code block rendering
- Conversation list, search, rename, delete
- System prompt editor per conversation
- Mid-chat model switching without losing history
- Model browser: download, delete, view quantization metadata
- Vision: image drag-and-drop for multimodal models

### Phase 3 — Document & Code Editors `3 weeks`

- Tiptap rich-text editor with AI slash commands (`/improve`, `/expand`)
- Export to `.md`, `.docx`, and `.pdf` from the document view
- Monaco editor integration with 50+ language support
- Inline code completions streamed from the active Ollama model
- Diff view for AI-suggested code edits (accept / reject hunks)
- File open/save via Tauri FS API with recent-files list

### Phase 4 — Image Generation & Tools `3 weeks`

- ComfyUI API integration for local Stable Diffusion workflows
- Image gallery with prompt and model history
- Tool-use framework: file read/write, calculator, web search
- Local web search via SearXNG or Brave Search API
- Sandboxed Python/JS code execution via subprocess isolation
- Per-chat tool toggle UI with capability indicators

### Phase 5 — Polish, Perf & Release `3 weeks`

- Onboarding wizard: hardware scan → model recommend → one-click download
- Dark / light theme toggle with system preference detection
- Virtual scrolling for long conversations (performance)
- Auto-updater integration via Tauri updater plugin
- Signed installers: `.dmg` (macOS), `.exe` (Windows), `.AppImage` (Linux)
- User documentation site (Docusaurus or static markdown)

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Desktop shell | Tauri 2 | Rust backend, tiny binary, native menus, hardware access via Rust commands |
| Frontend | React + TypeScript | Component ecosystem, strong typing, Vite for fast dev iteration |
| UI library | shadcn/ui + Tailwind | Composable accessible primitives; easy to theme and extend |
| Model backend | Ollama REST API | Local HTTP on `:11434`, streaming support, model management endpoints |
| Code editor | Monaco Editor | VS Code rendering engine, LSP support, strong React bindings |
| Rich text | Tiptap 2 | Headless ProseMirror-based editor, AI extension, export plugins |
| Image gen | ComfyUI API | Local diffusion server, workflow-based, GPU-aware scheduling |
| HW detection | `sysinfo` (Rust crate) | Cross-platform CPU / RAM / GPU enumeration from Tauri commands |
| State mgmt | Zustand | Lightweight, no boilerplate, works well with streaming responses |
| Storage | SQLite via `sqlx` | Local conversation history, settings, model metadata |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| GPU detection variance | Use `sysinfo` + `nvidia-smi` + `wgpu` fallback; let users manually override VRAM. |
| Image gen complexity | ComfyUI integration ships as an optional Phase 4 flag; vision models come first. |
| Ollama API changes | Pin to a tested Ollama version in docs; abstract all calls behind an API client module. |
| Monaco bundle size | Lazy-load the code editor view; exclude from initial bundle. |
| Cross-platform builds | Set up GitHub Actions matrix in Phase 1 before codebase grows. |
| Streaming edge cases | Test with slow/interrupted responses; implement retry logic with backoff in the Ollama client. |
