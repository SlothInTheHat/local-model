import React, { Suspense, useRef, useState, useEffect } from "react";
import { Save, ChevronRight, Send, Play, Square, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { FileTree } from "./FileTree";
import { openWorkspace, readFileFromHandle, writeFileToHandle, listDirectory } from "../lib/fileSystem";
import type { FileEntry } from "../lib/fileSystem";
import { runAgentTurn } from "../lib/agentLoop";
import { executeTool, TOOL_DEFINITIONS } from "../lib/tools";
import { streamChat } from "../lib/ollama";
import { supportsNativeTools } from "../lib/modelCapabilities";
import { useAgentStore } from "../store/agent";
import type { editor as MonacoEditorNS } from "monaco-editor";

const MonacoEditor = React.lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default }))
);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact",
  js: "javascript", jsx: "javascriptreact",
  py: "python", rs: "rust", go: "go",
  json: "json", md: "markdown", css: "css",
  html: "html", sh: "shell", yaml: "yaml",
  yml: "yaml", toml: "toml", sql: "sql",
  cpp: "cpp", c: "c", java: "java",
  rb: "ruby", php: "php", cs: "csharp",
  kt: "kotlin", swift: "swift", dart: "dart",
  lua: "lua", r: "r", scala: "scala",
  xml: "xml", bat: "bat", ps1: "powershell",
};

const ALL_LANGUAGES = [
  "plaintext", "typescript", "typescriptreact", "javascript", "javascriptreact",
  "python", "rust", "go", "json", "markdown", "css", "scss", "less", "html",
  "shell", "yaml", "toml", "sql", "cpp", "c", "csharp", "java", "ruby",
  "php", "kotlin", "swift", "dart", "lua", "r", "scala", "xml", "bat",
  "powershell", "dockerfile", "graphql", "ini", "makefile", "perl",
  "protobuf", "terraform",
];

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}

// Render a FileEntry tree as indented text for the system prompt
function formatTree(entries: FileEntry[], prefix: string): string {
  return entries
    .map((e) => {
      const line = prefix + (e.kind === "directory" ? "📁 " : "📄 ") + e.name;
      if (e.kind === "directory" && e.children) {
        return line + "\n" + formatTree(e.children, prefix + "  ");
      }
      return line;
    })
    .join("\n");
}

// Sandboxed JS runner — captures console output
function runJavaScript(code: string): { output: string; error: boolean } {
  const lines: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => lines.push(args.map(toStr).join(" ")),
    error: (...args: unknown[]) => lines.push("ERROR: " + args.map(toStr).join(" ")),
    warn: (...args: unknown[]) => lines.push("WARN: " + args.map(toStr).join(" ")),
    info: (...args: unknown[]) => lines.push("INFO: " + args.map(toStr).join(" ")),
  };
  function toStr(v: unknown) {
    if (typeof v === "object") {
      try { return JSON.stringify(v, null, 2); } catch { return String(v); }
    }
    return String(v);
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("console", code);
    const ret = fn(fakeConsole);
    if (ret !== undefined) lines.push("→ " + toStr(ret));
    return { output: lines.join("\n") || "(no output)", error: false };
  } catch (err) {
    return { output: (err as Error).message, error: true };
  }
}

const CODE_TOOLS = TOOL_DEFINITIONS.filter((t) =>
  (["read_file", "list_directory", "grep_files", "find_files", "write_file"] as string[]).includes(t.name)
);

const WRITE_TOOLS = new Set(["write_file"]);

interface AiMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolError?: boolean;
}

interface CodeEditorProps {
  selectedModel: string;
}

