import { expect, test } from "vitest";
import { isRead, operationById, POST_READS, skillDocs } from "./index.ts";

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
