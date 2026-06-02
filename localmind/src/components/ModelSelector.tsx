import { ChevronDown, Sparkles } from "lucide-react";
import { useChatStore } from "../store/chat";

interface Props {
  value: string;
  onChange: (model: string) => void;
  compact?: boolean;
}

export function ModelSelector({ value, onChange, compact }: Props) {
  const models = useChatStore((s) => s.availableModels);

  if (!models.length) {
    return (
      <span className="text-xs text-muted-foreground">No models — open Model Library</span>
    );
  }

  return (
    <div className="relative flex items-center w-full">
      <Sparkles className="absolute left-2.5 size-3 text-muted-foreground pointer-events-none" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={compact
          ? "w-full appearance-none pl-7 pr-6 py-1.5 text-xs border rounded-md bg-background text-foreground hover:bg-accent transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring/50 truncate"
          : "appearance-none pl-7 pr-7 py-1.5 text-sm border rounded-md bg-background text-foreground hover:bg-accent transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring/50"
        }
      >
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-1.5 size-3 text-muted-foreground pointer-events-none" />
    </div>
  );
}
