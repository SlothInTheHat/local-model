import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  build: {
    rollupOptions: {
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
      },
    },
  },
}));
