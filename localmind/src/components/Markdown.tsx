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
// result widget webview (see the import-graph comments at the top of
// src/result/ResultWidget.tsx and src/result/main.tsx). It must import ONLY
// react/react-markdown/remark/rehype/katex — never ../store/, never a
// side-effectful ../lib/ module, and never cn() from ../components/ui/utils.
// Pulling in a store here would boot a second scheduler/taskRunner inside
// that webview and double-fire every cron job. Keep every className below a
// plain static string.
//
// Note on rehype-katex error handling: the installed rehype-katex@7's
// `Options` type explicitly `Omit`s `throwOnError` — passing it would be a
// TS excess-property error. That's because this version already never
// crashes the render: internally it retries a failed render with
// `throwOnError: false, strict: "ignore"`, and if KaTeX still throws it
// builds a fallback `<span class="katex-error">` showing the raw source
// instead of propagating. So malformed TeX degrades to visible source text
// with no options needed here.

interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeCitations]}>
      {children}
    </ReactMarkdown>
  );
}
