//! Shadow git version control (coding-agent overhaul, workstream 4).
//!
//! A SECOND, independent git repository sharing the same working directory as
//! the user's workspace, auto-committed to after every mutating tool call the
//! agent makes — from ANY surface (chat, Code tab, scheduler, task queue,
//! workflows). This is the app's own safety net, not something the model
//! calls or that goes through tool approval.
//!
//! Isolation is the whole point: the workspace may already be the user's own
//! git repo, and interleaving automatic agent commits into their real branch
//! history would be a hazard (surprise commits, triggered hooks, polluted
//! blame). Git's "separated git dir" mechanism keeps the two completely
//! independent — the working TREE stays the real workspace root (so it sees
//! whatever the frontend's FSA-handle tools or the Rust fs_* commands wrote,
//! since both land on the same real files), but this repo's metadata (object
//! db, refs, index) lives at `<workspace_root>/.localmind/shadow-git/`. A
//! real `.git` the workspace might already have is a directory literally
//! named ".git" in the same working tree — git universally treats that exact
//! name as reserved and never recurses into or tracks it, so the two repos
//! never see each other.

use git2::{DiffFormat, DiffOptions, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::ensure_confined;

const SHADOW_GIT_REL: &str = ".localmind/shadow-git";
const AGENT_AUTHOR_NAME: &str = "LocalMind Agent";
const AGENT_AUTHOR_EMAIL: &str = "agent@localmind.local";

/// Frontend commit calls are deliberately fire-and-forget (never awaited, so a
/// slow commit can't stall the agent loop) — which means a burst of rapid
/// tool calls (e.g. scaffolding many files in one go) can invoke
/// shadow_git_ensure_init / shadow_git_commit concurrently. libgit2 takes a
/// lockfile when writing the index, and a losing concurrent writer errors out
/// rather than queuing, so without serializing here those commits silently
/// vanish (the frontend just logs and swallows the error). One process-wide
/// lock is enough: commits are fast, and this only guards the mutating path
/// (init + commit), never the read-only log/diff/show/restore commands.
fn commit_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn shadow_git_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(SHADOW_GIT_REL)
}

/// Opens the shadow repo if it already exists, or initializes a new one with
/// its git dir at `.localmind/shadow-git` and its working tree at
/// `workspace_root` (a "separated git dir", the same mechanism `git init
/// --separate-git-dir` uses) — see the module doc comment for why this never
/// touches a real `.git` the workspace might already have. Idempotent: safe
/// to call before every commit.
fn open_or_init(workspace_root: &Path) -> Result<Repository, String> {
    let git_dir = shadow_git_dir(workspace_root);

    // Try opening first — Repository::open() does proper git-dir discovery
    // (it correctly finds the real gitdir whether or not libgit2 nested it
    // under git_dir/.git, unlike a raw `git_dir.join("HEAD").exists()` check,
    // which assumes a layout libgit2 doesn't actually use here and was
    // silently always false, forcing a pointless reinit on every call).
    let repo = match Repository::open(&git_dir) {
        Ok(repo) => repo,
        Err(_) => {
            let mut opts = RepositoryInitOptions::new();
            opts.workdir_path(workspace_root);
            opts.mkdir(true);
            opts.mkpath(true);
            Repository::init_opts(&git_dir, &opts)
                .map_err(|e| format!("Failed to init shadow git repo: {e}"))?
        }
    };

    // Exclude the shadow repo's own metadata and the now-deprecated
    // write_file-only backup folder — written to info/exclude, NEVER the
    // workspace's own tracked .gitignore (which must never be touched just to
    // enable this feature). Must go in the REAL gitdir (repo.path(), which
    // libgit2 may have nested one level under git_dir — see above), not
    // git_dir itself: writing it to the wrong location means libgit2 never
    // sees the rule, so add_all(".") tries to walk into git_dir (which
    // contains a nested .git of its own) and fails outright with "invalid
    // path" on every commit attempt, silently, forever.
    // Always (over)written, unconditionally: libgit2's own init already drops
    // a template info/exclude full of commented-out example lines, so an
    // exists() guard here would just find that template and skip writing our
    // actual rule forever. Nothing else ever touches this file, so
    // unconditional overwrite is safe.
    let info_dir = repo.path().join("info");
    std::fs::create_dir_all(&info_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        info_dir.join("exclude"),
        "/.localmind/shadow-git/\n/.localmind-backups/\n",
    )
    .map_err(|e| e.to_string())?;

    Ok(repo)
}

