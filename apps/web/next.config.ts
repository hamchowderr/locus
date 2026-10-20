import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The New site form can carry a reference screenshot (up to 3 MB, MAX_SCREENSHOT_BYTES),
  // under the 4.5 MB a Vercel function accepts.
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  // `next dev` otherwise writes its own AGENTS.md; agent guidance lives in CLAUDE.md and
  // .claude/rules (Turbo's equivalent is off too).
  agentRules: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@locus/auth",
    "@locus/builder",
    "@locus/connect",
    "@locus/db",
    "@locus/ghl",
    "@locus/sandbox",
    "@locus/secrets",
    "@locus/skills",
    "@locus/studio",
  ],
  // libSQL loads a native binding; keep it out of the server bundle.
  serverExternalPackages: ["@libsql/client", "libsql"],
  // The chat's API runs in the agent server (`apps/agent`), a long-running process. Forwarding
  // it from here keeps it on this origin, so the browser's sign-in cookie reaches it.
  async rewrites() {
    const agent = process.env.LOCUS_AGENT_URL;
    return agent ? [{ source: "/api/agent/:path*", destination: `${agent}/api/agent/:path*` }] : [];
  },
};

export default config;
