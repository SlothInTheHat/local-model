import { useEffect, useState } from "react";
import { FileText, X, Image as ImageIcon, AlertCircle } from "lucide-react";

interface Props {
  handle: FileSystemFileHandle;
  path: string;
  onClose: () => void;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const MAX_DISPLAY_LEN = 20_000;

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read-only file preview, embeddable in the chat tab (or anywhere) so the
 * user doesn't need to switch to the Code tab / Monaco just to look at a
 * file the agent touched or the user is browsing via a FileTree. Images
 * render inline; text is shown monospace with the same clamp-then-expand
 * pattern ChatMessages uses for long tool output.
 */
export function FilePreviewPanel({ handle, path, onClose }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFull, setShowFull] = useState(false);

  const isImage = IMAGE_EXTS.has(extOf(path));

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setText(null);
    setImageUrl(null);
    setError(null);
    setShowFull(false);
    setLoading(true);

    (async () => {
      try {
        const file = await handle.getFile();
        if (cancelled) return;
        setSize(file.size);
        if (isImage) {
          objectUrl = URL.createObjectURL(file);
          setImageUrl(objectUrl);
        } else {
          setText(await file.text());
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [handle, path, isImage]);

  const clamped = text !== null && !showFull && text.length > MAX_DISPLAY_LEN;
  const displayText = text === null ? "" : clamped ? text.slice(0, MAX_DISPLAY_LEN) : text;

  return (
    <div className="h-full flex flex-col border-l bg-card">
      <div className="h-10 border-b px-3 flex items-center gap-2 shrink-0">
        {isImage ? (
          <ImageIcon className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <FileText className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-xs font-medium truncate flex-1" title={path}>{path}</span>
        {size !== null && (
          <span className="text-[10px] text-muted-foreground shrink-0">{formatBytes(size)}</span>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close preview"
          className="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && <p className="text-xs text-muted-foreground p-3">Loading…</p>}

        {error && (
          <div className="flex items-center gap-1.5 text-xs text-destructive p-3">
            <AlertCircle className="size-3.5 shrink-0" /> {error}
          </div>
        )}

        {!loading && !error && isImage && imageUrl && (
          <div className="p-3">
            <img src={imageUrl} alt={path} className="max-w-full h-auto rounded border border-border" />
          </div>
        )}

        {!loading && !error && !isImage && text !== null && (
          <>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all p-3 text-foreground leading-relaxed">
              {displayText}
            </pre>
            {clamped && (
              <div className="px-3 pb-3">
                <button
                  type="button"
                  onClick={() => setShowFull(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Show full file ({Math.round(text.length / 1000)}K chars)…
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
