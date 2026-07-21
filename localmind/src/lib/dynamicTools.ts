import type { ToolDef } from "./tools";

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

// Dynamic tools substitute model-supplied arguments into a shell command
// template (implementation === "run_command") with no quoting, so an argument
// like `"; calc.exe"` would break out of the intended command. Until argv-array
// tools land (a later package) that can pass arguments without a shell, we
// allow-list the characters permitted inside a substituted value and reject
// anything else. Permitted: letters, digits, and a conservative set of path /
// flag punctuation. Notably excludes shell metacharacters ; | & $ > < ` " ' ( )
// as well as Windows-specific % and ^ and any newline.
const SAFE_ARG_RE = /^[A-Za-z0-9_\-./:\\ @=+,]*$/;

/** Throw if a substituted argument value contains shell-unsafe characters. */
function assertSafeArg(param: string, value: string): void {
  if (!SAFE_ARG_RE.test(value)) {
    throw new Error(
      `Dynamic tool argument "${param}" contains disallowed characters. ` +
        `Only letters, digits, and _-./:\\ @=+, are permitted (shell ` +
        `metacharacters are blocked for safety).`,
    );
  }
}

/** Render a dynamic tool template by substituting {{param}} placeholders. */
export function renderTemplate(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = String(args[key] ?? "");
    assertSafeArg(key, value);
    return value;
  });
}

/**
 * Convert a DynamicToolDef into a ToolDef (what runAgentTurn / resolveToolPolicy
 * expect). Dynamic tools are agent/user-authored shell-command templates with
 * no built-in safety review, so this explicitly stamps them as external/gated
 * (group:"external", risk:"execute", planModeAllowed:false,
 * requiresApproval:true) rather than leaving that metadata undefined and
 * relying on resolveToolPolicy's fallback-to-external behavior. Do NOT change
 * these to planModeAllowed:true / requiresApproval:false — that would let a
 * self-registered tool run unapproved shell commands.
 */
export function toOllamaTool(def: DynamicToolDef): ToolDef {
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
    group: "external",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  };
}

/**
 * Validate a tool definition at save time. Catches malformed templates early:
 * placeholders must reference declared parameters, and the {{ }} braces must be
 * balanced. Does NOT restrict what the template *does* (e.g. `rm -rf` is the
 * tool author's business) — the runtime arg allow-list in renderTemplate is the
 * critical injection defense. Throws Error on the first problem found.
 */
export function validateDynamicToolDef(def: DynamicToolDef): void {
  if (!def.name || !def.description || !def.template) {
    throw new Error("Dynamic tool must have a name, description, and template.");
  }
  // Detect unbalanced {{ / }} — a leftover brace usually means a typo that
  // would silently fail to substitute (or leak literal braces to the shell).
  const opens = (def.template.match(/\{\{/g) ?? []).length;
  const closes = (def.template.match(/\}\}/g) ?? []).length;
  if (opens !== closes) {
    throw new Error("Dynamic tool template has unbalanced {{ }} placeholders.");
  }
  // Every {{param}} must be a declared parameter.
  const declared = new Set(Object.keys(def.parameters ?? {}));
  const re = /\{\{(\w+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(def.template)) !== null) {
    if (!declared.has(m[1])) {
      throw new Error(
        `Dynamic tool template references undeclared parameter "${m[1]}".`,
      );
    }
  }
}

/** Save a new tool definition JSON to .localmind/tools/. */
export async function saveDynamicTool(
  dirHandle: FileSystemDirectoryHandle,
  def: DynamicToolDef,
): Promise<void> {
  validateDynamicToolDef(def);
  const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: true });
  const toolsDir = await lmDir.getDirectoryHandle("tools", { create: true });
  const filename = `${def.name.replace(/[^a-z0-9_-]/gi, "-")}.json`;
  const fileHandle = await toolsDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(def, null, 2));
  await writable.close();
}
