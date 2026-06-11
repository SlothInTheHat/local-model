export function formatToolLabel(name: string, args: Record<string, unknown>): string {
  const cmd = String(args["cmd"] ?? "");
  const path = String(args["path"] ?? "");
  const pattern = String(args["pattern"] ?? "");
  const query = String(args["query"] ?? "");
  switch (name) {
    case "read_file":       return `📄 Reading ${path}`;
    case "write_file":      return `✏️ Writing ${path}`;
    case "patch_file":      return `🩹 Patching ${path}`;
    case "delete_file":     return `🗑️ Deleting ${path}`;
    case "list_directory":  return `📁 Listing ${args["path"] || "workspace"}`;
    case "grep_files":      return `🔍 Searching for "${pattern}"${args["path"] ? ` in ${args["path"]}` : ""}${args["file_pattern"] ? ` (${args["file_pattern"]})` : ""}`;
    case "find_files":      return `🔎 Finding files: "${pattern}"${args["path"] ? ` in ${args["path"]}` : ""}`;
    case "install_deps":    return `📦 Installing dependencies${path ? ` in ${path}` : ""}`;
    case "todo_write":      return `📋 Updating task list`;
    case "apply_patch":     return `🩹 Patching ${(args["patches"] as unknown[])?.length ?? "?"} file(s)`;
    case "web_fetch":       return `🌍 Fetching: ${String(args["url"] ?? "").slice(0, 50)}`;
    case "web_search":      return `🌐 Searching web: "${query}"`;
    case "run_command":     return `⚡ Running: ${cmd.slice(0, 60)}${cmd.length > 60 ? "…" : ""}`;
    case "calculator":      return `🧮 Calculating: ${args["expression"]}`;
    case "get_system_info": return `💻 Getting system info`;
    case "git_status":      return `📋 git status`;
    case "git_diff":        return `📋 git diff${args["staged"] ? " --staged" : ""}${args["path"] ? ` ${args["path"]}` : ""}`;
    case "git_log":         return `📋 git log`;
    case "git_add":         return `➕ git add ${args["paths"]}`;
    case "git_commit":      return `💾 git commit: "${String(args["message"] ?? "").slice(0, 50)}"`;
    case "save_skill":      return `⭐ Saving skill: "${args["name"]}"`;
    case "list_skills":     return `📚 Listing skills`;
    case "update_project_memory": return `🧠 Updating memory: ${args["section"]}`;
    case "register_tool":   return `🔧 Registering tool: ${args["name"]}`;
    default:                return `⚙ ${name}`;
  }
}

export function summariseToolResult(name: string, args: Record<string, unknown>, output: string): string {
  const lines = output.split("\n").filter(Boolean).length;
  const path = String(args["path"] ?? "");
  const cmd = String(args["cmd"] ?? "");
  switch (name) {
    case "read_file":       return `📄 Read ${path} — ${lines} line${lines !== 1 ? "s" : ""}`;
    case "write_file":      return `✏️ Wrote to ${path}`;
    case "patch_file":      return `🩹 Patched ${path}${args["replace_all"] ? " (all)" : ""}`;
    case "delete_file":     return `🗑️ Deleted ${path}`;
    case "list_directory":  return `📁 Listed ${args["path"] || "workspace"} — ${lines} item${lines !== 1 ? "s" : ""}`;
    case "grep_files": {
      const m = output.match(/^(\d+) match/);
      return `🔍 Searched "${args["pattern"]}"${args["path"] ? ` in ${args["path"]}` : ""} — ${m ? m[0] : "no matches"}`;
    }
    case "find_files": {
      const m = output.match(/^(\d+) file/);
      return `🔎 Found "${args["pattern"]}"${args["path"] ? ` in ${args["path"]}` : ""} — ${m ? m[0] : "none found"}`;
    }
    case "install_deps":    return `📦 Deps installed${args["path"] ? ` in ${args["path"]}` : ""}`;
    case "todo_write":      return `📋 Todos updated`;
    case "apply_patch":     return `🩹 Patched ${(args["patches"] as unknown[])?.length ?? "?"} file(s)`;
    case "web_fetch":       return `🌍 Fetched ${String(args["url"] ?? "").slice(0, 40)}`;
    case "web_search":      return `🌐 Web search "${args["query"]}" — ${lines} result${lines !== 1 ? "s" : ""}`;
    case "run_command":     return `⚡ Ran: ${cmd.slice(0, 50)}${cmd.length > 50 ? "…" : ""} — ${lines} line${lines !== 1 ? "s" : ""} output`;
    case "calculator":      return `🧮 ${args["expression"]} = ${output.trim()}`;
    case "get_system_info": return `💻 Got system info`;
    case "git_status":      return `📋 git status — ${lines} change${lines !== 1 ? "s" : ""}`;
    case "git_diff":        return `📋 git diff — ${lines} line${lines !== 1 ? "s" : ""}`;
    case "git_log":         return `📋 git log — ${lines} commit${lines !== 1 ? "s" : ""}`;
    case "git_add":         return `➕ Staged: ${args["paths"]}`;
    case "git_commit":      return `💾 Committed: "${String(args["message"] ?? "").slice(0, 50)}"`;
    case "save_skill":      return `⭐ Skill saved: "${args["name"]}"`;
    case "list_skills":     return `📚 ${lines} skill${lines !== 1 ? "s" : ""} found`;
    case "update_project_memory": return `🧠 Memory updated: ${args["section"]}`;
    case "register_tool":   return `🔧 Tool registered: ${args["name"]}`;
    default:                return `⚙ ${name} — done`;
  }
}
