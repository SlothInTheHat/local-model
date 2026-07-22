import { useEffect, useRef, useState } from "react";
import { Send, Square, Globe, Zap, Loader2, Bot, Paperclip, Mic } from "lucide-react";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { ImageAttachmentStrip } from "./ImageAttachmentStrip";
import { fileToBase64 } from "../lib/imageUtils";
import { isTauriEnv } from "../lib/fileSystem";
import { isDictationSupported, startDictation, cancelDictation, type DictationSession } from "../lib/dictation";
import { useSettingsStore } from "../store/settings";

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  isSearching: boolean;
  disabled: boolean;
  webSearchEnabled: boolean;
  onToggleWebSearch: () => void;
  // Agent mode
  agentMode: boolean;
  onToggleAgentMode: () => void;
  // Agent tool settings trigger+popover (AgentToolbar), rendered next to the
  // agent-mode toggle only while agent mode is on. Passed as a slot so
  // ChatInput doesn't need to know about ToolName/tool-toggle wiring.
  agentToolbarSlot?: React.ReactNode;
  // Image attachments
  attachedImages: string[];
  onAttachImages: (b64s: string[]) => void;
  onRemoveImage: (index: number) => void;
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  isSearching,
  disabled,
  webSearchEnabled,
  onToggleWebSearch,
  agentMode,
  onToggleAgentMode,
  agentToolbarSlot,
  attachedImages,
  onAttachImages,
  onRemoveImage,
}: Props) {
  const [text, setText] = useState("");
  // "recording" and "transcribing" only ever apply to the Tauri local-dictation
  // path below; the browser Web Speech fallback only ever toggles between
  // "idle" and "recording" (no separate transcribing phase — it streams a
  // result event instead).
  const [micState, setMicState] = useState<"idle" | "recording" | "transcribing">("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const dictationSessionRef = useRef<DictationSession | null>(null);
  const whisperModel = useSettingsStore((s) => s.whisperModel);

  // If this component unmounts mid-recording (e.g. the user navigates away),
  // make sure the mic is released rather than left hot with no UI left to
  // stop it.
  useEffect(() => {
    return () => {
      cancelDictation(dictationSessionRef.current);
      dictationSessionRef.current = null;
    };
  }, []);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || isSearching || disabled) return;
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    onSend(trimmed);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  /**
   * Tauri path (WP6.3): local offline dictation via mic capture + the
   * faster-whisper pipeline (src/lib/dictation.ts -> `transcribe_audio_base64`).
   * Click to start, click again to stop. Unlike the Web Speech fallback below,
   * this has real latency and no interim results, so the transcript is
   * inserted into the composer rather than auto-sent — the user reads it and
   * presses enter themselves.
   */
  async function toggleTauriDictation() {
    if (micState === "transcribing") return; // ignore clicks mid-transcription

    if (micState === "recording") {
      const session = dictationSessionRef.current;
      dictationSessionRef.current = null;
      if (!session) {
        setMicState("idle");
        return;
      }
      setMicState("transcribing");
      try {
        const transcript = await session.stop(whisperModel);
        if (transcript) {
          setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
          // Focus + move cursor to end so the user can immediately review/edit.
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
              el.focus();
              el.selectionStart = el.selectionEnd = el.value.length;
            }
          });
        } else {
          toast.error("Transcription produced no text — try speaking closer to the mic.");
        }
      } catch (e) {
        toast.error(`Transcription failed: ${(e as Error).message}`);
      } finally {
        setMicState("idle");
      }
      return;
    }

    // idle -> start recording
    if (!isDictationSupported()) {
      toast.error("This device/browser build doesn't support microphone capture (getUserMedia/MediaRecorder unavailable).");
      return;
    }
    try {
      const session = await startDictation();
      dictationSessionRef.current = session;
      setMicState("recording");
    } catch (e) {
      const err = e as DOMException | Error;
      if ("name" in err && err.name === "NotAllowedError") {
        toast.error("Microphone access was denied. Grant microphone permission to LocalMind (Windows Settings > Privacy > Microphone) and try again.");
      } else {
        toast.error(`Could not start microphone recording: ${err.message}`);
      }
      setMicState("idle");
    }
  }

  /** Browser dev-mode fallback: unchanged Web Speech API behavior (cloud-based,
   * auto-sends on result). Only used when NOT running inside Tauri. */
  function toggleWebSpeechMic() {
    if (micState === "recording") {
      recognitionRef.current?.stop();
      setMicState("idle");
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    const SR: (new () => { continuous: boolean; interimResults: boolean; onresult: ((e: any) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }) | undefined
      = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      const transcript = String(e.results[0][0].transcript).trim();
      setMicState("idle");
      if (transcript && !isStreaming && !isSearching && !disabled) {
        onSend(transcript);
      }
    };
    rec.onerror = () => setMicState("idle");
    rec.onend = () => setMicState("idle");
    rec.start();
    recognitionRef.current = rec;
    setMicState("recording");
  }

  function toggleMic() {
    if (isTauriEnv()) {
      void toggleTauriDictation();
    } else {
      toggleWebSpeechMic();
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    try {
      const b64s = await Promise.all(files.map(fileToBase64));
      onAttachImages(b64s);
    } catch (err) {
      console.error("Failed to read image files:", err);
    }
    // Reset file input so the same files can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    const b64s: string[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const b64 = await fileToBase64(file);
        b64s.push(b64);
      } catch {
        // skip
      }
    }
    if (b64s.length > 0) {
      onAttachImages(b64s);
    }
  }

  const busy = isStreaming || isSearching;
  const statusLabel = isSearching ? "Searching" : agentMode ? "Working" : "Thinking";

  return (
    <div className="border-t border-border bg-card p-4 shrink-0">
      {/* Hidden file input for image attachments */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      <div className="w-full">
        {/* Thinking/Working status pill — mirrors the real isStreaming/isSearching
            state, never a faked indicator. */}
        {busy && (
          <div className="flex justify-center mb-2">
            <div className="inline-flex items-center gap-2.5 bg-primary text-primary-foreground rounded-full px-4 py-2">
              <span className="text-[11px] tracking-wide">{statusLabel}</span>
              <span className="flex gap-[3px] items-center">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="block w-1 h-1 rounded-full bg-primary-foreground"
                    style={{ animation: "ndot 1.4s ease-in-out infinite", animationDelay: `${i * 0.18}s` }}
                  />
                ))}
              </span>
            </div>
          </div>
        )}

        {/* Image strip */}
        {attachedImages.length > 0 && (
          <div className="mb-2">
            <ImageAttachmentStrip images={attachedImages} onRemove={onRemoveImage} />
          </div>
        )}

        <div className="flex items-end gap-1.5 bg-input-background border border-border rounded-2xl px-3.5 py-2.5 shadow-sm">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => void onPaste(e)}
            placeholder={
              disabled
                ? "Select a model to start chatting…"
                : isSearching
                ? "Searching the web…"
                : isStreaming
                ? "Generating…"
                : "Ask anything… Your data stays private and local."
            }
            disabled={disabled || isSearching}
            className="flex-1 min-h-[44px] max-h-[200px] resize-none border-0 bg-transparent shadow-none px-1 py-1.5 focus-visible:ring-0"
          />

          {/* Inline toolbar */}
          <div className="flex items-center gap-1 shrink-0 pb-0.5">
            {/* Paperclip: attach image */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
              className={cn(
                "size-7 flex items-center justify-center rounded-full transition-colors",
                attachedImages.length > 0
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Paperclip className="size-4" />
            </button>

            {/* Web search toggle */}
            <button
              type="button"
              onClick={onToggleWebSearch}
              title={webSearchEnabled ? "Web search ON — click to disable" : "Enable web search"}
              className={cn(
                "size-7 flex items-center justify-center rounded-full transition-colors",
                webSearchEnabled
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Globe className="size-4" />
            </button>

            {/* Agent mode toggle */}
            <button
              type="button"
              onClick={onToggleAgentMode}
              title={agentMode ? "Agent mode ON — click to disable" : "Enable agent mode"}
              className={cn(
                "size-7 flex items-center justify-center rounded-full transition-colors",
                agentMode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Bot className="size-4" />
            </button>

            {/* Agent tool settings — only shown while agent mode is on;
                the popover itself lives in AgentToolbar. */}
            {agentMode && agentToolbarSlot}

            {/* Mic — voice input. Tauri: local offline dictation (WP6.3).
                Browser dev mode: Web Speech API fallback. Three visual states:
                idle, recording (pulsing destructive-red mic), transcribing
                (disabled spinner while the local whisper pipeline runs). */}
            <button
              type="button"
              onClick={toggleMic}
              disabled={micState === "transcribing"}
              title={
                micState === "recording"
                  ? "Listening… click to stop"
                  : micState === "transcribing"
                  ? "Transcribing…"
                  : "Voice input"
              }
              className={cn(
                "size-7 flex items-center justify-center rounded-full transition-colors",
                micState === "recording"
                  ? "bg-destructive text-destructive-foreground animate-pulse"
                  : micState === "transcribing"
                  ? "text-muted-foreground cursor-not-allowed"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              {micState === "transcribing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Mic className="size-4" />
              )}
            </button>
          </div>

          {busy ? (
            isSearching ? (
              <Button size="icon" variant="outline" disabled className="size-10 rounded-full shrink-0">
                <Loader2 className="size-4 animate-spin" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="outline"
                onClick={onStop}
                title="Stop generating"
                className="size-10 rounded-full shrink-0"
              >
                <Square className="size-4" fill="currentColor" />
              </Button>
            )
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={!text.trim() || disabled}
              title="Send"
              className="size-10 rounded-full shrink-0"
            >
              <Send className="size-5" />
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
          <div className="flex gap-3">
            <span>Enter to send</span>
            <span>•</span>
            <span>Shift+Enter for new line</span>
          </div>
          <div className="flex items-center gap-2">
            {agentMode && (
              <span className="flex items-center gap-1 text-primary font-medium">
                <Bot className="size-3" />
                Agent mode
              </span>
            )}
            {webSearchEnabled && (
              <span className="flex items-center gap-1 text-primary font-medium">
                <Globe className="size-3" />
                Web search on
              </span>
            )}
            <span className="flex items-center gap-1">
              <Zap className="size-3" />
              Streaming
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
