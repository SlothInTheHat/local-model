import { useEffect, useState } from "react";
import { Cpu, MemoryStick, Monitor, Zap, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { detectHardware } from "../lib/hardware";
import { useModelStore } from "../store/models";

export function HardwareSummary() {
  const { hardware, isScanning, vramOverride, setHardware, setScanning, setVramOverride } =
    useModelStore();
  const [editingVram, setEditingVram] = useState(false);
  const [vramInput, setVramInput] = useState("");

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
