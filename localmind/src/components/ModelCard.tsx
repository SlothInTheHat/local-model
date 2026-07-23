import { Download, Trash2, CheckCircle, XCircle, Loader2, HardDrive, Cpu, Zap, MessageSquare } from "lucide-react";
import { cn } from "./ui/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { Progress } from "./ui/progress";
import type { ModelSpec, Compatibility } from "../lib/modelLibrary";
import { TAG_COLORS, FAMILY_COLORS } from "../lib/modelLibrary";
import type { PullProgress } from "../store/models";

interface Props {
  spec: ModelSpec;
  compat: Compatibility;
  isInstalled: boolean;
  pull: PullProgress | null;
  onInstall: (id: string) => void;
  onDelete: (id: string) => void;
  onCancelPull: (id: string) => void;
  onUse?: (id: string) => void;
}

const COMPAT_BADGE: Record<Compatibility, { label: string; variant: "success" | "warning" | "danger" }> = {
  "gpu-ready": { label: "GPU Ready", variant: "success" },
  "cpu-only":  { label: "CPU Only",  variant: "warning" },
  "too-large": { label: "Too Large", variant: "danger"  },
};

export function ModelCard({ spec, compat, isInstalled, pull, onInstall, onDelete, onCancelPull, onUse }: Props) {
  const { label, variant } = COMPAT_BADGE[compat];
  const isPulling = pull !== null && !pull.error;
  const hasError = pull?.error != null;
  const familyClass = FAMILY_COLORS[spec.family] ?? "bg-secondary text-secondary-foreground";

  return (
    <Card className={cn("hover:shadow-md transition-shadow", isInstalled && "ring-1 ring-primary/10")}>
      <CardContent className="p-4 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-medium leading-tight">{spec.name}</h4>
              {isInstalled && (
                <Badge variant="secondary" className="text-[10px] py-0">Installed</Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", familyClass)}>
                {spec.family}
              </span>
              <div className="flex items-center gap-1">
                <Cpu className="size-3" />
                {spec.paramCount}
              </div>
              <div className="flex items-center gap-1">
                <HardDrive className="size-3" />
                {spec.diskSizeGb} GB
              </div>
              <div className="flex items-center gap-1">
                <Zap className="size-3" />
                {formatContext(spec.contextLength)} ctx
              </div>
            </div>
          </div>
          <Badge variant={variant} className="shrink-0 text-[10px]">{label}</Badge>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
          {spec.description}
        </p>

        {/* Tags */}
        <div className="flex flex-wrap gap-1">
          {spec.tags.map((tag) => (
            <span
              key={tag}
              className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", TAG_COLORS[tag])}
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Progress */}
        {isPulling && (
          <div className="space-y-1.5">
            <Progress value={pull!.percent > 0 ? pull!.percent : undefined} className="h-1.5" />
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span className="truncate">{pull!.status}</span>
              {pull!.percent > 0 && <span className="shrink-0 ml-2">{pull!.percent}%</span>}
            </div>
          </div>
        )}

        {hasError && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <XCircle className="size-3" />
            {pull!.error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          {isPulling ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCancelPull(spec.id)}
              className="gap-1.5"
            >
              <Loader2 className="size-3 animate-spin" />
              Cancel
            </Button>
          ) : isInstalled ? (
            <div className="flex items-center gap-2 w-full">
              <div className="flex items-center gap-1 text-xs text-success">
                <CheckCircle className="size-3" />
                Installed
              </div>
              <div className="ml-auto flex items-center gap-1">
                {onUse && (
                  <Button
                    size="sm"
                    onClick={() => onUse(spec.id)}
                    className="gap-1.5 h-7 text-xs"
                  >
                    <MessageSquare className="size-3" />
                    Use in Chat
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 hover:text-destructive"
                  onClick={() => onDelete(spec.id)}
                  title="Remove model"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              onClick={() => onInstall(spec.id)}
              disabled={compat === "too-large"}
              variant={compat === "too-large" ? "outline" : "default"}
              className="gap-1.5"
            >
              <Download className="size-3" />
              {compat === "too-large" ? "Insufficient memory" : "Download"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatContext(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}
