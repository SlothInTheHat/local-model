/**
 * KM1 — image transcription via the `vision` model role.
 *
 * Mirrors the vision sub-call shape in take_screenshot's tool executor
 * (src/lib/tools.ts ~2210): the primary model never sees the image bytes —
 * this module looks at the pixels itself (via `resolveRole("vision")`) and
 * hands back plain text, which then flows through the same chunk/embed path
 * as every other document type. Degrades to a single placeholder Section
 * (never throws) when no vision model is installed, since one un-ingestible
 * image in a batch shouldn't be treated as a hard error by the orchestrator.
 */
import { resolveRole } from "../modelRoles";
import { streamChatForModel } from "../chatProvider";
import type { Section } from "./types";

/** Hard cap on the transcription response so a rambling vision model can't
 *  stall ingestion of the rest of the batch. */
const VISION_MAX_CHARS = 4000;

/**
 * Transcribe an image's text and describe its diagrams for study notes.
 * `base64` must be RAW base64 (no `data:` prefix) — the shape
 * `read_upload_bytes` (src-tauri/src/lib.rs) already returns.
 */
export async function extractImage(base64: string, fileName: string): Promise<Section[]> {
  const visionModel = resolveRole("vision");
  if (!visionModel) {
    return [{ text: "(image, no vision model configured)", location: "(image)" }];
  }

  const prompt = `Transcribe ALL text and describe any diagrams in this image for study notes. The image file is named "${fileName}".`;
  try {
    let text = "";
    for await (const chunk of streamChatForModel(visionModel, [
      { role: "user", content: prompt, images: [base64] },
    ])) {
      text += chunk;
      if (text.length > VISION_MAX_CHARS) break;
    }
    const trimmed = text.trim();
    return [{
      text: trimmed || "(image, vision model returned an empty response)",
      location: "(image)",
    }];
  } catch (err) {
    // Never throw out of a single file's extraction — degrade to a
    // placeholder noting why, same policy as the "no vision model" branch.
    const reason = err instanceof Error ? err.message : String(err);
    return [{ text: `(image, vision model call failed: ${reason})`, location: "(image)" }];
  }
}
