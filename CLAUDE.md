# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This repo root is a thin wrapper — the actual product is in `localmind/`:

- **`localmind/`** — the Tauri 2 + React/TS desktop app (LocalMind). This is where almost all work happens. It has its own `localmind/CLAUDE.md` with detailed architecture notes and `localmind/FEATURES.md` with a living feature/tool inventory — read both before making non-trivial changes there.
- **`localmind/phone-agent/`** — a standalone Python Telegram bot companion (separate `requirements.txt`, not part of the npm/Tauri build). Text messages run a scoped subset of the same agent tools; videos get transcribed, researched, and mined into skills that feed back into the desktop app's skill registry.
- **`designs/`** — an unrelated scratch project (`figma-make-app`, per its own `designs/CLAUDE.md`/`AGENTS.md`): a standalone Vite+Tailwind app used for Figma Make mockups. Not part of LocalMind's build or runtime — don't assume changes there affect the desktop app.
- **`docs/`** — README screenshots only.
- Root-level `LocalMind_*.md` and `notes.md` are early planning documents, not authoritative — the current state of the product is the code plus `localmind/README.md`/`localmind/FEATURES.md`.

## Commands

All commands run from `localmind/`, not the repo root:

```bash
cd localmind
npm install

npm run dev           # Vite-only dev server (frontend, no Rust needed)
npx tsc --noEmit       # type-check
npm run build          # tsc + vite build

npm run tauri dev      # full desktop app (requires Rust — rustup.rs)
npm run tauri build    # produce a distributable installer (msi/nsis under src-tauri/target/release/bundle/)

node tests/confinement.test.mjs   # JS-side workspace-confinement assertions
cd src-tauri && cargo test --lib # Rust-side path-containment/confinement unit tests
```

There is no lint script configured. See `localmind/CLAUDE.md` for architecture (agent runtime, tool system, stores, styling) and command details.

## What LocalMind is

A private, local-first AI desktop assistant wrapping [Ollama](https://ollama.com): chat, a coding agent with its own editor, deep web research, per-class knowledge bases, scheduled automation, and a large tool set that lets the agent act on the user's machine (files, images, PDFs, windows/processes, etc.), confined to folders the user explicitly opens or enables. All model calls go to Ollama on `localhost`; the only other outbound calls are explicit tool calls (`web_search`/`web_fetch`/`download_file`) or user-configured MCP servers.
