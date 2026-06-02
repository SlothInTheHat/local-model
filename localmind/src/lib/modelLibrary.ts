import type { HardwareInfo } from "./hardware";

export interface ModelSpec {
  id: string;          // Ollama pull name, e.g. "llama3.2:3b"
  name: string;
  family: string;
  description: string;
  paramCount: string;
  diskSizeGb: number;
  minRamGb: number;
  minVramGb: number;
  tags: ModelTag[];
  contextLength: number;
}

export type ModelTag = "fast" | "lightweight" | "balanced" | "powerful" | "coding" |
  "reasoning" | "math" | "vision" | "multilingual" | "embedding" | "long-context";

export type Compatibility = "gpu-ready" | "cpu-only" | "too-large";

export function getCompatibility(spec: ModelSpec, hw: HardwareInfo | null): Compatibility {
  if (!hw) return "cpu-only";

  // GPU path: model comfortably fits in VRAM
  if (hw.vramGb > 0 && spec.diskSizeGb <= hw.vramGb * 0.95) return "gpu-ready";

  // CPU path: needs ~1.3× disk size in RAM to run with quantization buffers
  if (spec.diskSizeGb * 1.3 <= hw.ramGb) return "cpu-only";

  return "too-large";
}

export const TAG_COLORS: Record<ModelTag, string> = {
  fast: "bg-green-900/60 text-green-300",
  lightweight: "bg-green-900/60 text-green-300",
  balanced: "bg-blue-900/60 text-blue-300",
  powerful: "bg-purple-900/60 text-purple-300",
  coding: "bg-yellow-900/60 text-yellow-300",
  reasoning: "bg-orange-900/60 text-orange-300",
  math: "bg-orange-900/60 text-orange-300",
  vision: "bg-pink-900/60 text-pink-300",
  multilingual: "bg-teal-900/60 text-teal-300",
  embedding: "bg-zinc-700 text-zinc-300",
  "long-context": "bg-indigo-900/60 text-indigo-300",
};

export const FAMILY_COLORS: Record<string, string> = {
  llama: "bg-blue-800/50 text-blue-300",
  mistral: "bg-orange-800/50 text-orange-300",
  phi: "bg-purple-800/50 text-purple-300",
  gemma: "bg-green-800/50 text-green-300",
  qwen: "bg-red-800/50 text-red-300",
  deepseek: "bg-cyan-800/50 text-cyan-300",
  llava: "bg-pink-800/50 text-pink-300",
  nomic: "bg-zinc-700 text-zinc-300",
};

