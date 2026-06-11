/**
 * Returns true if the model supports native tool/function calling.
 * Non-Ollama models (containing "::") use OpenAI-compat format and always support tools.
 */
export function supportsNativeTools(modelName: string): boolean {
  // OpenAI-compatible provider models always support tool use
  if (modelName.includes("::")) return true;
  const lower = modelName.toLowerCase();
  return (
    // Meta Llama 3.1+
    lower.includes("llama3.1") || lower.includes("llama 3.1") ||
    lower.includes("llama3.2") || lower.includes("llama 3.2") ||
    lower.includes("llama3.3") || lower.includes("llama 3.3") ||
    lower.includes("llama3.4") || lower.includes("llama 3.4") ||
    // Mistral family
    lower.includes("mistral-nemo") ||
    lower.includes("mistral-large") ||
    lower.includes("devstral") ||
    lower.includes("mixtral") ||
    // Alibaba Qwen
    lower.includes("qwen2.5") ||
    lower.includes("qwen2") ||
    lower.includes("qwen3") ||
    // Cohere
    lower.includes("command-r") ||
    // Nous Research (tool-finetuned)
    lower.includes("hermes3") || lower.includes("hermes-3") ||
    lower.includes("hermes2") || lower.includes("hermes-2") ||
    // IBM Granite 3+
    lower.includes("granite3") || lower.includes("granite-3") ||
    // NVIDIA Nemotron
    lower.includes("nemotron") ||
    // Fireworks FireFunction
    lower.includes("firefunction") ||
    // Google Gemma 2+ via Ollama
    lower.includes("gemma2") || lower.includes("gemma-2") ||
    // xAI Grok
    lower.includes("grok")
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
    lower.includes("llama3.2") || lower.includes("llama 3.2") ||
    lower.includes("llama3.2-vision") ||
    lower.includes("llava-llama3") ||
    lower.includes("qwen2-vl") || lower.includes("qwen2.5-vl") ||
    lower.includes("internvl") ||
    lower.includes("phi-3-vision") || lower.includes("phi3-vision") ||
    lower.includes("cogvlm") ||
    lower.includes("pixtral")
  );
}
