import { randomUUID } from "node:crypto";
import type { ControlDb } from "@locus/db";
import { agencyComp, auditLog, location, member, organization, user } from "@locus/db/control";
import { count, eq } from "drizzle-orm";
import { rolesOf, type SessionContext } from "./client-access.ts";

/**
 * Operators run a Locus deployment: they see every agency on it and can comp one. Who they are
 * is the deployment's own setting, `LOCUS_OPERATORS` (comma-separated emails), so anyone running
 * Locus names their own.
 *
 * The operator view is account-level only: agencies, owners, client counts, billing state. It
 * never mints a GHL or Turso token and never opens a client's data, so being an operator gives
 * no way into what agencies keep in Locus.
 */

/** Refused. Always 403 with the same message, so a probe learns nothing. */
export class NotOperator extends Error {
  readonly status = 403;

  constructor() {
    super("Only this deployment's operators can do that.");
    this.name = "NotOperator";
  }
}

/** The operator emails from `LOCUS_OPERATORS`, lower-cased. None set means no operators. */
export function operatorsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.LOCUS_OPERATORS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether the session's user is an operator: a listed email, verified. */
export async function isOperator(
  db: ControlDb,
  ctx: SessionContext,
  operators: readonly string[],
): Promise<boolean> {
  if (operators.length === 0) return false;
  const [row] = await db
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, ctx.userId));
  return !!row?.emailVerified && operators.includes(row.email.toLowerCase());
}

export async function requireOperator(
  db: ControlDb,
  ctx: SessionContext,
  operators: readonly string[],
): Promise<void> {
  if (!(await isOperator(db, ctx, operators))) throw new NotOperator();
}

export interface AgencySummary {
  id: string;
  name: string;
  createdAt: Date;
  ownerEmails: string[];
  clients: number;
  comped: boolean;
}

/** Every agency on the deployment, newest first. Operators only. */
export async function listAgencies(
  db: ControlDb,
  ctx: SessionContext,
  operators: readonly string[],
): Promise<AgencySummary[]> {
  await requireOperator(db, ctx, operators);
  const agencies = await db
    .select({ id: organization.id, name: organization.name, createdAt: organization.createdAt })
    .from(organization);
  const owners = await db
    .select({ organizationId: member.organizationId, email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id));
  const clients = await db
    .select({ organizationId: location.organizationId, n: count() })
    .from(location)
    .groupBy(location.organizationId);
  const comped = new Set(
    (await db.select({ id: agencyComp.organizationId }).from(agencyComp)).map((r) => r.id),
  );
  return agencies
    .map((a) => ({
      ...a,
      ownerEmails: owners
        .filter((o) => o.organizationId === a.id && rolesOf(o.role).includes("owner"))
        .map((o) => o.email),
      clients: clients.find((c) => c.organizationId === a.id)?.n ?? 0,
      comped: comped.has(a.id),
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Comps an agency, or ends its comp. Operators only; each change goes in the audit log. */
export async function setComped(
  db: ControlDb,
  ctx: SessionContext,
  operators: readonly string[],
  organizationId: string,
  comped: boolean,
): Promise<void> {
  await requireOperator(db, ctx, operators);
  const [agency] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, organizationId));
  if (!agency) throw new NotOperator();

  const write = comped
    ? db
        .insert(agencyComp)
        .values({ organizationId, compedByUserId: ctx.userId })
        .onConflictDoNothing()
    : db.delete(agencyComp).where(eq(agencyComp.organizationId, organizationId));
  await db.batch([
    write,
    db.insert(auditLog).values({
      id: randomUUID(),
      organizationId,
      actorUserId: ctx.userId,
      action: comped ? "operator.comp" : "operator.uncomp",
    }),
  ]);
}

/** Whether the agency is comped. For the entitlement check; no session needed. */
export async function isComped(db: ControlDb, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agencyComp.organizationId })
    .from(agencyComp)
    .where(eq(agencyComp.organizationId, organizationId));
  return !!row;
}
