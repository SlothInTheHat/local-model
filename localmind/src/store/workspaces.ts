import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

interface WorkspacesState {
  recent: RecentWorkspace[];
  addRecent: (path: string, name: string) => void;
  removeRecent: (path: string) => void;
}

const MAX_RECENT = 10;

export const useWorkspacesStore = create<WorkspacesState>()(
  persist(
    (set) => ({
      recent: [],
      addRecent: (path, name) =>
        set((s) => ({
          recent: [
            { path, name, lastOpened: Date.now() },
            ...s.recent.filter((w) => w.path !== path),
          ].slice(0, MAX_RECENT),
        })),
      removeRecent: (path) =>
        set((s) => ({ recent: s.recent.filter((w) => w.path !== path) })),
    }),
    { name: "localmind-workspaces" }
  )
);
