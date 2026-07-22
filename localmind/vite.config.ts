import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// vite.config.ts is ESM, so __dirname isn't defined — derive it from
// import.meta.url instead.
const __dirname = fileURLToPath(new URL(".", import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  build: {
    rollupOptions: {
      // Multi-page build (WP5.3, extended for the result widget): the overlay
      // and result windows each load their own HTML entry so their bundles
      // never pull in main.tsx/App.tsx (and, by extension, the
      // stores/scheduler/taskRunner side effects those import).
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
        result: resolve(__dirname, "result.html"),
      },
      output: {
        manualChunks: {
          "vendor-radix": [
            "@radix-ui/react-slot", "@radix-ui/react-separator",
            "@radix-ui/react-scroll-area", "@radix-ui/react-progress",
            "@radix-ui/react-dialog", "@radix-ui/react-tooltip",
          ],
          "vendor-markdown": ["react-markdown", "remark-gfm"],
          "vendor-math": ["mathjs"],
          monaco: ["@monaco-editor/react", "monaco-editor"],
          tiptap: ["@tiptap/react", "@tiptap/starter-kit", "@tiptap/extension-placeholder", "@tiptap/suggestion"],
          docx: ["docx"],
          // KM1: pdf.js is only touched by the Knowledge Hub's PDF ingestion
          // path (src/lib/knowledge/pdf.ts) — split into its own chunk so it
          // doesn't bloat the main bundle for users who never ingest a PDF.
          pdfjs: ["pdfjs-dist"],
        },
      },
    },
  },

  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Proxy DuckDuckGo search to avoid CORS in browser dev mode.
    // The packaged Tauri app fetches directly (no CORS in native webview).
    proxy: {
      "/ddg-search": {
        target: "https://api.duckduckgo.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ddg-search/, ""),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        },
      },
      "/ddg-lite": {
        target: "https://lite.duckduckgo.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ddg-lite/, ""),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      "/ddg-html": {
        target: "https://html.duckduckgo.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ddg-html/, ""),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    },
  },
}));
