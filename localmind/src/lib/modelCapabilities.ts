/**
 * Returns true if the model supports native tool/function calling via Ollama.
 */
export function supportsNativeTools(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return (
    lower.includes("llama3.1") ||
    lower.includes("llama3.2") ||
    lower.includes("llama 3.1") ||
    lower.includes("llama 3.2") ||
    lower.includes("mistral-nemo") ||
    lower.includes("qwen2.5") ||
    lower.includes("command-r")
  );
}

/**
 * Returns true if the model supports vision / image inputs.
 */
export function isVisionModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return (
    lower.includes("llava") ||
    lower.includes("bakllava") ||
    lower.includes("moondream") ||
    lower.includes("minicpm") ||
    lower.includes("llama3.2") ||
    lower.includes("llama 3.2")
  );
}