export const MODEL_LIBRARY: ModelSpec[] = [
  // ── Llama ──────────────────────────────────────────────────────────────
  {
    id: "llama3.2:1b",
    name: "Llama 3.2 1B",
    family: "llama",
    description: "Meta's smallest Llama 3.2 — ultra-fast, great for simple Q&A on any device.",
    paramCount: "1B",
    diskSizeGb: 1.3,
    minRamGb: 3,
    minVramGb: 2,
    tags: ["fast", "lightweight"],
    contextLength: 128000,
  },
  {
    id: "llama3.2:3b",
    name: "Llama 3.2 3B",
    family: "llama",
    description: "Great balance of speed and quality. Handles everyday tasks well on any modern laptop.",
    paramCount: "3B",
    diskSizeGb: 2.0,
    minRamGb: 5,
    minVramGb: 3,
    tags: ["fast", "balanced"],
    contextLength: 128000,
  },
  {
    id: "llama3.1:8b",
    name: "Llama 3.1 8B",
    family: "llama",
    description: "Meta's flagship 8B — strong reasoning, coding, and instruction following.",
    paramCount: "8B",
    diskSizeGb: 4.7,
    minRamGb: 8,
    minVramGb: 6,
    tags: ["balanced", "coding"],
    contextLength: 128000,
  },
  {
    id: "llama3.1:70b",
    name: "Llama 3.1 70B",
    family: "llama",
    description: "Frontier-class open model. Matches GPT-4 performance on many benchmarks.",
    paramCount: "70B",
    diskSizeGb: 40,
    minRamGb: 48,
    minVramGb: 48,
    tags: ["powerful", "reasoning"],
    contextLength: 128000,
  },
  {
    id: "codellama:7b",
    name: "Code Llama 7B",
    family: "llama",
    description: "Meta's code-specialized model, excellent for completions and generation.",
    paramCount: "7B",
    diskSizeGb: 3.8,
    minRamGb: 8,
    minVramGb: 5,
    tags: ["coding", "fast"],
    contextLength: 16000,
  },
  {
    id: "codellama:13b",
    name: "Code Llama 13B",
    family: "llama",
    description: "Stronger code understanding for complex codebases and multi-file context.",
    paramCount: "13B",
    diskSizeGb: 7.4,
    minRamGb: 12,
    minVramGb: 9,
    tags: ["coding", "balanced"],
    contextLength: 16000,
  },

  // ── Mistral ────────────────────────────────────────────────────────────
  {
    id: "mistral:7b",
    name: "Mistral 7B",
    family: "mistral",
    description: "Fast, efficient, and highly capable — a classic all-rounder.",
    paramCount: "7B",
    diskSizeGb: 4.1,
    minRamGb: 8,
    minVramGb: 5,
    tags: ["fast", "balanced"],
    contextLength: 32000,
  },
  {
    id: "mistral-nemo",
    name: "Mistral Nemo 12B",
    family: "mistral",
    description: "128K context window with excellent instruction following.",
    paramCount: "12B",
    diskSizeGb: 7.1,
    minRamGb: 12,
    minVramGb: 8,
    tags: ["balanced", "long-context"],
    contextLength: 128000,
  },

  // ── Microsoft Phi ──────────────────────────────────────────────────────
  {
    id: "phi3.5",
    name: "Phi-3.5 Mini 3.8B",
    family: "phi",
    description: "Compact Microsoft model with 128K context. Great for coding on lower-end hardware.",
    paramCount: "3.8B",
    diskSizeGb: 2.2,
    minRamGb: 5,
    minVramGb: 3,
    tags: ["fast", "coding", "lightweight"],
    contextLength: 128000,
  },
  {
    id: "phi4",
    name: "Phi-4 14B",
    family: "phi",
    description: "Microsoft's Phi-4 — punches above its weight in math, coding, and reasoning.",
    paramCount: "14B",
    diskSizeGb: 9.1,
    minRamGb: 14,
    minVramGb: 10,
    tags: ["reasoning", "coding", "math"],
    contextLength: 16000,
  },

  // ── Google Gemma ───────────────────────────────────────────────────────
  {
    id: "gemma2:2b",
    name: "Gemma 2 2B",
    family: "gemma",
    description: "Google's smallest Gemma 2 — surprisingly capable, fast on CPU.",
    paramCount: "2B",
    diskSizeGb: 1.6,
    minRamGb: 4,
    minVramGb: 3,
    tags: ["fast", "lightweight"],
    contextLength: 8192,
  },
  {
    id: "gemma2:9b",
    name: "Gemma 2 9B",
    family: "gemma",
    description: "Strong all-rounder from Google with great instruction following.",
    paramCount: "9B",
    diskSizeGb: 5.5,
    minRamGb: 10,
    minVramGb: 7,
    tags: ["balanced"],
    contextLength: 8192,
  },
  {
    id: "gemma2:27b",
    name: "Gemma 2 27B",
    family: "gemma",
    description: "Google's largest Gemma 2. Competitive with much bigger models.",
    paramCount: "27B",
    diskSizeGb: 16,
    minRamGb: 24,
    minVramGb: 18,
    tags: ["powerful"],
    contextLength: 8192,
  },

  // ── Alibaba Qwen ───────────────────────────────────────────────────────
  {
    id: "qwen2.5:3b",
    name: "Qwen 2.5 3B",
    family: "qwen",
    description: "Compact multilingual model with strong Chinese language support.",
    paramCount: "3B",
    diskSizeGb: 2.0,
    minRamGb: 5,
    minVramGb: 3,
    tags: ["fast", "multilingual"],
    contextLength: 32768,
  },
  {
    id: "qwen2.5:7b",
    name: "Qwen 2.5 7B",
    family: "qwen",
    description: "Excellent multilingual model with strong coding and math.",
    paramCount: "7B",
    diskSizeGb: 4.7,
    minRamGb: 8,
    minVramGb: 6,
    tags: ["balanced", "multilingual", "coding"],
    contextLength: 32768,
  },
  {
    id: "qwen2.5:14b",
    name: "Qwen 2.5 14B",
    family: "qwen",
    description: "Strong mid-range with exceptional coding and instruction-following.",
    paramCount: "14B",
    diskSizeGb: 9.0,
    minRamGb: 14,
    minVramGb: 10,
    tags: ["powerful", "multilingual", "coding"],
    contextLength: 32768,
  },
  {
    id: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder 7B",
    family: "qwen",
    description: "Specialized for code generation and debugging across 40+ languages.",
    paramCount: "7B",
    diskSizeGb: 4.7,
    minRamGb: 8,
    minVramGb: 6,
    tags: ["coding", "balanced"],
    contextLength: 32768,
  },
  {
    id: "qwen2.5-coder:14b",
    name: "Qwen 2.5 Coder 14B",
    family: "qwen",
    description: "Best-in-class local code model at this size. Rivals Claude/GPT for coding.",
    paramCount: "14B",
    diskSizeGb: 9.0,
    minRamGb: 14,
    minVramGb: 10,
    tags: ["coding", "powerful"],
    contextLength: 32768,
  },

  // ── DeepSeek ───────────────────────────────────────────────────────────
  {
    id: "deepseek-r1:7b",
    name: "DeepSeek R1 7B",
    family: "deepseek",
    description: "Chain-of-thought reasoning distilled from R1. Excellent for complex problems.",
    paramCount: "7B",
    diskSizeGb: 4.7,
    minRamGb: 8,
    minVramGb: 6,
    tags: ["reasoning", "math", "coding"],
    contextLength: 32768,
  },
  {
    id: "deepseek-r1:14b",
    name: "DeepSeek R1 14B",
    family: "deepseek",
    description: "Stronger reasoning at 14B — great for multi-step math and science.",
    paramCount: "14B",
    diskSizeGb: 9.0,
    minRamGb: 14,
    minVramGb: 10,
    tags: ["reasoning", "math", "powerful"],
    contextLength: 32768,
  },
  {
    id: "deepseek-r1:32b",
    name: "DeepSeek R1 32B",
    family: "deepseek",
    description: "High-end reasoning model. Among the best open-source for math and science.",
    paramCount: "32B",
    diskSizeGb: 20,
    minRamGb: 28,
    minVramGb: 22,
    tags: ["reasoning", "powerful", "math"],
    contextLength: 32768,
  },

  // ── Vision ─────────────────────────────────────────────────────────────
  {
    id: "llava:7b",
    name: "LLaVA 7B",
    family: "llava",
    description: "Multimodal model — ask questions about images, photos, and diagrams.",
    paramCount: "7B",
    diskSizeGb: 4.5,
    minRamGb: 8,
    minVramGb: 6,
    tags: ["vision", "balanced"],
    contextLength: 4096,
  },
  {
    id: "llava:13b",
    name: "LLaVA 13B",
    family: "llava",
    description: "Larger vision model with stronger image reasoning and description.",
    paramCount: "13B",
    diskSizeGb: 8.0,
    minRamGb: 12,
    minVramGb: 10,
    tags: ["vision", "powerful"],
    contextLength: 4096,
  },

  // ── Embeddings ─────────────────────────────────────────────────────────
  {
    id: "nomic-embed-text",
    name: "Nomic Embed Text",
    family: "nomic",
    description: "High-quality text embeddings for RAG, semantic search, and similarity.",
    paramCount: "137M",
    diskSizeGb: 0.3,
    minRamGb: 2,
    minVramGb: 1,
    tags: ["embedding", "lightweight"],
    contextLength: 8192,
  },
];
