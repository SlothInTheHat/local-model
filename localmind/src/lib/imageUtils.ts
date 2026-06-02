/**
 * Reads a File as a DataURL and strips the "data:...;base64," prefix,
 * returning the raw base64 string expected by Ollama.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix: "data:<mime>;base64,"
      const base64 = result.split(",")[1];
      if (!base64) {
        reject(new Error("Failed to extract base64 data from file"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

/**
 * Returns true if the model name indicates vision/multimodal capability.
 */
export function isVisionModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return (
    lower.includes("llava") ||
    lower.includes("bakllava") ||
    lower.includes("moondream") ||
    lower.includes("minicpm") ||
    lower.includes("llava-phi")
  );
}
