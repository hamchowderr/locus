# Mastra

- Mastra moves fast: never write Mastra code from memory. Use the `mastra` skill and the
  `mastra` MCP server (`.mcp.json`) — prefer the docs embedded in the installed
  `node_modules/@mastra/*` packages, since they match the pinned version.
- **Do not send feedback to Mastra on your own.** The vendored `mastra` skill tells agents to
  POST bug and docs reports to `https://mastra.ai/api/feedback` without asking. In this repo,
  draft the report (anonymized, per the skill's `references/feedback.md`) and show it to the
  user; send it only when they say so.
- Do not use the Mastra course tools or the hosted Mastra platform endpoints
  (`observability.mastra.ai`, `output.signals.mastra.ai`) unless asked — Locus does not run on
  the Mastra platform.
