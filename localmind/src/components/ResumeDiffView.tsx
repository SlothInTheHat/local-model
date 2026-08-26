import React, { Suspense } from "react";
import { Button } from "./ui/button";
import { registerLocalMindMonacoThemes } from "../lib/monacoThemes";
import { registerLatexLanguage } from "../lib/monacoLatex";
import { useSettingsStore } from "../store/settings";

const MonacoDiffEditor = React.lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor }))
);

interface ResumeDiffViewProps {
  original: string;
  modified: string;
  language: string;
  summary: string;
  onAccept: () => void;
  onReject: () => void;
}

export function ResumeDiffView({ original, modified, language, summary, onAccept, onReject }: ResumeDiffViewProps) {
  const { codeEditorTheme } = useSettingsStore();

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-3 h-9 border-b bg-card shrink-0">
        <span className="text-xs text-foreground flex-1 truncate" title={summary}>{summary}</span>
        <Button
          size="sm"
          className="text-xs h-6 bg-success hover:bg-success/90 text-success-foreground border-0"
          onClick={onAccept}
        >
          Accept
        </Button>
        <Button
          size="sm" variant="outline"
          className="text-xs h-6 border-destructive/40 text-destructive hover:bg-destructive/10"
          onClick={onReject}
        >
          Reject
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading diff…</div>}>
          <MonacoDiffEditor
            height="100%"
            language={language}
            original={original}
            modified={modified}
            theme={codeEditorTheme === "dark" ? "localmind-dark" : "localmind-light"}
            options={{ readOnly: true, renderSideBySide: true }}
            beforeMount={(monacoInstance) => {
              registerLocalMindMonacoThemes(monacoInstance);
              registerLatexLanguage(monacoInstance);
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
