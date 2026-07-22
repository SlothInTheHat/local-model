/**
 * KM1 — Markdown/plain-text extraction.
 *
 * No parser dependency needed: split the file into lines, track the current
 * heading (`#`/`##`/`###`) and the line number it started at, and group
 * consecutive lines under that heading into one Section. A file with no
 * heading yet (front matter, or a plain .txt file) still gets a Section —
 * its location is just the starting line number with no heading prefix.
 */
import type { Section } from "./types";

/** Matches a `#`, `##`, or `###` ATX heading line (deliberately not deeper —
 *  ####+ headings are treated as ordinary body text for citation purposes;
 *  the anchor granularity of "which ### section" is already enough to cite). */
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;

export function extractMarkdown(text: string): Section[] {
  const lines = text.split(/\r\n|\r|\n/);
  const sections: Section[] = [];

  let currentHeading: string | null = null;
  let sectionStartLine = 1;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body.length > 0) {
      const location = currentHeading
        ? `#${currentHeading} L${sectionStartLine}`
        : `L${sectionStartLine}`;
      sections.push({ text: body, location });
    }
    buffer = [];
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const match = HEADING_RE.exec(line);
    if (match) {
      // A new heading starts a new section — flush whatever was accumulated
      // under the previous heading (or before any heading) first.
      flush();
      currentHeading = match[2].trim();
      sectionStartLine = lineNo;
      return;
    }
    // Only the no-heading-yet case needs the start line tracked here — once
    // a heading has been seen, sectionStartLine was already pinned to the
    // heading's own line number above and should stay put while its body
    // accumulates.
    if (buffer.length === 0 && currentHeading === null) {
      sectionStartLine = lineNo;
    }
    buffer.push(line);
  });
  flush();

  return sections;
}
