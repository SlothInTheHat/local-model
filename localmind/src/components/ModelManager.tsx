import { useEffect, useRef, useState } from "react";
import { Search, Sparkles, Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supportsNativeTools } from "../lib/modelCapabilities";
import { cn } from "./ui/utils";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { pullModel, deleteModel, listModels } from "../lib/ollama";
import { MODEL_LIBRARY, LIBRARY_UPDATED, getCompatibility, type ModelSpec } from "../lib/modelLibrary";
import { getLiveModelLibrary, getLiveLibraryFetchedAt, type LiveLibraryEntry } from "../lib/liveModelLibrary";
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

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ModelManager({ onUseModel }: Props) {
  const [tab, setTab] = useState<Tab>("recommended");
  const [search, setSearch] = useState("");
  const [toolsOnly, setToolsOnly] = useState(false);
  const [pullByName, setPullByName] = useState("");
  const [liveEntries, setLiveEntries] = useState<LiveLibraryEntry[]>([]);
  const [liveFetchedAt, setLiveFetchedAt] = useState<number | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);

  const { availableModels, setModels } = useChatStore();
  const { hardware, vramOverride, pullProgress, setPullProgress, clearPullProgress } =
    useModelStore();
  const aborts = useRef<Record<string, AbortController>>({});

  // Best-effort live refresh from ollama.com/library (see liveModelLibrary.ts)
  // — supplements the curated MODEL_LIBRARY below with anything Ollama has
  // added since it was last hand-updated. Cached for a day; a failed/blocked
  // fetch just means this section stays empty, never breaks the tab.
  useEffect(() => {
    setLiveLoading(true);
    getLiveModelLibrary()
      .then((entries) => {
        setLiveEntries(entries);
        setLiveFetchedAt(getLiveLibraryFetchedAt());
      })
      .finally(() => setLiveLoading(false));
  }, []);

  async function handleRefreshLiveLibrary() {
    setLiveLoading(true);
    try {
      const entries = await getLiveModelLibrary(true);
      setLiveEntries(entries);
      setLiveFetchedAt(getLiveLibraryFetchedAt());
      if (entries.length === 0) toast.error("Couldn't reach ollama.com/library — showing the curated catalog only.");
    } finally {
      setLiveLoading(false);
    }
  }

  async function handlePullByName() {
    const name = pullByName.trim();
    if (!name) return;
    setPullByName("");
    await handleInstall(name);
  }

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

  // Live-catalog entries (ollama.com/library) not already covered by the
  // curated MODEL_LIBRARY or already installed — "more from ollama.com" that
  // the curated list hasn't been hand-updated to include yet. Family-matched
  // against curated ids' prefix before ":" so e.g. curated "llama3.2:3b"
  // correctly absorbs a live "llama3.2" entry instead of duplicating it.
  const curatedFamilies = new Set(MODEL_LIBRARY.map((s) => s.id.split(":")[0]));
  const liveOnly = liveEntries.filter((e) => !curatedFamilies.has(e.id) && !isInstalled(e.id));
  const liveOnlyFiltered = q
    ? liveOnly.filter((e) => `${e.id} ${e.description} ${e.capabilityTags.join(" ")}`.toLowerCase().includes(q))
    : liveOnly;

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
          <span>
            {liveFetchedAt
              ? `+ ${liveEntries.length} live from ollama.com · ${timeAgo(liveFetchedAt)}`
              : liveLoading ? "Checking ollama.com…" : "Live catalog unavailable"}
          </span>
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

          {/* Pull any model by exact name — not limited to the curated catalog below.
              Works for anything in Ollama's real registry, e.g. a name copied from
              ollama.com/library that we haven't hand-added yet. */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Download className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={pullByName}
                onChange={(e) => setPullByName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handlePullByName(); }}
                placeholder="Pull any model by exact name, e.g. granite3.2:8b…"
                className="pl-9"
              />
            </div>
            <Button size="sm" variant="outline" disabled={!pullByName.trim()} onClick={() => void handlePullByName()}>
              Pull
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              disabled={liveLoading}
              onClick={() => void handleRefreshLiveLibrary()}
              title="Re-check ollama.com/library for new models"
            >
              <RefreshCw className={cn("size-3.5", liveLoading && "animate-spin")} />
            </Button>
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

          {/* More from ollama.com — live-scraped entries not yet in the curated
              catalog above. Shown only in "All" (compatibility/RAM-VRAM numbers
              are unknown for these, so they can't be sorted/filtered the way
              the curated grid is) and only while the free-text field above
              can pull them by exact name. */}
          {tab === "all" && liveOnlyFiltered.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-medium">More from ollama.com</h3>
                  <span className="text-[10px] text-muted-foreground">
                    not yet in the curated catalog above — sizes/RAM requirements unknown until you pull one
                  </span>
                </div>
                <div className="space-y-2">
                  {liveOnlyFiltered.map((entry) => {
                    const pullTargets = entry.sizeTags.length > 0
                      ? entry.sizeTags.map((t) => `${entry.id}:${t}`)
                      : [entry.id];
                    return (
                      <div key={entry.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium truncate">{entry.id}</span>
                            {entry.capabilityTags.map((t) => (
                              <span key={t} className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {t}
                              </span>
                            ))}
                          </div>
                          {entry.description && (
                            <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {pullTargets.slice(0, 4).map((target) => {
                            const label = target.includes(":") ? target.split(":")[1] : "latest";
                            const pull = pullProgress[target];
                            return pull ? (
                              <span key={target} className="text-[11px] text-muted-foreground px-2">
                                {pull.error ? "error" : `${Math.round(pull.percent)}%`}
                              </span>
                            ) : (
                              <Button key={target} size="sm" variant="outline" className="h-7 text-xs"
                                onClick={() => void handleInstall(target)}>
                                {label}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
