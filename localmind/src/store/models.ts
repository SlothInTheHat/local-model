import { create } from "zustand";
import type { HardwareInfo } from "../lib/hardware";

export interface PullProgress {
  status: string;
  percent: number;
  error?: string;
}

interface ModelStore {
  hardware: HardwareInfo | null;
  isScanning: boolean;
  vramOverride: number | null; // user-set VRAM override in GB
  pullProgress: Record<string, PullProgress>; // modelId → progress

  setHardware: (hw: HardwareInfo) => void;
  setScanning: (v: boolean) => void;
  setVramOverride: (gb: number | null) => void;
  setPullProgress: (id: string, p: PullProgress) => void;
  clearPullProgress: (id: string) => void;
}

export const useModelStore = create<ModelStore>((set) => ({
  hardware: null,
  isScanning: false,
  vramOverride: null,
  pullProgress: {},

  setHardware: (hw) => set({ hardware: hw }),
  setScanning: (v) => set({ isScanning: v }),
  setVramOverride: (gb) => set({ vramOverride: gb }),

  setPullProgress: (id, p) =>
    set((s) => ({ pullProgress: { ...s.pullProgress, [id]: p } })),

  clearPullProgress: (id) =>
    set((s) => {
      const next = { ...s.pullProgress };
      delete next[id];
      return { pullProgress: next };
    }),
}));
