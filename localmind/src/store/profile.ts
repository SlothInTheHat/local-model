import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ProfileState {
  // Git identity (used for commits)
  gitName: string;
  gitEmail: string;

  // GitHub
  githubUsername: string;
  githubToken: string; // Personal Access Token

  // GitLab
  gitlabHost: string;   // e.g. "gitlab.com" or self-hosted
  gitlabToken: string;  // Personal Access Token

  setGitIdentity: (name: string, email: string) => void;
  setGithub: (username: string, token: string) => void;
  setGitlab: (host: string, token: string) => void;
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set) => ({
      gitName: "",
      gitEmail: "",
      githubUsername: "",
      githubToken: "",
      gitlabHost: "gitlab.com",
      gitlabToken: "",

      setGitIdentity: (name, email) => set({ gitName: name, gitEmail: email }),
      setGithub: (username, token) => set({ githubUsername: username, githubToken: token }),
      setGitlab: (host, token) => set({ gitlabHost: host, gitlabToken: token }),
    }),
    { name: "localmind-profile" }
  )
);

// ─── Credential injection helpers ─────────────────────────────────────────────

function escRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite HTTPS git URLs in a command to embed stored credentials.
 * github.com → uses githubToken
 * gitlabHost  → uses gitlabToken
 * Called just before tauriInvoke("run_command") so the token is never shown
 * in the approval dialog or tool chip.
 */
export function injectGitCredentials(cmd: string): string {
  const { githubToken, githubUsername, gitlabHost, gitlabToken } = useProfileStore.getState();

  let out = cmd;

  if (githubToken) {
    // "x-access-token" works for all GitHub PATs without needing the username
    const user = githubUsername || "x-access-token";
    out = out.replace(
      /https:\/\/github\.com\//gi,
      `https://${encodeURIComponent(user)}:${encodeURIComponent(githubToken)}@github.com/`
    );
  }

  if (gitlabToken && gitlabHost) {
    const host = gitlabHost.replace(/^https?:\/\//, "");
    out = out.replace(
      new RegExp(`https://${escRe(host)}/`, "gi"),
      `https://oauth2:${encodeURIComponent(gitlabToken)}@${host}/`
    );
  }

  return out;
}

/**
 * Remove any stored tokens from command output before showing it in the UI.
 */
export function sanitizeOutput(text: string): string {
  const { githubToken, gitlabToken } = useProfileStore.getState();
  let out = text;
  if (githubToken) out = out.replace(new RegExp(escRe(githubToken), "g"), "***");
  if (gitlabToken) out = out.replace(new RegExp(escRe(gitlabToken), "g"), "***");
  return out;
}
