# LocalMind

**A private, local-first AI assistant for your desktop.**

LocalMind is a Tauri + React desktop app that wraps [Ollama](https://ollama.com) in a full agentic assistant — chat, a coding agent with its own editor, deep web research, per-class knowledge bases, scheduled automation, and a large set of tools that let it actually *act* on your computer (move files, download and edit images, merge PDFs, control windows, and more), all running against models on your own machine.

## Why

Most AI assistants are either cloud-hosted (your data leaves your machine) or narrowly scoped to one job (just chat, just code). LocalMind is built to be a general-purpose everyday assistant that happens to be entirely local:

- Every model call goes to Ollama on `localhost` — no cloud round-trip required.
- File and shell tools are confined to folders you explicitly open or enable (Settings → Privacy & Security lists exactly what's reachable and lets you turn well-known folders like Downloads or Desktop on/off).
- The only outbound network calls are ones you can see: `web_search`/`web_fetch`/`download_file`, or an MCP server you've deliberately connected yourself.

## Features

### Tabs

| Tab | What it does |
|---|---|
| **Chat** | Conversational chat with streaming responses, per-conversation system prompts, image attachments, and optional agent/tool mode. |
| **Code** | Monaco editor + file tree + its own coding agent (Plan/Build modes, todos, checkpoints). |
| **Docs** | Rich-text document editor with AI slash commands. |
| **Models** | Browse, download, and manage local Ollama models. |
| **Terminal** | An embedded shell, confined to the open workspace. |
| **Agents** | Dispatch and monitor parallel one-off subagent tasks. |
| **Research** | Deep, multi-step web research with citations. |
| **Study** | Per-class knowledge bases built from your own documents, with a concept graph and cited retrieval. |
| **Settings** | Workspace, hardware, model providers, MCP servers, privacy/security controls, feature-idea steering. |
| **Image** | Canvas image editor with an AI chat side panel. |
| **Skills** | Browse/manage the agent's saved, reusable skills. |
| **Benchmarks** | Run and score benchmark tasks against your models. |
| **Compare** | Side-by-side model comparison on the same prompt. |
| **Memory** | Global, cross-project semantic memory — follows you between workspaces. |
| **Logs** | History of agent tool calls across chat, Code tab, and unattended runs. |
| **Workflows** | Chat-created automations — run on demand or on a schedule. |
| **History** | Every agent-made file change is auto-committed to a shadow git repo; browse diffs and restore anything. |

### Agent tools

With a tool-calling model selected, the agent doesn't just describe what to do — it does it. The tool set spans:

- **Files**: read/write/patch/move/copy/rename/delete, recursive search, zip/unzip — reaching beyond the open workspace into any folder you've enabled (Downloads, Desktop, Documents, Pictures, Home).
- **Web**: search, fetch page text, and binary downloads (images, PDFs, archives) straight to disk.
- **Media**: on-device background removal, image resize/format conversion.
- **Documents**: PDF merge and text extraction.
- **OS control**: open/close/minimize windows, list/kill processes, disk usage, empty recycle bin, volume, screenshots with OCR, printing, text-to-speech.
- **Automation**: scheduled/recurring jobs and reminders, saved workflows, parallel subagents — all with OS notifications when something finishes.
- **Integrations**: connect external services (Gmail, Google Drive/Calendar, Canvas, browser control) via [MCP](https://modelcontextprotocol.io) servers in Settings.

Every mutating or externally-visible tool call is gated by an approval dialog (or blocked outright in read-only Plan mode) — nothing runs unattended without you having agreed to the shape of what it can do.

### Always-on infrastructure

System tray with close-to-tray, autostart, a global hotkey overlay, OS notifications, offline voice dictation in / text-to-speech out, and a workspace switcher that remembers recent projects.

## Prerequisites

- **[Ollama](https://ollama.com)** — required. Every model call (chat, code, vision, embeddings) goes through it; install it and make sure it's running.
- **Node.js** ([nodejs.org](https://nodejs.org)) — required to build from source; also needed at runtime only if you connect an MCP integration (Gmail/Drive/Calendar/Canvas/browser), which are spawned via `npx`.
- **Rust** ([rustup.rs](https://rustup.rs)) — required to build from source (Tauri compiles a native backend).

## Getting started

### Download

Pre-built Windows installers are attached to the [latest release](https://github.com/SlothInTheHat/local-model/releases/latest) — grab either the `.msi` or the `-setup.exe` (NSIS), either works. They're unsigned, so Windows SmartScreen will warn on first run ("More info" → "Run anyway"). [Ollama](#prerequisites) still needs to be installed separately either way.

### Build from source

```bash
git clone https://github.com/SlothInTheHat/local-model.git
cd local-model/localmind
npm install

npm run tauri dev      # run in dev mode
npm run tauri build    # produce a distributable installer
```

`tauri build` outputs installers under `src-tauri/target/release/bundle/` (e.g. `msi/` and `nsis/` on Windows).

## Project structure

- **`localmind/`** — the Tauri + React desktop app (the main project).
- **`localmind/phone-agent/`** — a standalone Telegram bot companion (Python): text messages run a scoped subset of the same agent tools, and videos get transcribed, researched, and mined into skills that feed back into the desktop app's skill registry.

See `localmind/CLAUDE.md` for architecture notes and `localmind/FEATURES.md` for a living, detailed feature/tool inventory kept in sync with the code.

## License

No license has been published for this repository yet — until one is added, all rights are reserved by the author.
