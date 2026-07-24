import { useEffect, useState } from "react";
import { Eye, EyeOff, CheckCircle2, XCircle, RefreshCw, Settings, User, GitBranch, Globe, Plug, Clock, Trash2, Lightbulb, Check, Monitor, Keyboard, FolderOpen, Cpu, Sparkles, Copy, Network, Layers, Mic, ShieldCheck, Volume2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Separator } from "./ui/separator";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "./ui/utils";
import { useProfileStore } from "../store/profile";
import { useSettingsStore, DEFAULT_OLLAMA_BASE_URL } from "../store/settings";
import { useProvidersStore } from "../store/providers";
import { useModelStore } from "../store/models";
import { useAgentStore, KNOWN_FOLDER_NAMES, type KnownFolderName } from "../store/agent";
import { useVoiceStore } from "../store/voice";
import { loadSpeechVoices, pickBestSpeechVoice, speakUtterance } from "../lib/speech";
import {
  getPiperStatus, setupPiper, downloadPiperVoice, speakWithPiper,
  CURATED_PIPER_VOICES, encodePiperVoiceSelection, decodePiperVoiceSelection,
  type PiperStatus,
} from "../lib/piper";
import { useModelSelectionStore } from "../store/modelSelection";
import { useChatStore } from "../store/chat";
import { useMemoryStore } from "../store/memory";
import { recommendedNumCtx } from "../lib/contextSize";
import { isTauriEnv } from "../lib/fileSystem";
import { supportsNativeTools } from "../lib/modelCapabilities";
import { resolveRoleWithReason, type ModelRole } from "../lib/modelRoles";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { ModelSelector } from "./ModelSelector";
import { McpSettings } from "./McpSettings";
import { describeSchedule, parseJobSpec } from "../lib/scheduler";
import { loadImprovements, setImprovementStatus, deleteImprovement, type Improvement } from "../lib/improvements";
import { TOOL_DEFINITIONS, type ToolDef } from "../lib/tools";

// ─── Tauri invoke shim (mirrors the pattern used in src/lib/tools.ts) ────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, type = "text" }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

// ─── GitHub section ───────────────────────────────────────────────────────────

