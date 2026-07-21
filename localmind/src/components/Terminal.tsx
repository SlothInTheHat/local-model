import { useEffect, useRef, useState, useCallback } from "react";
import { Trash2, Square, TerminalSquare } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";
import { useAgentStore } from "../store/agent";

interface TerminalLine {
  id: number;
  type: "input" | "output" | "error" | "info";
  text: string;
  cwd?: string;
}

// Tauri invoke shim — works in desktop mode, no-ops in browser
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as { invoke?: (cmd: string, args?: unknown) => Promise<T> };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

const isTauri = (): boolean =>
  !!(window as unknown as Record<string, unknown>).__TAURI__;

let lineIdCounter = 0;
function nextId() { return ++lineIdCounter; }

const MAX_OUTPUT = 20_000;

function sanitizeOutput(raw: string): string {
  // Strip null bytes and non-printable control chars (keep newline/tab/CR)
  const clean = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (clean.length <= MAX_OUTPUT) return clean;
  return clean.slice(0, MAX_OUTPUT) + `\n… (output truncated at ${MAX_OUTPUT} chars)`;
}

interface TerminalProps {
  /** Allow external callers (agent) to push a command to execute */
  onRegisterRunner?: (run: (cmd: string) => Promise<string>) => void;
}

export function Terminal({ onRegisterRunner }: TerminalProps) {
  const [lines, setLines] = useState<TerminalLine[]>([
    {
      id: nextId(),
      type: "info",
      text: isTauri()
        ? "LocalMind Terminal — type commands below (runs on your system)"
        : "LocalMind Terminal — command execution requires Tauri desktop mode (npm run tauri dev)",
    },
  ]);
  const { workspacePath } = useAgentStore();

  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const historyIdxRef = useRef(-1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  // Set cwd to workspace root when available, otherwise app cwd
  useEffect(() => {
    if (!isTauri()) return;
    const target = workspacePath ?? null;
    if (target) {
      setCwd(target);
    } else {
      tauriInvoke<string>("get_cwd").then(setCwd).catch(() => {});
    }
  }, [workspacePath]);

  function appendLine(line: Omit<TerminalLine, "id">) {
    setLines((prev) => [...prev, { ...line, id: nextId() }]);
  }

  const runCommand = useCallback(async (cmd: string): Promise<string> => {
    if (!cmd.trim()) return "";

    appendLine({ type: "input", text: cmd, cwd });

    if (!isTauri()) {
      const msg = "Terminal requires Tauri desktop mode — launch with: npm run tauri dev";
      appendLine({ type: "error", text: msg });
      return msg;
    }

    setRunning(true);
    abortRef.current = new AbortController();
    try {
      const result = await tauriInvoke<{ stdout: string; stderr: string; cwd: string; sandbox_blocked: boolean }>(
        "run_command",
        // Confinement is enforced Rust-side against the registered workspace
        // root(s); the cwd must already sit inside one of them.
        { cmd: cmd.trim(), cwd: cwd || undefined }
      );
      if (result.stdout) appendLine({ type: "output", text: sanitizeOutput(result.stdout) });
      if (result.stderr) appendLine({ type: "error", text: sanitizeOutput(result.stderr) });
      if (result.sandbox_blocked) appendLine({ type: "error", text: "⚠ Workspace sandbox: cannot navigate above workspace root." });
      if (result.cwd && result.cwd !== cwd) setCwd(result.cwd);
      return (result.stdout + result.stderr).trim();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      appendLine({ type: "error", text: msg });
      return `Error: ${msg}`;
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [cwd]);

  // Register the runner for external callers (agent tool)
  useEffect(() => {
    onRegisterRunner?.(runCommand);
  }, [onRegisterRunner, runCommand]);

  async function handleSubmit() {
    const cmd = input.trim();
    if (!cmd || running) return;
    setInput("");
    historyIdxRef.current = -1;
    setHistory((prev) => [cmd, ...prev].slice(0, 100));
    await runCommand(cmd);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { void handleSubmit(); return; }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIdxRef.current + 1, history.length - 1);
      historyIdxRef.current = next;
      setInput(history[next] ?? "");
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = next;
      setInput(next === -1 ? "" : history[next] ?? "");
    }
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-200 font-mono text-xs">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-zinc-800 shrink-0">
        <TerminalSquare className="size-4 text-zinc-400" />
        <span className="text-zinc-400 text-xs">Terminal</span>
        {!isTauri() && (
          <span className="text-amber-400 text-[10px] ml-1">
            (browser mode — launch with npm run tauri dev for real execution)
          </span>
        )}
        <div className="flex-1" />
        {running && (
          <Button
            size="sm" variant="ghost"
            className="h-6 px-2 text-xs text-zinc-400 hover:text-red-400"
            onClick={() => abortRef.current?.abort()}
          >
            <Square className="size-3 mr-1" /> Kill
          </Button>
        )}
        <Button
          size="sm" variant="ghost"
          className="h-6 px-2 text-xs text-zinc-400 hover:text-zinc-200"
          onClick={() => setLines([])}
          title="Clear terminal"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>

      {/* Output */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((line) => (
          <div
            key={line.id}
            className={cn(
              "whitespace-pre-wrap break-all leading-5",
              line.type === "input" && "text-cyan-300",
              line.type === "output" && "text-zinc-200",
              line.type === "error" && "text-red-400",
              line.type === "info" && "text-zinc-500 italic",
            )}
          >
            {line.type === "input" ? (
              <span>
                <span className="text-green-400">{line.cwd ? `${line.cwd}` : ""}</span>
                <span className="text-zinc-400">{line.cwd ? "> " : "> "}</span>
                {line.text}
              </span>
            ) : (
              line.text
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input line */}
      <div className="flex items-center gap-0 px-3 h-9 border-t border-zinc-800 shrink-0">
        <span className="text-green-400 shrink-0 select-none">
          {cwd || "~"}
        </span>
        <span className="text-zinc-400 shrink-0 select-none mr-1">&gt;</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
          placeholder={running ? "running…" : "enter command"}
          autoFocus
          spellCheck={false}
          className="flex-1 bg-transparent outline-none text-cyan-200 placeholder:text-zinc-600 min-w-0"
        />
        {running && (
          <span className="animate-pulse text-zinc-500 ml-2">▌</span>
        )}
      </div>
    </div>
  );
}
