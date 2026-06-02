import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { useChatStore } from "../store/chat";
import { useSettingsStore } from "../store/settings";

interface Props {
  open: boolean;
  onClose: () => void;
  convId: string;
}

export function SystemPromptDialog({ open, onClose, convId }: Props) {
  const { conversations, updateSystemPrompt } = useChatStore();
  const { defaultSystemPrompt } = useSettingsStore();

  const conv = conversations.find((c) => c.id === convId);
  const currentPrompt = conv?.systemPrompt ?? "";

  const [value, setValue] = useState(currentPrompt);

  // Sync when dialog opens or convId changes
  useEffect(() => {
    if (open) {
      setValue(currentPrompt);
    }
  }, [open, convId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSave() {
    updateSystemPrompt(convId, value);
    onClose();
  }

  function handleReset() {
    setValue(defaultSystemPrompt);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-card border rounded-xl shadow-lg p-6 space-y-4 focus:outline-none">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-foreground">
              System Prompt
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="text-xs text-muted-foreground -mt-2">
            This prompt is injected as the first system message for this conversation.
          </Dialog.Description>

          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={6}
            className="min-h-[120px] font-mono text-xs"
            placeholder="Enter a system prompt… (leave blank for none)"
          />

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{value.length} characters</span>
            <button
              type="button"
              onClick={handleReset}
              className="text-primary hover:underline"
            >
              Reset to default
            </button>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave}>Save</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
