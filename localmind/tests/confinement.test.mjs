/**
 * Workspace-confinement refusal cases (WP0.1 / WP0.5 security lockdown).
 *
 * The pure Rust logic (path containment + `&&` translation) is unit-tested in
 * src-tauri/src/lib.rs (`cargo test --lib`). This script:
 *   1. Asserts the JS-side path logic that create_folder relies on.
 *   2. Documents the manual, app-level refusal cases that can only be exercised
 *      inside the running Tauri app (fs_* / run_command are not reachable from
 *      plain node — they require the webview's __TAURI__ bridge).
 *
 * Run: `node tests/confinement.test.mjs`
 */

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

// ── 2. Manual verification checklist (run inside `npm run tauri dev`) ──────────
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
`);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("All automated assertions passed. Complete the manual checklist in-app.");
