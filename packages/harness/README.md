# @locus/harness

The agent harness: one Mastra loop with a small fixed tool set — `load_skill`, `query_data` (the read path: paginates every source itself, carries IDs across the chain, runs the model's SQL over a throwaway in-process database) and `perform_action` (the write path, gated in code) — plus subagents spawned per task or per client. Nothing GHL-specific lives in the system prompt; domain knowledge comes from `@locus/skills`. Design: vault note `Locus Agent Layer`.
