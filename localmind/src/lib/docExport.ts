import type { Node as PMNode } from "@tiptap/pm/model";
import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, LevelFormat, AlignmentType,
} from "docx";
import { jsPDF } from "jspdf";

/**
 * Shared Tiptap-document -> export logic for DocEditor's .docx/.pdf downloads.
 *
 * Both exporters walk the SAME intermediate `Block[]` representation (built
 * once by docToBlocks) instead of each re-implementing their own ad-hoc walk
 * of the ProseMirror doc — the original .docx exporter only handled top-level
 * nodes directly, so a bulletList/orderedList's actual text (nested two levels
 * down, inside listItem > paragraph) was silently dropped. This fixes that for
 * both formats at once rather than separately.
 */

export interface RunSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
}

export type Block =
  | { kind: "heading"; level: number; runs: RunSpec[] }
  | { kind: "paragraph"; runs: RunSpec[] }
  | { kind: "listItem"; ordered: boolean; depth: number; runs: RunSpec[] }
  | { kind: "codeBlock"; text: string }
  | { kind: "blockquote"; runs: RunSpec[] }
  | { kind: "math"; latex: string; display: boolean }
  | { kind: "hr" };

function runsFromInline(node: PMNode): RunSpec[] {
  const runs: RunSpec[] = [];
  node.forEach((child) => {
    if (child.isText) {
      const marks = child.marks;
      runs.push({
        text: child.text ?? "",
        bold: marks.some((m) => m.type.name === "bold"),
        italic: marks.some((m) => m.type.name === "italic"),
        code: marks.some((m) => m.type.name === "code"),
        strike: marks.some((m) => m.type.name === "strike"),
      });
    } else if (child.type.name === "hardBreak") {
      runs.push({ text: "\n" });
    } else if (child.type.name === "mathInline") {
      // Math export fidelity is intentionally limited to the raw LaTeX source
      // (not a rendered equation image) in both .docx and .pdf for now.
      runs.push({ text: `$${String(child.attrs["latex"] ?? "")}$` });
    }
  });
  return runs;
}

export function docToBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = [];

  function walkList(listNode: PMNode, ordered: boolean, depth: number) {
    listNode.forEach((itemNode) => {
      itemNode.forEach((inner) => {
        if (inner.type.name === "paragraph") {
          blocks.push({ kind: "listItem", ordered, depth, runs: runsFromInline(inner) });
        } else if (inner.type.name === "bulletList") {
          walkList(inner, false, depth + 1);
        } else if (inner.type.name === "orderedList") {
          walkList(inner, true, depth + 1);
        }
      });
    });
  }

  doc.forEach((node) => {
    switch (node.type.name) {
      case "heading":
        blocks.push({ kind: "heading", level: (node.attrs["level"] as number) ?? 1, runs: runsFromInline(node) });
        break;
      case "paragraph":
        blocks.push({ kind: "paragraph", runs: runsFromInline(node) });
        break;
      case "bulletList":
        walkList(node, false, 0);
        break;
      case "orderedList":
        walkList(node, true, 0);
        break;
      case "codeBlock":
        blocks.push({ kind: "codeBlock", text: node.textContent });
        break;
      case "blockquote":
        node.forEach((child) => {
          if (child.type.name === "paragraph") {
            blocks.push({ kind: "blockquote", runs: runsFromInline(child) });
          }
        });
        break;
      case "mathBlock":
        blocks.push({ kind: "math", latex: String(node.attrs["latex"] ?? ""), display: true });
        break;
      case "horizontalRule":
        blocks.push({ kind: "hr" });
        break;
      default:
        if (node.textContent) {
          blocks.push({ kind: "paragraph", runs: [{ text: node.textContent }] });
        }
    }
  });

  return blocks;
}

// ─── .docx ──────────────────────────────────────────────────────────────────

const ORDERED_LIST_REF = "localmind-ordered-list";
const MAX_LIST_LEVELS = 4;

