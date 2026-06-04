import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ResearchReport, ResearchChatMessage } from "../lib/research";

interface ResearchState {
  reports: ResearchReport[];
  activeReportId: string | null;

  addReport: (report: ResearchReport) => void;
  updateReport: (id: string, patch: Partial<ResearchReport>) => void;
  deleteReport: (id: string) => void;
  selectReport: (id: string | null) => void;
  addChatMessage: (reportId: string, msg: ResearchChatMessage) => void;
  appendToLastChat: (reportId: string, text: string) => void;
}

export const useResearchStore = create<ResearchState>()(
  persist(
    (set) => ({
      reports: [],
      activeReportId: null,

      addReport: (report) =>
        set((s) => ({ reports: [report, ...s.reports], activeReportId: report.id })),

      updateReport: (id, patch) =>
        set((s) => ({
          reports: s.reports.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        })),

      deleteReport: (id) =>
        set((s) => {
          const reports = s.reports.filter((r) => r.id !== id);
          return { reports, activeReportId: s.activeReportId === id ? (reports[0]?.id ?? null) : s.activeReportId };
        }),

      selectReport: (id) => set({ activeReportId: id }),

      addChatMessage: (reportId, msg) =>
        set((s) => ({
          reports: s.reports.map((r) =>
            r.id === reportId
              ? { ...r, chatMessages: [...(r.chatMessages ?? []), msg] }
              : r
          ),
        })),

      appendToLastChat: (reportId, text) =>
        set((s) => ({
          reports: s.reports.map((r) => {
            if (r.id !== reportId) return r;
            const msgs = [...(r.chatMessages ?? [])];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return r;
            msgs[msgs.length - 1] = { ...last, content: last.content + text };
            return { ...r, chatMessages: msgs };
          }),
        })),
    }),
    {
      name: "localmind-research",
      partialize: (s) => ({
        reports: s.reports.filter((r) => r.status === "done"),
        activeReportId: s.activeReportId,
      }),
    }
  )
);
