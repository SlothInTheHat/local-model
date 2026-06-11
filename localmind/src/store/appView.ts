import { create } from "zustand";
import type { AppView } from "../types/app";

interface AppViewState {
  view: AppView;
  mountedViews: Set<AppView>;
  setView: (v: AppView) => void;
}

export const useAppViewStore = create<AppViewState>()((set) => ({
  view: "chat",
  mountedViews: new Set<AppView>(),
  setView: (v) =>
    set((s) => {
      const next = new Set(s.mountedViews);
      next.add(v);
      return { view: v, mountedViews: next };
    }),
}));
