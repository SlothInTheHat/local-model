"""LocalMind Phone Agent - Telegram bot entrypoint.

Text messages run through agent_loop's tool-using agent (file/grep/git/
shell/web tools scoped to the LocalMind workspace; mutating tools require
inline Approve/Deny). Videos are transcribed and mined for skills, which
are written into the LocalMind workspace's .localmind/skills/ directory.
Run with:

    python agent.py
"""

import asyncio
import logging
import tempfile
from pathlib import Path

import requests
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import agent_loop
import config
import db
import video_pipeline

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("phone-agent")


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


_APPROVAL_KEYBOARD = InlineKeyboardMarkup([
    [
        InlineKeyboardButton("Approve", callback_data="approve"),
        InlineKeyboardButton("Deny", callback_data="deny"),
    ],
])


def _format_arg(value) -> str:
    text = str(value)
    if len(text) > 200:
        text = text[:200] + "…"
    return text


def _format_call(name: str, args: dict) -> str:
    arg_str = ", ".join(f"{k}={_format_arg(v)!r}" for k, v in args.items())
    return f"{name}({arg_str})"


def _format_pending(calls: list[tuple[str, dict]]) -> str:
    lines = [f"{i}. {_format_call(name, args)}" for i, (name, args) in enumerate(calls, start=1)]
    return "The agent wants to run:\n" + "\n".join(lines) + "\n\nApprove?"


async def _send_step_result(message, result: agent_loop.StepResult) -> None:
    if result.kind == "approval_needed":
        await message.reply_text(_format_pending(result.calls), reply_markup=_APPROVAL_KEYBOARD)
        return

    text = result.text or "(empty response)"
    for i in range(0, len(text), 4000):
        await message.reply_text(text[i:i + 4000])


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return

    message = update.message
    if message is None or not message.text:
        return

    chat_id = update.effective_chat.id
    if agent_loop.has_pending(chat_id):
        await message.reply_text(
            "There's a tool call awaiting Approve/Deny above — respond to that first, "
            "or send /reset to start a new conversation."
        )
        return

    await context.bot.send_chat_action(chat_id=chat_id, action="typing")

    try:
        result = await asyncio.to_thread(agent_loop.start, chat_id, message.text)
    except requests.RequestException as exc:
        await message.reply_text(f"Couldn't reach Ollama at {config.OLLAMA_HOST}: {exc}")
        return

    await _send_step_result(message, result)


async def handle_approval_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    chat = update.effective_chat
    if query is None or chat is None:
        return
    if chat.id != config.ALLOWED_CHAT_ID:
        await query.answer("Not authorized.")
        return

    await query.answer()
    chat_id = chat.id

    if not agent_loop.has_pending(chat_id):
        await query.edit_message_reply_markup(reply_markup=None)
        return

    approved = query.data == "approve"
    suffix = "\n\nApproved." if approved else "\n\nDenied."
    await query.edit_message_text((query.message.text or "") + suffix)

    await context.bot.send_chat_action(chat_id=chat_id, action="typing")
    try:
        if approved:
            result = await asyncio.to_thread(agent_loop.approve, chat_id)
        else:
            result = await asyncio.to_thread(agent_loop.deny, chat_id)
    except requests.RequestException as exc:
        await query.message.reply_text(f"Couldn't reach Ollama at {config.OLLAMA_HOST}: {exc}")
        return

    await _send_step_result(query.message, result)


async def handle_reset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return
    agent_loop.reset(update.effective_chat.id)
    await update.message.reply_text("Conversation reset.")


async def handle_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return
    await update.message.reply_text(
        "LocalMind Phone Agent\n\n"
        f"Workspace: {config.WORKSPACE_DIR}\n\n"
        "- Send a message to chat with the agent — it can read/write files, "
        "run commands, search git history, search/fetch the web, and save "
        "skills in this workspace. Mutating actions need your Approve/Deny.\n"
        "- Send a video to transcribe it and mine it for skills.\n"
        "- /skills — recently learned skills.\n"
        "- /model [name] — show or switch the model for this chat.\n"
        "- /models — list installed models and which support tool-calling.\n"
        "- /reset — clear the conversation history."
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


def _format_model_line(name: str, current: str) -> str:
    marker = "*" if name == current else " "
    tools = "tools" if agent_loop.supports_native_tools(name) else "no tools"
    return f"{marker} {name} ({tools})"


async def handle_models_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return

    message = update.message
    if message is None:
        return

    try:
        available = await asyncio.to_thread(agent_loop.list_models)
    except requests.RequestException as exc:
        await message.reply_text(f"Couldn't reach Ollama at {config.OLLAMA_HOST}: {exc}")
        return

    if not available:
        await message.reply_text("No models found - pull one with `ollama pull <name>`.")
        return

    current = agent_loop.get_model(update.effective_chat.id)
    lines = ["Installed models (* = current for this chat):"]
    lines += [_format_model_line(name, current) for name in sorted(available)]
    lines.append("\nSwitch with /model <name>.")
    await message.reply_text("\n".join(lines))


async def handle_model_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_allowed(update):
        await _reply_unauthorized(update)
        return

    message = update.message
    if message is None:
        return

    chat_id = update.effective_chat.id
    current = agent_loop.get_model(chat_id)

    if not context.args:
        tools = "supports" if agent_loop.supports_native_tools(current) else "does NOT support"
        await message.reply_text(
            f"Current model: {current} ({tools} tool-calling)\n\n"
            "/model <name> to switch, /models to list installed models."
        )
        return

    requested = " ".join(context.args).strip()
    try:
        available = await asyncio.to_thread(agent_loop.list_models)
    except requests.RequestException as exc:
        await message.reply_text(f"Couldn't reach Ollama at {config.OLLAMA_HOST}: {exc}")
        return

    resolved = agent_loop.resolve_model(requested, available)
    if resolved is None:
        await message.reply_text(
            f"Model '{requested}' isn't installed. Use /models to see what's available."
        )
        return

    agent_loop.set_model(chat_id, resolved)
    reply = f"Switched to {resolved} for this chat."
    if not agent_loop.supports_native_tools(resolved):
        reply += (
            "\n\n⚠️ This model may not support native tool-calling - "
            "the agent will likely just chat without using tools."
        )
    await message.reply_text(reply)


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
    app.add_handler(CommandHandler("models", handle_models_command))
    app.add_handler(CommandHandler("reset", handle_reset))
    app.add_handler(CallbackQueryHandler(handle_approval_callback))
    app.add_handler(MessageHandler(filters.VIDEO | filters.Document.VIDEO, handle_video))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    if not agent_loop.supports_native_tools(config.OLLAMA_MODEL):
        logger.warning(
            "OLLAMA_MODEL=%s may not support native tool-calling — the agent loop "
            "will likely just chat without using tools. See modelCapabilities.ts's "
            "supportsNativeTools() for known-good models (e.g. llama3.2, qwen2.5).",
            config.OLLAMA_MODEL,
        )

    logger.info("LocalMind Phone Agent starting (workspace: %s)", config.WORKSPACE_DIR)
    app.run_polling()


if __name__ == "__main__":
    main()
