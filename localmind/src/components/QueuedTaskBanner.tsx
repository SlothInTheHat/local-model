import { Inbox, X } from "lucide-react";
import { useTaskQueueStore } from "../store/taskQueue";
import type { AppView } from "../types/app";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

interface Props {
  view: AppView;
  onStart: (task: string) => void;
}

export function QueuedTaskBanner({ view, onStart }: Props) {
  const tasks = useTaskQueueStore((s) => s.tasks.filter((t) => t.targetView === view && t.status === "pending"));
  const setStatus = useTaskQueueStore((s) => s.setStatus);
  const remove = useTaskQueueStore((s) => s.remove);

  if (tasks.length === 0) return null;

  return (
    <div className="space-y-2 px-4 pt-2">
      {tasks.map((t) => (
        <Card key={t.id} className="border-blue-200 bg-blue-50/50">
          <CardContent className="p-3 flex items-center gap-3">
            <Inbox className="size-4 shrink-0 text-blue-600" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">Queued from {t.sourceView}</p>
              <p className="text-sm text-foreground truncate">{t.task}</p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setStatus(t.id, "in_progress");
                onStart(t.task);
              }}
            >
              Start
            </Button>
            <Button size="sm" variant="outline" onClick={() => remove(t.id)}>
              <X className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
