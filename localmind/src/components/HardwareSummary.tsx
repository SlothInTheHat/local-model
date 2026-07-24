import { useEffect, useState } from "react";
import { Cpu, MemoryStick, Monitor, Zap, RefreshCw, AlertCircle, CheckCircle2, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { detectHardware } from "../lib/hardware";
import { listRunningModels, probeModelLoad, type RunningModel } from "../lib/ollama";
import { useModelStore } from "../store/models";
import { useModelSelectionStore } from "../store/modelSelection";

// ─── Tauri invoke shim (mirrors the pattern used in src/lib/tools.ts / AppSettings.tsx) ──

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

const RUNNING_MODELS_POLL_MS = 8000;

export function HardwareSummary() {
  const { hardware, isScanning, vramOverride, setHardware, setScanning, setVramOverride } =
    useModelStore();
  const [editingVram, setEditingVram] = useState(false);
  const [vramInput, setVramInput] = useState("");
  const [runningModels, setRunningModels] = useState<RunningModel[] | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [checkingGpu, setCheckingGpu] = useState(false);
  const selectedModel = useModelSelectionStore((s) => s.selectedModel);

  async function scan() {
    setScanning(true);
    try {
      const hw = await detectHardware();
      setHardware(hw);
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    if (!hardware) scan();
  }, []);

  // GPU-usage signal: /api/ps reports each currently-loaded model's size_vram
  // vs total size — Ollama's own record of whether it put that model on GPU,
  // partially offloaded it, or ran it fully on CPU. Polled periodically since
  // this can change any time a new generation starts (not just once on mount)
  // and there's no push/event API for it. Empty array (nothing loaded right
  // now) is a real, valid state — distinct from null (haven't checked, or
  // Ollama unreachable), which is why a failed fetch resets to null rather
  // than pretending "nothing running."
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const models = await listRunningModels();
        if (!cancelled) setRunningModels(models);
      } catch {
        if (!cancelled) setRunningModels(null);
      }
    }
    void poll();
    const id = setInterval(poll, RUNNING_MODELS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function handleRestartOllama() {
    setRestarting(true);
    try {
      await tauriInvoke<string>("restart_ollama");
      toast.success("Ollama restarted — it will now pick up any GPU change.");
      setRunningModels(null);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to restart Ollama");
    } finally {
      setRestarting(false);
    }
  }

  // "Check GPU now": /api/ps only reports something while a model is
  // actually loaded, which is otherwise only true for a few minutes after a
  // real chat message — most of the time it just reads "idle." This forces a
  // 1-token generation on whatever model is currently selected so the status
  // above reflects reality on demand, instead of waiting for you to chat.
  const canCheckGpu = selectedModel.length > 0 && !selectedModel.includes("::");

  async function handleCheckGpuNow() {
    if (!canCheckGpu) {
      toast.error("Select a local Ollama model in Chat first — this can't check a cloud-provider model.");
      return;
    }
    setCheckingGpu(true);
    try {
      await probeModelLoad(selectedModel);
      const models = await listRunningModels();
      setRunningModels(models);
    } catch (err) {
      toast.error((err as Error).message ?? "GPU check failed");
    } finally {
      setCheckingGpu(false);
    }
  }

  const effectiveVram = vramOverride ?? hardware?.vramGb ?? 0;

  function commitVram() {
    const n = parseFloat(vramInput);
    setVramOverride(isNaN(n) || n <= 0 ? null : n);
    setEditingVram(false);
  }

  if (!hardware && isScanning) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <RefreshCw className="size-4 animate-spin" />
        Scanning hardware…
      </div>
    );
  }

  if (!hardware) {
    return (
      <Button onClick={scan} variant="outline" size="sm" className="gap-2">
        <Zap className="size-4" />
        Scan Hardware
      </Button>
    );
  }

  // Cross-reference OS-level GPU detection (hardware.vramGb, independent of
  // Ollama) against what Ollama itself is actually doing right now
  // (runningModels' size_vram) — a GPU present but every loaded model at
  // size_vram:0 means Ollama started before the GPU was available and hasn't
  // re-probed since (it only detects hardware once, at its own startup).
  const hasGpu = effectiveVram > 0;
  const gpuStatus: { kind: "unknown" | "idle" | "mismatch" | "gpu" | "cpu" } = (() => {
    if (runningModels === null) return { kind: "unknown" };
    if (runningModels.length === 0) return { kind: "idle" };
    const anyOnCpu = runningModels.some((m) => m.size_vram === 0);
    if (anyOnCpu && hasGpu) return { kind: "mismatch" };
    if (anyOnCpu) return { kind: "cpu" };
    return { kind: "gpu" };
  })();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-3">
        <MetricCard icon={<Cpu className="size-4" />} label="CPU" value={`${hardware.cpuThreads} threads`} />
        <MetricCard icon={<MemoryStick className="size-4" />} label="RAM" value={`${hardware.ramGb} GB`} />
        <MetricCard
          icon={<Monitor className="size-4" />}
          label="GPU"
          value={hardware.gpuName === "Unknown GPU" ? "Unknown" : hardware.gpuName}
          truncate
        />
        {/* VRAM — click to override */}
        <Card>
          <CardContent className="p-3 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap className="size-3.5" />
              VRAM
              {vramOverride !== null && (
                <span className="ml-auto text-[10px] text-warning font-medium">override</span>
              )}
            </div>
            {editingVram ? (
              <input
                autoFocus
                type="number"
                value={vramInput}
                onChange={(e) => setVramInput(e.target.value)}
                onBlur={commitVram}
                onKeyDown={(e) => e.key === "Enter" && commitVram()}
                placeholder="GB"
                className="w-full text-sm font-semibold bg-input-background border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
            ) : (
              <button
                onClick={() => {
                  setVramInput(String(effectiveVram || ""));
                  setEditingVram(true);
                }}
                title="Click to set manually"
                className="text-left text-sm font-semibold text-foreground hover:text-primary transition-colors truncate"
              >
                {effectiveVram > 0 ? `${effectiveVram} GB` : "Unknown"}
              </button>
            )}
          </CardContent>
        </Card>
      </div>

      {/* GPU-in-use signal + manual restart (Ollama only detects GPUs at its
          own startup — toggling a hybrid/discrete GPU on later needs this). */}
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs min-w-0">
          {gpuStatus.kind === "mismatch" && (
            <>
              <AlertCircle className="size-3.5 text-warning shrink-0" />
              <span className="text-warning font-medium truncate">
                Ollama is running on CPU despite {hardware.gpuName} being available — it likely started before the GPU was on.
              </span>
            </>
          )}
          {gpuStatus.kind === "gpu" && (
            <>
              <CheckCircle2 className="size-3.5 text-success shrink-0" />
              <span className="text-muted-foreground">Ollama is using your GPU.</span>
            </>
          )}
          {gpuStatus.kind === "cpu" && (
            <>
              <PowerOff className="size-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Running on CPU (no GPU detected).</span>
            </>
          )}
          {gpuStatus.kind === "idle" && (
            <span className="text-muted-foreground">No model loaded right now — GPU status shows once one runs.</span>
          )}
          {gpuStatus.kind === "unknown" && (
            <span className="text-muted-foreground">Checking Ollama GPU usage…</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {gpuStatus.kind === "idle" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleCheckGpuNow()}
              disabled={checkingGpu || !canCheckGpu}
              className="gap-1.5 h-7 text-xs"
              title={canCheckGpu ? `Run a 1-token test on ${selectedModel} to check now` : "Select a local model in Chat first"}
            >
              <Zap className={`size-3 ${checkingGpu ? "animate-pulse" : ""}`} />
              {checkingGpu ? "Checking…" : "Check GPU now"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRestartOllama()}
            disabled={restarting}
            className="gap-1.5 h-7 text-xs"
            title="Kill and relaunch Ollama so it re-detects your GPU — interrupts any generation in progress"
          >
            <RefreshCw className={`size-3 ${restarting ? "animate-spin" : ""}`} />
            {restarting ? "Restarting…" : "Restart Ollama"}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {effectiveVram === 0 && (
            <>
              <AlertCircle className="size-3.5 text-warning" />
              VRAM unknown — click the VRAM card to set it manually
            </>
          )}
          {effectiveVram > 0 && (
            <span>
              GPU-ready for models up to{" "}
              <span className="font-medium text-foreground">{Math.floor(effectiveVram * 0.95)} GB</span>
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={scan}
          disabled={isScanning}
          className="gap-1.5 h-7 text-xs"
        >
          <RefreshCw className={`size-3 ${isScanning ? "animate-spin" : ""}`} />
          Re-scan
        </Button>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  truncate,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  truncate?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-3 flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <span className={`text-sm font-semibold text-foreground ${truncate ? "truncate" : ""}`} title={value}>
          {value}
        </span>
      </CardContent>
    </Card>
  );
}
