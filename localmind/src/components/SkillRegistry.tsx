import { useState, useEffect, useRef } from "react";
import {
  Plus, Trash2, Pencil, BookMarked, Save, X, Tag, Search, FolderOpen,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { openWorkspace } from "../lib/fileSystem";
import { loadSkills, saveSkill, deleteSkill } from "../lib/skillEngine";
import { useAgentStore } from "../store/agent";
import type { Skill } from "../lib/skillEngine";

const EXAMPLE_SKILL = `When debugging Docker containers:
1. Check logs: \`docker logs <name> --tail 100\`
2. Check running: \`docker ps -a\`
3. Inspect config: \`docker inspect <name>\`
4. Enter container: \`docker exec -it <name> sh\`
5. Check network: \`docker network ls\``;

export function SkillRegistry() {
  const { dirHandle, setWorkspace } = useAgentStore();

  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  // Editor state
  const [editing, setEditing] = useState<Skill | null>(null); // null = new
  const [editorOpen, setEditorOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Selected for preview
  const [selected, setSelected] = useState<Skill | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // Load skills whenever workspace changes
  useEffect(() => {
    if (!dirHandle) { setSkills([]); return; }
    setLoading(true);
    loadSkills(dirHandle)
      .then(setSkills)
      .catch(() => toast.error("Failed to load skills"))
      .finally(() => setLoading(false));
  }, [dirHandle]);

  async function handleOpenWorkspace() {
    try {
      const ws = await openWorkspace();
      setWorkspace(ws.handle, ws.path, ws.name);
      toast.success(`Workspace opened: ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(`Could not open folder: ${e.message}`);
    }
  }

  function openNew() {
    setEditing(null);
    setEditName("");
    setEditTags("");
    setEditContent("");
    setEditorOpen(true);
  }

  function openEdit(skill: Skill) {
    setEditing(skill);
    setEditName(skill.name);
    setEditTags(skill.tags.join(", "));
    setEditContent(skill.content);
    setEditorOpen(true);
  }

  async function handleSave() {
    if (!dirHandle) return;
    if (!editName.trim()) { toast.error("Skill name required"); return; }
    if (!editContent.trim()) { toast.error("Skill content required"); return; }
    setSaving(true);
    try {
      // If editing an existing skill, delete the old file first (name may have changed)
      if (editing) {
        try { await deleteSkill(dirHandle, editing.filename); } catch { /* ignore */ }
      }
      await saveSkill(dirHandle, {
        name: editName.trim(),
        tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        content: editContent.trim(),
      });
      const updated = await loadSkills(dirHandle);
      setSkills(updated);
      setEditorOpen(false);
      toast.success(`Skill saved: ${editName.trim()}`);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(skill: Skill) {
    if (!dirHandle) return;
    if (!window.confirm(`Delete skill "${skill.name}"? This cannot be undone.`)) return;
    try {
      await deleteSkill(dirHandle, skill.filename);
      setSkills((prev) => prev.filter((s) => s.filename !== skill.filename));
      if (selected?.filename === skill.filename) setSelected(null);
      toast.success(`Deleted: ${skill.name}`);
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  }

  const filtered = query.trim()
    ? skills.filter((s) => {
        const q = query.toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          s.tags.some((t) => t.includes(q)) ||
          s.content.toLowerCase().includes(q)
        );
      })
    : skills;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left: skill list */}
      <div className="w-[280px] shrink-0 border-r bg-card flex flex-col">
        {/* Header */}
        <div className="p-3 border-b space-y-2 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookMarked className="size-4 text-primary" />
              <span className="text-sm font-semibold">Skill Registry</span>
            </div>
            <Button size="sm" className="h-7 text-xs gap-1" onClick={openNew} disabled={!dirHandle}>
              <Plus className="size-3" /> New
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              className="w-full text-xs h-7 pl-7 pr-2 rounded border border-border bg-background text-foreground"
            />
          </div>
        </div>

        {/* Workspace banner if no workspace */}
        {!dirHandle && (
          <div className="p-4 text-center space-y-2">
            <p className="text-xs text-muted-foreground">Open a workspace to manage skills</p>
            <Button size="sm" variant="outline" className="text-xs h-7 gap-1" onClick={() => void handleOpenWorkspace()}>
              <FolderOpen className="size-3" /> Open workspace
            </Button>
          </div>
        )}

        {/* Skill list */}
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-xs text-muted-foreground">Loading skills…</p>}
          {!loading && dirHandle && filtered.length === 0 && (
            <div className="p-4 text-center space-y-3">
              <p className="text-xs text-muted-foreground">
                {query ? "No matching skills." : "No skills yet. Create your first skill!"}
              </p>
              {!query && (
                <Button size="sm" variant="outline" className="text-xs h-7" onClick={openNew}>
                  <Plus className="size-3 mr-1" /> Create skill
                </Button>
              )}
            </div>
          )}
          {filtered.map((skill) => (
            <div
              key={skill.filename}
              onClick={() => setSelected(selected?.filename === skill.filename ? null : skill)}
              className={`group flex items-start gap-2 px-3 py-2.5 border-b cursor-pointer transition-colors ${
                selected?.filename === skill.filename
                  ? "bg-primary/10 border-l-2 border-l-primary"
                  : "hover:bg-muted/50"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{skill.name}</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {skill.tags.slice(0, 4).map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                      <Tag className="size-2" />{tag}
                    </span>
                  ))}
                  {skill.tags.length > 4 && (
                    <span className="text-[10px] text-muted-foreground">+{skill.tags.length - 4}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); openEdit(skill); }}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  title="Edit"
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); void handleDelete(skill); }}
                  className="p-1 rounded hover:bg-red-100 text-muted-foreground hover:text-red-600"
                  title="Delete"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="p-3 border-t text-[10px] text-muted-foreground shrink-0">
          {skills.length} skill{skills.length !== 1 ? "s" : ""} · stored in <code>.localmind/skills/</code>
        </div>
      </div>

      {/* Right: preview or editor */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {editorOpen ? (
          /* ── Skill editor ─────────────────────────────────────────── */
          <div className="flex flex-col h-full">
            <div className="h-10 border-b px-4 flex items-center justify-between shrink-0 bg-card">
              <span className="text-sm font-semibold">{editing ? `Edit: ${editing.name}` : "New Skill"}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setEditorOpen(false)}>
                  <X className="size-3" /> Cancel
                </Button>
                <Button size="sm" className="h-7 text-xs gap-1" onClick={() => void handleSave()} disabled={saving}>
                  <Save className="size-3" /> {saving ? "Saving…" : "Save skill"}
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Skill name</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="e.g. Docker Debugging"
                  className="w-full text-sm h-9 px-3 rounded border border-border bg-background text-foreground"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Tags <span className="text-muted-foreground font-normal">(comma-separated)</span></label>
                <input
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="docker, container, debug, logs"
                  className="w-full text-sm h-9 px-3 rounded border border-border bg-background text-foreground"
                />
                <p className="text-[10px] text-muted-foreground">Tags are used to auto-match this skill to relevant agent requests.</p>
              </div>
              <div className="space-y-1.5 flex-1">
                <label className="text-xs font-medium">Content <span className="text-muted-foreground font-normal">(Markdown)</span></label>
                <Textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder={EXAMPLE_SKILL}
                  className="font-mono text-xs min-h-[300px] resize-none"
                />
                <p className="text-[10px] text-muted-foreground">
                  Write step-by-step instructions, useful commands, and tips. The agent will use this as context when your request matches the tags.
                </p>
              </div>
            </div>
          </div>
        ) : selected ? (
          /* ── Skill preview ────────────────────────────────────────── */
          <div className="flex flex-col h-full">
            <div className="h-10 border-b px-4 flex items-center justify-between shrink-0 bg-card">
              <span className="text-sm font-semibold">{selected.name}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => openEdit(selected)}>
                  <Pencil className="size-3" /> Edit
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => void handleDelete(selected)}>
                  <Trash2 className="size-3" /> Delete
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {selected.tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                    <Tag className="size-3" />{tag}
                  </span>
                ))}
              </div>
              <div className="text-[10px] text-muted-foreground font-mono">
                {selected.filename}
              </div>
              <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed text-foreground bg-muted/30 rounded-lg p-4 border">
                {selected.content}
              </pre>
            </div>
          </div>
        ) : (
          /* ── Empty state ──────────────────────────────────────────── */
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <BookMarked className="size-8 text-primary/60" />
            </div>
            <div>
              <p className="text-base font-medium">Skill Registry</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Skills are reusable how-to guides automatically injected into the agent when your request matches their tags.
                Create skills to teach the agent your preferred workflows.
              </p>
            </div>
            <div className="bg-muted/40 rounded-lg p-4 text-left max-w-sm w-full border text-xs space-y-1">
              <p className="font-mono font-semibold text-muted-foreground">.localmind/skills/docker-debugging.md</p>
              <p className="font-mono text-muted-foreground">---</p>
              <p className="font-mono text-muted-foreground">name: Docker Debugging</p>
              <p className="font-mono text-muted-foreground">tags: docker, container, debug</p>
              <p className="font-mono text-muted-foreground">---</p>
              <p className="font-mono text-muted-foreground">When debugging containers: …</p>
            </div>
            {dirHandle ? (
              <Button onClick={openNew} className="gap-1">
                <Plus className="size-4" /> Create your first skill
              </Button>
            ) : (
              <Button variant="outline" className="gap-1" onClick={() => void handleOpenWorkspace()}>
                <FolderOpen className="size-4" /> Open workspace first
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
