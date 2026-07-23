import type { editor } from "monaco-editor";

/**
 * Custom Monaco themes matching LocalMind's "warm paper" token palette
 * (src/index.css) — Monaco can't read CSS custom properties, so it needs
 * concrete color literals registered via monaco.editor.defineTheme. Fixes
 * the Code tab's editor surface staying permanently VS-Code-dark regardless
 * of the app's light/dark setting.
 */
export const LOCALMIND_LIGHT_THEME: editor.IStandaloneThemeData = {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#FAFAF9", // --card
    "editor.foreground": "#111111", // --foreground
    "editorLineNumber.foreground": "#6B6660", // --muted-foreground
    "editorLineNumber.activeForeground": "#111111",
    "editor.lineHighlightBackground": "#E7E2D9", // --muted
    "editor.lineHighlightBorder": "#00000000",
    "editorCursor.foreground": "#0A0A0A", // --primary
    "editor.selectionBackground": "#E3DED4", // --accent
    "editorWidget.background": "#FAFAF9",
    "editorWidget.border": "#00000012", // --border
    "editorSuggestWidget.background": "#FAFAF9",
    "editorSuggestWidget.border": "#00000012",
    "editorIndentGuide.background": "#00000012",
    "editorIndentGuide.activeBackground": "#0000002a",
  },
};

export const LOCALMIND_DARK_THEME: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1C1B19",
    "editor.foreground": "#EDEBE6",
    "editorLineNumber.foreground": "#8A8681",
    "editorLineNumber.activeForeground": "#EDEBE6",
    "editor.lineHighlightBackground": "#26241F",
    "editor.lineHighlightBorder": "#00000000",
    "editorCursor.foreground": "#F0EDE7",
    "editor.selectionBackground": "#3A3730",
    "editorWidget.background": "#242320",
    "editorWidget.border": "#FFFFFF14",
    "editorSuggestWidget.background": "#242320",
    "editorSuggestWidget.border": "#FFFFFF14",
    "editorIndentGuide.background": "#FFFFFF14",
    "editorIndentGuide.activeBackground": "#FFFFFF2a",
  },
};

let registered = false;

/** Registers both custom themes once per app session — idempotent, safe to call from every mount. */
export function registerLocalMindMonacoThemes(monacoInstance: { editor: { defineTheme: (name: string, data: editor.IStandaloneThemeData) => void } }): void {
  if (registered) return;
  registered = true;
  monacoInstance.editor.defineTheme("localmind-light", LOCALMIND_LIGHT_THEME);
  monacoInstance.editor.defineTheme("localmind-dark", LOCALMIND_DARK_THEME);
}
