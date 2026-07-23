import { useRef, useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { supportsNativeTools } from "../lib/modelCapabilities";
import { cn } from "./ui/utils";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { pullModel, deleteModel, listModels } from "../lib/ollama";
import { MODEL_LIBRARY, LIBRARY_UPDATED, getCompatibility, type ModelSpec } from "../lib/modelLibrary";
import { useChatStore } from "../store/chat";
import { useModelStore } from "../store/models";
import { HardwareSummary } from "./HardwareSummary";
import { ModelCard } from "./ModelCard";

type Tab = "recommended" | "all" | "installed";

interface Props {
  onUseModel: (id: string) => void;
}

// Stub spec for models installed in Ollama but not in our library
function makeStubSpec(name: string): ModelSpec {
  const base = name.split(":")[0];
  return {
    id: name,
    name,
    family: base.split(/[-_]/)[0].toLowerCase(),
    description: "Installed locally — not in the curated library.",
    paramCount: name.includes(":") ? name.split(":")[1] : "?",
    diskSizeGb: 0,
    minRamGb: 0,
    minVramGb: 0,
    tags: [],
    contextLength: 0,
  };
}

export function ModelManager({ onUseModel }: Props) {
  const [tab, setTab] = useState<Tab>("recommended");
  const [search, setSearch] = useState("");
  const [toolsOnly, setToolsOnly] = useState(false);

  const { availableModels, setModels } = useChatStore();
  const { hardware, vramOverride, pullProgress, setPullProgress, clearPullProgress } =
    useModelStore();
  const aborts = useRef<Record<string, AbortController>>({});

  const effectiveHw = hardware
    ? vramOverride != null ? { ...hardware, vramGb: vramOverride } : hardware
    : null;

  const isInstalled = (id: string) =>
    availableModels.includes(id) ||
    (!id.includes(":") && availableModels.some((m) => m === `${id}:latest`));

  async function handleInstall(id: string) {
    const MAX_RETRIES = 8;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const abort = new AbortController();
      aborts.current[id] = abort;
      if (attempt === 1) {
        setPullProgress(id, { status: "Connecting…", percent: 0 });
      } else {
        setPullProgress(id, { status: `Reconnecting (attempt ${attempt})…`, percent: 0 });
        await new Promise((r) => setTimeout(r, 2000));
      }

      let succeeded = false;
      try {
        for await (const update of pullModel(id, abort.signal)) {
          setPullProgress(id, { status: update.status, percent: update.percent });
          if (update.done) { succeeded = true; break; }
        }
      } catch (err: unknown) {
        const e = err as Error;
        if (e.name === "AbortError") {
          // User cancelled — stop immediately
          delete aborts.current[id];
          clearPullProgress(id);
          return;
        }
        if (attempt >= MAX_RETRIES) {
          setPullProgress(id, { status: "", percent: 0, error: e.message });
          setTimeout(() => clearPullProgress(id), 5000);
          delete aborts.current[id];
          return;
        }
        // transient error — retry (Ollama resumes the download automatically)
        delete aborts.current[id];
        continue;
      } finally {
        delete aborts.current[id];
      }

      if (succeeded) break;

      // Stream ended without "success" (connection dropped mid-pull) — retry
      if (attempt >= MAX_RETRIES) {
        setPullProgress(id, { status: "", percent: 0, error: "Pull did not complete after several attempts." });
        setTimeout(() => clearPullProgress(id), 5000);
        return;
      }
    }

    const models = await listModels();
    setModels(models.map((m) => m.name));
    clearPullProgress(id);
  }

  async function handleDelete(id: string) {
    try {
      await deleteModel(id);
      const models = await listModels();
      setModels(models.map((m) => m.name));
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }

  function handleCancelPull(id: string) {
    aborts.current[id]?.abort();
    clearPullProgress(id);
  }

  const q = search.toLowerCase();
  const COMPAT_ORDER = { "gpu-ready": 0, "cpu-only": 1, "too-large": 2 };

  // Models from our library that are installed
  const catalogInstalledIds = new Set(MODEL_LIBRARY.filter((s) => isInstalled(s.id)).map((s) => s.id));

  // Models installed in Ollama but absent from our library catalog
  const uncatalogedSpecs: ModelSpec[] = availableModels
    .filter((name) => !MODEL_LIBRARY.some((s) => s.id === name))
    .map(makeStubSpec);

  // Total installed count (catalog matches + uncataloged) for the badge
  const totalInstalled = catalogInstalledIds.size + uncatalogedSpecs.length;

  const baseList: ModelSpec[] =
    tab === "installed"
      ? [
          ...MODEL_LIBRARY.filter((s) => isInstalled(s.id)),
          ...uncatalogedSpecs,
        ]
      : MODEL_LIBRARY;

  const filtered = baseList
    .filter((spec) => {
      if (q) {
        const hay =
          `${spec.name} ${spec.family} ${spec.tags.join(" ")} ${spec.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (toolsOnly && !supportsNativeTools(spec.id)) return false;
      if (tab === "recommended") return getCompatibility(spec, effectiveHw) !== "too-large";
      return true;
    })
    .sort((a, b) => {
      const aInst = isInstalled(a.id) ? 0 : 1;
      const bInst = isInstalled(b.id) ? 0 : 1;
      if (aInst !== bInst) return aInst - bInst;
      const ca = COMPAT_ORDER[getCompatibility(a, effectiveHw)];
      const cb = COMPAT_ORDER[getCompatibility(b, effectiveHw)];
      if (ca !== cb) return ca - cb;
      return a.diskSizeGb - b.diskSizeGb;
    });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-14 border-b bg-card px-6 flex items-center justify-between">
        <h2 className="text-sm font-medium">Model Library</h2>
        <div className="text-[10px] text-muted-foreground flex items-center gap-3">
          <span>Installed list: <span className="text-success font-medium">live from Ollama</span></span>
          <span>Catalog: curated · updated {LIBRARY_UPDATED}</span>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
          {/* Hardware */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="size-4 text-primary" />
              <h3 className="text-sm font-medium">Your Hardware</h3>
            </div>
            <HardwareSummary />
          </div>

          <Separator />

          {/* Filter bar */}
          <div className="flex items-center gap-3">
            <div className="flex rounded-lg border bg-muted p-0.5 gap-0.5">
              {(["recommended", "all", "installed"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors",
                    tab === t
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t}
                  {t === "installed" && totalInstalled > 0 && (
                    <span className="ml-1.5 bg-secondary text-secondary-foreground text-[10px] px-1 rounded-full">
                      {totalInstalled}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models, tags…"
                className="pl-9"
              />
            </div>

            <button
              type="button"
              onClick={() => setToolsOnly((v) => !v)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors shrink-0",
                toolsOnly
                  ? "bg-success/15 text-success border-success/40"
                  : "bg-background text-muted-foreground border-border hover:text-foreground"
              )}
              title="Filter to models that support native tool/function calling"
            >
              🔧 Tools only
            </button>
          </div>

          {/* Model grid */}
          {filtered.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-12">
              {tab === "installed" ? "No models installed yet." : "No models match your search."}
            </div>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((spec) => (
                <ModelCard
                  key={spec.id}
                  spec={spec}
                  compat={getCompatibility(spec, effectiveHw)}
                  isInstalled={isInstalled(spec.id)}
                  pull={pullProgress[spec.id] ?? null}
                  onInstall={handleInstall}
                  onDelete={handleDelete}
                  onCancelPull={handleCancelPull}
                  onUse={isInstalled(spec.id) ? onUseModel : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
