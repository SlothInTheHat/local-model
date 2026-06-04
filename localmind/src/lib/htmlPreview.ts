/**
 * HTML preview resource inliner.
 *
 * Blob-URL iframes have no base directory, so relative references like
 * href="style.css" or src="app.js" always fail.  Before handing HTML to
 * a blob URL we scan for local CSS, JS and image/font references and
 * replace them with fully-inlined content so the preview looks identical
 * to opening the file directly in a browser.
 *
 * CSS files → <style> tags (url() inside also rewritten to data URIs)
 * JS files  → <script> tags
 * Images in CSS url() / <img src> → data: URIs
 * External http/https/data: URLs → left untouched
 */

import { readFileFromHandle } from "./fileSystem";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTauriEnv(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

/** Resolve ".." and "." segments. */
function normPath(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

function isExternal(url: string): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("//") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("#") ||
    lower.startsWith("javascript:")
  );
}

function extMime(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    bmp: "image/bmp",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

// ─── File readers ─────────────────────────────────────────────────────────────

async function readText(
  dirHandle: FileSystemDirectoryHandle,
  path: string,
): Promise<string | null> {
  try {
    return await readFileFromHandle(dirHandle, path);
  } catch {
    return null;
  }
}

/**
 * Read a (possibly binary) file and return a `data:<mime>;base64,...` URI.
 * In Tauri mode uses fs_read_file_base64 (avoids text corruption of binary).
 * In browser mode uses the File API arrayBuffer.
 */
async function readAsDataUri(
  dirHandle: FileSystemDirectoryHandle,
  path: string,
  workspacePath: string | null,
): Promise<string | null> {
  const ext = path.split(".").pop() ?? "";
  const mime = extMime(ext);

  if (isTauriEnv() && workspacePath) {
    try {
      const w = window as unknown as Record<string, unknown>;
      const tauri = w.__TAURI__ as {
        core: { invoke: (cmd: string, args?: unknown) => Promise<string> };
      };
      const absPath = normPath(`${workspacePath.replace(/\\/g, "/")}/${path}`);
      const b64 = await tauri.core.invoke("fs_read_file_base64", { path: absPath });
      return `data:${mime};base64,${b64}`;
    } catch {
      return null;
    }
  }

  // Browser mode — File System Access API
  try {
    const parts = path.split("/").filter(Boolean);
    const fileName = parts.pop()!;
    let cur: FileSystemDirectoryHandle = dirHandle;
    for (const part of parts) {
      cur = await cur.getDirectoryHandle(part, { create: false });
    }
    const fh = await cur.getFileHandle(fileName, { create: false });
    const file = await fh.getFile();
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

// ─── CSS url() rewriter ───────────────────────────────────────────────────────

/**
 * Replace `url('relative/path')` inside a CSS string with base64 data URIs.
 * `cssDir` is the directory the CSS file lives in (relative to workspace root).
 */
async function rewriteCssUrls(
  css: string,
  cssDir: string,
  dirHandle: FileSystemDirectoryHandle,
  workspacePath: string | null,
): Promise<string> {
  const matches = [...css.matchAll(/url\((['"]?)([^'")\s]+)\1\)/gi)];
  for (const m of matches) {
    const raw = m[2];
    if (isExternal(raw)) continue;
    const resolved = normPath(cssDir ? `${cssDir}/${raw}` : raw);
    const dataUri = await readAsDataUri(dirHandle, resolved, workspacePath);
    if (dataUri) css = css.replace(m[0], `url("${dataUri}")`);
  }
  return css;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Walk an HTML string and inline all local CSS, JS, and binary assets so that
 * a blob-URL iframe renders it identically to opening the file in a real browser.
 *
 * @param html        Raw HTML content of the file being previewed
 * @param dirHandle   Workspace FileSystemDirectoryHandle
 * @param htmlPath    Relative path of the HTML file within the workspace (e.g. "src/index.html")
 * @param workspacePath OS-level absolute path (needed for Tauri binary reads; null in browser mode)
 */
export async function inlineHtmlResources(
  html: string,
  dirHandle: FileSystemDirectoryHandle,
  htmlPath: string,
  workspacePath: string | null,
): Promise<string> {
  const baseDir = htmlPath.includes("/")
    ? htmlPath.slice(0, htmlPath.lastIndexOf("/"))
    : "";

  // ── 1. Inline <link rel="stylesheet" href="…"> ──────────────────────────
  const linkMatches = [...html.matchAll(/<link\b([^>]*)>/gi)];
  for (const m of linkMatches) {
    const attrs = m[1];
    if (!/\bstylesheet\b/i.test(attrs)) continue;
    const hrefM = /\bhref=["']([^"']+)["']/i.exec(attrs);
    if (!hrefM) continue;
    const href = hrefM[1];
    if (isExternal(href)) continue;

    const cssPath = normPath(baseDir ? `${baseDir}/${href}` : href);
    const cssText = await readText(dirHandle, cssPath);
    if (cssText === null) continue;

    const cssDir = cssPath.includes("/") ? cssPath.slice(0, cssPath.lastIndexOf("/")) : "";
    const inlined = await rewriteCssUrls(cssText, cssDir, dirHandle, workspacePath);
    html = html.replace(m[0], `<style>\n${inlined}\n</style>`);
  }

  // ── 2. Inline <script src="…"></script> ──────────────────────────────────
  // Handle both self-closing style and empty body style, with optional whitespace
  const scriptMatches = [...html.matchAll(/<script\b([^>]*)>\s*<\/script>/gi)];
  for (const m of scriptMatches) {
    const attrs = m[1];
    const srcM = /\bsrc=["']([^"']+)["']/i.exec(attrs);
    if (!srcM) continue;
    const src = srcM[1];
    if (isExternal(src)) continue;

    const jsPath = normPath(baseDir ? `${baseDir}/${src}` : src);
    const jsText = await readText(dirHandle, jsPath);
    if (jsText === null) continue;

    // Preserve other attributes (type, defer, async, …) but drop src
    const remainingAttrs = attrs.replace(/\bsrc=["'][^"']*["']/i, "").trim();
    const openTag = remainingAttrs ? `<script ${remainingAttrs}>` : "<script>";
    html = html.replace(m[0], `${openTag}\n${jsText}\n</script>`);
  }

  // ── 3. Convert <img src="relative"> to data: URIs ────────────────────────
  const imgMatches = [...html.matchAll(/<img\b([^>]*)>/gi)];
  for (const m of imgMatches) {
    const srcM = /\bsrc=["']([^"']+)["']/i.exec(m[1]);
    if (!srcM) continue;
    const src = srcM[1];
    if (isExternal(src)) continue;

    const imgPath = normPath(baseDir ? `${baseDir}/${src}` : src);
    const dataUri = await readAsDataUri(dirHandle, imgPath, workspacePath);
    if (dataUri) html = html.replace(srcM[0], `src="${dataUri}"`);
  }

  return html;
}
