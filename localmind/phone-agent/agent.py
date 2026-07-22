"""LocalMind Phone Agent - Telegram bot entrypoint.

This bot is a thin relay, not an agent: text messages are forwarded to the
LocalMind desktop app's local IPC listener (127.0.0.1:41777), which queues
them onto the same task queue and headless agent runtime the desktop UI
itself uses. Every tool allowlist, approval gate, and workspace confinement
already built into that runtime applies automatically - this file never
calls a tool, model, or shell itself. See localmind_client.py for the HTTP
side of that relationship.

The LocalMind desktop app must be running for text messages to work.

Videos are still transcribed and mined for skills locally (video_pipeline.py)
- that capability doesn't go through the desktop app.

Run with:

    python agent.py
"""

import asyncio
import logging
import tempfile
from pathlib import Path

import requests
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import config
import db
import localmind_client
import video_pipeline

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("phone-agent")

# How long to wait synchronously for a relayed task to finish before telling
# the user it's still running. A local agent run is typically tens of
# seconds; this gives real headroom above that without blocking forever.
POLL_TIMEOUT_S = 240.0

_STATUS_LABELS = {"queued": "queued", "running": "running"}


def _is_allowed(update: Update) -> bool:
    chat = update.effective_chat
    return chat is not None and chat.id == config.ALLOWED_CHAT_ID


async def _reply_unauthorized(update: Update) -> None:
    if update.message:
        await update.message.reply_text("Sorry, this bot is private.")
    logger.warning(
        "Ignored message from unauthorized chat id %s",
        update.effective_chat.id if update.effective_chat else "?",
    )


async def _safe_edit(message, text: str) -> None:
    """Edit a message, swallowing failures (e.g. Telegram's "message is not
    modified" error, or the message having been deleted) - a failed status
    update must never crash the handler."""
    try:
        await message.edit_text(text)
    except Exception:  # noqa: BLE001 - best-effort UI update only
        logger.exception("Failed to edit status message")


def _log_future_exception(fut: "asyncio.Future") -> None:
    exc = fut.exception()
    if exc is not None:
        logger.exception("Background status edit failed", exc_info=exc)


async def _finish_with_text(context: ContextTypes.DEFAULT_TYPE, chat_id: int, placeholder, text: str) -> None:
    """Edit `placeholder` with `text`, splitting into follow-up messages if
    it's too long for a single Telegram message (mirrors the old bot's
    4000-char chunking)."""
    limit = 4000
    await _safe_edit(placeholder, text[:limit] or "(empty response)")
    for i in range(limit, len(text), limit):
        await context.bot.send_message(chat_id=chat_id, text=text[i:i + limit])


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return

    message = update.message
    if message is None or not message.text:
        return

    chat_id = update.effective_chat.id
    task_text = message.text

    await context.bot.send_chat_action(chat_id=chat_id, action="typing")

    try:
        task_id = await asyncio.to_thread(localmind_client.submit, task_text)
    except localmind_client.LocalMindClientError as exc:
        await message.reply_text(f"LocalMind isn't set up correctly on this computer: {exc}")
        return
    except requests.RequestException:
        await message.reply_text(
            "Couldn't reach LocalMind - make sure the LocalMind desktop app "
            "is running on this computer."
        )
        return

    placeholder = await message.reply_text("Working…")

    loop = asyncio.get_running_loop()

    def on_status(status: str) -> None:
        if status in localmind_client.TERMINAL_STATUSES:
            return
        label = _STATUS_LABELS.get(status, status)
        fut = asyncio.run_coroutine_threadsafe(_safe_edit(placeholder, f"Working… ({label})"), loop)
        fut.add_done_callback(_log_future_exception)

    try:
        result = await asyncio.to_thread(localmind_client.poll, task_id, POLL_TIMEOUT_S, on_status)
    except requests.RequestException:
        await _safe_edit(placeholder, "Lost connection to LocalMind while waiting for a reply.")
        return

    status = result.get("status")
    summary = result.get("summary")

    if status == "done":
        await _finish_with_text(context, chat_id, placeholder, summary or "(no summary returned)")
    elif status == "error":
        await _finish_with_text(
            context, chat_id, placeholder, f"⚠️ LocalMind reported an error:\n{summary or '(no details)'}"
        )
    else:
        await _safe_edit(
            placeholder,
            f"Still running after {int(POLL_TIMEOUT_S)}s — it'll keep going in LocalMind. "
            f"Task id: `{task_id}`",
        )


