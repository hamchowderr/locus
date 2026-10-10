import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { member, organization } from "./auth-schema.ts";

// The control database: shared by every agency, and holds nothing about any single client
// beyond its registry row. Every foreign key is indexed — Turso bills rows scanned.

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull();

const hosts = ["vercel", "netlify", "cloudflare"] as const;

/** The client registry — one row per GHL location. The most important table in the system. */
export const location = sqliteTable(
  "location",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** GHL's own id for the sub-account. */
    ghlLocationId: text("ghl_location_id").notNull(),
    name: text("name").notNull(),
    tursoDbName: text("turso_db_name").notNull().unique(),
    /** Read from the provisioner's response, never constructed. */
    tursoDbHostname: text("turso_db_hostname").notNull(),
    status: text("status", { enum: ["provisioning", "active", "suspended", "offboarding"] })
      .notNull()
      .default("provisioning"),
    createdAt: createdAt(),
  },
  // The unique index leads with organization_id, so it also serves the foreign key.
  (t) => [unique("location_ghl_unique").on(t.organizationId, t.ghlLocationId)],
);

/**
 * Which clients a staff member may touch. Checked before any Turso or GHL token is minted:
 * GHL's location tokens carry no user identity, so GHL cannot enforce this for us.
 * A member with no rows here is unrestricted only if their role says so — see `@locus/auth`.
 */
export const memberLocation = sqliteTable(
  "member_location",
  {
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("member_location_unique").on(t.memberId, t.locationId),
    index("member_location_location_idx").on(t.locationId),
  ],
);

/** Index of generated sites. Never their content — that lives in the client's database. */
export const site = sqliteTable(
  "site",
  {
    id: text("id").primaryKey(),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "cascade" }),
    /** Agency-owned, e.g. "their-org/their-site". */
    repoFullName: text("repo_full_name"),
    host: text("host", { enum: hosts }),
    hostProjectId: text("host_project_id"),
    deployUrl: text("deploy_url"),
    customDomain: text("custom_domain"),
    status: text("status", { enum: ["draft", "pushed", "deployed", "failed"] })
      .notNull()
      .default("draft"),
    createdAt: createdAt(),
  },
  (t) => [index("site_location_idx").on(t.locationId)],
);

// The three connections. Each names its credential by path (`secretRef`); the value lives in
// `secret` below, sealed, never in these rows.

export const agencyGhlConnection = sqliteTable("agency_ghl_connection", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** One Locus agency per GHL company, so a company's clients can't appear in two agencies. */
  ghlCompanyId: text("ghl_company_id").notNull().unique(),
  /** Space-delimited, as GHL returns it. */
  scopes: text("scopes").notNull(),
  /** e.g. "/locus/ghl/<organizationId>". */
  secretRef: text("secret_ref").notNull(),
  isWhitelabel: integer("is_whitelabel", { mode: "boolean" }).notNull().default(false),
  whitelabelDomain: text("whitelabel_domain"),
  whitelabelLogoUrl: text("whitelabel_logo_url"),
  companyName: text("company_name"),
  connectedAt: integer("connected_at", { mode: "timestamp_ms" }).notNull(),
});

export const githubInstallation = sqliteTable("github_installation", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  installationId: text("installation_id").notNull(),
  orgLogin: text("org_login").notNull(),
  connectedAt: integer("connected_at", { mode: "timestamp_ms" }).notNull(),
});

export const hostConnection = sqliteTable("host_connection", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: hosts }).notNull(),
  teamId: text("team_id").notNull(),
  secretRef: text("secret_ref").notNull(),
  connectedAt: integer("connected_at", { mode: "timestamp_ms" }).notNull(),
});

/** Who did what, to which client. Not a foreign key: the trail outlives what it describes. */
/**
 * Agencies' credentials (GHL, Vercel, GitHub tokens), sealed with AES-256-GCM by
 * `SecretCipher` from `@locus/secrets` and bound to their path. The key is not here: it is
 * `LOCUS_SECRETS_KEY`, kept in Infisical. Read and written only through `DbSecretStore`.
 */
export const secret = sqliteTable("secret", {
  path: text("path").primaryKey(),
  sealed: text("sealed").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    actorUserId: text("actor_user_id"),
    /** Null for agency-level actions. */
    locationId: text("location_id"),
    action: text("action").notNull(),
    detail: text("detail", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_created_idx").on(t.organizationId, t.createdAt)],
);

/**
 * Each client database's schema state, read by the tenant migration runner. `appliedHashes`
 * is the full set, not a version number: Drizzle's migrator only compares against the newest
 * applied migration, so a tenant that missed one in the middle would report clean forever.
 */
export const locationSchemaVersion = sqliteTable("location_schema_version", {
  locationId: text("location_id")
    .primaryKey()
    .references(() => location.id, { onDelete: "cascade" }),
  appliedHashes: text("applied_hashes", { mode: "json" }).$type<string[]>().notNull(),
  lastMigratedAt: integer("last_migrated_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
});
