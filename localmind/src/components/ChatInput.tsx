import { useRef, useState } from "react";
import { Send, Square, Globe, Zap, Loader2, Bot, Paperclip } from "lucide-react";
import { cn } from "./ui/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { ImageAttachmentStrip } from "./ImageAttachmentStrip";
import { fileToBase64 } from "../lib/imageUtils";

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
  attachedImages,
  onAttachImages,
  onRemoveImage,
}: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="border-t bg-card p-4 shrink-0">
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
        {/* Image strip */}
        {attachedImages.length > 0 && (
          <div className="mb-2">
            <ImageAttachmentStrip images={attachedImages} onRemove={onRemoveImage} />
          </div>
        )}

        <div className="flex gap-2 items-end">
          <div className="flex-1 relative">
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
              className="min-h-[60px] max-h-[200px] pr-24"
            />

            {/* Toolbar inside the textarea */}
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              {/* Paperclip: attach image */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                className={cn(
                  "size-7 flex items-center justify-center rounded-md transition-colors",
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
                  "size-7 flex items-center justify-center rounded-md transition-colors",
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
                  "size-7 flex items-center justify-center rounded-md transition-colors",
                  agentMode
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
              >
                <Bot className="size-4" />
              </button>
            </div>
          </div>

          {busy ? (
            isSearching ? (
              <Button size="icon" variant="outline" disabled className="size-[60px] shrink-0">
                <Loader2 className="size-4 animate-spin" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="outline"
                onClick={onStop}
                title="Stop generating"
                className="size-[60px] shrink-0"
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
              className="size-[60px] shrink-0"
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