async def handle_reset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return
    await update.message.reply_text(
        "Nothing to reset — each message is now handled independently by "
        "the LocalMind desktop app, which keeps its own conversation state."
    )


async def handle_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return
    await update.message.reply_text(
        "LocalMind Phone Agent\n\n"
        f"Workspace: {config.WORKSPACE_DIR}\n\n"
        "- Send a message and it's relayed to the LocalMind desktop app, "
        "which must be running on this computer — it answers using its "
        "own memory, tools, and skills. Unattended runs from this bot use "
        "the desktop app's safe tool allowlist (shell commands, package "
        "installs, and git writes are auto-denied; there's no approval "
        "step here).\n"
        "- Send a video to transcribe it and mine it for skills.\n"
        "- /skills — recently learned skills.\n"
        "- /model — model selection now happens in the LocalMind desktop app.\n"
        "- /reset — no longer needed; each message is independent."
    )


async def handle_video(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return

    message = update.message
    if message is None:
        return

    video = message.video or message.document
    if video is None:
        return

    if video.file_size and video.file_size > config.MAX_VIDEO_MB * 1024 * 1024:
        await message.reply_text(
            f"That video is too large (limit is {config.MAX_VIDEO_MB} MB)."
        )
        return

    await message.reply_text("Got it - downloading and processing the video, this may take a while...")
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="typing")

    tg_file = await context.bot.get_file(video.file_id)

    suffix = Path(getattr(video, "file_name", "") or "video.mp4").suffix or ".mp4"
    tmp_path = Path(tempfile.mkstemp(suffix=suffix)[1])

    try:
        await tg_file.download_to_drive(custom_path=str(tmp_path))
        summary, skill_paths = await asyncio.to_thread(video_pipeline.process_video, tmp_path)
    except Exception as exc:  # noqa: BLE001 - report any pipeline failure to the user
        logger.exception("Video processing failed")
        await message.reply_text(f"Something went wrong processing that video: {exc}")
        return
    finally:
        tmp_path.unlink(missing_ok=True)

    reply = summary
    if skill_paths:
        relative = []
        for p in skill_paths:
            try:
                relative.append(str(Path(p).relative_to(config.WORKSPACE_DIR)))
            except ValueError:
                relative.append(p)
        reply += "\n\nNew skills:\n" + "\n".join(f"- {p}" for p in relative)

    await message.reply_text(reply)


async def handle_model_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return
    if update.message is None:
        return
    await update.message.reply_text(
        "Model selection now happens in the LocalMind desktop app (this bot "
        "no longer runs its own model/agent loop) - switch models there."
    )


async def handle_skills_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return

    message = update.message
    if message is None:
        return

    skills = db.recent_skills(10)
    if not skills:
        await message.reply_text("No skills recorded yet.")
        return

    lines = ["Recent skills:"]
    for skill in skills:
        lines.append(f"- {skill['name']} ({skill['tags']})")

    await message.reply_text("\n".join(lines))


def main() -> None:
    app = ApplicationBuilder().token(config.TELEGRAM_TOKEN).build()

    app.add_handler(CommandHandler("start", handle_start))
    app.add_handler(CommandHandler("skills", handle_skills_command))
    app.add_handler(CommandHandler("model", handle_model_command))
    app.add_handler(CommandHandler("models", handle_model_command))
    app.add_handler(CommandHandler("reset", handle_reset))
    app.add_handler(MessageHandler(filters.VIDEO | filters.Document.VIDEO, handle_video))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    if not localmind_client.health():
        logger.warning(
            "LocalMind desktop app does not appear to be reachable at startup "
            "(health check failed) - text messages will fail until it's running."
        )

    logger.info("LocalMind Phone Agent starting (workspace: %s)", config.WORKSPACE_DIR)
    app.run_polling()


if __name__ == "__main__":
    main()
