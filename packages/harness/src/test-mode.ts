/**
 * Test-write mode: the only way Locus may write to a real client's GHL account during testing.
 *
 * Enforced in code, on the write path, for the agent and for scripts alike:
 * - Only a short list of operations is allowed at all (contacts, notes, tasks, tags,
 *   opportunities). Messages, appointments, workflows, campaigns, custom values: refused.
 * - New contacts must be obviously fake — a `Locus Test` name, an `@example.com` email, no
 *   phone — so even a misfiring GHL workflow has nobody real to reach.
 * - Every record the run creates is tagged `locus-test-<run>` (contacts) and written to a ledger.
 * - Updates, deletes and child records (notes, tasks, opportunities, tags) are allowed only on
 *   records already in the ledger — existing data is untouchable.
 * - `cleanupRun` deletes everything in the ledger, newest first.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { GhlError, type GhlRequestInput, type GhlSession, ghlRequest } from "@locus/ghl";
import { operationById, type SkillOperation } from "@locus/skills";
import { ActionError } from "./actions.ts";

export type RecordKind = "contact" | "note" | "task" | "opportunity";

export interface LedgerEntry {
  run: string;
  kind: RecordKind;
  id: string;
  /** The contact a note or task belongs to. */
  contactId?: string;
  at: string;
  deleted?: boolean;
}

export interface Ledger {
  append(entry: LedgerEntry): void;
  entries(): LedgerEntry[];
}

/** Records still alive in this ledger, by kind. */
function live(ledger: Ledger, run: string): Map<string, LedgerEntry> {
  const alive = new Map<string, LedgerEntry>();
  for (const entry of ledger.entries()) {
    if (entry.run !== run) continue;
    if (entry.deleted) alive.delete(`${entry.kind}:${entry.id}`);
    else alive.set(`${entry.kind}:${entry.id}`, entry);
  }
  return alive;
}

export function memoryLedger(): Ledger {
  const list: LedgerEntry[] = [];
  return { append: (entry) => list.push(entry), entries: () => [...list] };
}

/** One JSON object per line, appended — survives a crash mid-run. Keep the file out of git. */
export function fileLedger(path: string): Ledger {
  return {
    append(entry) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
    },
    entries() {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerEntry);
    },
  };
}

export interface WriteGuard {
  /** Throws `ActionError` for anything not allowed; returns the input to send. */
  check(op: SkillOperation, input: GhlRequestInput): GhlRequestInput;
  /** Records what a successful write created or deleted. */
  record(op: SkillOperation, input: GhlRequestInput, result: unknown): void;
}

export const TEST_TAG_PREFIX = "locus-test-";
const RUN_ID = /^[a-z0-9-]{3,40}$/;

/** What each allowed operation needs to be true before it runs. */
const RULES: Record<string, { create?: RecordKind; owns?: [RecordKind, string][] }> = {
  "contacts.create-contact": { create: "contact" },
  "contacts.update-contact": { owns: [["contact", "contactId"]] },
  "contacts.delete-contact": { owns: [["contact", "contactId"]] },
  "contacts.add-tags": { owns: [["contact", "contactId"]] },
  "contacts.remove-tags": { owns: [["contact", "contactId"]] },
  "contacts.create-note": { create: "note", owns: [["contact", "contactId"]] },
  "contacts.update-note": {
    owns: [
      ["contact", "contactId"],
      ["note", "id"],
    ],
  },
  "contacts.delete-note": {
    owns: [
      ["contact", "contactId"],
      ["note", "id"],
    ],
  },
  "contacts.create-task": { create: "task", owns: [["contact", "contactId"]] },
  "contacts.update-task": {
    owns: [
      ["contact", "contactId"],
      ["task", "taskId"],
    ],
  },
  "contacts.update-task-completed": {
    owns: [
      ["contact", "contactId"],
      ["task", "taskId"],
    ],
  },
  "contacts.delete-task": {
    owns: [
      ["contact", "contactId"],
      ["task", "taskId"],
    ],
  },
  "opportunities.create-opportunity": { create: "opportunity" },
  "opportunities.update-opportunity": { owns: [["opportunity", "id"]] },
  "opportunities.update-opportunity-status": { owns: [["opportunity", "id"]] },
  "opportunities.delete-opportunity": { owns: [["opportunity", "id"]] },
};

const DELETE_OPS: Record<RecordKind, string> = {
  note: "contacts.delete-note",
  task: "contacts.delete-task",
  opportunity: "opportunities.delete-opportunity",
  contact: "contacts.delete-contact",
};

