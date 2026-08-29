import { useEffect, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
// KaTeX ships its own .woff2 fonts alongside this stylesheet; importing the
// npm package's CSS (rather than a CDN <link>) means Vite bundles both into
// dist/assets/ so math renders correctly fully offline — same reasoning as
// the self-hosted fonts in src/main.tsx.
import "katex/dist/katex.min.css";
// Pure, store-free tree transform (text-node regex → <span class="km-citation">)
// — safe to import here under the HARD CONSTRAINT below. See its header
// comment for why detection and interactivity are split across two files.
import { rehypeCitations } from "../lib/citationsRehype";

// HARD CONSTRAINT: this component is shared by the main app AND the isolated
// quick-invoke overlay webview, which renders the answer card once the
// separate `result` window was merged into it (see the import-graph comment
// at the top of src/overlay/QuickInvoke.tsx). It must import ONLY
// react/react-markdown/remark/rehype/katex/mermaid — never ../store/, never a
// side-effectful ../lib/ module, and never cn() from ../components/ui/utils.
// Pulling in a store here would boot a second scheduler/taskRunner inside
// that webview and double-fire every cron job. Keep every className below a
// plain static string. mermaid is fine under this rule — it's a pure,
// store-free rendering library, same category as react-markdown itself.
//
// Note on rehype-katex error handling: the installed rehype-katex@7's
// `Options` type explicitly `Omit`s `throwOnError` — passing it would be a
// TS excess-property error. That's because this version already never
// crashes the render: internally it retries a failed render with
// `throwOnError: false, strict: "ignore"`, and if KaTeX still throws it
// builds a fallback `<span class="katex-error">` showing the raw source
// instead of propagating. So malformed TeX degrades to visible source text
// with no options needed here.

let mermaidInitialized = false;

/** Lazy-loads and renders one ```mermaid fenced block into an SVG. Rendering
 *  is deferred until the block is no longer streaming (`isStreaming` false) —
 *  calling mermaid.render() on a truncated, still-arriving diagram definition
 *  just throws/flickers on every token, so a plain code placeholder shows
 *  until the fence closes. */
function MermaidBlock({ code, isStreaming }: { code: string; isStreaming: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`lm-mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (isStreaming) return;
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        if (!mermaidInitialized) {
          // "strict" sanitizes generated SVG/links — this renders text that
          // ultimately traces back to model output (and, transitively,
          // anything a prompt-injected web page talked the model into
          // repeating), so treat it as untrusted input, not authored content.
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
          mermaidInitialized = true;
        }
        const { svg: rendered } = await mermaid.render(idRef.current, code);
        if (!cancelled) { setSvg(rendered); setFailed(false); }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [code, isStreaming]);

  if (isStreaming || failed || !svg) {
    return <pre><code className="language-mermaid">{code}</code></pre>;
  }
  return (
    <div
      className="lm-mermaid-diagram"
      style={{ maxWidth: "100%", overflowX: "auto" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function makeCodeRenderer(isStreaming: boolean) {
  return function CodeRenderer({ className, children, ...rest }: ComponentProps<"code">) {
    if (className === "language-mermaid") {
      return <MermaidBlock code={String(children ?? "").replace(/\n$/, "")} isStreaming={isStreaming} />;
    }
    return <code className={className} {...rest}>{children}</code>;
  };
}

interface MarkdownProps {
  children: string;
  /** True while this specific message is still streaming — see MermaidBlock's doc comment. Defaults false (the result-widget webview never streams). */
  isStreaming?: boolean;
}

export function Markdown({ children, isStreaming = false }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeCitations]}
      components={{ code: makeCodeRenderer(isStreaming) }}
    >
      {children}
    </ReactMarkdown>
  );
}
