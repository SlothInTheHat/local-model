export interface HardwareInfo {
  cpuThreads: number;
  ramGb: number;
  gpuName: string;
  vramGb: number; // 0 = unknown / integrated
}

interface TauriGpuInfo {
  name: string;
  vram_mb: number;
}

// Tauri invoke shim — works in desktop mode, no-ops in browser
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as { invoke?: (cmd: string, args?: unknown) => Promise<T> };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

// Best-effort VRAM lookup from GPU renderer string (fallback for browser/dev mode)
function estimateVram(renderer: string): number {
  const s = renderer.toLowerCase();

  const table: [RegExp, number][] = [
    // NVIDIA RTX 40-series
    [/rtx\s*4090/, 24], [/rtx\s*4080/, 16],
    [/rtx\s*4070\s*ti/, 12], [/rtx\s*4070/, 12],
    [/rtx\s*4060\s*ti/, 8], [/rtx\s*4060/, 8],
    // NVIDIA RTX 30-series
    [/rtx\s*3090/, 24], [/rtx\s*3080\s*ti/, 12],
    [/rtx\s*3080/, 10], [/rtx\s*3070\s*ti/, 8],
    [/rtx\s*3070/, 8], [/rtx\s*3060\s*ti/, 8],
    [/rtx\s*3060/, 12],
    // NVIDIA RTX 20-series
    [/rtx\s*2080\s*ti/, 11], [/rtx\s*2080/, 8],
    [/rtx\s*2070/, 8], [/rtx\s*2060/, 6],
    // NVIDIA GTX 10-series
    [/gtx\s*1080\s*ti/, 11], [/gtx\s*1080/, 8],
    [/gtx\s*1070\s*ti/, 8], [/gtx\s*1070/, 8],
    [/gtx\s*1060\s*6gb/, 6], [/gtx\s*1060/, 6],
    [/gtx\s*1050\s*ti/, 4], [/gtx\s*1050/, 4],
    // AMD RX 7000-series
    [/rx\s*7900\s*xtx/, 24], [/rx\s*7900\s*xt/, 20],
    [/rx\s*7800\s*xt/, 16], [/rx\s*7700\s*xt/, 12],
    [/rx\s*7600/, 8],
    // AMD RX 6000-series
    [/rx\s*6900\s*xt/, 16], [/rx\s*6800\s*xt/, 16],
    [/rx\s*6800/, 16], [/rx\s*6700\s*xt/, 12],
    [/rx\s*6650\s*xt/, 8], [/rx\s*6600\s*xt/, 8],
    [/rx\s*6600/, 8], [/rx\s*6500\s*xt/, 4],
    // AMD RX 5000-series
    [/rx\s*5700\s*xt/, 8], [/rx\s*5700/, 8],
    [/rx\s*5600\s*xt/, 6], [/rx\s*580/, 8],
    // Intel Arc
    [/arc\s*a770/, 16], [/arc\s*a750/, 8],
    [/arc\s*a580/, 8], [/arc\s*a380/, 6],
    // Apple Silicon (unified memory — conservative estimate)
    [/apple m[234]\s*ultra/, 64],
    [/apple m[234]\s*max/, 36],
    [/apple m[234]\s*pro/, 18],
    [/apple m[1234]/, 16],
  ];

  for (const [re, vram] of table) {
    if (re.test(s)) return vram;
  }
  return 0; // unknown / integrated
}

function webglGpuInfo(): { gpuName: string; vramGb: number } {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl") as WebGLRenderingContext | null) ??
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);

    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) {
        const gpuName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
        return { gpuName, vramGb: estimateVram(gpuName) };
      }
    }
  } catch {
    // WebGL not available
  }
  return { gpuName: "Unknown GPU", vramGb: 0 };
}

export async function detectHardware(): Promise<HardwareInfo> {
  const cpuThreads = navigator.hardwareConcurrency ?? 4;
  const ramGb = Math.round((navigator as unknown as Record<string, number>).deviceMemory ?? 4);

  // Try native GPU query via Tauri first (accurate VRAM from OS)
  try {
    const gpus = await tauriInvoke<TauriGpuInfo[]>("get_gpu_info");
    // Pick the GPU with the most VRAM (skip pure integrated adapters with 0 MB)
    const best = gpus
      .filter((g) => g.name.trim().length > 0)
      .sort((a, b) => b.vram_mb - a.vram_mb)[0];

    if (best) {
      return {
        cpuThreads,
        ramGb,
        gpuName: best.name,
        vramGb: Math.round(best.vram_mb / 1024),
      };
    }
  } catch {
    // Not in Tauri or command failed — fall through to WebGL
  }

  // Fallback: derive GPU name + VRAM estimate from WebGL renderer string
  const { gpuName, vramGb } = webglGpuInfo();
  return { cpuThreads, ramGb, gpuName, vramGb };
}