/// Ensures the shadow repo exists for this workspace, without committing
/// anything. Called before the first commit of a session so a fresh
/// workspace has somewhere to commit to.
#[tauri::command]
pub fn shadow_git_ensure_init(workspace_root: String) -> Result<(), String> {
    let _guard = commit_lock().lock().unwrap_or_else(|e| e.into_inner());
    let confined = ensure_confined(&workspace_root)?;
    open_or_init(&confined)?;
    Ok(())
}

/// Stages every tracked-and-changed file (respecting the workspace's own
/// .gitignore, honored by git2's default add_all behavior) and commits if the
/// resulting tree differs from HEAD's — a call that touched nothing (e.g. a
/// read-only run_command) produces no commit rather than a vacuous one.
/// Returns the short commit id if a commit was made, None otherwise.
#[tauri::command]
pub fn shadow_git_commit(workspace_root: String, message: String) -> Result<Option<String>, String> {
    let _guard = commit_lock().lock().unwrap_or_else(|e| e.into_inner());
    let confined = ensure_confined(&workspace_root)?;
    let repo = open_or_init(&confined)?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(std::iter::once("."), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(ref parent) = parent_commit {
        if parent.tree_id() == tree_oid {
            return Ok(None); // nothing actually changed — no vacuous commit
        }
    }

    let sig = Signature::now(AGENT_AUTHOR_NAME, AGENT_AUTHOR_EMAIL).map_err(|e| e.to_string())?;
    let parents: Vec<&git2::Commit> = parent_commit.as_ref().map(|c| vec![c]).unwrap_or_default();
    let commit_oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.to_string())?;

    Ok(Some(commit_oid.to_string()[..8].to_string()))
}

#[derive(Serialize)]
pub struct ShadowCommitInfo {
    pub oid: String,
    pub message: String,
    pub timestamp: i64,
    pub files_changed: Vec<String>,
}

/// Every file path touched by a commit relative to its (single) parent — an
/// initial commit (no parent) is diffed against an empty tree, so its files
/// show up as "changed" too.
fn diff_paths_for_commit(repo: &Repository, commit: &git2::Commit) -> Result<Vec<String>, String> {
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parents().next().and_then(|p| p.tree().ok());
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            if let Some(p) = delta.new_file().path().or_else(|| delta.old_file().path()) {
                paths.push(p.to_string_lossy().to_string());
            }
            true
        },
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;
    Ok(paths)
}

/// Lists shadow-git commits, newest first, optionally filtered to those that
/// touched `path`. Returns an empty list (not an error) if no commit has ever
/// been made yet.
#[tauri::command]
pub fn shadow_git_log(workspace_root: String, path: Option<String>, limit: u32) -> Result<Vec<ShadowCommitInfo>, String> {
    let confined = ensure_confined(&workspace_root)?;
    let repo = open_or_init(&confined)?;

    let head_commit = match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(c) => c,
        None => return Ok(vec![]),
    };

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push(head_commit.id()).map_err(|e| e.to_string())?;

    let filter_path = path.map(|p| p.replace('\\', "/"));
    let limit = limit as usize;

    let mut results = Vec::new();
    for oid_result in revwalk {
        if results.len() >= limit {
            break;
        }
        let oid = oid_result.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let files_changed = diff_paths_for_commit(&repo, &commit)?;

        if let Some(ref fp) = filter_path {
            if !files_changed.iter().any(|f| f == fp) {
                continue;
            }
        }

        results.push(ShadowCommitInfo {
            oid: oid.to_string(),
            message: commit.message().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            files_changed,
        });
    }

    Ok(results)
}

