import { useRef, useState, useCallback, useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { MathInline, MathBlock, setEditorContentWithMath } from "../lib/tiptapMath";
import { CommentMark, reanchorComments, findCommentRange, removeCommentMark } from "../lib/tiptapComment";
import { useDocCommentsStore } from "../store/docComments";
import { DocFloatingComments } from "./DocFloatingComments";
import { DocAiSuggestionCard } from "./DocAiSuggestionCard";
import { DocSelectionMenu, type PresetAction } from "./DocSelectionMenu";
import { MessageSquarePlus, MessageSquare } from "lucide-react";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  List,
  Code,
  Copy,
  Download,
  ChevronDown,
  CheckCircle,
  X,
  Save,
  FileText,
} from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";
import { FileTree } from "./FileTree";
import { streamChatForModel } from "../lib/chatProvider";
import { useModelSelectionStore } from "../store/modelSelection";
import { useAgentStore } from "../store/agent";
import { openWorkspace, readFileFromHandle, writeFileToHandle } from "../lib/fileSystem";
import { docToBlocks, blocksToDocxBlob, blocksToPdfBlob } from "../lib/docExport";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

type AiAction = "/improve" | "/expand" | "/summarize";

const AI_ACTION_LABELS: Record<AiAction, string> = {
  "/improve": "Improve writing",
  "/expand": "Expand",
  "/summarize": "Summarize",
};

const AI_ACTION_PROMPTS: Record<AiAction, string> = {
  "/improve":
    "Improve the writing of the following text. Return only the improved version, no commentary:\n\n",
  "/expand":
    "Expand the following text with more detail and depth. Return only the expanded version:\n\n",
  "/summarize":
    "Summarize the following text concisely. Return only the summary:\n\n",
};

interface OpenDocTab { path: string; content: string; isDirty: boolean; }

/** The old single-scratchpad storage key, from before Docs was workspace/file-backed. */
const LEGACY_DOC_STORAGE_KEY = "localmind-doc-content";

// ─── Toolbar button ───────────────────────────────────────────────────────────

