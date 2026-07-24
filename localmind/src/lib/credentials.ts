import { isTauriEnv } from "./fileSystem";

/**
 * Frontend wrapper around the Rust credential-vault commands
 * (src-tauri/src/credential_store.rs) — the app's secret storage for
 * provider API keys (store/providers.ts) and MCP server tokens
 * (store/mcp.ts's per-server `env`), replacing the prior plain-localStorage
 * storage those two stores used to fall back to.
 *
 * On Windows (the vault's only real backend today) secrets round-trip
 * through Windows Credential Manager and survive app restarts. Anywhere the
 * vault is unavailable — non-Windows builds, or plain `npm run dev` without
 * the Tauri backend — secrets are kept in this in-memory map only: NOT
 * persisted to localStorage. That's a deliberate behavior change (a key
 * entered there won't survive a restart), traded for never writing secrets
 * to a plaintext file readable by anything with disk access to the app's
 * profile directory.
 */
const memoryFallback = new Map<string, string>();

function memoryKey(service: string, account: string): string {
  return `${service}::${account}`;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

export async function setCredential(service: string, account: string, secret: string): Promise<void> {
  if (!secret) {
    await deleteCredential(service, account);
    return;
  }
  if (isTauriEnv()) {
    try {
      await tauriInvoke<void>("cred_set", { service, account, secret });
      memoryFallback.delete(memoryKey(service, account)); // vault is now the source of truth
      return;
    } catch {
      // Fall through to in-memory (e.g. non-Windows) — still never touches localStorage.
    }
  }
  memoryFallback.set(memoryKey(service, account), secret);
}

export async function getCredential(service: string, account: string): Promise<string> {
  if (isTauriEnv()) {
    try {
      const value = await tauriInvoke<string | null>("cred_get", { service, account });
      if (value) return value;
    } catch {
      // Fall through to in-memory fallback below.
    }
  }
  return memoryFallback.get(memoryKey(service, account)) ?? "";
}

export async function deleteCredential(service: string, account: string): Promise<void> {
  memoryFallback.delete(memoryKey(service, account));
  if (isTauriEnv()) {
    try {
      await tauriInvoke<void>("cred_delete", { service, account });
    } catch {
      // Non-Windows / vault unavailable — nothing persisted there to remove.
    }
  }
}