/// Reads `path`'s content as it existed at `commit_oid`.
#[tauri::command]
pub fn shadow_git_show_file(workspace_root: String, commit_oid: String, path: String) -> Result<String, String> {
    let confined = ensure_confined(&workspace_root)?;
    let repo = open_or_init(&confined)?;
    let oid = Oid::from_str(&commit_oid).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree
        .get_path(Path::new(&path))
        .map_err(|e| format!("'{path}' not found at commit {commit_oid}: {e}"))?;
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

/// Unified diff for `commit_oid` against its parent, optionally scoped to one path.
#[tauri::command]
pub fn shadow_git_diff(workspace_root: String, commit_oid: String, path: Option<String>) -> Result<String, String> {
    let confined = ensure_confined(&workspace_root)?;
    let repo = open_or_init(&confined)?;
    let oid = Oid::from_str(&commit_oid).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parents().next().and_then(|p| p.tree().ok());

    let mut diff_opts = DiffOptions::new();
    if let Some(ref p) = path {
        diff_opts.pathspec(p);
    }
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut diff_opts))
        .map_err(|e| e.to_string())?;

    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' | '-' | ' ' => out.push(line.origin()),
            _ => {}
        }
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(out)
}

/// Writes EVERY file tracked at `commit_oid` back to disk — a `git reset
/// --hard` analog scoped to whatever the shadow repo tracks (respects the
/// workspace's own .gitignore, same as shadow_git_commit's staging). Used by
/// the "restore workspace to this point" dashboard action, as opposed to
/// shadow_git_restore_file's single-path restore. Returns the list of paths
/// written. Does not delete files that were created AFTER `commit_oid` and
/// aren't present in its tree — this only overwrites, matching the narrower
/// "get back to a known-good state" use case rather than a destructive prune.
#[tauri::command]
pub fn shadow_git_restore_all(workspace_root: String, commit_oid: String) -> Result<Vec<String>, String> {
    let confined = ensure_confined(&workspace_root)?;
    let repo = open_or_init(&confined)?;
    let oid = Oid::from_str(&commit_oid).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;

    let mut restored: Vec<String> = Vec::new();
    let mut walk_err: Option<String> = None;

    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() != Some(git2::ObjectType::Blob) {
            return 0;
        }
        let Some(name) = entry.name() else { return 0 };
        let rel_path = format!("{dir}{name}");
        let obj = match entry.to_object(&repo) {
            Ok(o) => o,
            Err(e) => {
                walk_err = Some(e.to_string());
                return -1;
            }
        };
        let Some(blob) = obj.as_blob() else { return 0 };
        let full_path = confined.join(&rel_path);
        if let Some(parent) = full_path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return 0;
            }
        }
        if std::fs::write(&full_path, blob.content()).is_ok() {
            restored.push(rel_path);
        }
        0
    })
    .map_err(|e| e.to_string())?;

    if let Some(e) = walk_err {
        return Err(format!("Restore stopped partway through: {e}"));
    }

    Ok(restored)
}

/// Writes `path`'s content as it existed at `commit_oid` back to the real
/// file on disk — the actual "restore" action. Does not create a new shadow
/// commit itself; the next mutating tool call (or another explicit restore)
/// captures the resulting state.
#[tauri::command]
pub fn shadow_git_restore_file(workspace_root: String, commit_oid: String, path: String) -> Result<(), String> {
    let confined = ensure_confined(&workspace_root)?;
    let repo = open_or_init(&confined)?;
    let oid = Oid::from_str(&commit_oid).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree
        .get_path(Path::new(&path))
        .map_err(|e| format!("'{path}' not found at commit {commit_oid}: {e}"))?;
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;

    let target_path = confined.join(&path);
    // Re-confine the final joined path — path comes from our own tracked
    // history so this should always resolve inside the root, but this is a
    // cheap, consistent defense-in-depth check shared with every other
    // file-touching command in this codebase.
    let confined_target = ensure_confined(&target_path.to_string_lossy())?;
    if let Some(parent) = confined_target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&confined_target, blob.content()).map_err(|e| e.to_string())?;
    Ok(())
}
