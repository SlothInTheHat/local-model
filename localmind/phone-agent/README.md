# LocalMind Phone Agent

A standalone Telegram bot that lets you message your local LocalMind setup
from your phone:

- **Text messages** run through a tool-using agent loop (see
  [Agent mode](#agent-mode-tools--approvals) below) — it can read/write
  files, run shell commands, search/diff git, search and fetch the web, and
  save skills, all scoped to your LocalMind workspace.
- **Videos** are transcribed (faster-whisper), mined for tools/skills/
  techniques (Ollama), researched on the web (DuckDuckGo, no API key), and
  saved as LocalMind skills in `<workspace>/.localmind/skills/` — they show
  up automatically in LocalMind's Skills tab.
- `/skills` lists the most recently learned skills, `/reset` clears the
  conversation, `/start` shows a quick help message.
- `/model` shows the model currently in use for this chat; `/model <name>`
  switches it (per-chat, resets to `OLLAMA_MODEL` on restart). `/models`
  lists every model installed in Ollama and whether each one supports
  native tool-calling.

This is a separate Python process. It does not touch LocalMind's npm/cargo
build and runs independently of the Tauri app.

## Requirements

- Python 3.11+ (3.13 recommended)
- [Ollama](https://ollama.com) running locally with a model pulled
  (e.g. `ollama pull llama3.2`)
- ffmpeg on your `PATH`
- A Telegram bot token

## 1. Create a Telegram bot

1. Open Telegram, message **@BotFather**, and send `/newbot`.
2. Follow the prompts to choose a name and username. BotFather will give you
   a token like `123456789:AAExampleTokenString`.
3. Find your numeric chat ID: message **@userinfobot** (or
   **@RawDataBot**) and copy the `id` field from its reply. This locks the
   bot down so only you can use it.

## 2. Install dependencies

```powershell
cd localmind\phone-agent
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Install ffmpeg if you don't already have it:

```powershell
winget install ffmpeg
```

## 3. Configure

Copy `.env.example` to `.env` and fill in your values:

```powershell
copy .env.example .env
```

```ini
TELEGRAM_TOKEN=123456789:AAExampleTokenString
ALLOWED_CHAT_ID=123456789
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2
WHISPER_MODEL=base
LOCALMIND_WORKSPACE=C:\Users\you\path\to\your\localmind\workspace
MAX_VIDEO_MB=500
```

`LOCALMIND_WORKSPACE` should be the **same folder** you open as a workspace
in LocalMind — skills get written to
`LOCALMIND_WORKSPACE\.localmind\skills\`.

## 4. Run

```powershell
python agent.py
```

The first time you send a video, faster-whisper will download the
`WHISPER_MODEL` (~150 MB for "base") — this needs internet once, then
transcription runs fully offline.

Send your bot a text message — you should get a reply from your local model.
Send a short video or voice-note-as-video — after a minute or two you should
get a summary plus a list of any new skill files.

### Starting everything at once

From the `localmind/` folder, `.\start-all.ps1` checks/starts Ollama, then
opens separate windows for the phone-agent bot and the LocalMind desktop app
(`npm run tauri dev`) — useful instead of starting each piece by hand.

## Running it "always on" (Windows)

### Option A: Startup folder (simple)

1. Create a file `run-phone-agent.bat`:
   ```bat
   @echo off
   cd /d "C:\path\to\localmind\phone-agent"
   .venv\Scripts\pythonw.exe agent.py
   ```
2. Press `Win+R`, type `shell:startup`, and drop a shortcut to this `.bat`
   file in the folder that opens. The bot starts whenever you log in.

### Option B: Task Scheduler (more robust)

1. Open **Task Scheduler** → **Create Task**.
2. **General**: name it "LocalMind Phone Agent", check "Run whether user is
   logged on or not".
3. **Triggers**: New → "At log on".
4. **Actions**: New → Program/script:
   `C:\path\to\localmind\phone-agent\.venv\Scripts\pythonw.exe`,
   arguments: `agent.py`, start in:
   `C:\path\to\localmind\phone-agent`.
5. Save (you'll be prompted for your Windows password).

## Agent mode (tools & approvals)

Every text message is sent to Ollama (`/api/chat`) along with a set of
tools (`agent_tools.py`), mirroring a subset of LocalMind's own
`src/lib/tools.ts`:

- **Files**: `read_file`, `write_file`, `patch_file`, `delete_file`,
  `list_directory`, `grep_files`, `find_files`, `create_folder`
- **Shell & git**: `run_command`, `git_status`, `git_diff`, `git_log`,
  `git_add`, `git_commit`
- **Web & misc**: `web_search`, `web_fetch`, `calculator`,
  `get_system_info`
- **Skills**: `save_skill`, `list_skills`

All file/command tools are scoped to `LOCALMIND_WORKSPACE` and run with
direct filesystem access (no path-traversal sandboxing — this is a trusted
local process for a single user).

**Approvals**: read-only tools (file reads, search, git status/diff/log,
web search/fetch, etc.) run automatically. Mutating tools — `write_file`,
`patch_file`, `delete_file`, `create_folder`, `run_command`, `git_add`,
`git_commit`, `save_skill` — are queued and the bot sends an
Approve/Deny message before running them.

Conversation history is kept in memory per chat and is lost on restart;
use `/reset` to start a fresh conversation manually.

**Model requirement**: tool-calling needs a model that supports Ollama's
native `tools` API (e.g. `llama3.2`, `qwen2.5`, `mistral-nemo` — see
`supports_native_tools()` in `agent_loop.py`, mirroring
`src/lib/modelCapabilities.ts`'s `supportsNativeTools()`). With other
models, the bot still replies but won't use tools.

## Verification

1. **Pipeline smoke test (no Telegram needed)** — from the `phone-agent`
   directory with the venv active:
   ```powershell
   python -c "from video_pipeline import process_video; print(process_video('sample.mp4'))"
   ```
   Confirm it creates `<workspace>\.localmind\resources\transcripts\sample.md`
   with real transcript text, and at least one
   `<workspace>\.localmind\skills\<slug>.md` with `---\nname:\ntags:\n---`
   frontmatter.
2. **Open the workspace in LocalMind** (`npm run tauri dev`) → Skills tab →
   confirm the new skill appears.
3. **Telegram smoke test** — run `python agent.py`, message your bot from
   your phone, then send the same test video.
4. **Ask the in-app agent** "what skills do you have access to?" — it should
   pick up the new skill via its existing skill-matching.

## Notes / limitations

- This bot can reply to you, but it can't currently push messages *into* a
  running LocalMind window — that would require a local HTTP listener in
  the Tauri backend (not part of this).
- Only the chat ID in `ALLOWED_CHAT_ID` can use the bot.
- `phone_agent.db` (SQLite) tracks processed videos and written skills to
  avoid re-downloading resources for skills you already have.
