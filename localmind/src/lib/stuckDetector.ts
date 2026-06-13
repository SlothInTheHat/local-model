import type { ToolCall, ToolResult } from "./tools";

/** True if a tool result represents a failure (explicit error, or a non-zero "[exit code: N]" trailer). */
export function toolResultFailed(result: ToolResult): boolean {
  if (result.error) return true;
  const m = result.output.match(/\[exit code: (\d+)\]\s*$/);
  return !!m && m[1] !== "0";
}

/** Pattern-match common failure output and suggest a concrete next step. */
export function errorRecoveryHint(output: string): string | null {
  if (/old_string not found|no match for old_string/i.test(output)) {
    return "[RECOVERY HINT] patch_file's old_string didn't match the file. Call read_file on this file to see its current exact content, then retry patch_file with text copied verbatim from that output.";
  }
  if (/ModuleNotFoundError|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(output)) {
    return "[RECOVERY HINT] A module/import is missing or its API doesn't match what you expected. Check the installed version (pip show / npm list) and adjust the import or code accordingly — don't just re-run the install.";
  }
  if (/SyntaxError|IndentationError|Unexpected token/i.test(output)) {
    return "[RECOVERY HINT] Your last edit introduced a syntax error. read_file the affected file, locate the broken section, and patch_file it surgically — do not rewrite the whole file.";
  }
  if (/NameError|UnboundLocalError|is not defined/i.test(output)) {
    return "[RECOVERY HINT] A variable, function, or import is undefined or out of scope. read_file the surrounding code to see where it should come from, then patch_file the specific block.";
  }
  if (/ENOENT|No such file or directory|FileNotFoundError/i.test(output)) {
    return "[RECOVERY HINT] A path is wrong, or the command ran in the wrong directory. Use list_directory to verify the actual layout, then retry with the correct path or a cwd= argument.";
  }
  const exitMatch = output.match(/\[exit code: (\d+)\]/);
  if (exitMatch && exitMatch[1] !== "0") {
    return "[RECOVERY HINT] This is a real error — read the full output above before deciding what to fix. Do not re-run the same command unchanged.";
  }
  return null;
}

const REPEATABLE_TOOLS = new Set(["run_command", "web_search", "web_fetch", "install_deps"]);
const READ_ONLY_TOOLS = new Set(["read_file", "list_directory", "grep_files", "find_files"]);

/**
 * Tracks tool-call patterns across an agent session and surfaces hard blocks
 * (call not executed) and soft notes (appended to the tool result) to keep
 * the model from looping on the same action.
 */
export class StuckDetector {
  static readonly DUPLICATE_LIMIT = 2;
  static readonly MANAGEMENT_STREAK_LIMIT = 2;
  static readonly RUN_ERROR_REPEAT_LIMIT = 2;
  static readonly WEB_SEARCH_LIMIT = 4;
  static readonly TOOL_CALL_LIMITS: Record<string, number> = {
    update_project_memory: 10,
    save_global_memory: 10,
    save_skill: 1,
  };
  static readonly MANAGEMENT_TOOLS = new Set([
    "todo_write", "update_project_memory", "save_global_memory", "list_skills", "get_system_info",
  ]);
  static readonly REAL_WORK_TOOLS = new Set([
    "read_file", "write_file", "patch_file", "apply_patch", "run_command",
    "grep_files", "find_files", "list_directory", "create_folder", "delete_file",
    "install_deps", "web_search", "web_fetch",
    "git_status", "git_diff", "git_log", "git_add", "git_commit",
  ]);

  private toolCallCounts = new Map<string, number>();
  private fingerprintCounts = new Map<string, number>();
  private lastFingerprint = "";
  private lastFingerprintCount = 0;
  private lastWrittenContent = new Map<string, string>();
  private lastRunError = "";
  private lastRunErrorCount = 0;
  private managementStreak = 0;
  private webSearchCallCount = 0;

  private fingerprint(call: ToolCall): string {
    return `${call.name}:${JSON.stringify(call.args)}`;
  }

