import { useState } from "react";
import { Eye, EyeOff, CheckCircle2, XCircle, RefreshCw, Settings, User, GitBranch, Globe } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Separator } from "./ui/separator";
import { ScrollArea } from "./ui/scroll-area";
import { useProfileStore } from "../store/profile";
import { useSettingsStore } from "../store/settings";
import { McpSettings } from "./McpSettings";

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
            <span className="flex items-center gap-1 text-xs text-green-600">
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
          <p className="text-[11px] text-green-600 flex items-center gap-1">
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
          <p className="text-[11px] text-green-600 flex items-center gap-1">
            <CheckCircle2 className="size-3" /> Token saved — git operations on {gitlabHost} will authenticate automatically.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AppSettings() {
  const { gitName, gitEmail, setGitIdentity } = useProfileStore();
  const { defaultSystemPrompt, agentAutoApproveReads, theme, setDefaultSystemPrompt, setAgentAutoApproveReads, setTheme } =
    useSettingsStore();

  const [localName, setLocalName] = useState(gitName);
  const [localEmail, setLocalEmail] = useState(gitEmail);
  const [localPrompt, setLocalPrompt] = useState(defaultSystemPrompt);
  const [showMcp, setShowMcp] = useState(false);

  const identityDirty = localName !== gitName || localEmail !== gitEmail;
  const promptDirty = localPrompt !== defaultSystemPrompt;

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

          <Separator />

          {/* ── App settings ── */}
          <Section icon={<Settings className="size-4 text-muted-foreground" />} title="App Settings">
            <Card>
              <CardContent className="p-4 space-y-4">
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

                {/* Auto-approve reads */}
                <Field label="Agent behavior">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={agentAutoApproveReads}
                      onChange={(e) => setAgentAutoApproveReads(e.target.checked)}
                      className="size-4 rounded"
                    />
                    <span className="text-sm text-foreground">Auto-approve read-only tool calls</span>
                  </label>
                  <p className="text-[11px] text-muted-foreground pl-6">
                    Skips the confirmation dialog for read_file, list_directory, grep_files, find_files, git_status, git_log, and web_search.
                  </p>
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
              </CardContent>
            </Card>
          </Section>
        </div>
      </ScrollArea>
    </div>
  );
}
