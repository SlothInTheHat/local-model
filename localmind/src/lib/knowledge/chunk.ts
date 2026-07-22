/**
 * KM1 — split extracted Sections into embed-sized KnowledgeChunks.
 *
 * A Section (a whole PDF page, a whole markdown heading block, a whole image
 * transcription) can easily exceed a sane embedding-input size. This module
 * splits any oversized section on the highest-fidelity boundary available —
 * paragraph, then sentence, then a hard character cut as a last resort — so
 * a chunk never straddles unrelated ideas any more than necessary. Sections
 * that already fit under `maxChars` pass through untouched as a single chunk.
 */
import type { Section, KnowledgeChunk } from "./types";

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitSentences(text: string): string[] {
  // Split right after sentence-ending punctuation followed by whitespace,
  // keeping the punctuation on the preceding piece.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/** Greedily pack `units` (paragraphs or sentences) into chunks no larger than
 *  `maxChars`, joining with `joiner`. Any single unit that is itself too big
 *  is recursively split further (sentences, then a hard character cut). */
function packUnits(units: string[], maxChars: number, joiner: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? current + joiner + unit : unit;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (unit.length <= maxChars) {
      current = unit;
    } else {
      chunks.push(...splitOversizedUnit(unit, maxChars));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** A single paragraph/sentence that alone exceeds maxChars: fall back to
 *  splitting on sentence boundaries, then (if even one sentence is still too
 *  long — e.g. a giant run-on line with no punctuation) a hard character cut. */
function splitOversizedUnit(text: string, maxChars: number): string[] {
  const sentences = splitSentences(text);
  if (sentences.length > 1) return packUnits(sentences, maxChars, " ");
  return hardSplit(text, maxChars);
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length > 1) return packUnits(paragraphs, maxChars, "\n\n");
  return splitOversizedUnit(text, maxChars);
}

export function chunkSections(sections: Section[], maxChars = 1200): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let chunkIndex = 0;
  for (const section of sections) {
    const trimmed = section.text.trim();
    if (!trimmed) continue;
    const pieces = splitText(trimmed, maxChars);
    pieces.forEach((piece, i) => {
      const text = piece.trim();
      if (!text) return; // drop empty/whitespace-only chunks
      const location = i === 0 ? section.location : `${section.location} (cont.)`;
      chunks.push({ text, location, chunkIndex: chunkIndex++ });
    });
  }
  return chunks;
}