function GitHubSection() {
  const { githubUsername, githubToken, setGithub } = useProfileStore();
  const [username, setUsername] = useState(githubUsername);
  const [token, setToken] = useState(githubToken);
  const [showToken, setShowToken] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testUser, setTestUser] = useState("");

  const isDirty = username !== githubUsername || token !== githubToken;

  function save() {
    setGithub(username.trim(), token.trim());
    setTestStatus("idle");
  }

  async function testConnection() {
    const tok = token.trim();
    if (!tok) return;
    setTestStatus("testing");
    setTestUser("");
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tok}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json() as { login: string };
      setTestUser(data.login);
      setTestStatus("ok");
      // Auto-fill username if blank
      if (!username.trim()) setUsername(data.login);
    } catch {
      setTestStatus("fail");
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="size-4" />
          GitHub
        </div>

        <Field label="Username (optional — auto-filled on test)">
          <TextInput value={username} onChange={setUsername} placeholder="your-github-username" />
        </Field>

        <Field
          label="Personal Access Token"
          hint="Create at github.com → Settings → Developer settings → Personal access tokens. Needs repo scope for private repos."
        >
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              className="w-full text-sm px-3 py-1.5 pr-9 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-ring font-mono"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </Field>

        <div className="flex items-center gap-2">
          <Button size="sm" className="h-7 text-xs" onClick={save} disabled={!isDirty && testStatus !== "fail"}>
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => void testConnection()}
            disabled={!token.trim() || testStatus === "testing"}
          >
            {testStatus === "testing"
              ? <><RefreshCw className="size-3 animate-spin" /> Testing…</>
              : "Test connection"}
          </Button>
          {testStatus === "ok" && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 className="size-3.5" /> Connected as @{testUser}
            </span>
          )}
          {testStatus === "fail" && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="size-3.5" /> Invalid token
            </span>
          )}
        </div>

        {githubToken && (
          <p className="text-[11px] text-success flex items-center gap-1">
            <CheckCircle2 className="size-3" /> Token saved — git clone/push over HTTPS will authenticate automatically.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── GitLab section ───────────────────────────────────────────────────────────

function GitLabSection() {
  const { gitlabHost, gitlabToken, setGitlab } = useProfileStore();
  const [host, setHost] = useState(gitlabHost);
  const [token, setToken] = useState(gitlabToken);
  const [showToken, setShowToken] = useState(false);
  const isDirty = host !== gitlabHost || token !== gitlabToken;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="size-4" />
          GitLab
        </div>
        <Field label="Host" hint="Use 'gitlab.com' for GitLab.com or your self-hosted domain.">
          <TextInput value={host} onChange={setHost} placeholder="gitlab.com" />
        </Field>
        <Field label="Personal Access Token" hint="GitLab → Preferences → Access Tokens. Needs read_repository + write_repository.">
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
              className="w-full text-sm px-3 py-1.5 pr-9 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-ring font-mono"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </Field>
        <Button size="sm" className="h-7 text-xs" onClick={() => setGitlab(host.trim(), token.trim())} disabled={!isDirty}>
          Save
        </Button>
        {gitlabToken && (
          <p className="text-[11px] text-success flex items-center gap-1">
            <CheckCircle2 className="size-3" /> Token saved — git operations on {gitlabHost} will authenticate automatically.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Providers section ────────────────────────────────────────────────────────

function ProvidersSection() {
  const { providers, setProvider } = useProvidersStore();
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string>>({});

  function toggleKey(id: string) {
    setShowKeys((s) => ({ ...s, [id]: !s[id] }));
  }

  function getModelDraft(id: string, current: string[]) {
    return modelEdits[id] ?? current.join("\n");
  }

  function saveModels(id: string, current: string[]) {
    const draft = modelEdits[id] ?? current.join("\n");
    const models = draft.split("\n").map((m) => m.trim()).filter(Boolean);
    setProvider(id, { models });
  }

  return (
    <div className="space-y-3">
      {providers.map((p) => (
        <Card key={p.id}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-foreground">{p.name}</span>
                <span className="ml-2 text-[10px] text-muted-foreground font-mono">{p.baseUrl}</span>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-muted-foreground">{p.enabled ? "Enabled" : "Disabled"}</span>
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => setProvider(p.id, { enabled: e.target.checked })}
                  className="size-4 rounded"
                />
              </label>
            </div>

            {p.enabled && (
              <>
                {/* API key */}
                <Field label="API Key" hint={p.id === "llamacpp" ? "Leave empty for local llama.cpp server (no auth needed)." : undefined}>
                  <div className="relative">
                    <input
                      type={showKeys[p.id] ? "text" : "password"}
                      value={p.apiKey}
                      onChange={(e) => setProvider(p.id, { apiKey: e.target.value })}
                      placeholder={p.id === "openrouter" ? "sk-or-…" : p.id === "openai" ? "sk-…" : "optional"}
                      className="w-full text-sm px-3 py-1.5 pr-8 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-ring font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => toggleKey(p.id)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKeys[p.id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                </Field>

                {/* Model list */}
                <Field label="Models (one per line)" hint="These models will appear in the model selector, prefixed with the provider name.">
                  <textarea
                    value={getModelDraft(p.id, p.models)}
                    onChange={(e) => setModelEdits((s) => ({ ...s, [p.id]: e.target.value }))}
                    rows={4}
                    className="w-full text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring resize-none font-mono"
                    placeholder="gpt-4o&#10;gpt-4o-mini"
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs mt-1"
                    onClick={() => saveModels(p.id, p.models)}
                  >
                    Save models
                  </Button>
                </Field>
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Scheduled jobs section (WP2.2) ───────────────────────────────────────────

interface JobRow {
  id: string;
  spec: string;
  next_run_at: number;
  status: string;
  created_at: number;
}

function ScheduledJobsSection() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const rows = await tauriInvoke<JobRow[]>("jobs_list", {});
      setJobs(rows);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function cancel(id: string) {
    setCancellingId(id);
    try {
      await tauriInvoke("jobs_cancel", { id });
      await refresh();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Clock className="size-4" />
            Scheduled Jobs
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Background tasks scheduled via the agent's <code className="px-1 py-0.5 rounded bg-muted font-mono text-[11px]">schedule_task</code> tool. These run unattended, ticking in the background even when this tab isn't open, and survive app restarts.
        </p>

        {error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <XCircle className="size-3.5" /> {error}
          </p>
        )}

        {jobs.length === 0 && !loading && !error && (
          <p className="text-xs text-muted-foreground italic">No scheduled jobs yet.</p>
        )}

        {jobs.length > 0 && (
          <div className="space-y-2">
            {jobs.map((job) => {
              const parsed = parseJobSpec(job.spec);
              const taskText = parsed?.task ?? "(unparseable spec)";
              const scheduleText = parsed ? describeSchedule(parsed.schedule) : "?";
              return (
                <div
                  key={job.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-border p-2.5"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-xs text-foreground truncate" title={taskText}>{taskText}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {scheduleText} · next: {new Date(job.next_run_at).toLocaleString()} · <span className="capitalize">{job.status}</span>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1 shrink-0"
                    onClick={() => void cancel(job.id)}
                    disabled={cancellingId === job.id || job.status !== "active"}
                  >
                    <Trash2 className="size-3" />
                    Cancel
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Feature proposals section (WP3.2) ───────────────────────────────────────

const SIZE_LABEL: Record<Improvement["size_guess"], string> = { S: "Small", M: "Medium", L: "Large" };

function FeatureProposalsSection() {
  const { dirHandle } = useAgentStore();
  const [items, setItems] = useState<Improvement[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function refresh() {
    if (!dirHandle) { setItems([]); return; }
    setLoading(true);
    try {
      const rows = await loadImprovements(dirHandle);
      // proposed first, then approved, then done; newest first within a group.
      const rank = { proposed: 0, approved: 1, done: 2 } as const;
      rows.sort((a, b) => rank[a.status] - rank[b.status] || b.created_at.localeCompare(a.created_at));
      setItems(rows);
    } catch (e) {
      toast.error(`Could not load proposals: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [dirHandle]);

  async function approve(it: Improvement) {
    if (!dirHandle) return;
    setBusyId(it.slug);
    try {
      await setImprovementStatus(dirHandle, it.slug, it.status === "approved" ? "proposed" : "approved");
      await refresh();
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(it: Improvement) {
    if (!dirHandle) return;
    if (!window.confirm(`Delete proposal "${it.title}"? This removes the spec file.`)) return;
    setBusyId(it.slug);
    try {
      await deleteImprovement(dirHandle, it.slug);
      await refresh();
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Lightbulb className="size-4" />
            Feature Proposals
          </div>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => void refresh()} disabled={loading || !dirHandle}>
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          When the agent hits a capability LocalMind lacks, it drafts a spec via its <code className="px-1 py-0.5 rounded bg-muted font-mono text-[11px]">propose_feature</code> tool instead of failing. Specs live in <code className="px-1 py-0.5 rounded bg-muted font-mono text-[11px]">.localmind/improvements/</code>; approve the ones worth building and a Claude Code session can implement them.
        </p>

        {!dirHandle && (
          <p className="text-xs text-muted-foreground italic">Open a workspace (Chat → agent mode → Open Folder) to see its proposals.</p>
        )}
        {dirHandle && items.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground italic">No proposals yet.</p>
        )}

        {items.length > 0 && (
          <div className="space-y-2">
            {items.map((it) => (
              <div key={it.slug} className="rounded-md border border-border p-2.5 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => setExpanded(expanded === it.slug ? null : it.slug)}
                      className="text-xs font-medium text-foreground text-left hover:underline truncate w-full"
                      title="Show details"
                    >
                      {it.title}
                    </button>
                    <p className="text-[11px] text-muted-foreground truncate" title={it.motivation}>{it.motivation}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        it.status === "approved" ? "bg-success/15 text-success"
                        : it.status === "done" ? "bg-muted text-muted-foreground"
                        : "bg-warning/15 text-warning"
                      }`}>{it.status}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{SIZE_LABEL[it.size_guess]}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant={it.status === "approved" ? "default" : "outline"}
                      className="h-7 text-xs gap-1"
                      onClick={() => void approve(it)}
                      disabled={busyId === it.slug}
                      title={it.status === "approved" ? "Un-approve" : "Approve for implementation"}
                    >
                      <Check className="size-3" />
                      {it.status === "approved" ? "Approved" : "Approve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1 text-destructive"
                      onClick={() => void remove(it)}
                      disabled={busyId === it.slug}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
                {expanded === it.slug && (
                  <div className="pt-1.5 border-t border-border space-y-1.5">
                    {it.proposed_files.length > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">Files:</span> <span className="font-mono">{it.proposed_files.join(", ")}</span>
                      </p>
                    )}
                    {it.acceptance_criteria && (
                      <p className="text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">Acceptance:</span> {it.acceptance_criteria}
                      </p>
                    )}
                    {it.body && (
                      <pre className="text-[11px] whitespace-pre-wrap font-sans leading-relaxed text-foreground bg-muted/30 rounded p-2 border max-h-48 overflow-y-auto">{it.body}</pre>
                    )}
                    <p className="text-[10px] text-muted-foreground font-mono">.localmind/improvements/{it.filename}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Desktop integration (WP5.1: tray, close-to-tray, autostart, hotkey) ─────

// Must match src-tauri/src/ipc.rs's IPC_BIND_ADDR — kept as a literal here
// (not fetched from Rust) since it's baked into the binary, not runtime
// config.
const IPC_ENDPOINT = "http://127.0.0.1:41777";

const VOICE_SAMPLE_TEXT = "Hi, this is what I sound like. I'm LocalMind, your local AI assistant.";

function DesktopIntegrationSection() {
  const { closeToTray, setCloseToTray, whisperModel, setWhisperModel, dictationEngine, setDictationEngine } =
    useSettingsStore();
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [ipcToken, setIpcToken] = useState<string | null>(null);
  const [showIpcToken, setShowIpcToken] = useState(false);
  const [ipcCopied, setIpcCopied] = useState(false);
  const tauri = isTauriEnv();

  const { selectedVoiceName, setSelectedVoiceName } = useVoiceStore();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [samplePlaying, setSamplePlaying] = useState(false);

  const [piperStatus, setPiperStatus] = useState<PiperStatus | null>(null);
  const [piperBusy, setPiperBusy] = useState(false);
  const [piperVoiceToDownload, setPiperVoiceToDownload] = useState(CURATED_PIPER_VOICES[0].id);

  function refreshPiperStatus() {
    if (!tauri) return;
    void getPiperStatus().then(setPiperStatus).catch(() => setPiperStatus(null));
  }

  useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    void loadSpeechVoices().then((v) => {
      if (!cancelled) setVoices(v);
    });
    return () => {
      cancelled = true;
    };
  }, [tauri]);

  useEffect(refreshPiperStatus, [tauri]);

  async function handlePiperSetup() {
    setPiperBusy(true);
    try {
      const msg = await setupPiper();
      toast.success(msg);
      refreshPiperStatus();
    } catch (e) {
      toast.error(`Piper setup failed: ${(e as Error).message}`);
    } finally {
      setPiperBusy(false);
    }
  }

  async function handlePiperDownload() {
    setPiperBusy(true);
    try {
      const msg = await downloadPiperVoice(piperVoiceToDownload);
      toast.success(msg);
      refreshPiperStatus();
    } catch (e) {
      toast.error(`Voice download failed: ${(e as Error).message}`);
    } finally {
      setPiperBusy(false);
    }
  }

  const sortedVoices = [...voices].sort((a, b) => {
    const aEn = a.lang.toLowerCase().startsWith("en") ? 0 : 1;
    const bEn = b.lang.toLowerCase().startsWith("en") ? 0 : 1;
    if (aEn !== bEn) return aEn - bEn;
    return a.name.localeCompare(b.name);
  });
  const autoVoice = pickBestSpeechVoice(voices);

  async function playVoiceSample() {
    if (samplePlaying) return;
    setSamplePlaying(true);
    try {
      const piperVoice = decodePiperVoiceSelection(selectedVoiceName);
      if (piperVoice) {
        await speakWithPiper(VOICE_SAMPLE_TEXT, piperVoice);
      } else {
        const voice = (selectedVoiceName ? voices.find((v) => v.name === selectedVoiceName) : null) ?? autoVoice;
        window.speechSynthesis.cancel();
        await speakUtterance(VOICE_SAMPLE_TEXT, voice);
      }
    } catch (e) {
      toast.error(`Couldn't play sample: ${(e as Error).message}`);
    } finally {
      setSamplePlaying(false);
    }
  }

  useEffect(() => {
    if (!tauri) return;
    import("@tauri-apps/plugin-autostart")
      .then(({ isEnabled }) => isEnabled())
      .then(setAutostartOn)
      .catch(() => {/* leave default (off) if the plugin can't be reached */});
  }, [tauri]);

  useEffect(() => {
    if (!tauri) return;
    tauriInvoke<string>("get_ipc_token")
      .then(setIpcToken)
      .catch((e) => console.error("[settings] could not load IPC token:", e));
  }, [tauri]);

  async function copyIpcToken() {
    if (!ipcToken) return;
    try {
      await navigator.clipboard.writeText(ipcToken);
      setIpcCopied(true);
      setTimeout(() => setIpcCopied(false), 1500);
    } catch (e) {
      toast.error(`Could not copy token: ${(e as Error).message}`);
    }
  }

  async function toggleAutostart(next: boolean) {
    if (!tauri) return;
    setAutostartBusy(true);
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      await (next ? enable() : disable());
      setAutostartOn(next);
    } catch (e) {
      toast.error(`Could not update autostart: ${(e as Error).message}`);
    } finally {
      setAutostartBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        {!tauri && (
          <p className="text-xs text-muted-foreground italic">
            Tray, autostart, and the global hotkey only apply to the desktop app (not this browser preview).
          </p>
        )}

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={autostartOn}
            disabled={!tauri || autostartBusy}
            onChange={(e) => void toggleAutostart(e.target.checked)}
            className="size-4 rounded"
          />
          <span className="text-sm text-foreground">Start hidden on login</span>
        </label>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={closeToTray}
            onChange={(e) => setCloseToTray(e.target.checked)}
            className="size-4 rounded"
          />
          <span className="text-sm text-foreground">Close button minimizes to tray instead of quitting</span>
        </label>
        <p className="text-[11px] text-muted-foreground pl-6 -mt-2">
          When off, clicking the window's X quits LocalMind (and its background scheduler) like a normal app. Either way, "Quit" in the tray menu always exits.
        </p>

        <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <Keyboard className="size-3.5 shrink-0" />
          Global hotkey <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted font-mono text-[11px]">Ctrl+Shift+Space</kbd> shows/hides LocalMind from anywhere.
        </div>

        {tauri && (
          <div className="pt-3 border-t border-border space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Mic className="size-4" />
              Voice dictation
            </div>
            <p className="text-[11px] text-muted-foreground">
              The mic button in chat turns speech into text. Whisper runs fully offline; the experimental browser
              engine streams words in real time (faster feel) but may need an internet connection.
            </p>
            <Field label="Dictation engine">
              <select
                value={dictationEngine}
                onChange={(e) => setDictationEngine(e.target.value as typeof dictationEngine)}
                className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="whisper">Whisper — offline, accurate (records, then transcribes)</option>
                <option value="browser">Browser speech — real-time, experimental (may need internet)</option>
              </select>
              <p className="text-[11px] text-muted-foreground">
                Try “Browser speech” if Whisper feels slow: it types words as you talk instead of waiting until you
                stop. If your system has no speech recognition it silently falls back to Whisper. Applies to the chat
                mic and the Ctrl+Shift+K overlay.
              </p>
            </Field>
            <Field label="Whisper model">
              <select
                value={whisperModel}
                onChange={(e) => setWhisperModel(e.target.value as typeof whisperModel)}
                className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="tiny">Tiny — fastest, least accurate</option>
                <option value="base">Base — good balance (default)</option>
                <option value="small">Small — more accurate, slower</option>
                <option value="medium">Medium — most accurate, slowest</option>
              </select>
              <p className="text-[11px] text-muted-foreground">
                Larger models are more accurate but slower. Transcription always runs on CPU, so bigger models take
                noticeably longer per dictation.
              </p>
            </Field>
          </div>
        )}

        {tauri && (
          <div className="pt-3 border-t border-border space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Volume2 className="size-4" />
              Voice output (text-to-speech)
            </div>
            <p className="text-[11px] text-muted-foreground">
              Used by the speak_text tool for hands-free responses. "Online (Natural)" voices sound the most
              natural but are cloud-rendered by Microsoft (need an internet connection) — install one under Windows
              Settings → Time & Language → Speech if none is listed below.
            </p>
            <Field label="Voice">
              <div className="flex gap-2">
                <select
                  value={selectedVoiceName ?? ""}
                  onChange={(e) => setSelectedVoiceName(e.target.value || null)}
                  className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{`Auto (best available${autoVoice ? `: ${autoVoice.name}` : ""})`}</option>
                  {(piperStatus?.voices.length ?? 0) > 0 && (
                    <optgroup label="Piper (offline neural)">
                      {piperStatus!.voices.map((id) => (
                        <option key={id} value={encodePiperVoiceSelection(id)}>{id}</option>
                      ))}
                    </optgroup>
                  )}
                  {sortedVoices.length > 0 && (
                    <optgroup label="System">
                      {sortedVoices.map((v) => (
                        <option key={v.name} value={v.name}>{`${v.name} (${v.lang})`}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 shrink-0"
                  disabled={samplePlaying || (voices.length === 0 && (piperStatus?.voices.length ?? 0) === 0)}
                  onClick={() => void playVoiceSample()}
                >
                  <Play className="size-3.5" /> {samplePlaying ? "Playing…" : "Play sample"}
                </Button>
              </div>
              {voices.length === 0 && (
                <p className="text-[11px] text-muted-foreground italic">
                  No system voices found yet — this can take a moment on first load.
                </p>
              )}
            </Field>

            <div className="pt-2 border-t border-border/60 space-y-1.5">
              <p className="text-xs font-medium text-foreground">
                Piper — offline neural voices (much less robotic than the system ones above)
              </p>
              {!piperStatus ? (
                <p className="text-[11px] text-muted-foreground italic">Checking status…</p>
              ) : !piperStatus.venv_ready ? (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    {piperStatus.python_available
                      ? "Not set up yet. This installs piper-tts (GPL-3.0) into its own isolated Python environment under LocalMind's app data folder — nothing bundled into LocalMind itself."
                      : "Requires Python 3.9+ installed and on PATH — none was found. Install it from python.org, then come back here."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={piperBusy || !piperStatus.python_available}
                    onClick={() => void handlePiperSetup()}
                  >
                    {piperBusy ? "Setting up… (can take a minute)" : "Set up Piper"}
                  </Button>
                </>
              ) : (
                <div className="flex gap-2">
                  <select
                    value={piperVoiceToDownload}
                    onChange={(e) => setPiperVoiceToDownload(e.target.value)}
                    className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
                  >
                    {CURATED_PIPER_VOICES.filter((v) => !piperStatus.voices.includes(v.id)).map((v) => (
                      <option key={v.id} value={v.id}>{v.label}</option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 shrink-0"
                    disabled={piperBusy}
                    onClick={() => void handlePiperDownload()}
                  >
                    {piperBusy ? "Downloading…" : "Download voice"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {tauri && (
          <div className="pt-3 border-t border-border space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Network className="size-4" />
              Local IPC listener
            </div>
            <p className="text-[11px] text-muted-foreground">
              Other local programs on this machine (e.g. the phone-agent Telegram bridge) can hand LocalMind a task by
              POSTing to the endpoint below with this bearer token. Every task still goes through the normal queue,
              approval gates, and tool allowlist — nothing bypasses them.
            </p>
            <Field label="Endpoint">
              <input
                type="text"
                value={IPC_ENDPOINT}
                readOnly
                className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-muted text-foreground outline-none font-mono"
              />
            </Field>
            <Field label="Bearer token">
              <div className="relative flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type={showIpcToken ? "text" : "password"}
                    value={ipcToken ?? "loading…"}
                    readOnly
                    className="w-full text-sm px-3 py-1.5 pr-9 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowIpcToken((v) => !v)}
                    disabled={!ipcToken}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                  >
                    {showIpcToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs gap-1 shrink-0"
                  onClick={() => void copyIpcToken()}
                  disabled={!ipcToken}
                >
                  {ipcCopied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
                </Button>
              </div>
            </Field>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Model Roles (WP6.2a) ─────────────────────────────────────────────────────
//
// `primary` (the main chat model) is deliberately NOT offered here — it has
// its own selector above and duplicating it would just invite the two to
// drift apart. Only the background/specialized roles are pinnable.

const PINNABLE_ROLES: Array<{ role: Exclude<ModelRole, "primary" | "embed">; label: string; hint: string }> = [
  {
    role: "digest",
    label: "Digest",
    hint: "Summarizes a finished session into durable memories in the background. Kept small and off the main model so it stays cheap.",
  },
  {
    role: "vision",
    label: "Vision",
    hint: "Handles image inputs (e.g. screenshots) — a follow-up feature consumes this. Needs a model that actually supports vision, not just any model.",
  },
];

function describeResolution(role: ModelRole): { model: string | null; text: string } {
  const { model, source } = resolveRoleWithReason(role);
  if (!model) {
    return {
      model: null,
      text: role === "vision"
        ? "No vision model installed — pull llava or moondream to enable image tools."
        : "No model resolved.",
    };
  }
  const prefix = source === "pinned" ? "Pinned" : source === "fallback" ? "Auto (fallback to main model)" : "Auto";
  return { model, text: `${prefix} → ${model}` };
}

function ModelRolesSection() {
  const { modelRoles, setModelRole } = useSettingsStore();
  const { availableModels } = useChatStore();
  const { embedModel, setEmbedModel } = useMemoryStore();

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          By default LocalMind runs all background work on your selected chat model. Pin a smaller or
          specialized model per role below to keep that work cheap, or leave it on "Auto" to let LocalMind choose.
        </p>

        {PINNABLE_ROLES.map(({ role, label, hint }) => {
          const { model, text } = describeResolution(role);
          return (
            <Field key={role} label={label} hint={hint}>
              <select
                value={modelRoles[role] ?? ""}
                onChange={(e) => setModelRole(role, e.target.value || null)}
                className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Auto</option>
                {availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <p className={cn("text-[11px]", model ? "text-muted-foreground" : "text-warning")}>{text}</p>
            </Field>
          );
        })}

        {/* Embed is shown for visibility only — it's not a second pin. The
            model actually used for embeddings is owned by src/store/memory.ts
            `embedModel` (Memory settings' own selector); this select writes
            straight through to that same value so there's exactly one source
            of truth. */}
        <Field
          label="Embed"
          hint="Turns text into vectors for memory search. This is the same setting as the Embed Model field in Memory — shown here for a complete picture of what runs what."
        >
          <select
            value={embedModel}
            onChange={(e) => setEmbedModel(e.target.value || "nomic-embed-text")}
            className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="nomic-embed-text">Auto (nomic-embed-text)</option>
            {availableModels
              .filter((m) => m !== "nomic-embed-text")
              .map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
          </select>
          <p className="text-[11px] text-muted-foreground">Auto → {embedModel}</p>
        </Field>
      </CardContent>
    </Card>
  );
}

// ─── Privacy & Security ───────────────────────────────────────────────────────
//
// Previously there was no durable, discoverable place to answer "what can
// the agent access, and what leaves my machine" — per-tool enable/disable
// lived only in AgentToolbar.tsx (a chat-view toolbar, easy to miss) and,
// worse, reset on every app restart since useAgentStore wasn't persisted.
// That store now persists toolsEnabled directly (see store/agent.ts); this
// section is the durable, visible home for reviewing/changing it, plus the
// data-egress and confinement disclosures the tab audit flagged as missing.

const TOOL_GROUP_LABELS: Record<string, string> = {
  files: "Files",
  shell: "Shell",
  git: "Git",
  web: "Web",
  media: "Media & devices",
  state: "App state & automation",
  app: "Desktop & OS",
  external: "External (MCP)",
};

function KnownFolderToggle({ name }: { name: KnownFolderName }) {
  const extraRoots = useAgentStore((s) => s.extraRoots);
  const enableKnownFolder = useAgentStore((s) => s.enableKnownFolder);
  const disableKnownFolder = useAgentStore((s) => s.disableKnownFolder);
  const [busy, setBusy] = useState(false);
  const path = extraRoots[name];
  const enabled = !!path;

  async function handleToggle(checked: boolean) {
    if (!checked) {
      disableKnownFolder(name);
      return;
    }
    setBusy(true);
    try {
      await enableKnownFolder(name);
    } catch (err) {
      toast.error(`Couldn't enable ${name}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex items-center justify-between gap-2 py-1 text-xs cursor-pointer">
      <span className="flex flex-col min-w-0">
        <span className="font-medium text-foreground">{name}</span>
        {enabled && (
          <span className="text-[10px] text-muted-foreground font-mono truncate">{path}</span>
        )}
      </span>
      <input
        type="checkbox"
        checked={enabled}
        disabled={busy}
        onChange={(e) => void handleToggle(e.target.checked)}
        className="accent-primary shrink-0"
      />
    </label>
  );
}

function PrivacySecuritySection() {
  const { toolsEnabled, setToolEnabled, workspacePath } = useAgentStore();

  const groups = new Map<string, ToolDef[]>();
  for (const def of TOOL_DEFINITIONS) {
    const key = def.group ?? "state";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(def);
  }
  const groupOrder = ["files", "shell", "git", "web", "media", "app", "state", "external"];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-1.5">
          <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <FolderOpen className="size-3.5" /> Workspace confinement
          </p>
          {workspacePath ? (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              File and shell tools (<code>read_file</code>/<code>write_file</code>/<code>run_command</code>/etc.) are
              confined to <code className="text-foreground">{workspacePath}</code> — the Rust side refuses any
              resolved path outside it. The Terminal tab's confinement is the same for its starting directory, but
              once a shell command is running, the command itself can still touch absolute paths elsewhere on
              disk or the network — confinement bounds where tools start, not everything a shell command could do.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              No workspace is open, so file and shell tools have nothing to confine to and will refuse to run.
              Open one from the Workspace section above.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-1.5">
          <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <FolderOpen className="size-3.5" /> Known folder access
          </p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            File tools can also reach these well-known folders beyond the open workspace — off by default, and
            each one you turn on here is registered with the confinement layer above just like a workspace.
          </p>
          {!isTauriEnv() ? (
            <p className="text-[11px] text-muted-foreground italic">Only available in the desktop app.</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4">
              {KNOWN_FOLDER_NAMES.map((name) => (
                <KnownFolderToggle key={name} name={name} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-1.5">
          <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Globe className="size-3.5" /> Data leaving this machine
          </p>
          <ul className="text-[11px] text-muted-foreground leading-relaxed list-disc pl-4 space-y-1">
            <li><code className="text-foreground">web_search</code> sends your query text to DuckDuckGo.</li>
            <li><code className="text-foreground">web_fetch</code> sends a request to whatever URL it's given.</li>
            <li>
              If a non-Ollama provider is configured under AI Providers above, prompts sent to that model go to
              that provider's servers, not just your machine.
            </li>
            <li>
              Enabled MCP servers (Settings → Integrations) can each make their own network calls per their own
              purpose (e.g. a Gmail MCP server talks to Google) — review what you've connected there.
            </li>
            <li>Everything else — file reads/writes, shell commands, local model inference — stays on this machine.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-xs font-medium text-foreground">Tool permissions</p>
          <p className="text-[11px] text-muted-foreground -mt-2">
            Disabling a tool here applies everywhere (chat, Code tab, subagents) and persists across restarts —
            this is the same list as the toolbar's per-session toggles, just durable.
          </p>
          {groupOrder.filter((g) => groups.has(g)).map((groupKey) => (
            <div key={groupKey} className="space-y-1 pt-1 first:pt-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {TOOL_GROUP_LABELS[groupKey] ?? groupKey}
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {groups.get(groupKey)!.map((def) => (
                  <label
                    key={def.name}
                    title={def.description}
                    className="flex items-center gap-1.5 text-xs text-foreground py-0.5 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={toolsEnabled[def.name as keyof typeof toolsEnabled] ?? true}
                      onChange={(e) => setToolEnabled(def.name as never, e.target.checked)}
                      className="accent-primary"
                    />
                    <span className="font-mono truncate">{def.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AppSettings() {
  const { gitName, gitEmail, setGitIdentity } = useProfileStore();
  const {
    defaultSystemPrompt, theme, numCtxOverride, featureIdeasSteering, ollamaBaseUrl,
    setDefaultSystemPrompt, setTheme, setNumCtxOverride, setFeatureIdeasSteering, setOllamaBaseUrl,
  } = useSettingsStore();
  const { hardware, vramOverride } = useModelStore();
  const { selectedModel, setSelectedModel } = useModelSelectionStore();

  const [localName, setLocalName] = useState(gitName);
  const [localEmail, setLocalEmail] = useState(gitEmail);
  const [localPrompt, setLocalPrompt] = useState(defaultSystemPrompt);
  const [localNumCtx, setLocalNumCtx] = useState(numCtxOverride != null ? String(numCtxOverride) : "");
  const [localOllamaUrl, setLocalOllamaUrl] = useState(ollamaBaseUrl);
  const [showMcp, setShowMcp] = useState(false);

  const identityDirty = localName !== gitName || localEmail !== gitEmail;
  const promptDirty = localPrompt !== defaultSystemPrompt;
  const effectiveHardware = vramOverride != null && hardware ? { ...hardware, vramGb: vramOverride } : hardware;
  const autoNumCtx = recommendedNumCtx(effectiveHardware);
  const numCtxDirty = localNumCtx !== (numCtxOverride != null ? String(numCtxOverride) : "");
  const ollamaUrlDirty = localOllamaUrl !== ollamaBaseUrl;

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 border-b px-6 flex items-center shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="size-5 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Settings & Profile</h1>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-10">

          {/* ── Workspace (relocated from the retired sidebar) ── */}
          <Section icon={<FolderOpen className="size-4 text-muted-foreground" />} title="Workspace">
            <Card>
              <CardContent className="p-4 space-y-3">
                <WorkspaceSelector />
                {hardware ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 pt-1 border-t border-border">
                    <Cpu className="size-3 shrink-0" />
                    <span className="truncate">
                      {hardware.cpuThreads}c · {hardware.gpuName === "Unknown GPU" ? "GPU unknown" : hardware.gpuName} · {hardware.ramGb}GB
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1 border-t border-border">
                    <Cpu className="size-3" />
                    <span>Hardware not scanned — see Model Library for a full scan.</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </Section>

          {/* ── Model (relocated from the retired sidebar; the Nucleus also
              offers a quick model glance, but this is the full picker) ── */}
          <Section icon={<Sparkles className="size-4 text-muted-foreground" />} title="Model">
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Active Model</span>
                  {selectedModel && (
                    <span
                      className={cn(
                        "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                        supportsNativeTools(selectedModel)
                          ? "bg-success/15 text-success"
                          : "bg-warning/15 text-warning"
                      )}
                    >
                      {supportsNativeTools(selectedModel) ? "tools on" : "no tools"}
                    </span>
                  )}
                </div>
                <ModelSelector value={selectedModel} onChange={setSelectedModel} />
              </CardContent>
            </Card>
          </Section>

          <Separator />

          {/* ── Model Roles (WP6.2a) ── */}
          <Section icon={<Layers className="size-4 text-muted-foreground" />} title="Model Roles">
            <ModelRolesSection />
          </Section>

          <Separator />

          {/* ── Git Identity ── */}
          <Section icon={<User className="size-4 text-muted-foreground" />} title="Git Identity">
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name" hint="Used as git commit author name.">
                    <TextInput value={localName} onChange={setLocalName} placeholder="Your Name" />
                  </Field>
                  <Field label="Email" hint="Used as git commit author email.">
                    <TextInput value={localEmail} onChange={setLocalEmail} placeholder="you@example.com" />
                  </Field>
                </div>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!identityDirty}
                  onClick={() => setGitIdentity(localName.trim(), localEmail.trim())}
                >
                  Save identity
                </Button>
              </CardContent>
            </Card>
          </Section>

          {/* ── Account credentials ── */}
          <Section icon={<GitBranch className="size-4 text-muted-foreground" />} title="Git Accounts">
            <p className="text-xs text-muted-foreground">
              Tokens are stored locally and injected automatically when the AI runs git commands over HTTPS. They are never sent anywhere other than the respective git host.
            </p>
            <GitHubSection />
            <GitLabSection />
          </Section>

          {/* ── Google & other services ── */}
          <Section icon={<Globe className="size-4 text-muted-foreground" />} title="Google & Other Services">
            <Card>
              <CardContent className="p-4 space-y-3">
                <p className="text-sm text-foreground">
                  Gmail, Google Calendar, and Google Drive are supported via <strong>MCP servers</strong>.
                </p>
                <p className="text-xs text-muted-foreground">
                  Run an MCP server for the service you want (e.g. <code className="px-1 py-0.5 rounded bg-muted font-mono text-xs">npx @gptscript-ai/gptscript-gmail-mcp</code>), then add it below.
                </p>
                <button
                  onClick={() => setShowMcp((v) => !v)}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  {showMcp ? "▲ Hide" : "▼ Show"} MCP server configuration
                </button>
                {showMcp && (
                  <div className="pt-2 border-t border-border">
                    <McpSettings />
                  </div>
                )}
              </CardContent>
            </Card>
          </Section>

          {/* ── AI Providers ── */}
          <Section icon={<Plug className="size-4 text-muted-foreground" />} title="AI Providers">
            <p className="text-xs text-muted-foreground">
              Connect cloud providers alongside Ollama. Enabled providers appear in the model selector.
              API keys are stored locally and never sent anywhere except the provider's own API.
            </p>
            <ProvidersSection />
          </Section>

          <Separator />

          {/* ── Scheduled jobs (WP2.2) ── */}
          <Section icon={<Clock className="size-4 text-muted-foreground" />} title="Scheduled Jobs">
            <ScheduledJobsSection />
          </Section>

          <Separator />

          {/* ── Feature proposals (WP3.2) ── */}
          <Section icon={<Lightbulb className="size-4 text-muted-foreground" />} title="Feature Proposals">
            <FeatureProposalsSection />
          </Section>

          <Separator />

          {/* ── App settings ── */}
          <Section icon={<Settings className="size-4 text-muted-foreground" />} title="App Settings">
            <Card>
              <CardContent className="p-4 space-y-4">
                {/* Ollama server URL */}
                <Field
                  label="Ollama server URL"
                  hint={`Where LocalMind sends chat/model requests. Leave blank for the default local instance (${DEFAULT_OLLAMA_BASE_URL}). Point at a remote host to use a shared or GPU-equipped Ollama server.`}
                >
                  <div className="flex items-center gap-2">
                    <TextInput
                      value={localOllamaUrl}
                      onChange={setLocalOllamaUrl}
                      placeholder={DEFAULT_OLLAMA_BASE_URL}
                    />
                    <Button
                      size="sm"
                      className="h-7 text-xs shrink-0"
                      disabled={!ollamaUrlDirty}
                      onClick={() => {
                        const trimmed = localOllamaUrl.trim();
                        setLocalOllamaUrl(trimmed || DEFAULT_OLLAMA_BASE_URL);
                        setOllamaBaseUrl(trimmed || DEFAULT_OLLAMA_BASE_URL);
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs shrink-0"
                      disabled={localOllamaUrl === DEFAULT_OLLAMA_BASE_URL}
                      onClick={() => {
                        setLocalOllamaUrl(DEFAULT_OLLAMA_BASE_URL);
                        setOllamaBaseUrl(DEFAULT_OLLAMA_BASE_URL);
                      }}
                    >
                      Reset
                    </Button>
                  </div>
                </Field>

                {/* Theme */}
                <Field label="Theme">
                  <div className="flex gap-2">
                    {(["light", "dark"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTheme(t)}
                        className={`flex-1 py-1.5 rounded-md border text-xs font-medium transition-colors capitalize ${
                          theme === t
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground border-border hover:text-foreground"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </Field>

                {/* Default system prompt */}
                <Field label="Default system prompt" hint="Used for new conversations. Individual chats can override this.">
                  <textarea
                    value={localPrompt}
                    onChange={(e) => setLocalPrompt(e.target.value)}
                    rows={4}
                    className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs mt-1"
                    disabled={!promptDirty}
                    onClick={() => setDefaultSystemPrompt(localPrompt)}
                  >
                    Save prompt
                  </Button>
                </Field>

                {/* Agent context window */}
                <Field
                  label="Agent context window (num_ctx)"
                  hint={`Tokens of context the agent loop sends to Ollama. Too small and the agent silently loses track of its task/history. Auto = ${autoNumCtx} based on detected VRAM.`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={localNumCtx}
                      onChange={(e) => setLocalNumCtx(e.target.value)}
                      placeholder={`Auto (${autoNumCtx})`}
                      min={2048}
                      step={1024}
                      className="w-40 text-sm px-3 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-ring"
                    />
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={!numCtxDirty}
                      onClick={() => {
                        const n = parseInt(localNumCtx, 10);
                        setNumCtxOverride(Number.isFinite(n) && n > 0 ? n : null);
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={localNumCtx === ""}
                      onClick={() => {
                        setLocalNumCtx("");
                        setNumCtxOverride(null);
                      }}
                    >
                      Reset to auto
                    </Button>
                  </div>
                </Field>

                {/* Feature idea steering */}
                <Field
                  label="Feature idea steering (optional)"
                  hint='Guides the "Research feature ideas" action (Chat, with a workspace open) toward the kind of features you want.'
                >
                  <textarea
                    value={featureIdeasSteering}
                    onChange={(e) => setFeatureIdeasSteering(e.target.value)}
                    rows={3}
                    placeholder="e.g. Lean towards a JARVIS-style assistant: voice control, proactive automation, deeper OS integration."
                    className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                </Field>
              </CardContent>
            </Card>
          </Section>

          <Separator />

          {/* ── Desktop integration (WP5.1) ── */}
          <Section icon={<Monitor className="size-4 text-muted-foreground" />} title="Desktop Integration">
            <DesktopIntegrationSection />
          </Section>

          <Separator />

          {/* ── Privacy & Security ── */}
          <Section icon={<ShieldCheck className="size-4 text-muted-foreground" />} title="Privacy & Security">
            <PrivacySecuritySection />
          </Section>
        </div>
      </ScrollArea>
    </div>
  );
}
