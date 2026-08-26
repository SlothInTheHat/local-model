import * as Dialog from "@radix-ui/react-dialog";
import {
  Brain, FolderOpen, MessageSquare, Microscope, Bot, ImageIcon, AlertCircle, Download,
} from "lucide-react";
import { Button } from "./ui/button";
import { useOnboardingStore } from "../store/onboarding";
import { useAgentStore } from "../store/agent";
import { openWorkspace } from "../lib/fileSystem";
import { toast } from "sonner";

interface Props {
  /** Live Ollama connection status from App.tsx's initOllama — shown inline
   *  here instead of only as a toast, so a first-run user with Ollama not
   *  yet installed/running gets a clear next step instead of just an empty
   *  chat view and a banner they may not connect to "why is nothing working." */
  ollamaError: string | null;
  /** True when ollamaError specifically means "Ollama is up but CORS-rejecting
   *  this app's origin" (see isOllamaCorsBlocked in lib/ollama.ts) — the
   *  guidance below branches on this since "install and start Ollama" is
   *  actively wrong when Ollama is already running. */
  ollamaCorsBlocked?: boolean;
}

const HIGHLIGHTS: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <MessageSquare className="size-4" />,
    title: "Chat & Code",
    body: "Conversational chat with optional agent tools, plus a full Monaco code editor with its own agent loop.",
  },
  {
    icon: <Microscope className="size-4" />,
    title: "Research & Knowledge",
    body: "Deep multi-step web research, and per-class knowledge bases built from your own documents.",
  },
  {
    icon: <Bot className="size-4" />,
    title: "Automation",
    body: "Scheduled jobs, saved workflows, and subagents that run tasks unattended in the background.",
  },
  {
    icon: <ImageIcon className="size-4" />,
    title: "Everyday tools",
    body: "An image editor, a document editor, cross-project memory, and more — all listed in the tab bar.",
  },
];

export function Onboarding({ ollamaError, ollamaCorsBlocked }: Props) {
  const { complete } = useOnboardingStore();
  const { setWorkspace } = useAgentStore();

  async function handleOpenWorkspace() {
    try {
      const ws = await openWorkspace();
      setWorkspace(ws.handle, ws.path, ws.name);
      toast.success(`Workspace opened: ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(`Could not open folder: ${e.message}`);
      return; // let them try again from the dialog rather than dismissing on failure
    }
    complete();
  }

  return (
    <Dialog.Root open onOpenChange={(v) => !v && complete()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-[200]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[201] w-full max-w-xl bg-card border rounded-2xl shadow-lg p-6 space-y-5 focus:outline-none max-h-[85vh] overflow-y-auto">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-primary flex items-center justify-center shrink-0">
              <Brain className="size-5 text-primary-foreground" />
            </div>
            <div>
              <Dialog.Title className="text-base font-semibold text-foreground">
                Welcome to LocalMind
              </Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                A local, private AI assistant — chat, code, research, and automate, all running on your own machine.
              </Dialog.Description>
            </div>
          </div>

          {ollamaError && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/30 text-warning text-xs">
              <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
              <span>
                {ollamaCorsBlocked ? (
                  <>
                    {ollamaError} This happens with an Ollama instance you started yourself (outside LocalMind) whose
                    CORS policy doesn't allow this app's origin — LocalMind only sets this automatically for
                    Ollama instances it launches itself. Fix: set the{" "}
                    <code className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10">OLLAMA_ORIGINS</code>{" "}
                    environment variable to include{" "}
                    <code className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10">http://tauri.localhost</code>{" "}
                    (Windows) or{" "}
                    <code className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10">tauri://localhost</code>{" "}
                    (macOS/Linux) and restart Ollama, then come back here.
                  </>
                ) : (
                  <>
                    {ollamaError} LocalMind runs models through{" "}
                    <a href="https://ollama.com" target="_blank" rel="noreferrer" className="underline">
                      Ollama
                    </a>{" "}
                    — install and start it, then come back here. You can still look around in the meantime.
                    If Ollama is already installed and this still won't go away, open the Models tab and click "Log" next to Restart Ollama to see the actual error.
                  </>
                )}
              </span>
            </div>
          )}

          <div className="rounded-lg border bg-muted/40 p-3 space-y-1.5">
            <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Download className="size-3.5" /> What you'll need installed separately
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              LocalMind is a shell around software that runs on your machine — it doesn't bundle any of this itself:
            </p>
            <ul className="text-xs text-muted-foreground leading-relaxed list-disc pl-4 space-y-1">
              <li>
                <a href="https://ollama.com" target="_blank" rel="noreferrer" className="underline text-foreground">
                  Ollama
                </a>{" "}
                — <strong>required</strong>. Every model LocalMind runs (chat, code, vision, embeddings) goes through
                it. Install it and make sure it's running before you start.
              </li>
              <li>
                <a href="https://nodejs.org" target="_blank" rel="noreferrer" className="underline text-foreground">
                  Node.js
                </a>{" "}
                — optional, only needed if you connect an MCP integration in Settings (Gmail, Drive, Calendar,
                Canvas, browser control). Everything else works without it.
              </li>
            </ul>
          </div>

          <div className="rounded-lg border bg-muted/40 p-3 space-y-1.5">
            <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <FolderOpen className="size-3.5" /> Workspaces
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Most tabs (Code, Docs, Terminal, Skills, History) work on a <strong>workspace</strong> — a folder on
              your computer the agent can read and write. Open one now, or skip it and start chatting right away;
              you can open a workspace later from any of those tabs.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {HIGHLIGHTS.map((h) => (
              <div key={h.title} className="flex gap-2 items-start">
                <div className="size-7 rounded-lg bg-accent flex items-center justify-center shrink-0 text-foreground">
                  {h.icon}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">{h.title}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug">{h.body}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground text-center">
            Not sure where to start? Just ask chat something like <em>"what can you do?"</em> — it can give you a
            full rundown of every feature and tool it has access to.
          </p>

          <div className="flex gap-2 pt-1">
            <Button className="flex-1 gap-1.5" onClick={() => void handleOpenWorkspace()}>
              <FolderOpen className="size-4" /> Open a workspace folder
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => complete()}>
              Skip for now
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
