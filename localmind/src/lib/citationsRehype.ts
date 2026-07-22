/**
 * rehypeCitations — a pure, synchronous rehype plugin that turns inline
 * knowledge-hub citations like `[test/Sp26_Lec18_post.pdf p.45]` into a
 * `<span class="km-citation" data-cite-*>` element in the rendered markdown
 * tree, WITHOUT touching anything but plain text nodes.
 *
 * Why this file exists (read src/components/Markdown.tsx's header comment
 * first): Markdown.tsx is shared with the isolated result-widget webview and
 * is forbidden from importing a Zustand store or any side-effectful ../lib/
 * module — doing so would boot a second scheduler/taskRunner inside that
 * webview. So citation *detection* has to be a store-free, pure tree
 * transform (this file, safe to import from Markdown.tsx), while citation
 * *interactivity* (looking the passage up in useMemoryStore and popping a
 * card) is wired up separately in ChatMessages.tsx, which is main-app-only
 * and free to use stores. This plugin only ever emits inert DOM attributes;
 * it never reads or writes application state.
 *
 * Detection is intentionally two-step to robustly allow collection/file
 * names containing spaces while still rejecting ordinary markdown-ish
 * bracket text (footnote markers like `[1]`, or plain asides like
 * `[see notes]`):
 *   1. Find every `[...]` bracket span in a text node via /\[([^\]]+)\]/g.
 *   2. Split the inner string on the FIRST `/` into `collection` (before)
 *      and `rest` (after). If there's no `/`, it's not a citation.
 *   3. Test `rest` against /^(.+\.(?:pdf|md|markdown|txt|png|jpe?g|webp))(?:\s+(.*))?$/i
 *      — group 1 becomes `file` (must end in a known document/image
 *      extension), group 2 (optional) becomes `location`. If this fails,
 *      it's not a citation either, and the bracket text is left untouched.
 */

import type { Element, ElementContent, Root, RootContent, Text } from "hast";

/** Matches every top-level `[...]` bracket span in a text node. Re-created
 *  per call site via a fresh `.exec` loop below (the `g` flag makes a shared
 *  module-level RegExp stateful across calls, so we always reset `lastIndex`
 *  before use). */
const CITATION_TOKEN_RE = /\[([^\]]+)\]/g;

/** `rest` (the part of a citation's inner text after the first `/`) must look
 *  like a filename ending in a known knowledge-hub document/image extension,
 *  optionally followed by a location anchor separated by whitespace. */
const FILE_LOCATION_RE = /^(.+\.(?:pdf|md|markdown|txt|png|jpe?g|webp))(?:\s+(.*))?$/i;

/** A successfully-parsed citation token's fields. */
export interface ParsedCitation {
  collection: string;
  file: string;
  location: string;
}

/**
 * Parse the inner text of a single `[...]` bracket span (without the
 * brackets) into its citation fields, or return `null` if it doesn't match
 * the citation shape — in which case the caller should leave the bracket
 * text alone (it's an ordinary footnote marker, aside, etc.).
 */
export function parseCitationToken(inner: string): ParsedCitation | null {
  const slashIdx = inner.indexOf("/");
  if (slashIdx === -1) return null;
  const collection = inner.slice(0, slashIdx);
  const rest = inner.slice(slashIdx + 1);
  const match = rest.match(FILE_LOCATION_RE);
  if (!match) return null;
  return { collection, file: match[1], location: match[2] ?? "" };
}

/**
 * Split a single text node's string value into an array of text/element
 * nodes: plain text runs interleaved with `<span class="km-citation">`
 * elements for every substring that parses as a citation. Non-citation
 * bracket text (e.g. `[1]`, `[see notes]`) is left as part of the
 * surrounding plain text, untouched.
 */
function splitTextIntoCitationNodes(value: string): Array<Text | Element> {
  const out: Array<Text | Element> = [];
  let lastIndex = 0;

  CITATION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_TOKEN_RE.exec(value)) !== null) {
    const [full, inner] = match;
    const parsed = parseCitationToken(inner);
    if (!parsed) continue; // Not a citation — leave this bracket span as plain text.

    if (match.index > lastIndex) {
      out.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    out.push({
      type: "element",
      tagName: "span",
      properties: {
        className: ["km-citation"],
        "data-cite-collection": parsed.collection,
        "data-cite-file": parsed.file,
        "data-cite-location": parsed.location,
      },
      children: [{ type: "text", value: full }],
    });
    lastIndex = match.index + full.length;
  }

  if (lastIndex < value.length) {
    out.push({ type: "text", value: value.slice(lastIndex) });
  }
  // No citations found at all → return the original text node unchanged.
  if (out.length === 0) {
    out.push({ type: "text", value });
  }
  return out;
}

/**
 * Recursively walk a list of hast child nodes, replacing citation tokens in
 * text nodes with `km-citation` spans. Elements whose tagName is `code` or
 * `pre` are passed through verbatim (children untouched) so citation-looking
 * text inside code blocks/inline code is never rewritten. All other elements
 * are recursed into.
 */
function transformChildren<T extends RootContent | ElementContent>(children: T[]): T[] {
  const result: T[] = [];
  for (const child of children) {
    if (child.type === "text") {
      // splitTextIntoCitationNodes returns Text/Element nodes, both valid
      // members of every hast content union (RootContent/ElementContent).
      result.push(...(splitTextIntoCitationNodes(child.value) as unknown as T[]));
    } else if (child.type === "element") {
      const el = child as Element;
      if (el.tagName === "code" || el.tagName === "pre") {
        result.push(child); // Skip code/pre subtrees entirely — don't rewrite code text.
      } else {
        result.push({
          ...el,
          children: transformChildren(el.children),
        } as unknown as T);
      }
    } else {
      result.push(child);
    }
  }
  return result;
}

/**
 * The rehype plugin itself. Usage: `rehypePlugins={[rehypeKatex, rehypeCitations]}`.
 * Pure and synchronous — returns a transformer closure that mutates the tree
 * in place (the standard unified/rehype plugin shape), performing no I/O and
 * touching no application state.
 */
export function rehypeCitations() {
  return (tree: Root) => {
    tree.children = transformChildren(tree.children);
  };
}

export default rehypeCitations;
