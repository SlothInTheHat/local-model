import type { languages } from "monaco-editor";

/**
 * Minimal LaTeX Monarch tokenizer — token coloring only (comments, control
 * sequences, brace/bracket delimiters, math spans). No bracket-matching-aware
 * grammar, no autocomplete/snippets — explicitly out of scope, see the Resume
 * Tailoring plan.
 */
const LATEX_MONARCH_LANGUAGE: languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/\\[a-zA-Z]+/, "keyword"],
      [/\$\$/, { token: "string", next: "@mathblock" }],
      [/\$/, { token: "string", next: "@mathinline" }],
      [/[{}]/, "@brackets"],
      [/[[\]]/, "@brackets"],
    ],
    mathblock: [
      [/\$\$/, { token: "string", next: "@pop" }],
      [/[^$]+/, "string"],
    ],
    mathinline: [
      [/\$/, { token: "string", next: "@pop" }],
      [/[^$]+/, "string"],
    ],
  },
};

let registered = false;

/** Registers the "latex" Monaco language id once per app session — idempotent, safe to call from every mount (mirrors monacoThemes.ts's guard pattern). */
export function registerLatexLanguage(monacoInstance: {
  languages: {
    register: (lang: { id: string }) => void;
    setMonarchTokensProvider: (id: string, lang: languages.IMonarchLanguage) => void;
  };
}): void {
  if (registered) return;
  registered = true;
  monacoInstance.languages.register({ id: "latex" });
  monacoInstance.languages.setMonarchTokensProvider("latex", LATEX_MONARCH_LANGUAGE);
}
