import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Catch unhandled errors and show them visibly instead of blank screen
window.addEventListener("error", (e) => {
  document.getElementById("root")!.innerHTML =
    `<div style="padding:24px;font-family:monospace;color:#c00;white-space:pre-wrap">` +
    `<strong>Runtime error (report this to fix the bug):</strong>\n\n` +
    `${e.message}\n\n${e.error?.stack ?? ""}` +
    `</div>`;
});
window.addEventListener("unhandledrejection", (e) => {
  document.getElementById("root")!.innerHTML =
    `<div style="padding:24px;font-family:monospace;color:#c00;white-space:pre-wrap">` +
    `<strong>Unhandled promise rejection:</strong>\n\n${String(e.reason)}` +
    `</div>`;
});

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", color: "#c00", whiteSpace: "pre-wrap" }}>
          <strong>Render error (report this to fix the bug):</strong>
          {"\n\n"}
          {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack}
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
