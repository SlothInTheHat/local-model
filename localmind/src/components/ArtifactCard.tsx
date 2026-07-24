import { useEffect, useRef, useState } from "react";
import { ArrowUpDown, ExternalLink } from "lucide-react";
import type { ArtifactRecord } from "../store/artifacts";

/**
 * Renders a self-contained HTML document (canvas/plot artifacts, and the
 * webpage reader-view fallback) in a sandboxed blob-URL iframe — the same
 * pattern Workflows.tsx's WorkflowHtmlPreview already uses for HTML-output
 * workflows, reused here a third time for chat.
 */
function IframeArtifact({ html, title, sandbox }: { html: string; title?: string; sandbox: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
    prevUrlRef.current = url;
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      if (prevUrlRef.current === url) prevUrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  if (!blobUrl) return null;
  return (
    <iframe
      src={blobUrl}
      sandbox={sandbox}
      className="w-full h-80 rounded border bg-white"
      title={title ?? "Artifact preview"}
    />
  );
}

/** Live iframe of a real external URL, with a client-side timeout as a
 *  secondary safety net for JS frame-busting (the tool executor's header
 *  preflight already catches the far more common X-Frame-Options/CSP case
 *  before this ever renders — this only covers a site that lets itself be
 *  framed per headers but then detects it via script and blanks itself). */
function LiveWebpageArtifact({ artifact }: { artifact: ArtifactRecord }) {
  const [failed, setFailed] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loadedRef.current) setFailed(true);
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  if (failed) {
    return <IframeArtifact html={artifact.html ?? ""} title={artifact.title} sandbox="" />;
  }
  return (
    <div>
      <iframe
        src={artifact.url}
        sandbox="allow-scripts allow-same-origin allow-popups"
        onLoad={() => { loadedRef.current = true; }}
        className="w-full h-80 rounded border bg-white"
        title={artifact.title ?? artifact.url}
      />
      {artifact.url && (
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" /> Open in browser
        </a>
      )}
    </div>
  );
}

function TableArtifact({ columns, rows, title }: { columns: string[]; rows: unknown[][]; title?: string }) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [filter, setFilter] = useState("");

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => r.some((cell) => String(cell ?? "").toLowerCase().includes(q)))
    : rows;
  const sorted = sortCol === null
    ? filtered
    : [...filtered].sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        const cmp = typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av ?? "").localeCompare(String(bv ?? ""));
        return cmp * sortDir;
      });

  return (
    <div className="border border-border rounded-md overflow-hidden max-w-full bg-card">
      {title && <div className="px-3 py-1.5 text-xs font-medium bg-muted border-b border-border">{title}</div>}
      <div className="px-2 py-1.5 border-b border-border">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  onClick={() => {
                    if (sortCol === i) setSortDir((d) => (d === 1 ? -1 : 1));
                    else { setSortCol(i); setSortDir(1); }
                  }}
                  className="text-left px-2 py-1.5 font-medium cursor-pointer hover:bg-muted select-none whitespace-nowrap text-foreground"
                >
                  <span className="inline-flex items-center gap-1">
                    {c}
                    {sortCol === i && <ArrowUpDown className="size-3" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, ri) => (
              <tr key={ri} className="border-t border-border/50 hover:bg-muted/30">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-2 py-1.5 whitespace-nowrap text-foreground/90">{String(cell ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length !== rows.length && (
        <div className="px-2 py-1 text-[10px] text-muted-foreground border-t border-border">
          {filtered.length} / {rows.length} rows
        </div>
      )}
    </div>
  );
}

export function ArtifactCard({ artifact }: { artifact: ArtifactRecord }) {
  if (artifact.kind === "table" && artifact.columns && artifact.rows) {
    return <TableArtifact columns={artifact.columns} rows={artifact.rows} title={artifact.title} />;
  }

  if (artifact.kind === "webpage") {
    // Header preflight already determined this at tool-execution time — a
    // known-blocked site skips the live attempt entirely rather than
    // rendering a frame we already know will come back blank.
    if (!artifact.blocked && artifact.url) {
      return <LiveWebpageArtifact artifact={artifact} />;
    }
    return <IframeArtifact html={artifact.html ?? ""} title={artifact.title} sandbox="" />;
  }

  // canvas / plot — model-generated content, sandbox="allow-scripts" only
  // (no allow-same-origin), matching Workflows.tsx's stricter precedent for
  // generated-not-authored HTML rather than CodeEditor.tsx's looser one.
  return <IframeArtifact html={artifact.html ?? ""} title={artifact.title} sandbox="allow-scripts" />;
}
