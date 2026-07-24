import { useEffect, useRef, useState } from "react";
import { Node, nodeInputRule, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * LaTeX math support for the Docs editor (Tiptap). Two atom nodes — inline
 * ($...$) and block ($$...$$) — rendered live via KaTeX, editable by clicking
 * back into raw LaTeX source. Reuses the katex dependency already used
 * elsewhere (Markdown.tsx's chat/Study rendering via rehype-katex) rather than
 * adding a new one.
 *
 * Markdown round-trip:
 * - SAVE (editor -> markdown text): handled by each node's addStorage().markdown.serialize
 *   below, following the standard prosemirror-markdown node-serializer shape
 *   (state.write(...)) that tiptap-markdown (the package this app uses) expects.
 * - TYPING ($...$ / $$...$$ live in the editor): handled by nodeInputRule below —
 *   pure Tiptap/ProseMirror, no dependency on tiptap-markdown's parse internals.
 * - OPENING an existing file that already contains raw $...$/$$...$$ text:
 *   tiptap-markdown's parse side doesn't know about these nodes, so on its own
 *   it would just leave that text as plain visible text. setEditorContentWithMath
 *   below covers this instead with a self-contained doc-scan-and-replace pass
 *   run right after setContent, rather than hooking into tiptap-markdown's
 *   parse internals (undocumented for custom nodes, higher risk to get wrong
 *   without the ability to test live here).
 */

function renderKatexHtml(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { throwOnError: false, displayMode });
  } catch (e) {
    return `<span style="color:#c00">Invalid LaTeX: ${(e as Error).message}</span>`;
  }
}

function MathNodeView({ node, updateAttributes, selected, editor }: ReactNodeViewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(String(node.attrs["latex"] ?? ""));
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const displayMode = node.type.name === "mathBlock";

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Reflect external attr changes (e.g. undo) while not actively editing.
  useEffect(() => {
    if (!editing) setDraft(String(node.attrs["latex"] ?? ""));
  }, [node.attrs, editing]);

  function commit() {
    updateAttributes({ latex: draft });
    setEditing(false);
  }

  function cancel() {
    setDraft(String(node.attrs["latex"] ?? ""));
    setEditing(false);
  }

  if (editing) {
    const InputTag = displayMode ? "textarea" : "input";
    return (
      <NodeViewWrapper as={displayMode ? "div" : "span"} className={displayMode ? "my-2" : "inline-block align-middle"}>
        <InputTag
          ref={inputRef as never}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (!displayMode || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="font-mono text-sm px-1.5 py-0.5 rounded border border-primary bg-background text-foreground outline-none min-w-[6ch]"
          style={displayMode ? { width: "100%", minHeight: "3rem" } : undefined}
          placeholder="LaTeX…"
        />
      </NodeViewWrapper>
    );
  }

  const latex = String(node.attrs["latex"] ?? "");
  return (
    <NodeViewWrapper
      as={displayMode ? "div" : "span"}
      className={
        (displayMode ? "my-2 block text-center " : "inline-block align-middle ") +
        "cursor-text rounded px-0.5 hover:bg-accent/50 " +
        (selected ? "ring-2 ring-ring" : "")
      }
      onClick={() => {
        if (!editor.isEditable) return;
        setDraft(latex);
        setEditing(true);
      }}
      data-latex={latex}
    >
      {latex.trim() ? (
        <span dangerouslySetInnerHTML={{ __html: renderKatexHtml(latex, displayMode) }} />
      ) : (
        <span className="text-muted-foreground italic text-sm">{displayMode ? "Empty formula — click to edit" : "$…$"}</span>
      )}
    </NodeViewWrapper>
  );
}

export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { latex: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "span[data-math-inline]" }];
  },

  renderHTML({ node }) {
    return ["span", { "data-math-inline": "", "data-latex": node.attrs["latex"] }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        // A single non-$ run between two $, not immediately preceded/followed
        // by another $ (so this doesn't fire while typing the second $ of $$).
        find: /(?<!\$)\$([^$\n]+)\$(?!\$)$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[1] }),
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { latex: string } }) {
          state.write(`$${node.attrs.latex}$`);
        },
      },
    };
  },
});

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { latex: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "div[data-math-block]" }];
  },

  renderHTML({ node }) {
    return ["div", { "data-math-block": "", "data-latex": node.attrs["latex"] }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /^\$\$([^$]+)\$\$$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[1].trim() }),
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void; closeBlock: (node: unknown) => void }, node: { attrs: { latex: string } }) {
          state.write(`$$\n${node.attrs.latex}\n$$`);
          state.closeBlock(node);
        },
      },
    };
  },
});

/**
 * Sets editor content (same effect as editor.commands.setContent) and then
 * converts any raw $...$/$$...$$ text already present into rendered math
 * nodes — for opening an existing file, or inserting AI-generated text, that
 * already contains LaTeX source rather than having been typed live (typing
 * live is handled by the input rules above instead). Applies replacements
 * from the end of the document backward so earlier match positions stay
 * valid as the doc is mutated.
 */
export function setEditorContentWithMath(editor: Editor, content: string): void {
  editor.commands.setContent(content);

  type Match = { from: number; to: number; latex: string; block: boolean };
  const matches: Match[] = [];

  editor.state.doc.descendants((node, pos) => {
    // Whole-paragraph $$...$$ (its own paragraph, no other content) -> block math.
    if (node.type.name === "paragraph" && node.childCount === 1 && node.firstChild?.isText) {
      const text = node.firstChild.text ?? "";
      const blockMatch = /^\$\$([\s\S]+)\$\$$/.exec(text.trim());
      if (blockMatch) {
        matches.push({ from: pos, to: pos + node.nodeSize, latex: blockMatch[1].trim(), block: true });
        return false; // don't also scan this paragraph's text as inline math
      }
    }
    if (node.isText && node.text) {
      const text = node.text;
      const re = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        matches.push({ from: pos + m.index, to: pos + m.index + m[0].length, latex: m[1], block: false });
      }
    }
    return undefined;
  });

  if (matches.length === 0) return;

  const tr = editor.state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const nodeType = m.block ? editor.schema.nodes["mathBlock"] : editor.schema.nodes["mathInline"];
    if (!nodeType) continue;
    tr.replaceWith(m.from, m.to, nodeType.create({ latex: m.latex }));
  }
  editor.view.dispatch(tr);
}