const DOCX_HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

function runsToTextRuns(runs: RunSpec[]): TextRun[] {
  return runs.map((r) => new TextRun({
    text: r.text,
    bold: r.bold,
    italics: r.italic,
    strike: r.strike,
    font: r.code ? "Courier New" : undefined,
  }));
}

export async function blocksToDocxBlob(blocks: Block[]): Promise<Blob> {
  const children: Paragraph[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        children.push(new Paragraph({
          children: runsToTextRuns(block.runs),
          heading: DOCX_HEADING_LEVELS[Math.min(block.level - 1, DOCX_HEADING_LEVELS.length - 1)],
        }));
        break;
      case "paragraph":
        if (block.runs.length > 0) children.push(new Paragraph({ children: runsToTextRuns(block.runs) }));
        break;
      case "listItem":
        children.push(new Paragraph(
          block.ordered
            ? { children: runsToTextRuns(block.runs), numbering: { reference: ORDERED_LIST_REF, level: Math.min(block.depth, MAX_LIST_LEVELS - 1) } }
            : { children: runsToTextRuns(block.runs), bullet: { level: Math.min(block.depth, MAX_LIST_LEVELS - 1) } }
        ));
        break;
      case "codeBlock":
        for (const line of block.text.split("\n")) {
          children.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Courier New" })] }));
        }
        break;
      case "blockquote":
        children.push(new Paragraph({ children: runsToTextRuns(block.runs.map((r) => ({ ...r, italic: true }))), indent: { left: 720 } }));
        break;
      case "math":
        children.push(new Paragraph({ children: [new TextRun({ text: `$${block.latex}$`, font: "Cambria Math" })] }));
        break;
      case "hr":
        children.push(new Paragraph({ text: "" }));
        break;
    }
  }

  const doc = new Document({
    numbering: {
      config: [{
        reference: ORDERED_LIST_REF,
        levels: Array.from({ length: MAX_LIST_LEVELS }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{ children }],
  });

  return Packer.toBlob(doc);
}

// ─── .pdf ───────────────────────────────────────────────────────────────────
//
// jsPDF has no rich-text-run layout of its own (each call to .text() is a
// single plain string) — mixed bold/italic within one line is laid out here
// manually run-by-run, tracking an x cursor and wrapping when it would exceed
// the right margin. This is the standard approach for rich text in jsPDF;
// there's no built-in "flow this rich paragraph" API to delegate to.

const PDF_MARGIN = 56; // ~0.78in, points
const PDF_PAGE_WIDTH = 612; // US Letter, points
const PDF_PAGE_HEIGHT = 792;
const PDF_BODY_SIZE = 11;
const PDF_LINE_HEIGHT = 15;

const PDF_HEADING_SIZES: Record<number, number> = { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 11 };

class PdfCursor {
  y = PDF_MARGIN;
  constructor(private doc: jsPDF) {}

  ensureSpace(need: number) {
    if (this.y + need > PDF_PAGE_HEIGHT - PDF_MARGIN) {
      this.doc.addPage();
      this.y = PDF_MARGIN;
    }
  }

  advance(by: number) {
    this.y += by;
  }
}

/** Lays out a run-based paragraph with word wrap, mixed bold/italic per run,
 *  starting at left indent `x0`, returning nothing (mutates cursor.y). */
function layoutRuns(doc: jsPDF, cursor: PdfCursor, runs: RunSpec[], x0: number, size: number, lineHeight: number) {
  const maxWidth = PDF_PAGE_WIDTH - PDF_MARGIN - x0;
  doc.setFontSize(size);

  // Flatten runs into words tagged with their run's style, so wrapping can
  // happen at word boundaries while still switching style mid-line.
  type Word = { text: string; bold: boolean; italic: boolean; code: boolean };
  const words: Word[] = [];
  for (const r of runs) {
    for (const part of r.text.split(/(\s+)/).filter((w) => w !== "")) {
      words.push({ text: part, bold: !!r.bold, italic: !!r.italic, code: !!r.code });
    }
  }
  if (words.length === 0) return;

  let x = x0;
  cursor.ensureSpace(lineHeight);
  for (const word of words) {
    if (word.text.trim() === "") {
      // whitespace — just advance if it fits, otherwise treat as a line break point
      const w = doc.getTextWidth(" ");
      if (x + w > x0 + maxWidth) {
        x = x0;
        cursor.advance(lineHeight);
        cursor.ensureSpace(lineHeight);
      } else {
        x += w;
      }
      continue;
    }
    doc.setFont(word.code ? "courier" : "helvetica", word.bold && word.italic ? "bolditalic" : word.bold ? "bold" : word.italic ? "italic" : "normal");
    const w = doc.getTextWidth(word.text);
    if (x + w > x0 + maxWidth && x > x0) {
      x = x0;
      cursor.advance(lineHeight);
      cursor.ensureSpace(lineHeight);
    }
    doc.text(word.text, x, cursor.y);
    x += w;
  }
  cursor.advance(lineHeight);
}

export function blocksToPdfBlob(blocks: Block[], title?: string): Blob {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const cursor = new PdfCursor(doc);

  if (title) {
    doc.setFontSize(PDF_HEADING_SIZES[1]);
    doc.setFont("helvetica", "bold");
    doc.text(title, PDF_MARGIN, cursor.y);
    cursor.advance(PDF_HEADING_SIZES[1] + 8);
  }

  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const size = PDF_HEADING_SIZES[Math.min(block.level, 6)] ?? PDF_BODY_SIZE;
        cursor.advance(6);
        layoutRuns(doc, cursor, block.runs.map((r) => ({ ...r, bold: true })), PDF_MARGIN, size, size + 4);
        cursor.advance(4);
        break;
      }
      case "paragraph":
        if (block.runs.length > 0) {
          layoutRuns(doc, cursor, block.runs, PDF_MARGIN, PDF_BODY_SIZE, PDF_LINE_HEIGHT);
          cursor.advance(4);
        }
        break;
      case "listItem": {
        const indent = PDF_MARGIN + 16 * (block.depth + 1);
        cursor.ensureSpace(PDF_LINE_HEIGHT);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(PDF_BODY_SIZE);
        doc.text(block.ordered ? "•" : "•", indent - 12, cursor.y); // bullet glyph for both; ordered numbering omitted for simplicity
        layoutRuns(doc, cursor, block.runs, indent, PDF_BODY_SIZE, PDF_LINE_HEIGHT);
        break;
      }
      case "codeBlock": {
        doc.setFont("courier", "normal");
        doc.setFontSize(PDF_BODY_SIZE);
        for (const line of block.text.split("\n")) {
          cursor.ensureSpace(PDF_LINE_HEIGHT);
          doc.text(line, PDF_MARGIN + 8, cursor.y);
          cursor.advance(PDF_LINE_HEIGHT);
        }
        cursor.advance(4);
        break;
      }
      case "blockquote":
        layoutRuns(doc, cursor, block.runs.map((r) => ({ ...r, italic: true })), PDF_MARGIN + 16, PDF_BODY_SIZE, PDF_LINE_HEIGHT);
        cursor.advance(4);
        break;
      case "math":
        doc.setFont("courier", "normal");
        doc.setFontSize(PDF_BODY_SIZE);
        cursor.ensureSpace(PDF_LINE_HEIGHT);
        doc.text(`$${block.latex}$`, PDF_MARGIN, cursor.y);
        cursor.advance(PDF_LINE_HEIGHT + 4);
        break;
      case "hr":
        cursor.ensureSpace(10);
        doc.setDrawColor(180);
        doc.line(PDF_MARGIN, cursor.y, PDF_PAGE_WIDTH - PDF_MARGIN, cursor.y);
        cursor.advance(14);
        break;
    }
  }

  return doc.output("blob");
}
