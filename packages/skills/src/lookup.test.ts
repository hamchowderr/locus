import { expect, test } from "vitest";
import { catalog, isRead, operationById, POST_READS, skillDocs } from "./index.ts";

test("every reviewed POST read exists in the catalog and is a POST", () => {
  for (const id of POST_READS) expect(operationById(id)?.method, id).toBe("POST");
});

test("reads are GETs plus the reviewed POST searches", () => {
  const read = (id: string) => {
    const op = operationById(id);
    if (!op) throw new Error(`missing ${id}`);
    return isRead(op);
  };
  expect(read("contacts.get-contact")).toBe(true);
  expect(read("contacts.search-contacts-advanced")).toBe(true);
  expect(read("contacts.create-contact")).toBe(false);
  expect(read("oauth.get-access-token")).toBe(false);
});

test("skill docs load for a category and not for an unknown one", () => {
  expect(skillDocs("contacts")?.operations).toContain("contacts.get-contact");
  expect(skillDocs("contacts")?.skill).toContain("name: contacts");
  expect(skillDocs("nope")).toBeUndefined();
});

// A POST that GHL titles as a read but is missing from POST_READS can't be used by query_data,
// so the agent could never read it. Any new one in a docs refresh fails here until it is
// reviewed: added to POST_READS, or listed below with the reason it is not a read.
const READ_TITLE = /^(get|fetch|list|search|retrieve|find|filter|preview)\b/i;
const NOT_READS: Record<string, string> = {
  "oauth.get-access-token": "exchanges an OAuth code; reads nothing from a client",
  "oauth.get-location-access-token": "mints a location token; reads nothing from a client",
};

test("every POST titled as a read is reviewed", () => {
  const unreviewed = catalog
    .flatMap((skill) => skill.operations)
    .filter((op) => op.method === "POST" && READ_TITLE.test(op.title))
    .filter((op) => !POST_READS.has(op.id) && !(op.id in NOT_READS))
    .map((op) => `${op.id} (${op.title})`);
  expect(unreviewed).toEqual([]);
});
