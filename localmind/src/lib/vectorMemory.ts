import type { MemoryEntry } from "../store/memory";
import { useMemoryStore } from "../store/memory";

const OLLAMA_BASE = "http://localhost:11434";

export async function embedText(text: string, model: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`Embed request failed: ${res.status}`);
  const data = await res.json() as { embeddings: number[][] };
  const emb = data.embeddings?.[0];
  if (!emb) throw new Error("No embedding returned");
  return emb;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Embed text and save it to the persistent memory store. */
export async function addMemory(
  text: string,
  tags: string[] = [],
  source: "user" | "agent" = "user"
): Promise<MemoryEntry> {
  const { embedModel, addEntry } = useMemoryStore.getState();
  const embedding = await embedText(text, embedModel);
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    text,
    embedding,
    tags,
    source,
    createdAt: Date.now(),
  };
  addEntry(entry);
  return entry;
}

/** Find the most relevant memories for a query. Falls back to keyword search. */
export async function searchMemory(
  query: string,
  topK = 5,
  threshold = 0.35
): Promise<Array<{ entry: MemoryEntry; score: number }>> {
  const { entries, embedModel } = useMemoryStore.getState();
  if (entries.length === 0) return [];

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query, embedModel);
  } catch {
    // Embedding model unavailable — fall back to keyword matching
    const q = query.toLowerCase();
    return entries
      .filter((e) => e.text.toLowerCase().includes(q) || e.tags.some((t) => q.includes(t)))
      .slice(0, topK)
      .map((entry) => ({ entry, score: 0.5 }));
  }

  return entries
    .map((entry) => ({
      entry,
      score: entry.embedding.length > 0 ? cosineSimilarity(queryEmbedding, entry.embedding) : 0,
    }))
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function formatMemoriesForContext(
  results: Array<{ entry: MemoryEntry; score: number }>
): string {
  if (results.length === 0) return "";
  const lines = results.map(
    ({ entry }) =>
      `- ${entry.text}${entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : ""}`
  );
  return `## Relevant Memories\n${lines.join("\n")}`;
}
