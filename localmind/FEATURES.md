# LocalMind — Current Features

This is a living reference of what LocalMind can do *today*. It exists so
both you and the agent can answer "does this already exist?" without
guessing. **Whenever a feature, tool, view, or tab is added, removed, or
materially changed, update this file as part of that change.**

## Views / tabs

| Tab | What it does |
|-----|--------------|
| **chat** | Multi-turn conversation, streaming responses, per-conversation system prompt, image attachments, TTS, conversation search/history sidebar, optional agent mode (tool-using). |
| **code** | Monaco editor + file tree + coding agent (Plan/Build modes, todos, checkpoints/backups, project memory, skill matching). |
| **docs** | Tiptap rich-text editor with AI slash commands; export to .docx/.md/.pdf. |
| **models** | Browse/download/delete Ollama models, hardware-aware recommendations, quantization info. |
| **terminal** | Embedded shell terminal. |
| **agents** | Subagent manager — dispatch parallel one-off agent tasks. |
| **research** | Deep research mode — multi-step web research with citations. |
| **study** | Study mode — topic Q&A with a branching exploration tree. |
| **settings** | App settings: default system prompt, agent auto-approve, theme, feature-idea steering, MCP servers. |
| **image** | Image editor with an AI chat side panel. |
| **skills** | Skill registry browser — view/manage `.localmind/skills/*.md`. |
| **benchmarks** | Run benchmark tasks against models and compare scores. |
| **compare** | Side-by-side model comparison on the same prompt. |
| **memory** | Global, cross-project memory — semantic search (via `nomic-embed-text` embeddings) over notes added here or by the agent (`save_global_memory`), shared by every project. Distinct from per-project memory (`.localmind/memory.md`, see Agent behaviors). |
| **logs** | Agent session logs / history of tool calls. |

## Agent tools

- **Files**: read_file, write_file, patch_file, apply_patch, delete_file, list_directory, grep_files, find_files, create_folder
- **Shell**: run_command, install_deps
- **Git**: git_status, git_diff, git_log, git_add, git_commit
- **Web**: web_search, web_fetch
- **State**: todo_write, update_project_memory, save_global_memory, list_skills, save_skill, get_system_info
- **App control**: switch_model (change the active Ollama model app-wide), switch_view (navigate the user's UI to another tab), send_task_to_tab (queue a task for another tab's agent without interrupting the user's current view)

## Agent behaviors

- **Plan / Build modes** — Plan mode is read-only (no writes/commands/git mutations); Build mode has full access.
- **Completion review** — after finishing, the agent re-checks its own work (up to 2 cycles) and fixes issues itself instead of asking "should I continue?".
- **Stuck detector** — guards against repeated identical tool calls / no-progress loops, with recovery hints.
- **Checkpoints** — write_file/patch_file back up the previous content to `.localmind-backups/`; CheckpointBrowser views/restores them.
- **Project memory** — `.localmind/memory.md`, agent-updatable named sections, auto-injected into the system prompt. Per-workspace (one project's memory doesn't leak into another's).
- **Global memory** — a separate, app-wide vector store (the **memory** tab / `save_global_memory`), auto-searched against the current task and injected into the system prompt (both agent mode and normal chat) regardless of which project is open. Use this for facts/preferences that should follow the user across projects.
- **Skills** — `.localmind/skills/*.md` (frontmatter: name/tags), fuzzy-matched into context each turn. Written manually, by the "research feature ideas" flow, or by the phone-agent's video pipeline.
- **Feature ideas** — lightbulb button has the agent research what similar tools (Claude Code, Cursor, other local-LLM agents) do well and write prioritized next-feature ideas to `FEATURE_IDEAS.md` (steerable via Settings).
- **MCP client** — connect to external MCP servers (configured in Settings) for additional tools.
- **Recent projects** — the workspace switcher (sidebar) remembers recently-opened project folders for one-click switching (desktop/Tauri only), and auto-reopens the last project on launch.

## Companion: Phone Agent (Telegram bot, `phone-agent/`)

Standalone Python process, independent of the Tauri/npm build:
- Text messages → tool-using agent loop (subset of the tools above, scoped to the LocalMind workspace; mutating tools need inline Approve/Deny).
- `/model [name]` — show/switch the Ollama model for this chat; `/models` — list installed models and whether each supports tool-calling.
- `/skills` — recently learned skills; `/reset` — clear conversation; `/start` — help.
- Videos → transcribed (faster-whisper), mined for skills (Ollama), researched (DuckDuckGo), saved to `.localmind/skills/`.
- `start-all.ps1` — one command to check Ollama + launch the phone-agent + the desktop app.

## Known gaps / not yet built

- No scheduler that runs an agent overnight to autonomously implement `FEATURE_IDEAS.md` items.
- Phone agent can't push messages/tasks into a *running* LocalMind window (no local HTTP listener).
- Task queue (`useTaskQueueStore` / `QueuedTaskBanner`) is in-memory only — doesn't persist across app restarts.
