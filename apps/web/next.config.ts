import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
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
};

export default config;