export function createTestWriteGuard({ run, ledger }: { run: string; ledger: Ledger }): WriteGuard {
  if (!RUN_ID.test(run)) throw new Error(`run id "${run}" must be 3–40 of [a-z0-9-]`);
  const runTag = `${TEST_TAG_PREFIX}${run}`;
  const refuse = (why: string): never => {
    throw new ActionError(`test mode: ${why}`);
  };
  const owned = (kind: RecordKind, id: unknown) =>
    typeof id === "string" && live(ledger, run).has(`${kind}:${id}`);

  return {
    check(op, input) {
      const rule = RULES[op.id];
      if (!rule) return refuse(`${op.id} is not allowed against a real account`);

      for (const [kind, param] of rule.owns ?? []) {
        if (!owned(kind, input.path?.[param])) {
          refuse(
            `${op.id} may only touch ${kind}s this run created (${param} is not in the ledger)`,
          );
        }
      }

      const body = { ...input.body };
      checkTags(body.tags, refuse);
      if (op.id === "contacts.add-tags" || op.id === "contacts.remove-tags") {
        if (!Array.isArray(body.tags) || body.tags.length === 0) refuse("tags must be given");
      }

      if (op.id === "contacts.create-contact") {
        const name = `${body.firstName ?? ""} ${body.lastName ?? ""}`.trim();
        if (!name.startsWith("Locus Test")) refuse('test contacts must be named "Locus Test …"');
        if (body.email !== undefined && !/^[^@\s]+@example\.com$/.test(String(body.email))) {
          refuse("test contacts may only use @example.com emails");
        }
        for (const field of ["phone", "address1", "website", "dateOfBirth"]) {
          if (body[field] !== undefined) refuse(`test contacts may not have a ${field}`);
        }
        const tags = Array.isArray(body.tags) ? (body.tags as string[]) : [];
        body.tags = [...new Set([...tags, runTag])];
      }

      if (op.id === "opportunities.create-opportunity") {
        if (!owned("contact", body.contactId)) {
          refuse("opportunities may only be created for contacts this run created");
        }
        if (!String(body.name ?? "").startsWith("Locus Test")) {
          refuse('test opportunities must be named "Locus Test …"');
        }
      }

      return { ...input, ...(Object.keys(body).length > 0 ? { body } : {}) };
    },

    record(op, input, result) {
      const rule = RULES[op.id];
      if (!rule) return;
      const at = new Date().toISOString();

      if (rule.create) {
        const created = (result as Record<string, { id?: unknown } | undefined>)?.[rule.create];
        const id = created?.id;
        if (typeof id !== "string") {
          // Never lose track of a record: an unrecognised response is a hard stop.
          throw new ActionError(`test mode: ${op.id} returned no ${rule.create}.id to record`);
        }
        const contactId = input.path?.contactId;
        ledger.append({ run, kind: rule.create, id, ...(contactId ? { contactId } : {}), at });
      }

      if (op.method === "DELETE") {
        const last = rule.owns?.at(-1);
        const id = last ? input.path?.[last[1]] : undefined;
        if (last && id) ledger.append({ run, kind: last[0], id, at, deleted: true });
      }
    },
  };
}

function checkTags(tags: unknown, refuse: (why: string) => never): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) refuse("tags must be a list");
  for (const tag of tags as unknown[]) {
    if (typeof tag !== "string" || !tag.startsWith(TEST_TAG_PREFIX)) {
      refuse(
        `only ${TEST_TAG_PREFIX}* tags are allowed — "${String(tag)}" could trigger a workflow`,
      );
    }
  }
}

export interface CleanupReport {
  deleted: { kind: RecordKind; id: string }[];
  alreadyGone: { kind: RecordKind; id: string }[];
  failed: { kind: RecordKind; id: string; error: string }[];
}

/** Deletes every live record of a run, newest first. Safe to run again after a failure. */
export async function cleanupRun(
  { run, ledger }: { run: string; ledger: Ledger },
  deps: { session: GhlSession; fetch?: typeof fetch },
): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: [], alreadyGone: [], failed: [] };
  const entries = [...live(ledger, run).values()].reverse();

  for (const entry of entries) {
    const op = operationById(DELETE_OPS[entry.kind]);
    if (!op) throw new Error(`catalog is missing ${DELETE_OPS[entry.kind]}`);
    const path: Record<string, string> =
      entry.kind === "note"
        ? { contactId: entry.contactId ?? "", id: entry.id }
        : entry.kind === "task"
          ? { contactId: entry.contactId ?? "", taskId: entry.id }
          : entry.kind === "opportunity"
            ? { id: entry.id }
            : { contactId: entry.id };
    const done = () => ledger.append({ ...entry, at: new Date().toISOString(), deleted: true });
    try {
      await ghlRequest(op, deps.session, { path }, deps.fetch ? { fetch: deps.fetch } : {});
      report.deleted.push({ kind: entry.kind, id: entry.id });
      done();
    } catch (error) {
      if (error instanceof GhlError && error.status === 404) {
        report.alreadyGone.push({ kind: entry.kind, id: entry.id });
        done();
      } else {
        report.failed.push({ kind: entry.kind, id: entry.id, error: (error as Error).message });
      }
    }
  }
  return report;
}
