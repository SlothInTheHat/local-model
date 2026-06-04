import { MODEL_LIBRARY, getCompatibility } from "./modelLibrary";
import type { HardwareInfo } from "./hardware";

export type TaskType = "coding" | "math" | "vision" | "research" | "writing" | "general";

interface TaskSignal {
  type: TaskType;
  label: string;
  reason: string;
}

const CODING_KW = [
  "code", "bug", "debug", "implement", "function", "class", "script", "program",
  "compile", "syntax", "error", "typescript", "javascript", "python", "rust", "go",
  "react", "refactor", "algorithm", "leetcode", "write a function", "write a class",
  "create a component", "build an api", "fix this", "unit test", "integration test",
];

const MATH_KW = [
  "calculate", "solve", "equation", "integral", "derivative", "algebra",
  "geometry", "statistics", "probability", "compute", "proof", "formula",
  "linear regression", "matrix", "calculus",
];

const RESEARCH_KW = [
  "research", "explain", "analyze", "analyse", "summarize", "summarise",
  "compare", "what is", "what are", "how does", "how do", "history of",
  "background on", "overview of", "understand", "tell me about",
  "information about", "difference between", "pros and cons",
];

const WRITING_KW = [
  "write an essay", "write a story", "write a poem", "creative writing",
  "draft a", "rewrite this", "rephrase", "proofread", "improve my writing",
  "write a blog", "cover letter", "write a report",
];

function hits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
}

export function detectTask(text: string, hasImages: boolean): TaskSignal {
  if (hasImages) return { type: "vision", label: "vision", reason: "image understanding" };

  const scores = {
    coding: hits(text, CODING_KW),
    math: hits(text, MATH_KW),
    research: hits(text, RESEARCH_KW),
    writing: hits(text, WRITING_KW),
  };

  const max = Math.max(...Object.values(scores));
  if (max === 0) return { type: "general", label: "general", reason: "general task" };

  if (scores.coding === max) return { type: "coding", label: "coding", reason: "code task" };
  if (scores.math === max) return { type: "math", label: "math", reason: "math problem" };
  if (scores.research === max) return { type: "research", label: "research", reason: "research task" };
  return { type: "writing", label: "writing", reason: "writing task" };
}

function scoreModel(name: string, task: TaskType): number {
  const n = name.toLowerCase();
  switch (task) {
    case "coding":
      if (n.includes("deepseek-coder") || n.includes("deepseek_coder")) return 100;
      if (n.includes("qwen2.5-coder") || n.includes("qwen2.5_coder")) return 96;
      if (n.includes("codellama")) return 92;
      if (n.includes("codegemma")) return 88;
      if (n.includes("starcoder")) return 85;
      if (n.includes("magicoder") || n.includes("wizardcoder")) return 82;
      if (n.includes("code")) return 65;
      if (n.includes("deepseek")) return 52;
      if (n.includes("qwen2.5")) return 46;
      if (n.includes("llama3.1") || n.includes("llama3.2") || n.includes("llama 3.1") || n.includes("llama 3.2")) return 42;
      if (n.includes("mistral-nemo") || n.includes("mistral")) return 38;
      return 20;

    case "math":
      if (n.includes("deepseek-math") || n.includes("mathstral")) return 100;
      if (n.includes("qwen2.5-math") || n.includes("wizard-math")) return 96;
      if (n.includes("deepseek")) return 62;
      if (n.includes("qwen2.5")) return 56;
      if (n.includes("llama3.1") || n.includes("llama 3.1")) return 44;
      if (n.includes("mistral")) return 38;
      return 22;

    case "vision":
      if (n.includes("llava")) return 100;
      if (n.includes("bakllava")) return 96;
      if (n.includes("minicpm")) return 92;
      if (n.includes("moondream")) return 88;
      if (n.includes("llama3.2") || n.includes("llama 3.2")) return 80;
      return 0;

    case "research":
    case "writing":
    case "general":
      if (n.includes("llama3.1") || n.includes("llama 3.1") || n.includes("llama3.2") || n.includes("llama 3.2")) return 90;
      if (n.includes("mistral-nemo") || n.includes("mistral-large")) return 88;
      if (n.includes("gemma2") || n.includes("gemma-2")) return 86;
      if (n.includes("command-r")) return 84;
      if (n.includes("mistral")) return 76;
      if (n.includes("gemma")) return 72;
      if (n.includes("phi3") || n.includes("phi-3") || n.includes("phi 3")) return 66;
      if (n.includes("llama")) return 60;
      if (n.includes("qwen2.5")) return 54;
      if (n.includes("coder") || n.includes("starcoder")) return 18;
      return 40;
  }
}

export function recommendModel(
  text: string,
  hasImages: boolean,
  availableModels: string[],
  currentModel: string,
  hardware?: HardwareInfo | null,
): { model: string; taskLabel: string; reason: string } | null {
  if (availableModels.length <= 1) return null;

  const task = detectTask(text, hasImages);
  if (task.type === "general") return null;

  // Filter to models that actually fit in the user's hardware.
  // Models not in the library (custom pulls) are kept — we can't check their size.
  const candidates = hardware
    ? availableModels.filter((name) => {
        const spec = MODEL_LIBRARY.find(
          (s) => s.id === name || s.id === `${name}:latest`,
        );
        if (!spec) return true; // unknown — don't exclude
        return getCompatibility(spec, hardware) !== "too-large";
      })
    : availableModels;

  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort(
    (a, b) => scoreModel(b, task.type) - scoreModel(a, task.type),
  );

  const best = ranked[0];
  if (best === currentModel) return null;

  const bestScore = scoreModel(best, task.type);
  const currentScore = scoreModel(currentModel, task.type);
  if (bestScore - currentScore < 15) return null;

  if (task.type === "vision" && bestScore === 0) return null;

  return { model: best, taskLabel: task.label, reason: task.reason };
}
