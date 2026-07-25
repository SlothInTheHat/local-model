# LocalMind Phone Agent

A standalone Telegram bot that lets you message your local LocalMind setup
from your phone. **It is a thin relay, not an agent**: it does no
reasoning, calls no models, and runs no tools itself. Instead:

- **Text messages** are forwarded over HTTP to the LocalMind desktop app's
  local IPC listener (`127.0.0.1:41777`), which queues them onto the same
  task queue and headless agent runtime the desktop UI itself uses. Every
  tool allowlist, memory, skill, and MCP integration already built into the
  desktop app applies automatically — this bot has none of its own.
  **The LocalMind desktop app must be running** for text messages to work;
  if it isn't, the bot tells you plainly instead of failing silently.
- **Videos** are still transcribed locally (faster-whisper), mined for
  tools/skills/techniques (Ollama), researched on the web (DuckDuckGo, no
  API key), and saved as LocalMind skills in
  `<workspace>/.localmind/skills/` — they show up automatically in
  LocalMind's Skills tab. This path doesn't go through the desktop app's
  IPC listener; it's a standalone pipeline (`video_pipeline.py`).
- `/skills` lists the most recently learned skills, `/start` shows a quick
  help message.
- `/reset` and `/model`/`/models` still exist as commands but no longer do
  anything stateful — there is no per-chat conversation or model to reset
  or switch here anymore (see [Architecture](#architecture) below).

This is a separate Python process. It does not touch LocalMind's npm/cargo
build and runs independently of the Tauri app (except that the app must be
running for text relaying to work).

## Requirements

- Python 3.11+ (3.13 recommended)
- The LocalMind desktop app, running, for text messages to work
- ffmpeg on your `PATH` (for video transcription)
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

Install ffmpeg if you don't already have it (only needed for video
transcription):

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
in LocalMind — skills mined from videos get written to
`LOCALMIND_WORKSPACE\.localmind\skills\`. `OLLAMA_HOST`/`OLLAMA_MODEL` are
only used by the video pipeline (transcript skill-mining); text messages no
longer talk to Ollama directly — the desktop app does that.

## 4. Run

Start the LocalMind desktop app first (`npm run tauri dev`, or the built
app) — it generates the IPC token on first launch and must be running for
text messages to relay successfully. Then:

```powershell
python agent.py
```

Send your bot a text message — it's relayed to the desktop app and you'll
get its answer back (with a "Working…" status message that updates while
it runs).

Send a short video or voice-note-as-video — after a minute or two you should
get a summary plus a list of any new skill files. The first time you send a
video, faster-whisper will download the `WHISPER_MODEL` (~150 MB for
"base") — this needs internet once, then transcription runs fully offline.

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

## Architecture: relay, not agent

Prior versions of this bot ran their own duplicate tool-using agent loop
(`agent_loop.py` + `agent_tools.py`, since removed) that reimplemented a
subset of LocalMind's TypeScript agent runtime and tool schemas. That meant
two independent implementations of "an agent that reads files and runs
commands" could drift, and the Python one had none of the desktop app's
guarding, memory, MCP servers, or skills.

Now, `handle_text` in `agent.py` does only this (see `localmind_client.py`
for the implementation):

1. `POST /task` with `{"task": <your message>, "targetView": "chat",
   "expectSideEffects": false}` to `http://127.0.0.1:41777` — the desktop
   app's loopback-only HTTP listener — and get back a task id.
2. `GET /task/{id}` repeatedly until the task reaches `done` or `error`
   (or a few minutes pass), editing a single Telegram status message along
   the way instead of spamming new ones.
3. Reply with the final summary (or a clear error / "still running, here's
   the task id" message).

**Tool approvals don't apply here.** The desktop app's headless task-queue
runtime — the same one that runs everything queued this way — treats
IPC-submitted tasks as unattended runs: mutating/dangerous tools (shell
commands, package installs, git writes, etc.) are auto-denied by the
desktop app's safe tool allowlist rather than prompted for approval. There
is no Approve/Deny flow in Telegram anymore; if you need to run something
that requires approval, do it in the LocalMind desktop app directly.

### Finding the IPC token

The desktop app generates a bearer token on first launch and persists it to
`%APPDATA%\com.lalwa.localmind\ipc-token.txt` (Windows). `localmind_client.py`
looks for it in this order:

1. `LOCALMIND_IPC_TOKEN` env var — the raw token string.
2. `LOCALMIND_IPC_TOKEN_FILE` env var — a path to a file containing it.
3. `%APPDATA%\com.lalwa.localmind\ipc-token.txt` (the default).

If none of these resolve to a token, the bot will tell you exactly which
path it looked for and how to override it — it won't fail with a raw
traceback.

The IPC base URL defaults to `http://127.0.0.1:41777` and can be overridden
with `LOCALMIND_IPC_URL` (e.g. for testing against a different port).

## Verification

1. **Relay smoke test (no Telegram needed)** — from the `phone-agent`
   directory with the venv active and the LocalMind desktop app running:
   ```powershell
   python -c "import localmind_client as lc; print(lc.health()); tid = lc.submit('say hello'); print(lc.poll(tid, 60))"
   ```
   Confirm `health()` prints `True` and `poll()` eventually returns a dict
   with `status: "done"` and a non-empty `summary`.
2. **Video pipeline smoke test** — same as before, independent of the
   desktop app:
   ```powershell
   python -c "from video_pipeline import process_video; print(process_video('sample.mp4'))"
   ```
   Confirm it creates `<workspace>\.localmind\resources\transcripts\sample.md`
   with real transcript text, and at least one
   `<workspace>\.localmind\skills\<slug>.md` with `---\nname:\ntags:\n---`
   frontmatter.
3. **Telegram smoke test** — with the desktop app running, run
   `python agent.py`, message your bot from your phone, and confirm you get
   a relayed answer. Then stop the desktop app and send another message —
   confirm you get a plain "LocalMind isn't running" reply, not a crash.

## Building the bundled pipeline (for LocalMind's packaged installer)

This section is unrelated to the Telegram bot above — it's for
`src-tauri/src/transcribe.rs`'s `transcribe_video`/`transcribe_audio_base64`
Tauri commands, which reuse `transcribe_cli.py`/`whisper_daemon.py` from this
folder. In dev (`npm run tauri dev`), those commands just run this venv's
Python directly — the steps below are only needed to produce the
self-contained binaries that ship *inside* a packaged LocalMind installer
(`npm run tauri build`), since end users have neither this venv nor
necessarily ffmpeg installed.

1. **Install PyInstaller into this venv** (one-time):
   ```powershell
   .venv\Scripts\python.exe -m pip install pyinstaller
   ```
2. **Build the combined CLI+daemon executable.** `transcribe_tool.py` wraps
   both `transcribe_cli.py` and `whisper_daemon.py` behind one entry point
   (`transcribe_tool.exe cli <path>` / `transcribe_tool.exe daemon`) so
   ctranslate2/faster-whisper's ~230MB of native libs ship once instead of
   twice:
   ```powershell
   .venv\Scripts\python.exe -m PyInstaller --onedir --noconfirm --name transcribe_tool `
     --hidden-import transcribe_cli --hidden-import whisper_daemon `
     --distpath ..\src-tauri\resources\transcribe\dist --workpath build\pyi-work --specpath build `
     transcribe_tool.py
   ```
   Output lands at `src-tauri/resources/transcribe/dist/transcribe_tool/` —
   gitignored (regenerate, don't commit).
3. **Vendor a static ffmpeg.exe** into `src-tauri/resources/transcribe/ffmpeg/`
   — a Windows "essentials" build from <https://www.gyan.dev/ffmpeg/builds/>
   works (only `ffmpeg.exe` is needed, not `ffprobe`/`ffplay`). Also
   gitignored.
4. `npm run tauri build` (from the repo root) picks both up automatically via
   `tauri.conf.json`'s `bundle.resources` and copies them into the packaged
   app's resource directory. `transcribe.rs` checks there first, falling
   back to this venv only if the bundled resources aren't present (i.e. a
   dev checkout that hasn't run the steps above).

Sanity-check the built executable directly before trusting a full app build
(needs *some* ffmpeg on PATH for this specific manual check — the packaged
app itself doesn't, since it uses the bundled one):
```powershell
resources\transcribe\dist\transcribe_tool\transcribe_tool.exe cli path\to\some.wav
```

## Notes / limitations

- Only the chat ID in `ALLOWED_CHAT_ID` can use the bot — this check is
  unchanged and is the only thing standing between a stranger on Telegram
  and your desktop agent.
- The desktop app must be running for text messages; the bot itself has no
  fallback model or offline mode for text.
- `phone_agent.db` (SQLite) tracks processed videos and written skills to
  avoid re-downloading resources for skills you already have — unrelated to
  the IPC relay.
