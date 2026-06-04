export interface DynamicToolDef {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  implementation: "run_command";
  template: string; // use {{paramName}} placeholders
}

/** Load all *.json files from .localmind/tools/ */
export async function loadDynamicTools(
  dirHandle: FileSystemDirectoryHandle,
): Promise<DynamicToolDef[]> {
  const tools: DynamicToolDef[] = [];
  try {
    const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: false });
    const toolsDir = await lmDir.getDirectoryHandle("tools", { create: false });
    for await (const [name, entry] of toolsDir.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".json")) continue;
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        const text = await file.text();
        const def = JSON.parse(text) as DynamicToolDef;
        if (def.name && def.description && def.template) tools.push(def);
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // directory doesn't exist yet — normal on first open
  }
  return tools;
}

/** Render a dynamic tool template by substituting {{param}} placeholders. */
export function renderTemplate(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    String(args[key] ?? ""),
  );
}

/** Convert a DynamicToolDef into a ToolDef-compatible object (what runAgentTurn expects). */
export function toOllamaTool(def: DynamicToolDef): { name: string; description: string; parameters: Record<string, unknown> } {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const [key, param] of Object.entries(def.parameters)) {
    properties[key] = { type: param.type, description: param.description };
    if (param.required !== false) required.push(key);
  }
  return {
    name: def.name,
    description: def.description,
    parameters: { type: "object", properties, required },
  };
}

/** Save a new tool definition JSON to .localmind/tools/. */
export async function saveDynamicTool(
  dirHandle: FileSystemDirectoryHandle,
  def: DynamicToolDef,
): Promise<void> {
  const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: true });
  const toolsDir = await lmDir.getDirectoryHandle("tools", { create: true });
  const filename = `${def.name.replace(/[^a-z0-9_-]/gi, "-")}.json`;
  const fileHandle = await toolsDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(def, null, 2));
  await writable.close();
}