  /** Pre-execution check. Returns a block message (call NOT executed) or null to proceed. */
  checkBeforeExecute(call: ToolCall): string | null {
    const fingerprint = this.fingerprint(call);

    // 1. Per-tool call limits
    const limit = StuckDetector.TOOL_CALL_LIMITS[call.name];
    if (limit !== undefined) {
      const count = this.toolCallCounts.get(call.name) ?? 0;
      if (count >= limit) {
        return `[BLOCKED] ${call.name} has already been called ${count} time(s) this session — its limit. This call was NOT executed. Move on to the next step.`;
      }
    }

    // 2. Web-search cap
    if (call.name === "web_search" && this.webSearchCallCount >= StuckDetector.WEB_SEARCH_LIMIT) {
      return `[BLOCKED — RESEARCH CAP] You have already called web_search ${this.webSearchCallCount} times this session. This call was NOT executed. You have enough information — make a decision and start writing code.`;
    }

    // 3. Whole-session duplicate for re-runnable side-effect tools
    if (REPEATABLE_TOOLS.has(call.name) && (this.fingerprintCounts.get(fingerprint) ?? 0) >= 1) {
      const what = String(call.args["cmd"] ?? call.args["query"] ?? call.args["url"] ?? call.name);
      return `[BLOCKED — REPEATED CALL] You already ran "${what.slice(0, 120)}" with these exact arguments earlier this session — the result will be identical. This call was NOT executed. Mark the related todo complete and move to the NEXT task (writing/patching actual files).`;
    }

    // 4. Exact-duplicate consecutive call (any tool)
    if (fingerprint === this.lastFingerprint) {
      this.lastFingerprintCount++;
    } else {
      this.lastFingerprint = fingerprint;
      this.lastFingerprintCount = 1;
    }
    if (this.lastFingerprintCount >= StuckDetector.DUPLICATE_LIMIT) {
      this.lastFingerprint = "";
      this.lastFingerprintCount = 0;
      return `[BLOCKED — LOOP] You called ${call.name} with identical arguments ${StuckDetector.DUPLICATE_LIMIT} times in a row. This call was NOT executed. Try something different — re-read the relevant file, or move to the next todo item.`;
    }

    // 5. Management-tool streak (planning without acting)
    if (StuckDetector.MANAGEMENT_TOOLS.has(call.name) && this.managementStreak + 1 >= StuckDetector.MANAGEMENT_STREAK_LIMIT) {
      return `[BLOCKED — PLANNING LOOP] You have called management tools (${[...StuckDetector.MANAGEMENT_TOOLS].join("/")}) ${this.managementStreak + 1} times in a row with no real work in between. This call was NOT executed. Your next action MUST be one of: read_file, write_file, patch_file, apply_patch, run_command, grep_files, find_files, web_search — execute the in_progress (or first pending) todo now.`;
    }

    // 6. Repeated run_command error
    if (call.name === "run_command" && this.lastRunErrorCount >= StuckDetector.RUN_ERROR_REPEAT_LIMIT) {
      this.lastRunErrorCount = 0;
      this.lastRunError = "";
      return `[BLOCKED — SAME ERROR ${StuckDetector.RUN_ERROR_REPEAT_LIMIT}x] The last ${StuckDetector.RUN_ERROR_REPEAT_LIMIT} run_command attempts failed with the same error. This call was NOT executed. read_file the broken file, find the issue, and patch_file it before running anything again.`;
    }

    return null;
  }

  /** Post-execution. Returns informational notes to append to the tool result. */
  recordResult(call: ToolCall, result: ToolResult): string[] {
    const notes: string[] = [];
    const fingerprint = this.fingerprint(call);

    this.toolCallCounts.set(call.name, (this.toolCallCounts.get(call.name) ?? 0) + 1);

    if (REPEATABLE_TOOLS.has(call.name)) {
      this.fingerprintCounts.set(fingerprint, (this.fingerprintCounts.get(fingerprint) ?? 0) + 1);
    }

    if (call.name === "web_search") this.webSearchCallCount++;

    if (StuckDetector.MANAGEMENT_TOOLS.has(call.name)) {
      this.managementStreak++;
    } else if (StuckDetector.REAL_WORK_TOOLS.has(call.name)) {
      this.managementStreak = 0;
    }

    // No-op write detection
    if (call.name === "write_file" && !result.error) {
      const path = String(call.args["path"] ?? "");
      const content = String(call.args["content"] ?? "");
      if (this.lastWrittenContent.get(path) === content) {
        notes.push(`[NO-OP] "${path}" already contains this exact content — nothing changed. Move to the next todo.`);
      }
      this.lastWrittenContent.set(path, content);
    }

    // Already-installed detection
    if (call.name === "run_command" && !result.error) {
      const out = result.output ?? "";
      const alreadyInstalled =
        out.includes("up to date") || out.includes("already satisfied") ||
        out.includes("Requirement already satisfied") || out.includes("nothing to install") ||
        out.includes("already installed");
      if (alreadyInstalled) {
        notes.push(`[ALREADY INSTALLED] This dependency is already present. Do not run this install command again — start writing the actual code files.`);
      }
    }

    // Repeated run_command error tracking
    if (call.name === "run_command") {
      if (toolResultFailed(result)) {
        const errorSig = result.output.split("\n").slice(0, 3).join("|");
        if (errorSig === this.lastRunError) {
          this.lastRunErrorCount++;
          if (this.lastRunErrorCount >= StuckDetector.RUN_ERROR_REPEAT_LIMIT) {
            notes.push(`[SAME ERROR ${this.lastRunErrorCount}x] If you run this exact command again it will be blocked — read the file and patch the specific broken line instead.`);
          }
        } else {
          this.lastRunError = errorSig;
          this.lastRunErrorCount = 1;
        }
      } else {
        this.lastRunError = "";
        this.lastRunErrorCount = 0;
      }
    }

    // Total call frequency note for read-only browsing tools
    if (READ_ONLY_TOOLS.has(call.name)) {
      const count = (this.fingerprintCounts.get(fingerprint) ?? 0) + 1;
      this.fingerprintCounts.set(fingerprint, count);
      if (count === 4) {
        notes.push(`[REPEATED] You have called ${call.name} with these exact arguments ${count} times this session. You already have this information — use it instead of looking it up again.`);
      }
    }

    return notes;
  }
}