function ToolbarButton({
  active,
  onClick,
  title,
  disabled,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "size-7 flex items-center justify-center rounded transition-colors text-sm disabled:opacity-40 disabled:pointer-events-none",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

/** Reads the current document as markdown source. tiptap-markdown extends
 *  Editor.storage at runtime (via the Markdown extension configured below)
 *  but doesn't ship a module augmentation for @tiptap/core's `Storage` type,
 *  so TypeScript doesn't know `.markdown` exists — hence the cast. */
function getMarkdown(editor: NonNullable<ReturnType<typeof useEditor>>): string {
  return (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
}

// ─── Main component ───────────────────────────────────────────────────────────

export function DocEditor() {
  const selectedModel = useModelSelectionStore((s) => s.selectedModel);
  const { dirHandle, workspacePath, setWorkspace } = useAgentStore();

  const [openTabs, setOpenTabs] = useState<OpenDocTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string>("");
  const [treeVersion, setTreeVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  const [isAiDropdownOpen, setIsAiDropdownOpen] = useState(false);
  const [isAiStreaming, setIsAiStreaming] = useState(false);
  const aiDropdownRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const commentsRowRef = useRef<HTMLDivElement>(null);

  const activeTab = openTabs.find((t) => t.path === activeTabPath) ?? null;

  // ─── Comments ─────────────────────────────────────────────────────────────
  const { getComments, addComment, addMessage, setResolved, deleteComment } = useDocCommentsStore();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [aiThinkingCommentId, setAiThinkingCommentId] = useState<string | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number; from: number; to: number } | null>(null);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [pendingSuggestion, setPendingSuggestion] = useState<{ from: number; to: number; text: string; loading: boolean } | null>(null);
  const activeComments = activeTabPath ? getComments(workspacePath, activeTabPath) : [];

  const handleUpdate = useCallback(() => {
    setOpenTabs((prev) =>
      prev.map((t) => (t.path === activeTabPath ? { ...t, isDirty: true } : t))
    );
  }, [activeTabPath]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Open or create a file in the tree to start writing…",
      }),
      Markdown.configure({ html: false }),
      MathInline,
      MathBlock,
      CommentMark,
    ],
    content: "",
    onUpdate: handleUpdate,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[400px] px-8 py-6 text-foreground",
      },
    },
  });

  // ─── Workspace / file management ───────────────────────────────────────────

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

  /** Persists whatever's live in the editor back into its tab before we
   *  navigate away from it (switch tabs, close, etc.) — mirrors CodeEditor's
   *  fileContent/openTabs split, just with tiptap-markdown as the source of
   *  truth for "what's the current text" instead of a controlled string. */
  function flushActiveTabContent() {
    if (!editor || !activeTabPath) return;
    const md = getMarkdown(editor);
    setOpenTabs((prev) => prev.map((t) => (t.path === activeTabPath ? { ...t, content: md } : t)));
    return md;
  }

  /** Loads content into the editor (math-conversion included) and reapplies
   *  any unresolved comments' highlight marks for that specific file path —
   *  every "load a document's content" call site should go through this
   *  rather than setEditorContentWithMath directly, so comments never fall
   *  out of sync with whichever file is actually on screen. */
  function loadDocContent(path: string, content: string) {
    if (!editor) return;
    setEditorContentWithMath(editor, content);
    reanchorComments(editor, getComments(workspacePath, path));
  }

  async function handleOpenFile(_handle: FileSystemFileHandle, path: string) {
    if (!dirHandle || !editor) return;

    flushActiveTabContent();

    const existing = openTabs.find((t) => t.path === path);
    if (existing) {
      setActiveTabPath(path);
      loadDocContent(path, existing.content);
      return;
    }

    try {
      const text = await readFileFromHandle(dirHandle, path);
      setOpenTabs((prev) => [...prev, { path, content: text, isDirty: false }]);
      setActiveTabPath(path);
      loadDocContent(path, text);
      toast.success(`Opened ${path.split("/").pop()}`);
    } catch (err) {
      toast.error(`Could not open file: ${(err as Error).message}`);
    }
  }

  function handleSwitchTab(path: string) {
    if (!editor || path === activeTabPath) return;
    flushActiveTabContent();
    const tab = openTabs.find((t) => t.path === path);
    if (!tab) return;
    setActiveTabPath(path);
    loadDocContent(path, tab.content);
  }

  function handleCloseTab(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    const tab = openTabs.find((t) => t.path === path);
    if (tab?.isDirty && !window.confirm(`${path.split("/").pop()} has unsaved changes. Close anyway?`)) return;
    const newTabs = openTabs.filter((t) => t.path !== path);
    setOpenTabs(newTabs);
    if (activeTabPath === path && editor) {
      const last = newTabs[newTabs.length - 1];
      if (last) {
        setActiveTabPath(last.path);
        loadDocContent(last.path, last.content);
      } else {
        setActiveTabPath("");
        editor.commands.setContent("");
      }
    }
  }

  const handleSave = useCallback(async () => {
    if (!dirHandle || !editor || !activeTabPath) return;
    setSaveStatus("saving");
    try {
      const md = getMarkdown(editor);
      await writeFileToHandle(dirHandle, activeTabPath, md);
      setOpenTabs((prev) =>
        prev.map((t) => (t.path === activeTabPath ? { ...t, content: md, isDirty: false } : t))
      );
      setSaveStatus("saved");
      toast.success(`Saved ${activeTabPath.split("/").pop()}`);
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
      setSaveStatus("idle");
    }
  }, [dirHandle, editor, activeTabPath]);

  // Ctrl+S / Cmd+S to save the active document.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  // One-time migration: the old single-scratchpad localStorage content, if
  // any, gets adopted as a real file the first time a workspace is open and
  // no docs have been opened/created yet — otherwise it's silently orphaned
  // now that Docs is file-backed.
  useEffect(() => {
    if (!dirHandle || openTabs.length > 0) return;
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(LEGACY_DOC_STORAGE_KEY);
    } catch {
      return;
    }
    if (!legacy) return;
    // Old format was Tiptap JSON, not markdown/plain text — not worth a real
    // parser for a one-time best-effort recovery, so pull out just the text.
    let text = "";
    try {
      const asJson: unknown = JSON.parse(legacy);
      text = extractTextFromTiptapJson(asJson).trim();
    } catch {
      text = legacy.trim();
    }
    localStorage.removeItem(LEGACY_DOC_STORAGE_KEY);
    if (!text) return;
    void (async () => {
      try {
        const path = "recovered-document.md";
        await writeFileToHandle(dirHandle, path, text);
        setOpenTabs((prev) => [...prev, { path, content: text, isDirty: false }]);
        setActiveTabPath(path);
        loadDocContent(path, text);
        setTreeVersion((v) => v + 1);
        toast.info("Recovered your previous document as recovered-document.md");
      } catch {
        // best-effort only
      }
    })();
    // Only ever run this once per dirHandle becoming available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirHandle]);

  // ─── AI actions ───────────────────────────────────────────────────────────

  /** Runs a prompt against a specific range's text and stages the result as a
   *  pending suggestion instead of applying it directly — the user has to
   *  Accept or Reject (see acceptAiSuggestion/rejectAiSuggestion below) before
   *  anything actually changes in the document. Takes an explicit range
   *  rather than reading editor.state.selection at call time — callers
   *  invoked from a context menu capture the selection at right-click time,
   *  since opening the menu / typing a custom prompt can otherwise outlive the
   *  moment the user actually made their selection. */
  async function runAiPromptOnRange(instruction: string, range: { from: number; to: number }) {
    if (!editor) return;
    if (!selectedModel) {
      toast.error("No model selected — pick one in Settings or the Chat tab first.");
      return;
    }
    const { from, to } = range;
    const selectedText = from !== to ? editor.state.doc.textBetween(from, to, "\n") : editor.getText();
    if (!selectedText.trim()) return;

    const messages = [{ role: "user" as const, content: instruction + selectedText }];

    setIsAiStreaming(true);
    setPendingSuggestion({ from, to, text: "", loading: true });
    abortRef.current = new AbortController();

    let result = "";
    try {
      for await (const chunk of streamChatForModel(selectedModel, messages, abortRef.current.signal)) {
        result += chunk;
        setPendingSuggestion({ from, to, text: result, loading: true });
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(`AI action failed: ${e.message}`);
    } finally {
      setIsAiStreaming(false);
      abortRef.current = null;
    }

    if (!result.trim()) {
      setPendingSuggestion(null);
      return;
    }
    setPendingSuggestion({ from, to, text: result, loading: false });
  }

  /** Applies a pending AI suggestion — the only place that actually writes an
   *  AI text-action's result into the document, and only reachable via an
   *  explicit user click. Content is parsed as markdown (tiptap-markdown), so
   *  a model reply using bold/italic/list markdown renders correctly instead
   *  of showing up as literal asterisks. */
  function acceptAiSuggestion() {
    if (!editor || !pendingSuggestion) return;
    const { from, to, text } = pendingSuggestion;
    if (from !== to) {
      editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, text).run();
    } else {
      loadDocContent(activeTabPath, text);
    }
    setPendingSuggestion(null);
  }

  function rejectAiSuggestion() {
    setPendingSuggestion(null);
  }

  async function runAiAction(action: AiAction, range?: { from: number; to: number }) {
    setIsAiDropdownOpen(false);
    const effectiveRange = range ?? (editor ? editor.state.selection : { from: 0, to: 0 });
    await runAiPromptOnRange(AI_ACTION_PROMPTS[action], effectiveRange);
  }

  async function runCustomAiPrompt(instruction: string, range: { from: number; to: number }) {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    await runAiPromptOnRange(
      `${trimmed}\n\nApply this to the following text. Return only the result, no commentary:\n\n`,
      range
    );
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  function handleAddComment(range?: { from: number; to: number }) {
    if (!editor || !activeTabPath) return;
    const { from, to } = range ?? editor.state.selection;
    if (from === to) {
      toast.error("Select some text first to comment on it.");
      return;
    }
    const anchorText = editor.state.doc.textBetween(from, to, "\n");
    if (!anchorText.trim()) return;
    const id = crypto.randomUUID();
    editor.chain().setTextSelection({ from, to }).focus().setMark("comment", { commentId: id }).run();
    addComment(workspacePath, activeTabPath, {
      id,
      anchorText,
      resolved: false,
      messages: [],
      createdAt: Date.now(),
    });
    setCommentsOpen(true);
    // Auto-focus the new card's reply box — otherwise a comment starts as an
    // empty thread with nothing for "Ask AI" to actually respond to, and it's
    // easy to not notice you still need to click into the card and type.
    setFocusCommentId(id);
  }

  /** Right-click on a selection -> custom context menu (Comment / Ask AI /
   *  presets) instead of the browser's native menu. Only intercepts when
   *  there's an actual selection — with nothing selected there's no clear
   *  "act on this text" meaning, so the native menu is left alone. */
  function handleEditorContextMenu(e: React.MouseEvent) {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    e.preventDefault();
    setSelectionMenu({ x: e.clientX, y: e.clientY, from, to });
  }

  function handleReplyToComment(commentId: string, text: string) {
    if (!activeTabPath) return;
    addMessage(workspacePath, activeTabPath, commentId, {
      id: crypto.randomUUID(),
      author: "user",
      text,
      createdAt: Date.now(),
    });
  }

  function handleJumpToComment(commentId: string) {
    if (!editor) return;
    const found = findCommentRange(editor, commentId);
    if (!found) {
      toast.info("This comment's text isn't highlighted in the current document (it may have been edited).");
      return;
    }
    editor.chain().focus().setTextSelection(found).scrollIntoView().run();
  }

  function handleDeleteComment(commentId: string) {
    if (!activeTabPath) return;
    if (editor) removeCommentMark(editor, commentId);
    deleteComment(workspacePath, activeTabPath, commentId);
  }

  /** Resolving a comment removes its highlight (same as delete); reopening
   *  tries to restore it by re-finding the anchor text. Previously only
   *  delete stripped the mark, so a resolved comment's text stayed
   *  highlighted with nothing left to attach it to. */
  function handleSetResolved(commentId: string, resolved: boolean) {
    if (!activeTabPath) return;
    if (editor) {
      if (resolved) {
        removeCommentMark(editor, commentId);
      } else {
        const comment = activeComments.find((c) => c.id === commentId);
        if (comment) reanchorComments(editor, [{ ...comment, resolved: false }]);
      }
    }
    setResolved(workspacePath, activeTabPath, commentId, resolved);
  }

  async function handleAskAiOnComment(commentId: string) {
    if (!activeTabPath) return;
    if (!selectedModel) {
      toast.error("No model selected — pick one in Settings or the Chat tab first.");
      return;
    }
    const comment = activeComments.find((c) => c.id === commentId);
    if (!comment) return;

    setAiThinkingCommentId(commentId);
    try {
      const threadText = comment.messages.map((m) => `${m.author === "ai" ? "AI" : "User"}: ${m.text}`).join("\n");
      const prompt = [
        "You're weighing in on a comment left on part of a document. Be concise and specific — a sentence or two, not an essay.",
        `The commented text: "${comment.anchorText}"`,
        threadText ? `Discussion so far:\n${threadText}` : "No replies yet — the user just wants your take on this part of the text.",
      ].join("\n\n");

      let result = "";
      for await (const chunk of streamChatForModel(selectedModel, [{ role: "user", content: prompt }])) {
        result += chunk;
      }
      if (result.trim()) {
        addMessage(workspacePath, activeTabPath, commentId, {
          id: crypto.randomUUID(),
          author: "ai",
          text: result.trim(),
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      toast.error(`AI reply failed: ${(err as Error).message}`);
    } finally {
      setAiThinkingCommentId(null);
    }
  }

  // ─── Export helpers ───────────────────────────────────────────────────────

  function exportMarkdown() {
    if (!editor) return;
    const md = getMarkdown(editor);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeTabPath ? activeTabPath.split("/").pop()! : "document.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyMarkdown() {
    if (!editor) return;
    void navigator.clipboard.writeText(getMarkdown(editor));
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportDocx() {
    if (!editor) return;
    const blocks = docToBlocks(editor.state.doc);
    const blob = await blocksToDocxBlob(blocks);
    downloadBlob(blob, activeTabPath ? activeTabPath.replace(/\.md$/i, ".docx") : "document.docx");
  }

  function exportPdf() {
    if (!editor) return;
    const blocks = docToBlocks(editor.state.doc);
    const title = activeTabPath ? activeTabPath.split("/").pop()?.replace(/\.md$/i, "") : undefined;
    const blob = blocksToPdfBlob(blocks, title);
    downloadBlob(blob, activeTabPath ? activeTabPath.replace(/\.md$/i, ".pdf") : "document.pdf");
  }

  if (!editor) return null;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left: File tree */}
      <div className="w-[200px] shrink-0 border-r bg-card flex flex-col">
        <FileTree
          dirHandle={dirHandle}
          onOpenFile={(handle, path) => void handleOpenFile(handle, path)}
          onOpenDir={handleOpenDir}
          refreshKey={treeVersion}
          onRefresh={() => setTreeVersion((v) => v + 1)}
        />
      </div>

      {/* Right: tabs + toolbar + editor */}
      <div className="flex flex-col flex-1 min-w-0 bg-background">
        {/* Tab bar */}
        {openTabs.length > 0 && (
          <div className="flex items-end gap-0 border-b bg-muted/30 shrink-0 overflow-x-auto">
            {openTabs.map((tab) => {
              const name = tab.path.split("/").pop() ?? tab.path;
              const isActive = tab.path === activeTabPath;
              return (
                <div
                  key={tab.path}
                  onClick={() => handleSwitchTab(tab.path)}
                  className={`flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r whitespace-nowrap shrink-0 transition-colors ${
                    isActive
                      ? "bg-background text-foreground border-b-2 border-b-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/60"
                  }`}
                >
                  <FileText className="size-3 shrink-0" />
                  <span className={tab.isDirty ? "italic" : ""}>{name}</span>
                  {tab.isDirty && <span className="size-1.5 rounded-full bg-warning shrink-0" />}
                  <button
                    onClick={(e) => handleCloseTab(tab.path, e)}
                    className="ml-0.5 opacity-50 hover:opacity-100 transition-opacity"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Toolbar */}
        <div className="border-b bg-card px-4 py-2 flex items-center gap-1 flex-wrap shrink-0">
          {/* Formatting buttons */}
          <ToolbarButton
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
            disabled={!activeTab}
          >
            <Bold className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
            disabled={!activeTab}
          >
            <Italic className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("heading", { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            title="Heading 1"
            disabled={!activeTab}
          >
            <Heading1 className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            title="Heading 2"
            disabled={!activeTab}
          >
            <Heading2 className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet list"
            disabled={!activeTab}
          >
            <List className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("codeBlock")}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            title="Code block"
            disabled={!activeTab}
          >
            <Code className="size-3.5" />
          </ToolbarButton>

          <div className="w-px h-5 bg-border mx-1" />

          {/* Save */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-2 gap-1"
            onClick={() => void handleSave()}
            disabled={!activeTab || !activeTab.isDirty || saveStatus === "saving"}
            title="Save (Ctrl+S)"
          >
            <Save className="size-3" />
            {saveStatus === "saving" ? "Saving…" : "Save"}
          </Button>

          {/* AI Actions dropdown */}
          <div className="relative" ref={aiDropdownRef}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2 gap-1"
              onClick={() => setIsAiDropdownOpen((v) => !v)}
              disabled={isAiStreaming || !selectedModel || !activeTab}
            >
              {isAiStreaming ? "Generating…" : "AI Actions"}
              <ChevronDown className="size-3" />
            </Button>
            {isAiDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-44 bg-card border rounded-md shadow-lg z-10 py-1">
                {(Object.entries(AI_ACTION_LABELS) as [AiAction, string][]).map(
                  ([action, label]) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => void runAiAction(action)}
                      className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
                    >
                      {label}
                    </button>
                  )
                )}
              </div>
            )}
          </div>

          {/* Comments */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-2 gap-1"
            onClick={() => handleAddComment()}
            disabled={!activeTab}
            title="Comment on the selected text"
          >
            <MessageSquarePlus className="size-3.5" />
            Comment
          </Button>
          <ToolbarButton
            active={commentsOpen}
            onClick={() => setCommentsOpen((v) => !v)}
            title={`Toggle comments panel${activeComments.filter((c) => !c.resolved).length > 0 ? ` (${activeComments.filter((c) => !c.resolved).length} open)` : ""}`}
          >
            <MessageSquare className="size-3.5" />
          </ToolbarButton>

          <div className="flex-1" />

          {/* Save indicator */}
          {saveStatus === "saved" && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle className="size-3" />
              Saved
            </span>
          )}

          {/* Export buttons */}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 gap-1"
            onClick={copyMarkdown}
            title="Copy as Markdown"
            disabled={!activeTab}
          >
            <Copy className="size-3" />
            Copy MD
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 gap-1"
            onClick={exportMarkdown}
            title="Download .md"
            disabled={!activeTab}
          >
            <Download className="size-3" />
            .md
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 gap-1"
            onClick={() => void exportDocx()}
            title="Download .docx"
            disabled={!activeTab}
          >
            <Download className="size-3" />
            .docx
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 gap-1"
            onClick={exportPdf}
            title="Download .pdf"
            disabled={!activeTab}
          >
            <Download className="size-3" />
            .pdf
          </Button>
        </div>

        {/* Editor content + floating margin comments */}
        <div className="flex-1 min-h-0 overflow-y-auto relative">
          {!activeTab && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-8 pointer-events-none">
              <FileText className="size-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">No document open</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  {dirHandle
                    ? "Create or open a .md file from the tree on the left to start writing."
                    : "Open a workspace folder to create and manage documents."}
                </p>
              </div>
            </div>
          )}
          <div ref={commentsRowRef} className={cn("flex justify-center gap-4 relative", !activeTab && "invisible")}>
            <div className="max-w-3xl w-full" onContextMenu={handleEditorContextMenu}>
              <EditorContent editor={editor} />
            </div>
            {pendingSuggestion && editor && (
              <DocAiSuggestionCard
                editor={editor}
                containerRef={commentsRowRef}
                suggestion={pendingSuggestion}
                onAccept={acceptAiSuggestion}
                onReject={rejectAiSuggestion}
              />
            )}
            {commentsOpen && activeTab && editor && (
              <DocFloatingComments
                editor={editor}
                containerRef={commentsRowRef}
                comments={activeComments}
                onResolve={handleSetResolved}
                onDelete={handleDeleteComment}
                onReply={(id, text) => { handleReplyToComment(id, text); setFocusCommentId(null); }}
                onAskAi={(id) => void handleAskAiOnComment(id)}
                onJumpTo={handleJumpToComment}
                aiThinkingCommentId={aiThinkingCommentId}
                focusCommentId={focusCommentId}
              />
            )}
          </div>
        </div>

        {selectionMenu && editor && (
          <DocSelectionMenu
            x={selectionMenu.x}
            y={selectionMenu.y}
            onComment={() => handleAddComment({ from: selectionMenu.from, to: selectionMenu.to })}
            onCustomPrompt={(instruction) => void runCustomAiPrompt(instruction, { from: selectionMenu.from, to: selectionMenu.to })}
            presets={(Object.entries(AI_ACTION_LABELS) as [AiAction, string][]).map(([action, label]): PresetAction => ({
              key: action,
              label,
              onClick: () => void runAiAction(action, { from: selectionMenu.from, to: selectionMenu.to }),
            }))}
            onClose={() => setSelectionMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

/** Best-effort text extraction from the old Tiptap-JSON scratchpad format,
 *  for the one-time legacy-content recovery above — walks the ProseMirror-ish
 *  doc tree pulling out any `text` leaves. Not a full renderer; good enough
 *  to not lose the user's words during the one-time migration. */
function extractTextFromTiptapJson(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { text?: string; content?: unknown[]; type?: string };
  if (typeof n.text === "string") return n.text;
  const childText = Array.isArray(n.content) ? n.content.map(extractTextFromTiptapJson).join(" ") : "";
  return n.type === "paragraph" || n.type === "heading" ? `${childText}\n` : childText;
}