export function CodeEditor({ selectedModel }: CodeEditorProps) {
  const { dirHandle, setWorkspace } = useAgentStore();

  const [fileContent, setFileContent] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [language, setLanguage] = useState<string>("plaintext");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  // AI panel
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [chatPrompt, setChatPrompt] = useState<string>("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(true);
  const aiBottomRef = useRef<HTMLDivElement>(null);

  // Workspace file tree + auto-read markdown docs
  const [workspaceTree, setWorkspaceTree] = useState<string>("");
  const [workspaceDocs, setWorkspaceDocs] = useState<string>("");
  const [treeVersion, setTreeVersion] = useState(0);

  // Run output panel
  const [runOutput, setRunOutput] = useState<{ output: string; error: boolean } | null>(null);
  const [isOutputOpen, setIsOutputOpen] = useState(false);

  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Refresh workspace tree + eagerly read markdown docs when workspace changes
  useEffect(() => {
    if (!dirHandle) {
      setWorkspaceTree("");
      setWorkspaceDocs("");
      return;
    }

    listDirectory(dirHandle, 3)
      .then((entries) => setWorkspaceTree(formatTree(entries, "")))
      .catch(() => setWorkspaceTree("(could not read workspace)"));

    // Read well-known markdown docs in priority order
    const MD_CANDIDATES = [
      "CLAUDE.md", "claude.md",
      "README.md", "readme.md", "README.mdx",
      "CONTRIBUTING.md", "contributing.md",
      "ARCHITECTURE.md", "architecture.md",
      "DEVELOPMENT.md", "development.md",
      "docs/README.md", "docs/OVERVIEW.md",
    ];

    (async () => {
      const found: string[] = [];
      for (const path of MD_CANDIDATES) {
        try {
          const text = await readFileFromHandle(dirHandle, path);
          found.push(`### ${path}\n${text.slice(0, 6000)}${text.length > 6000 ? "\n…(truncated)" : ""}`);
          if (found.length >= 3) break; // cap at 3 docs to avoid overflowing context
        } catch {
          // file doesn't exist, skip
        }
      }
      setWorkspaceDocs(found.join("\n\n"));
    })();
  }, [dirHandle, treeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleOpenDir() {
    try {
      const ws = await openWorkspace();
      setWorkspace(ws.handle, ws.path, ws.name);
      toast.success(`Workspace opened: ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(`Could not open folder: ${e.message}`);
    }
  }

  async function handleOpenFile(_handle: FileSystemFileHandle, path: string) {
    if (!dirHandle) return;
    try {
      const text = await readFileFromHandle(dirHandle, path);
      setFileContent(text);
      setCurrentPath(path);
      setLanguage(detectLanguage(path));
      setRunOutput(null);
      toast.success(`Opened ${path.split("/").pop()}`);
    } catch (err) {
      toast.error(`Could not open file: ${(err as Error).message}`);
    }
  }

  async function handleSave() {
    if (!dirHandle || !currentPath) return;
    setSaveStatus("saving");
    try {
      await writeFileToHandle(dirHandle, currentPath, fileContent);
      setSaveStatus("saved");
      toast.success(`Saved ${currentPath.split("/").pop()}`);
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
      setSaveStatus("idle");
    }
  }

  function handleRun() {
    if (!fileContent.trim()) return;
    if (language === "javascript" || language === "javascriptreact") {
      const result = runJavaScript(fileContent);
      setRunOutput(result);
      setIsOutputOpen(true);
      if (result.error) toast.error("Runtime error");
      else toast.success("Ran successfully");
    } else if (language === "typescript" || language === "typescriptreact") {
      setRunOutput({ output: "TypeScript must be compiled first.\nTip: ask the AI assistant to convert it to JavaScript, then run.", error: true });
      setIsOutputOpen(true);
    } else {
      setRunOutput({ output: `Cannot run ${language} in the browser.\nFor Python, Rust, etc. — use your terminal: run the file directly.`, error: true });
      setIsOutputOpen(true);
    }
  }

  async function handleChatSend() {
    if (!chatPrompt.trim() || !selectedModel || isChatStreaming) return;
    const prompt = chatPrompt.trim();
    setChatPrompt("");

    const userMsg: AiMessage = { role: "user", content: prompt };
    const displayMessages: AiMessage[] = [...aiMessages, userMsg, { role: "assistant", content: "" }];
    setAiMessages(displayMessages);
    setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    setIsChatStreaming(true);
    abortRef.current = new AbortController();

    const toolsSupported = supportsNativeTools(selectedModel);

    // Build system context
    const parts: string[] = [
      "You are a code assistant with full read access to the user's workspace.",
    ];

    if (toolsSupported) {
      parts.push(
        "IMPORTANT RULES:",
        "- Before answering any question about the codebase, use your tools to find relevant files.",
        "- Use grep_files to locate functions, variables, imports, or patterns.",
        "- Use find_files to locate files by name.",
        "- Use read_file to read any file you need — especially markdown docs first.",
        "- Never guess file contents. If unsure, read the file.",
      );
    }

    if (dirHandle) {
      parts.push(`\nWorkspace: ${dirHandle.name}`);

      if (workspaceDocs) {
        parts.push(`\n## Workspace documentation (auto-read on open)\n${workspaceDocs}`);
      }

      if (workspaceTree) {
        parts.push(`\n## File tree\n${workspaceTree}`);
      }
    }

    if (currentPath) {
      parts.push(`\n## Currently open: ${currentPath}\n\`\`\`${language}\n${fileContent}\n\`\`\``);
    }

    // Build Ollama message history (excluding tool chips from display)
    type OllamaMsg = {
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
    };
    let history: OllamaMsg[] = [
      { role: "system", content: parts.join("\n") },
      ...aiMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: prompt },
    ];

    const appendToLastAssistant = (chunk: string) => {
      setAiMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
        }
        return msgs;
      });
      setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
    };

    const setLastAssistantError = (msg: string) => {
      setAiMessages((prev) => {
        const msgs = [...prev];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, content: msg };
        } else {
          msgs.push({ role: "assistant", content: msg });
        }
        return msgs;
      });
    };

    try {
      if (!toolsSupported) {
        // ── Plain streaming — model doesn't support Ollama tool calling ─────────
        for await (const chunk of streamChat(selectedModel, history, abortRef.current.signal)) {
          appendToLastAssistant(chunk);
        }
      } else {
        // ── Agentic loop — model supports tool calling ────────────────────────
        const MAX_TOOL_ROUNDS = 10;
        let round = 0;

        while (round < MAX_TOOL_ROUNDS) {
          round++;
          let gotToolCalls = false;

          for await (const event of runAgentTurn(selectedModel, history, CODE_TOOLS, abortRef.current.signal)) {
            if (event.type === "text_delta" && event.content) {
              appendToLastAssistant(event.content);

            } else if (event.type === "tool_calls" && event.toolCalls) {
              gotToolCalls = true;

              for (const call of event.toolCalls) {
                const label = formatToolLabel(call.name, call.args);

                // Remove any trailing empty assistant placeholder before adding the chip
                setAiMessages((prev) => {
                  const msgs = [...prev];
                  const last = msgs[msgs.length - 1];
                  if (last?.role === "assistant" && !last.content) msgs.pop();
                  return [...msgs, { role: "tool", content: label, toolName: call.name }];
                });
                setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);

                // Write tools require explicit user approval
                if (WRITE_TOOLS.has(call.name)) {
                  const path = typeof call.args["path"] === "string" ? call.args["path"] : String(call.args["path"] ?? "");
                  const approved = window.confirm(
                    `AI wants to write: ${path || "unknown path"}\n\nAllow this file write?`
                  );
                  if (!approved) {
                    const deniedSummary = `${label} → denied`;
                    setAiMessages((prev) => {
                      const msgs = [...prev];
                      let idx = -1;
                      for (let j = msgs.length - 1; j >= 0; j--) {
                        if (msgs[j].role === "tool" && msgs[j].content === label) { idx = j; break; }
                      }
                      if (idx !== -1) msgs[idx] = { role: "tool", content: deniedSummary, toolName: call.name, toolError: true };
                      return msgs;
                    });
                    history = [
                      ...history,
                      { role: "assistant", content: "", tool_calls: [{ function: { name: call.name, arguments: call.args } }] },
                      { role: "tool", content: "Tool call denied by user." },
                    ];
                    continue;
                  }
                }

                const result = await executeTool(call, dirHandle);
                const summary = result.error
                  ? `${label} → error`
                  : summariseToolResult(call.name, result.output);

                setAiMessages((prev) => {
                  const msgs = [...prev];
                  let idx = -1;
                  for (let j = msgs.length - 1; j >= 0; j--) {
                    if (msgs[j].role === "tool" && msgs[j].content === label) { idx = j; break; }
                  }
                  if (idx !== -1) {
                    msgs[idx] = { role: "tool", content: summary, toolName: call.name, toolError: !!result.error };
                  }
                  return msgs;
                });

                if (!result.error && call.name === "write_file") {
                  setTreeVersion((v) => v + 1);
                }

                history = [
                  ...history,
                  {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ function: { name: call.name, arguments: call.args } }],
                  },
                  {
                    role: "tool",
                    content: result.error ? `Error: ${result.error}` : result.output,
                  },
                ];
              }
              break;

            } else if (event.type === "error") {
              setLastAssistantError(`Error: ${event.error}`);
            }
          }

          if (!gotToolCalls) break;

          // Add a single empty assistant bubble for the next round's response
          setAiMessages((prev) => [...prev, { role: "assistant", content: "" }]);
        }
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") setLastAssistantError(`Error: ${e.message}`);
    } finally {
      setIsChatStreaming(false);
      abortRef.current = null;
    }
  }

  function formatToolLabel(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case "read_file": return `📄 read_file: ${args["path"]}`;
      case "list_directory": return `📁 list_directory: ${args["path"] || "."}`;
      case "grep_files": return `🔍 grep_files: "${args["pattern"]}"${args["path"] ? ` in ${args["path"]}` : ""}${args["file_pattern"] ? ` (${args["file_pattern"]})` : ""}`;
      case "find_files": return `🔎 find_files: "${args["pattern"]}"`;
      case "write_file": return `✏️ write_file: ${args["path"]}`;
      default: return `⚙ ${name}`;
    }
  }

  function summariseToolResult(name: string, output: string): string {
    const lines = output.split("\n").length;
    switch (name) {
      case "read_file": return `📄 read_file → ${lines} line${lines !== 1 ? "s" : ""}`;
      case "list_directory": return `📁 list_directory → ${lines} entries`;
      case "grep_files": {
        const m = output.match(/^(\d+) match/);
        return `🔍 grep_files → ${m ? m[0] : `${lines} lines`}`;
      }
      case "find_files": {
        const m = output.match(/^(\d+) file/);
        return `🔎 find_files → ${m ? m[0] : `${lines} results`}`;
      }
      case "write_file": return `✏️ write_file → saved`;
      default: return `⚙ ${name} → done`;
    }
  }

  function handleApplyLastResponse() {
    const editor = editorRef.current;
    const lastAssistant = [...aiMessages].reverse().find((m) => m.role === "assistant");
    if (!editor || !lastAssistant?.content) return;

    // Extract code from markdown code block if present
    const codeMatch = lastAssistant.content.match(/```(?:\w+)?\n([\s\S]*?)```/);
    const code = codeMatch ? codeMatch[1] : lastAssistant.content;

    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      editor.executeEdits("ai-apply", [{ range: selection, text: code, forceMoveMarkers: true }]);
      toast.success("Applied to selection");
    } else {
      // Replace entire file
      const model = editor.getModel();
      if (model) {
        editor.executeEdits("ai-apply", [{
          range: model.getFullModelRange(),
          text: code,
          forceMoveMarkers: true,
        }]);
        toast.success("Applied to file");
      }
    }
  }

  const pathParts = currentPath ? currentPath.split("/") : [];
  const canRun = language === "javascript" || language === "javascriptreact";

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: File tree */}
        <div className="w-[200px] shrink-0 border-r bg-card flex flex-col">
          <FileTree
            dirHandle={dirHandle}
            onOpenFile={handleOpenFile}
            onOpenDir={handleOpenDir}
            refreshKey={treeVersion}
            onRefresh={() => setTreeVersion((v) => v + 1)}
          />
        </div>

        {/* Center: Editor + output */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Top bar */}
          <div className="h-10 border-b bg-card px-3 flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground flex-1 min-w-0 overflow-hidden">
              {dirHandle && (
                <span className="text-foreground font-medium truncate shrink-0">{dirHandle.name}</span>
              )}
              {pathParts.map((part, i) => (
                <React.Fragment key={i}>
                  <ChevronRight className="size-3 shrink-0" />
                  <span className={i === pathParts.length - 1 ? "text-foreground font-medium truncate" : "truncate"}>
                    {part}
                  </span>
                </React.Fragment>
              ))}
              {!currentPath && <span className="italic">No file open</span>}
            </div>

            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="text-xs h-7 px-1.5 rounded border border-border bg-background text-foreground shrink-0 cursor-pointer"
              title="Select language"
            >
              {ALL_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>

            <Button
              size="sm" variant={canRun ? "default" : "outline"}
              className="text-xs h-7 px-2 shrink-0 gap-1"
              onClick={handleRun}
              disabled={!fileContent.trim()}
              title={canRun ? "Run JavaScript (Ctrl+Enter)" : "Run (JS only in browser)"}
            >
              <Play className="size-3" />
              Run
            </Button>

            <Button
              size="sm" variant="outline"
              className="text-xs h-7 px-2 shrink-0"
              onClick={handleSave}
              disabled={!currentPath || saveStatus === "saving"}
            >
              <Save className="size-3 mr-1" />
              {saveStatus === "saved" ? "Saved!" : saveStatus === "saving" ? "Saving…" : "Save"}
            </Button>

            <Button
              size="sm" variant="ghost"
              className="text-xs h-7 px-2 shrink-0"
              onClick={() => setIsChatPanelOpen((v) => !v)}
            >
              AI {isChatPanelOpen ? "▶" : "◀"}
            </Button>
          </div>

          {/* Monaco */}
          <div className="flex-1 min-h-0">
            <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading editor…</div>}>
              <MonacoEditor
                height="100%"
                language={language}
                value={fileContent}
                theme="vs-dark"
                onChange={(v) => setFileContent(v ?? "")}
                onMount={(ed) => {
                  editorRef.current = ed;
                  // Ctrl+Enter to run
                  ed.addCommand(2048 /* Ctrl */ | 3 /* Enter */, () => handleRun());
                  // Ctrl+S to save
                  ed.addCommand(2048 | 49 /* S */, () => void handleSave());
                }}
                options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false }}
              />
            </Suspense>
          </div>

          {/* Output panel */}
          {runOutput && (
            <div className="border-t bg-zinc-950 shrink-0" style={{ maxHeight: isOutputOpen ? 200 : 32 }}>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 h-8 text-xs text-zinc-300 hover:bg-zinc-900 transition-colors"
                onClick={() => setIsOutputOpen((v) => !v)}
              >
                {isOutputOpen ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
                <span className={runOutput.error ? "text-red-400" : "text-green-400"}>
                  {runOutput.error ? "Error" : "Output"}
                </span>
                <span className="text-zinc-500 ml-auto">{currentPath.split("/").pop()}</span>
              </button>
              {isOutputOpen && (
                <pre className="px-3 pb-3 text-xs font-mono overflow-y-auto text-zinc-200 whitespace-pre-wrap"
                  style={{ maxHeight: 168 }}>
                  {runOutput.output}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Right: AI chat panel */}
        {isChatPanelOpen && (
          <div className="w-[280px] shrink-0 border-l bg-card flex flex-col">
            <div className="px-3 py-2 border-b text-xs font-medium text-foreground flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span>AI Assistant</span>
                {!supportsNativeTools(selectedModel) ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">
                    no tools · {selectedModel.split(":")[0]}
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 border border-green-200">
                    tools on
                  </span>
                )}
              </div>
              {aiMessages.length > 0 && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-[10px]"
                  onClick={() => setAiMessages([])}
                >
                  Clear
                </button>
              )}
            </div>

            {/* Conversation */}
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
              {aiMessages.length === 0 && (
                <p className="text-xs text-muted-foreground italic">Ask about this file…</p>
              )}
              {aiMessages.map((msg, i) => {
                if (msg.role === "tool") {
                  return (
                    <div key={i} className="flex justify-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border ${
                        msg.toolError
                          ? "bg-red-50 text-red-600 border-red-200"
                          : "bg-muted text-muted-foreground border-border"
                      }`}>
                        {msg.content}
                      </span>
                    </div>
                  );
                }
                return (
                  <div key={i} className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}>
                    <div className={`max-w-full rounded-lg px-2.5 py-1.5 text-xs ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground font-mono whitespace-pre-wrap"
                    }`}>
                      {msg.content || <span className="animate-pulse">▌</span>}
                    </div>
                  </div>
                );
              })}
              <div ref={aiBottomRef} />
            </div>

            {/* Apply button */}
            {aiMessages.some((m) => m.role === "assistant" && m.content) && (
              <div className="px-3 py-1.5 border-t">
                <Button size="sm" variant="outline" className="w-full text-xs h-7" onClick={handleApplyLastResponse}>
                  Apply to {editorRef.current?.getSelection()?.isEmpty() === false ? "selection" : "file"}
                </Button>
              </div>
            )}

            {/* Input */}
            <div className="p-3 border-t space-y-2">
              <Textarea
                value={chatPrompt}
                onChange={(e) => setChatPrompt(e.target.value)}
                placeholder={selectedModel ? "Ask about this code…" : "No model selected"}
                rows={3}
                className="text-xs min-h-[60px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); }
                }}
              />
              <div className="flex gap-2">
                <Button
                  size="sm" className="flex-1 text-xs h-7"
                  onClick={() => void handleChatSend()}
                  disabled={!chatPrompt.trim() || isChatStreaming || !selectedModel}
                >
                  <Send className="size-3 mr-1" />
                  {isChatStreaming ? "…" : "Send"}
                </Button>
                {isChatStreaming && (
                  <Button size="sm" variant="outline" className="text-xs h-7 px-2"
                    onClick={() => abortRef.current?.abort()}>
                    <Square className="size-3" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
