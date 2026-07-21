/**
 * Single source of truth for the one-click MCP "Quick Setup" preset DATA.
 * UI concerns (the lucide Icon component per preset) stay in McpSettings.tsx,
 * which merges this data with a local id → Icon map. Anything that needs to
 * describe or reference these presets in text (e.g. capabilityRegistry.ts)
 * should import MCP_PRESETS rather than hardcoding names.
 *
 * Package names verified against npm. The Google services all require a
 * one-time OAuth setup (Google Cloud project + OAuth client JSON), so they are
 * marked `setup` and carry the exact env var each package expects.
 */
export interface McpPreset {
  id: string;
  label: string;
  command: string;
  args: string;
  description: string;
  /** Env vars the server needs; KEY → placeholder value shown pre-filled in the form. */
  env?: Record<string, string>;
  /**
   * Needs per-user credentials. Clicking the card opens the manual Add form
   * pre-filled (so the user can supply the credential path / review the auth
   * step) instead of silently creating a server that will fail to connect.
   */
  setup?: boolean;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    command: "npx",
    args: "-y @shinzolabs/gmail-mcp",
    description: "Read, search & send email. One-time auth: run `npx @shinzolabs/gmail-mcp auth` in a terminal, then connect here.",
    setup: true,
  },
  {
    id: "gdrive",
    label: "Google Drive",
    command: "npx",
    args: "-y @modelcontextprotocol/server-gdrive",
    description: "Browse, read & search Drive files. Needs a Google OAuth client; set GDRIVE_CREDENTIALS_PATH to your credentials JSON.",
    env: { GDRIVE_CREDENTIALS_PATH: "C:\\path\\to\\.gdrive-server-credentials.json" },
    setup: true,
  },
  {
    id: "gcal",
    label: "Google Calendar",
    command: "npx",
    args: "-y @cocal/google-calendar-mcp",
    description: "View & create calendar events. Needs a Google OAuth client; set GOOGLE_OAUTH_CREDENTIALS to your gcp-oauth.keys.json.",
    env: { GOOGLE_OAUTH_CREDENTIALS: "C:\\path\\to\\gcp-oauth.keys.json" },
    setup: true,
  },
  {
    id: "canvas",
    label: "Canvas",
    command: "npx",
    args: "-y canvas-mcp-server",
    description: "Canvas LMS: courses, assignments, grades & submissions. Needs a Canvas access token (Account → Settings → + New Access Token) and your Canvas domain.",
    env: { CANVAS_API_TOKEN: "", CANVAS_DOMAIN: "canvas.illinois.edu" },
    setup: true,
  },
  {
    id: "browser",
    label: "Browser",
    command: "npx",
    args: "-y @playwright/mcp@latest",
    description: "Automate browser navigation & forms (no auth needed)",
  },
];
