"""Single PyInstaller entry point for both transcription modes, so the
bundled build ships ctranslate2/faster-whisper's ~230MB of native libs ONCE
instead of once per executable (transcribe_cli.py and whisper_daemon.py are
otherwise separate scripts with near-identical dependency graphs).

Usage:
  transcribe_tool.exe cli <path_or_url>   -> same as transcribe_cli.py
  transcribe_tool.exe daemon              -> same as whisper_daemon.py

Dev mode (raw `python transcribe_cli.py` / `python whisper_daemon.py`) is
untouched — this wrapper only exists for the PyInstaller-bundled build that
ships inside the packaged LocalMind installer.
"""

import sys


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in ("cli", "daemon"):
        print("usage: transcribe_tool.exe {cli <path_or_url>|daemon}", file=sys.stderr)
        return 2

    mode = sys.argv[1]
    # Strip the mode arg so each module's own main() sees the argv shape it expects.
    sys.argv = [sys.argv[0], *sys.argv[2:]]

    if mode == "cli":
        import transcribe_cli
        return transcribe_cli.main()
    else:
        import whisper_daemon
        return whisper_daemon.main()


if __name__ == "__main__":
    sys.exit(main())
