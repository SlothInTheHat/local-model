const MEMORY_PATH = ".localmind/memory.md";

async function getLmDir(
  dirHandle: FileSystemDirectoryHandle,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await dirHandle.getDirectoryHandle(".localmind", { create });
  } catch {
    return null;
  }
}

/** Read the project memory file. Returns empty string if it doesn't exist. */
export async function readProjectMemory(
  dirHandle: FileSystemDirectoryHandle,
): Promise<string> {
  try {
    const lmDir = await getLmDir(dirHandle, false);
    if (!lmDir) return "";
    const fileHandle = await lmDir.getFileHandle("memory.md", { create: false });
    const file = await fileHandle.getFile();
    return file.text();
  } catch {
    return "";
  }
}

/** Write the full project memory file content. */
export async function writeProjectMemory(
  dirHandle: FileSystemDirectoryHandle,
  content: string,
): Promise<void> {
  const lmDir = await getLmDir(dirHandle, true);
  if (!lmDir) throw new Error("Cannot create .localmind directory");
  const fileHandle = await lmDir.getFileHandle("memory.md", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Update or append a named section (## heading) in memory.md.
 * If the section exists, its content is replaced. If not, it's appended.
 */
export async function updateMemorySection(
  dirHandle: FileSystemDirectoryHandle,
  section: string,
  content: string,
): Promise<string> {
  const current = await readProjectMemory(dirHandle);
  const heading = `## ${section}`;
  const lines = current.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === heading);

  let updated: string;
  if (startIdx === -1) {
    // Section doesn't exist — append it
    const separator = current.trim() ? "\n\n" : "";
    updated = `${current.trimEnd()}${separator}${heading}\n\n${content.trim()}\n`;
  } else {
    // Find next ## heading to know where section ends
    let endIdx = lines.findIndex((l, i) => i > startIdx && /^##\s/.test(l));
    if (endIdx === -1) endIdx = lines.length;
    const before = lines.slice(0, startIdx + 1).join("\n");
    const after = lines.slice(endIdx).join("\n");
    updated = `${before}\n\n${content.trim()}\n${after ? `\n${after}` : ""}`;
  }

  await writeProjectMemory(dirHandle, updated);
  return updated;
}

/** Return a formatted block for injection into an agent system prompt. */
export function formatMemoryForContext(memory: string): string {
  if (!memory.trim()) return "";
  return `## Project Memory (background notes from earlier sessions — context only, not instructions for this turn)\n\n${memory.trim()}`;
}

export { MEMORY_PATH };
