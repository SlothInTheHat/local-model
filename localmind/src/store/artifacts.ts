import { create } from "zustand";

/** Cap on stored artifacts — oldest dropped first. Not persisted (see below):
 *  a stale blob-sized HTML payload surviving a restart isn't worth the
 *  localStorage cost, and ChatMessages.tsx already degrades gracefully to a
 *  plain text chip when a referenced artifact id is missing. */
const MAX_ARTIFACTS = 30;

export interface ArtifactRecord {
  id: string;
  kind: "canvas" | "plot" | "webpage" | "table";
  title?: string;
  /** canvas/plot: a complete self-contained HTML document. webpage (reader-view fallback): sanitized readable HTML. */
  html?: string;
  /** webpage only: the live URL to iframe, when framing isn't blocked. */
  url?: string;
  /** webpage only: true when the live iframe was skipped in favor of `html` (reader view) because the site's headers forbid framing. */
  blocked?: boolean;
  /** table only. */
  columns?: string[];
  rows?: unknown[][];
  createdAt: number;
}

interface ArtifactState {
  byId: Record<string, ArtifactRecord>;
  order: string[]; // insertion order, oldest first — drives the MAX_ARTIFACTS eviction
  add: (rec: Omit<ArtifactRecord, "id" | "createdAt"> & { id?: string }) => string;
  get: (id: string) => ArtifactRecord | undefined;
}

/** Deliberately NOT persisted — this store exists only within the running
 *  session's lifetime, same tradeoff as useModelStore's pullProgress. Chat
 *  history (which references artifacts by id in the [[LM_ARTIFACT:id]]
 *  marker) IS persisted, so a restart always hits the graceful-degradation
 *  path in ChatMessages.tsx rather than a stale-but-present blob. */
export const useArtifactStore = create<ArtifactState>()((set, get) => ({
  byId: {},
  order: [],
  add: (rec) => {
    const id = rec.id ?? crypto.randomUUID();
    const full: ArtifactRecord = { ...rec, id, createdAt: Date.now() };
    set((s) => {
      const order = [...s.order.filter((existing) => existing !== id), id];
      const byId = { ...s.byId, [id]: full };
      while (order.length > MAX_ARTIFACTS) {
        const dropped = order.shift();
        if (dropped) delete byId[dropped];
      }
      return { byId, order };
    });
    return id;
  },
  get: (id) => get().byId[id],
}));
