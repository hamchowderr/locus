/**
 * Live writes against a real GHL sub-account, inside test-write mode. Off unless
 * LOCUS_LIVE_WRITES=1. Run by hand, never in CI; the account and its rules are in the vault
 * note `KnowBS/GHL Account Inventory`.
 *
 * Creates one fake contact with a note and a task, then deletes all of it and checks it is gone.
 * The ledger is written to `.locus-test-runs/<run>.jsonl`, so if this test dies half way,
 * `scripts/cleanup-test-run.ts <run> --delete` removes what was left.
 */

import { join } from "node:path";
import { GhlError, type GhlSession, ghlRequest } from "@locus/ghl";
import { operationById } from "@locus/skills";
import { describe, expect, test } from "vitest";
import { performAction } from "./actions.ts";
import { cleanupRun, createTestWriteGuard, fileLedger } from "./test-mode.ts";

const token = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const enabled = process.env.LOCUS_LIVE_WRITES === "1" && Boolean(token && locationId);

describe.skipIf(!enabled)("live writes in test mode", () => {
  test("create a fake contact with a note and a task, then remove every trace", async () => {
    const session: GhlSession = {
      token: token ?? "",
      tokenKind: "location",
      locationId: locationId ?? "",
    };
    const run = `live-${Date.now().toString(36)}`;
    const ledger = fileLedger(join(process.cwd(), "../../.locus-test-runs", `${run}.jsonl`));
    const writeGuard = createTestWriteGuard({ run, ledger });
    const act = (operation: string, params: object) =>
      performAction({ operation, params }, { session, writeGuard });

    try {
      const { contact } = (await act("contacts.create-contact", {
        body: { firstName: "Locus Test", lastName: run, email: `${run}@example.com` },
      })) as { contact: { id: string } };
      await act("contacts.create-note", {
        path: { contactId: contact.id },
        body: { body: "Created by a Locus test run; deleted by the same run." },
      });
      await act("contacts.create-task", {
        path: { contactId: contact.id },
        body: {
          title: "Locus Test task",
          dueDate: new Date(Date.now() + 86_400_000).toISOString(),
          completed: false,
        },
      });
      expect(ledger.entries().filter((e) => e.run === run)).toHaveLength(3);
    } finally {
      const report = await cleanupRun({ run, ledger }, { session });
      expect(report.failed).toEqual([]);
    }

    const contactId = ledger.entries().find((e) => e.kind === "contact")?.id ?? "";
    const getContact = operationById("contacts.get-contact");
    if (!getContact) throw new Error("catalog is missing contacts.get-contact");
    const gone = await ghlRequest(getContact, session, { path: { contactId } }).then(
      () => false,
      (error) => error instanceof GhlError && [400, 404].includes(error.status),
    );
    expect(gone).toBe(true);
  }, 120_000);
});
