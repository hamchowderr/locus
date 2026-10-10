import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// One database per client. No GoHighLevel data here, ever — GHL is the system of record.
// Mastra's tables are created by @mastra/libsql, not here.

export const siteFile = sqliteTable(
  "site_file",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull(),
  },
  (t) => [unique("site_file_path_version").on(t.path, t.version)],
);

export const siteVersion = sqliteTable("site_version", {
  version: integer("version").primaryKey(),
  commitSha: text("commit_sha"),
  message: text("message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const generationRun = sqliteTable("generation_run", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});
