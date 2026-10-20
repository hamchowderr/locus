import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
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
    /** The folder the agency filed the site under on the Sites page; null for none. */
    folder: text("folder_name"),
    createdAt: createdAt(),
  },
  (t) => [
    index("site_location_idx").on(t.locationId),
    // A host project is one site, whichever agency or client links it.
    unique("site_host_project_unique").on(t.hostProjectId),
    // Each save replaces the whole repository, so a repository is one site.
    unique("site_repo_full_name_unique").on(t.repoFullName),
  ],
);

/**
 * The database of an app-style site (member logins, bookings, its own records), on Otaku's
 * Turso. Plain websites have no row here. Like `location`, a registry row only: the site's
 * data lives in that database, never in this one.
 */
export const siteBackend = sqliteTable(
  "site_backend",
  {
    // Restrict, not cascade: deleting the site or client row must never leave its Turso
    // database behind unreachable. Whatever removes them destroys the database first.
    siteId: text("site_id")
      .primaryKey()
      .references(() => site.id, { onDelete: "restrict" }),
    /** The site's client, so every lookup is scoped by the session's client as well. */
    locationId: text("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "restrict" }),
    tursoDbName: text("turso_db_name").notNull().unique(),
    /** Read from the provisioner's response, never constructed. */
    tursoDbHostname: text("turso_db_hostname").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("site_backend_location_idx").on(t.locationId)],
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
  /** The team's name or the account's username, for display. */
  accountName: text("account_name"),
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

/**
 * Agencies a deployment's operator has comped: they count as paid without a Stripe
 * subscription. A row means comped; deleting it ends the comp. Each change is in `audit_log`.
 */
export const agencyComp = sqliteTable("agency_comp", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** The operator who comped it. Not a foreign key, like `audit_log.actor_user_id`. */
  compedByUserId: text("comped_by_user_id").notNull(),
  note: text("note"),
  createdAt: createdAt(),
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

/**
 * Sign-in and sign-up attempts per key (an IP address or an email address) in the current
 * fixed window. Better Auth's own limiter only sees HTTP calls and keeps its counts in one
 * instance's memory; the web app calls the API directly from server actions, on many instances.
 */
export const authRateLimit = sqliteTable(
  "auth_rate_limit",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    windowStart: integer("window_start").notNull(),
  },
  // Expired keys are deleted by window start.
  (t) => [index("auth_rate_limit_window_start_idx").on(t.windowStart)],
);

// Usage metering for AI site generation. Credits are integers in hundredths of a credit
// (`CREDIT = 100` in `@locus/auth`); one credit is $0.01 of provider cost times Locus's markup.

/**
 * One metered piece of work (an LLM call, AI images, sandbox time) for one client. `location_id`
 * is not a foreign key, like `audit_log`: an agency's monthly total must not shrink when one of
 * its clients is offboarded mid-month. `site_id` is not one either, for the same reason.
 */
export const usageEvent = sqliteTable(
  "usage_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    locationId: text("location_id").notNull(),
    siteId: text("site_id"),
    actorUserId: text("actor_user_id"),
    kind: text("kind", { enum: ["llm", "image", "sandbox"] }).notNull(),
    /** Hundredths of a credit. */
    credits: integer("credits").notNull(),
    /** The measurement the credits were priced from: model and tokens, image count, seconds. */
    detail: text("detail", { mode: "json" }),
    /**
     * The part of `credits` past the plan's monthly credits that the agency pays for as extra
     * usage (`usage_overage`). Zero unless extra usage was on when the event was recorded.
     */
    overageCredits: integer("overage_credits").notNull().default(0),
    /** When the overage was sent to Stripe's meter; null while it is still to send. */
    overageReportedAt: integer("overage_reported_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_event_location_created_idx").on(t.locationId, t.createdAt),
    index("usage_event_org_created_idx").on(t.organizationId, t.createdAt),
    // Only events still to send to Stripe, so the report job reads nothing else.
    index("usage_event_overage_unreported_idx")
      .on(t.createdAt)
      .where(sql`${t.overageCredits} > 0 and ${t.overageReportedAt} is null`),
  ],
);

/**
 * Each client's credits per calendar month (UTC), kept alongside `usage_event` in the same batch
 * so a monthly total reads one row per client instead of every event (Turso bills rows read).
 * Not a foreign key to `location`, for the same reason as `usage_event`.
 */
export const usageMonth = sqliteTable(
  "usage_month",
  {
    locationId: text("location_id").notNull(),
    /** "YYYY-MM", UTC. */
    month: text("month").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Hundredths of a credit. */
    credits: integer("credits").notNull(),
    /** The part of `credits` billed as extra usage, in hundredths of a credit. */
    overageCredits: integer("overage_credits").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.locationId, t.month] }),
    index("usage_month_org_month_idx").on(t.organizationId, t.month),
  ],
);

/** An agency's own limits for one client. No row means the defaults below. */
export const usageLimit = sqliteTable("usage_limit", {
  locationId: text("location_id")
    .primaryKey()
    .references(() => location.id, { onDelete: "cascade" }),
  /** Hundredths of a credit per calendar month (UTC). Null: no cap of its own, only the plan's. */
  monthlyCreditCap: integer("monthly_credit_cap"),
  alertAtPercent: integer("alert_at_percent").notNull().default(80),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * An agency's extra usage: credits past its plan's monthly credits, billed through Stripe's meter
 * at the end of the billing period. No row, or `enabled` false, means generation stops at the
 * plan's credits.
 */
export const usageOverage = sqliteTable("usage_overage", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** Extra credits the agency allows per calendar month (UTC), in hundredths of a credit. */
  monthlyCreditLimit: integer("monthly_credit_limit").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * A usage alert that fired, so each one fires once per period. `subject` is `"agency"` or
 * `"location:<id>"` (a nullable location id can't be part of a unique key in SQLite);
 * `period` is the calendar month, `"YYYY-MM"` in UTC; `threshold` a percentage of the limit.
 */
export const usageAlert = sqliteTable(
  "usage_alert",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    period: text("period").notNull(),
    threshold: integer("threshold").notNull(),
    createdAt: createdAt(),
  },
  // Leads with organization_id, so it also serves the foreign key.
  (t) => [unique("usage_alert_once").on(t.organizationId, t.subject, t.period, t.threshold)],
);
