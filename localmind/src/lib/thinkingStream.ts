/**
 * Splits a streamed token sequence into visible text vs. reasoning ("thinking")
 * content, for models that emit `<think>...</think>` inline in `content`
 * instead of (or in addition to) using Ollama's native `message.thinking`
 * field. A per-chunk regex can't do this correctly — the tags routinely land
 * split across two separate stream chunks — so this keeps a small buffer of
 * unresolved trailing text across calls.
 */

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

export interface ThinkSplitResult {
  text: string;
  thinking: string;
}

/** Longest prefix of `needle` that `s` ends with (excluding a full match) — i.e. how much of `s`'s tail to hold back in case the next chunk completes the tag. */
function trailingPartialTagLength(s: string, needle: string): number {
  const maxLen = Math.min(s.length, needle.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (s.endsWith(needle.slice(0, len))) return len;
  }
  return 0;
}

export function createThinkSplitter() {
  let inThink = false;
  let buffer = "";

  function push(chunk: string): ThinkSplitResult {
    let text = "";
    let thinking = "";
    let input = buffer + chunk;
    buffer = "";

    while (input.length > 0) {
      const tag = inThink ? CLOSE_TAG : OPEN_TAG;
      const idx = input.indexOf(tag);
      if (idx === -1) {
        const holdBack = trailingPartialTagLength(input, tag);
        const emit = input.slice(0, input.length - holdBack);
        if (inThink) thinking += emit; else text += emit;
        buffer = holdBack > 0 ? input.slice(input.length - holdBack) : "";
        input = "";
      } else {
        const emit = input.slice(0, idx);
        if (inThink) thinking += emit; else text += emit;
        input = input.slice(idx + tag.length);
        inThink = !inThink;
      }
    }

    return { text, thinking };
  }

  /** Flush any buffered partial-tag text as plain text (call at stream end — an unclosed tag fragment is not a real tag). */
  function flush(): ThinkSplitResult {
    const leftover = buffer;
    buffer = "";
    return inThink ? { text: "", thinking: leftover } : { text: leftover, thinking: "" };
  }

  return { push, flush };
}
