import { newAsyncContext, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSAsyncContext } from "quickjs-emscripten";
import type { ToolDef } from "./tools";

/**
 * "Code Mode" — lets the model write one script against a generated tool SDK
 * instead of one tool call per round, collapsing what would otherwise be N
 * local-model round-trips into a single inference pass (DeepSeek Harness's
 * "Code Mode" idea, adapted here since every round-trip in LocalMind is a
 * full local Ollama generation rather than a cheap cloud call).
 *
 * Isolation: QuickJS (via quickjs-emscripten, a WASM build) starts with a
 * genuinely empty global environment — no `fetch`/`XMLHttpRequest`/`window`/
 * `WebSocket`/DOM of any kind, because none of that was ever implemented in
 * the interpreter, not because it was deleted. The only capability the script
 * gets is whatever this module explicitly injects (`__invoke`, `console.log`,
 * and the generated per-tool stub functions) — it can never reach
 * `window.__TAURI__` or the network directly. Every nested tool call is
 * dispatched back out to the host via `dispatch`, which the caller wires to
 * `executeToolGuarded` so nested calls still go through the full
 * approval/StuckDetector/read-before-write/capToolOutput/shadow-git pipeline.
 */

const SCRIPT_TIMEOUT_MS = 20_000;
const SCRIPT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024; // 64MB
const SCRIPT_MAX_STACK_SIZE_BYTES = 4 * 1024 * 1024; // 4MB

export interface ScriptDispatchResult {
  output: string;
  error?: string;
  sideEffect?: boolean;
  paths?: string[];
}

export interface ScriptCallRecord {
  name: string;
  args: Record<string, unknown>;
  output: string;
  error?: string;
}

export interface ScriptRunResult {
  calls: ScriptCallRecord[];
  returnValue: string;
  consoleOutput: string;
  sandboxError?: string;
  sideEffectPaths: string[];
  hadMutatingCall: boolean;
}

const VALID_JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Generates the SDK source exposed inside the sandbox: one plain (non-async —
 * `__invoke` is asyncified on the host side, so the interpreter never sees a
 * promise) function per tool in `tools`. Always the caller's already-BM25-
 * retrieved subset for that round, never the full built-in list — Code Mode's
 * SDK surface stays consistent with what a normal round would have offered.
 * Excludes `run_tool_script` itself (no self-recursion).
 */
export function buildScriptSdk(tools: ToolDef[]): string {
  const names = tools
    .map((t) => t.name)
    .filter((name) => name !== "run_tool_script" && VALID_JS_IDENTIFIER.test(name));
  return names
    .map(
      (name) =>
        `function ${name}(args) { return JSON.parse(__invoke(${JSON.stringify(name)}, JSON.stringify(args || {}))); }`,
    )
    .join("\n");
}

/**
 * Runs `code` inside a fresh, disposable QuickJS context against the SDK for
 * `tools`. Every `__invoke` call blocks (from the script's point of view —
 * `newAsyncifiedFunction` makes a genuinely async host call look synchronous
 * inside QuickJS) on `dispatch`, which the caller must route through
 * `executeToolGuarded` for each nested call.
 */
export async function runToolScript(
  code: string,
  tools: ToolDef[],
  dispatch: (name: string, args: Record<string, unknown>) => Promise<ScriptDispatchResult>,
): Promise<ScriptRunResult> {
  const calls: ScriptCallRecord[] = [];
  const consoleLines: string[] = [];
  const sideEffectPaths = new Set<string>();
  let hadMutatingCall = false;

  let context: QuickJSAsyncContext | undefined;
  try {
    context = await newAsyncContext();
    context.runtime.setMemoryLimit(SCRIPT_MEMORY_LIMIT_BYTES);
    context.runtime.setMaxStackSize(SCRIPT_MAX_STACK_SIZE_BYTES);
    context.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + SCRIPT_TIMEOUT_MS));

    const invokeHandle = context.newAsyncifiedFunction("__invoke", async (nameHandle, argsJsonHandle) => {
      const ctx = context!;
      const name = ctx.getString(nameHandle);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(ctx.getString(argsJsonHandle) || "{}") as Record<string, unknown>;
      } catch {
        // Malformed args JSON from the script — dispatch with an empty object;
        // the tool's own arg validation surfaces the real error to the model.
      }
      const result = await dispatch(name, args);
      calls.push({ name, args, output: result.output, error: result.error });
      if (result.sideEffect) {
        hadMutatingCall = true;
        for (const p of result.paths ?? []) sideEffectPaths.add(p);
      }
      // The generated stub does JSON.parse(__invoke(...)), so the script sees
      // a real {output, error} object — same shape as ToolResult — not a bare
      // string, so `read_file({...}).output` works as documented on the tool.
      return ctx.newString(JSON.stringify({ output: result.output, error: result.error }));
    });
    invokeHandle.consume((fn) => context!.setProp(context!.global, "__invoke", fn));

    const logHandle = context.newFunction("__consoleLog", (...args) => {
      const ctx = context!;
      const parts = args.map((a) => {
        try {
          const v = ctx.dump(a);
          return typeof v === "string" ? v : JSON.stringify(v);
        } catch {
          return "[unserializable]";
        }
      });
      consoleLines.push(parts.join(" "));
    });
    logHandle.consume((fn) => {
      const ctx = context!;
      const consoleObj = ctx.newObject();
      ctx.setProp(consoleObj, "log", fn);
      ctx.setProp(ctx.global, "console", consoleObj);
      consoleObj.dispose();
    });

    // SDK function declarations are top-level statements; the model's code
    // runs inside an IIFE so `return` works as expected, and the final
    // expression is always a JSON-stringified value regardless of what the
    // script returns (including undefined → "null").
    const sdk = buildScriptSdk(tools);
    const fullSource = `${sdk}\nJSON.stringify((function() {\n${code}\n})() ?? null);`;

    let returnValue = "null";
    let sandboxError: string | undefined;
    try {
      const evalResult = await context.evalCodeAsync(fullSource, "run_tool_script.js");
      returnValue = context.unwrapResult(evalResult).consume((h) => context!.getString(h));
    } catch (err) {
      sandboxError = err instanceof Error ? err.message : String(err);
    }

    return {
      calls,
      returnValue,
      consoleOutput: consoleLines.join("\n"),
      sandboxError,
      sideEffectPaths: [...sideEffectPaths],
      hadMutatingCall,
    };
  } finally {
    context?.dispose();
  }
}
