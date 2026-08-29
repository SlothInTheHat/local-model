/**
 * Workspace-confinement refusal cases (WP0.1 / WP0.5 security lockdown).
 *
 * The pure Rust logic (path containment + `&&` translation) is unit-tested in
 * src-tauri/src/lib.rs (`cargo test --lib`). This script:
 *   1. Asserts the JS-side path logic that create_folder relies on.
 *   2. Asserts run_tool_script's QuickJS sandbox (src/lib/toolScript.ts) has
 *      no ambient network/DOM globals — unlike fs_* / run_command, this one is
 *      reachable from plain node (quickjs-emscripten is a real npm package,
 *      not behind the __TAURI__ bridge), so it's a real assertion, not just a
 *      manual checklist item.
 *   3. Documents the manual, app-level refusal cases that can only be exercised
 *      inside the running Tauri app (fs_* / run_command are not reachable from
 *      plain node — they require the webview's __TAURI__ bridge).
 *
 * Run: `node tests/confinement.test.mjs`
 */

import { newAsyncContext } from "quickjs-emscripten";

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

// ── 1. JS-side absolute-path detection used by create_folder in src/lib/tools.ts
// Relative paths get prefixed with the workspace root; absolute paths pass through.
const isAbsolute = (p) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p);

console.log("create_folder path classification:");
assert(isAbsolute("C:/Users/me/ws/sub") === true, "Windows drive path is absolute");
assert(isAbsolute("C:\\Users\\me\\ws") === true, "Windows backslash path is absolute");
assert(isAbsolute("/home/me/ws") === true, "POSIX absolute path is absolute");
assert(isAbsolute("src/components") === false, "relative path is not absolute (gets workspace prefix)");
assert(isAbsolute("newfolder") === false, "bare name is not absolute (gets workspace prefix)");

// ── 2. run_tool_script SDK generation only exposes the given tool names ────────
// Mirrors buildScriptSdk in src/lib/toolScript.ts (duplicated here rather than
// imported, same convention as isAbsolute above — keeps this script plain
// Node with no TS build step).
const VALID_JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function buildScriptSdk(tools) {
  const names = tools
    .map((t) => t.name)
    .filter((name) => name !== "run_tool_script" && VALID_JS_IDENTIFIER.test(name));
  return names
    .map((name) => `function ${name}(args) { return JSON.parse(__invoke(${JSON.stringify(name)}, JSON.stringify(args || {}))); }`)
    .join("\n");
}

console.log("\nrun_tool_script SDK generation:");
{
  const sdk = buildScriptSdk([{ name: "read_file" }, { name: "write_file" }, { name: "run_tool_script" }]);
  assert(sdk.includes("function read_file("), "exposes a retrieved tool (read_file)");
  assert(sdk.includes("function write_file("), "exposes a retrieved tool (write_file)");
  assert(!sdk.includes("function run_tool_script("), "never exposes run_tool_script to itself (no self-recursion)");
}
{
  const sdk = buildScriptSdk([{ name: "delete_file" }]);
  assert(!sdk.includes("read_file") && !sdk.includes("write_file"), "does NOT expose tools outside the given (retrieved) subset");
}
{
  // A malicious/malformed tool name must never become injectable script text.
  const sdk = buildScriptSdk([{ name: "not; valid() //" }]);
  assert(!sdk.includes("not; valid"), "rejects a non-identifier tool name instead of splicing it into the generated source");
}

// ── 3. run_tool_script sandbox has no ambient network/DOM globals ──────────────
console.log("\nrun_tool_script sandbox confinement (live QuickJS context):");
{
  const context = await newAsyncContext();
  try {
    const result = context.evalCode(
      `JSON.stringify({ fetch: typeof fetch, window: typeof window, XMLHttpRequest: typeof XMLHttpRequest, WebSocket: typeof WebSocket, importScripts: typeof importScripts, Worker: typeof Worker })`,
    );
    const globals = JSON.parse(context.unwrapResult(result).consume((h) => context.getString(h)));
    assert(globals.fetch === "undefined", "no ambient fetch()");
    assert(globals.window === "undefined", "no ambient window (so no window.__TAURI__ either)");
    assert(globals.XMLHttpRequest === "undefined", "no ambient XMLHttpRequest");
    assert(globals.WebSocket === "undefined", "no ambient WebSocket");
    assert(globals.importScripts === "undefined", "no ambient importScripts");
    assert(globals.Worker === "undefined", "no ambient Worker (can't spawn its way out)");
  } finally {
    context.dispose();
  }
}

// ── 4. Manual verification checklist (run inside `npm run tauri dev`) ──────────
// These exercise the Rust confinement layer end-to-end; they cannot run headless.
console.log(`
Manual refusal cases — verify inside the running desktop app:

  [ ] Open a workspace folder, then via the agent/terminal:
      - fs_read_file on a path OUTSIDE the workspace (e.g. C:/Windows/win.ini
        or /etc/passwd) -> refused with "Path confinement: ... outside ...".
      - fs_delete on a path outside the workspace -> refused (nothing deleted).
      - fs_write_file / fs_mkdir outside the workspace -> refused.
      - run_command with cwd outside the workspace -> refused.
      - A '..' path that escapes the root (workspace/../secret) -> refused
        (canonicalize_lenient resolves the '..' before the check).

  [ ] With NO workspace open:
      - Any fs_read_file/fs_write_file/fs_delete/fs_mkdir/run_command -> refused
        with "no workspace root registered".
      - fs_exists still works (used to validate remembered workspace paths).

  [ ] PowerShell '&&' handling (Windows):
      - run_command "false && echo hi"  -> "hi" is NOT printed (short-circuit).
      - run_command "cd . && echo ok"   -> "ok" IS printed.
      - run_command 'echo "a && b"'     -> prints  a && b  (quotes preserved).

  [ ] move_file's new action:"copy" param (consolidated from copy_file):
      - move_file({from, to, action:"copy"}) with 'to' OUTSIDE the workspace
        -> refused, same as a plain move; original file untouched.
      - move_file({from, to, action:"copy"}) inside the workspace -> both
        the original AND the new copy exist afterward.
`);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("All automated assertions passed. Complete the manual checklist in-app.");
