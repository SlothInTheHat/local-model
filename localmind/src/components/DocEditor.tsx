import { useRef, useState, useCallback, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
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
} from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";
import { streamChat } from "../lib/ollama";
import { useChatStore } from "../store/chat";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";

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

// ─── Toolbar button ───────────────────────────────────────────────────────────

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "size-7 flex items-center justify-center rounded transition-colors text-sm",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const DOC_STORAGE_KEY = "localmind-doc-content";

export function DocEditor() {
  const { availableModels } = useChatStore();
  const selectedModel = availableModels[0] ?? "";

  const [isAiDropdownOpen, setIsAiDropdownOpen] = useState(false);
  const [isAiStreaming, setIsAiStreaming] = useState(false);
  const [saveIndicator, setSaveIndicator] = useState(false);
  const aiDropdownRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted content once on mount
  const initialContent = useMemo(() => {
    try {
      const saved = localStorage.getItem(DOC_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as object) : "";
    } catch {
      return "";
    }
  }, []);

  const handleUpdate = useCallback(({ editor: ed }: { editor: ReturnType<typeof useEditor> extends null ? never : NonNullable<ReturnType<typeof useEditor>> }) => {
    // Debounce save — 800 ms after last keystroke
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      localStorage.setItem(DOC_STORAGE_KEY, JSON.stringify(ed.getJSON()));
      setSaveIndicator(true);
      setTimeout(() => setSaveIndicator(false), 1500);
    }, 800);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Start writing your document… (use the toolbar or AI actions above)",
      }),
    ],
    content: initialContent,
    onUpdate: handleUpdate,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none focus:outline-none min-h-[400px] px-8 py-6 text-foreground",
      },
    },
  });

  // ─── AI actions ───────────────────────────────────────────────────────────

  async function runAiAction(action: AiAction) {
    if (!editor || !selectedModel) return;
    setIsAiDropdownOpen(false);

    const { from, to } = editor.state.selection;
    const selectedText =
      from !== to
        ? editor.state.doc.textBetween(from, to, "\n")
        : editor.getText();

    if (!selectedText.trim()) return;

    const systemPrompt = AI_ACTION_PROMPTS[action];
    const messages = [
      { role: "user" as const, content: systemPrompt + selectedText },
    ];

    setIsAiStreaming(true);
    abortRef.current = new AbortController();

    let result = "";
    try {
      for await (const chunk of streamChat(
        selectedModel,
        messages,
        abortRef.current.signal
      )) {
        result += chunk;
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") console.error(e);
    } finally {
      setIsAiStreaming(false);
      abortRef.current = null;
    }

    if (!result) return;

    // Replace selection or whole document
    if (from !== to) {
      editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, result).run();
    } else {
      editor.commands.setContent(result);
    }
  }

  // ─── Export helpers ───────────────────────────────────────────────────────

  function exportMarkdown() {
    if (!editor) return;
    // Convert Tiptap JSON to markdown via the editor's text (simple approach)
    const text = editor.getText();
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "document.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyMarkdown() {
    if (!editor) return;
    void navigator.clipboard.writeText(editor.getText());
  }

  async function exportDocx() {
    if (!editor) return;
    const nodes = editor.state.doc.content;
    const children: Paragraph[] = [];

    nodes.forEach((node) => {
      if (node.type.name === "heading") {
        const level = (node.attrs as { level: number }).level;
        const text = node.textContent;
        children.push(
          new Paragraph({
            text,
            heading:
              level === 1
                ? HeadingLevel.HEADING_1
                : level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          })
        );
      } else {
        // paragraph / bullet / code block — treat as paragraph with runs
        const runs: TextRun[] = [];
        node.content.forEach((child) => {
          const isBold = child.marks.some((m) => m.type.name === "bold");
          const isItalic = child.marks.some((m) => m.type.name === "italic");
          runs.push(new TextRun({ text: child.text ?? "", bold: isBold, italics: isItalic }));
        });
        if (runs.length > 0) {
          children.push(new Paragraph({ children: runs }));
        } else if (node.textContent) {
          children.push(new Paragraph({ text: node.textContent }));
        }
      }
    });

    const doc = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "document.docx";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="border-b bg-card px-4 py-2 flex items-center gap-1 flex-wrap shrink-0">
        {/* Formatting buttons */}
        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <Bold className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <Italic className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Heading 1"
        >
          <Heading1 className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading 2"
        >
          <Heading2 className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          <List className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title="Code block"
        >
          <Code className="size-3.5" />
        </ToolbarButton>

        <div className="w-px h-5 bg-border mx-1" />

        {/* AI Actions dropdown */}
        <div className="relative" ref={aiDropdownRef}>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-2 gap-1"
            onClick={() => setIsAiDropdownOpen((v) => !v)}
            disabled={isAiStreaming || !selectedModel}
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

        <div className="flex-1" />

        {/* Save indicator */}
        {saveIndicator && (
          <span className="flex items-center gap-1 text-xs text-green-600">
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
        >
          <Download className="size-3" />
          .docx
        </Button>
      </div>

      {/* Editor content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
