/**
 * KM1 — PDF text extraction via pdfjs-dist.
 *
 * One `Section` per page (`location: "p.<n>"`), text = that page's text
 * items joined into a single normalized string. Uses the standard (not
 * legacy) pdfjs-dist build, since this app only ever runs inside a modern
 * Tauri webview / Vite dev server — no need for the legacy build's older
 * browser shims.
 *
 * ─── Offline-first requirement ─────────────────────────────────────────────
 * pdf.js farms text/rendering work out to a worker script. If that worker is
 * ever loaded from a CDN (pdfjs-dist's own docs default to unpkg/cdnjs
 * examples), this app would silently require network access to open a PDF —
 * unacceptable for an offline-first tool. Importing the worker file through
 * Vite's `?url` suffix instead resolves it to a same-origin, content-hashed
 * asset URL at build time (see `declare module '*?url'` in vite/client.d.ts,
 * referenced from src/vite-env.d.ts), so the worker ships inside `dist/`
 * alongside everything else — mirroring how katex's fonts/CSS are bundled
 * locally rather than pulled from a CDN (src/components/Markdown.tsx).
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
// Vite URL-import: resolves to a local, hashed asset path — never a network URL.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Section } from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Extract one Section per page from a PDF's raw bytes. */
export async function extractPdf(bytes: Uint8Array): Promise<Section[]> {
  // getDocument() returns a PDFDocumentLoadingTask — `.promise` resolves to
  // the PDFDocumentProxy with the actual page data; `destroy()` (worker/
  // network cleanup) lives on the task, not the proxy, so both are kept.
  const loadingTask = getDocument({ data: bytes });
  const sections: Section[] = [];
  try {
    const doc = await loadingTask.promise;
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => (typeof (item as TextItem).str === "string" ? (item as TextItem).str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        sections.push({ text, location: `p.${pageNum}` });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return sections;
}
