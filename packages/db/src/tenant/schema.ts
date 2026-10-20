import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// One database per client. No GoHighLevel data here, ever — GHL is the system of record.
// Mastra's tables are created by @mastra/libsql, not here.
//
// A site's code lives here, not in the control database: the control `site` row is only its
// index entry. File contents are stored once per distinct content (`site_blob`), so a version
// that changes one file costs one new blob and a list of paths.

/** One distinct file content, keyed by its SHA-256. Binary files are stored base64. */
export const siteBlob = sqliteTable("site_blob", {
  hash: text("hash").primaryKey(),
  encoding: text("encoding", { enum: ["utf8", "base64"] }).notNull(),
  content: text("content").notNull(),
  /** Bytes of the decoded content. */
  size: integer("size").notNull(),
});

/** The working tree: what the agent is editing now, before it is saved as a version. */
export const siteDraftFile = sqliteTable(
  "site_draft_file",
  {
    siteId: text("site_id").notNull(),
    path: text("path").notNull(),
    blobHash: text("blob_hash")
      .notNull()
      .references(() => siteBlob.hash),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.path] }),
    index("site_draft_file_blob_idx").on(t.blobHash),
  ],
);

/** A saved state of the whole site, numbered per site from 1. */
export const siteVersion = sqliteTable(
  "site_version",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    number: integer("number").notNull(),
    message: text("message").notNull(),
    /** `copy`: version 1 of a site copied from another site's latest version. */
    source: text("source", { enum: ["template", "agent", "restore", "edit", "copy"] }).notNull(),
    /** The version this one was made from; null for the first. */
    parentId: text("parent_id"),
    bookmarked: integer("bookmarked", { mode: "boolean" }).notNull().default(false),
    /** Set once the version is committed to the agency's repository. */
    commitSha: text("commit_sha"),
    createdByUserId: text("created_by_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [unique("site_version_site_number").on(t.siteId, t.number)],
);

export const siteVersionFile = sqliteTable(
  "site_version_file",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => siteVersion.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobHash: text("blob_hash")
      .notNull()
      .references(() => siteBlob.hash),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.path] }),
    index("site_version_file_blob_idx").on(t.blobHash),
  ],
);

/** What the site is for and how it should look: the starting point every generation reads. */
export const siteBrief = sqliteTable("site_brief", {
  siteId: text("site_id").primaryKey(),
  brief: text("brief", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** One agent turn that changed a site, for history and for metering. */
export const generationRun = sqliteTable(
  "generation_run",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id").notNull(),
    threadId: text("thread_id"),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
    /** The version the run saved, if it saved one. */
    versionId: text("version_id"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("generation_run_site_idx").on(t.siteId, t.startedAt)],
);

/**
 * How many leads a published site's forms sent to the CRM each day (UTC), and how many failed.
 * Counts only: no visitor details and no GHL ids — GHL is the system of record. Spam that the
 * honeypot, timing or rate limits drop isn't counted, so junk never costs a write.
 */
export const siteLeadDay = sqliteTable(
  "site_lead_day",
  {
    siteId: text("site_id").notNull(),
    /** `YYYY-MM-DD`, UTC. */
    day: text("day").notNull(),
    delivered: integer("delivered").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.day] })],
);
