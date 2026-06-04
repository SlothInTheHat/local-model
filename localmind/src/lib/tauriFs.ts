/**
 * Tauri-native file system handles.
 *
 * Replaces the browser File System Access API (showDirectoryPicker / FileSystemDirectoryHandle)
 * in desktop Tauri mode. This avoids the "Must be handling a user gesture" error that occurs
 * when showDirectoryPicker is called after awaiting a Tauri native dialog.
 *
 * TauriDirectoryHandle / TauriFileHandle implement the same surface used by fileSystem.ts
 * so the rest of the app needs no changes.
 */

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as Record<string, unknown>;
  const tauri = w.__TAURI__ as { core: { invoke: (c: string, a?: unknown) => Promise<T> } };
  return tauri.core.invoke(cmd, args);
}

// Hidden entries — mirror the list in fileSystem.ts
const HIDDEN = new Set([
  ".localmind-backups", "node_modules", ".git", "dist",
  ".next", "__pycache__", ".venv", "build", "coverage",
]);

// ─── Writable stream shim ─────────────────────────────────────────────────────

class TauriWritableStream {
  private buf = "";
  constructor(private osPath: string) {}

  async write(data: string | BufferSource | Blob): Promise<void> {
    if (typeof data === "string") {
      this.buf = data;
    } else if (data instanceof Blob) {
      this.buf = await data.text();
    } else {
      this.buf = new TextDecoder().decode(data as ArrayBuffer);
    }
  }

  async close(): Promise<void> {
    await invoke("fs_write_file", { path: this.osPath, content: this.buf });
  }

  // Unused stubs required by callers that check the type
  async seek(_pos: number): Promise<void> {}
  async truncate(_size: number): Promise<void> {}
}

// ─── File handle ─────────────────────────────────────────────────────────────

export class TauriFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  readonly osPath: string;

  constructor(osPath: string) {
    this.osPath = osPath;
    this.name = osPath.replace(/\\/g, "/").split("/").pop() ?? osPath;
  }

  async getFile(): Promise<File> {
    const text = await invoke<string>("fs_read_file", { path: this.osPath });
    return new File([text], this.name, { type: "text/plain" });
  }

  async createWritable(): Promise<TauriWritableStream> {
    return new TauriWritableStream(this.osPath);
  }

  isSameEntry(other: unknown): Promise<boolean> {
    return Promise.resolve(
      other instanceof TauriFileHandle && other.osPath === this.osPath,
    );
  }
}

// ─── Directory handle ─────────────────────────────────────────────────────────

interface RawFsEntry { name: string; path: string; is_dir: boolean; }

export class TauriDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;
  readonly osPath: string;

  constructor(osPath: string) {
    // Normalise to forward slashes for consistency
    this.osPath = osPath.replace(/\\/g, "/").replace(/\/$/, "");
    this.name = this.osPath.split("/").pop() ?? this.osPath;
  }

  async *entries(): AsyncIterableIterator<[string, TauriFileHandle | TauriDirectoryHandle]> {
    const raw = await invoke<RawFsEntry[]>("fs_list_dir", { path: this.osPath });
    for (const e of raw) {
      if (HIDDEN.has(e.name)) continue;
      const normalPath = e.path.replace(/\\/g, "/");
      yield [
        e.name,
        e.is_dir ? new TauriDirectoryHandle(normalPath) : new TauriFileHandle(normalPath),
      ];
    }
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<TauriDirectoryHandle> {
    const subPath = `${this.osPath}/${name}`;
    const exists = await invoke<boolean>("fs_exists", { path: subPath });
    if (!exists) {
      if (options?.create) {
        await invoke("fs_mkdir", { path: subPath });
      } else {
        throw new DOMException(`Directory not found: ${name}`, "NotFoundError");
      }
    }
    return new TauriDirectoryHandle(subPath);
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<TauriFileHandle> {
    const filePath = `${this.osPath}/${name}`;
    const exists = await invoke<boolean>("fs_exists", { path: filePath });
    if (!exists) {
      if (options?.create) {
        // Create an empty file
        await invoke("fs_write_file", { path: filePath, content: "" });
      } else {
        throw new DOMException(`File not found: ${name}`, "NotFoundError");
      }
    }
    return new TauriFileHandle(filePath);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const entryPath = `${this.osPath}/${name}`;
    await invoke("fs_delete", { path: entryPath, recursive: options?.recursive ?? false });
  }

  isSameEntry(other: unknown): Promise<boolean> {
    return Promise.resolve(
      other instanceof TauriDirectoryHandle && other.osPath === this.osPath,
    );
  }
}
