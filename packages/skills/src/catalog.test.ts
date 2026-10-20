import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type GhlSession, ghlRequest } from "@locus/ghl";
import { createFakeGhl } from "@locus/testing";
import { describe, expect, test } from "vitest";
import { catalog, docsSource, type SkillOperation } from "./index.ts";

const operations = catalog.flatMap((skill) => skill.operations);

describe("catalog", () => {
  test("matches the committed docs snapshot", () => {
    const snapshot = readFileSync(new URL("../source/v3-llms-full.txt", import.meta.url));
    expect(createHash("sha256").update(snapshot).digest("hex")).toBe(docsSource.sha256);

    const claimed = /\((\d+) endpoints in (\d+) services\)/.exec(snapshot.toString("utf8"));
    expect(operations).toHaveLength(Number(claimed?.[1]));
    expect(catalog).toHaveLength(Number(claimed?.[2]));
  });

  test("operation ids are unique and namespaced by category", () => {
    expect(new Set(operations.map((op) => op.id)).size).toBe(operations.length);
    for (const skill of catalog) {
      for (const op of skill.operations) expect(op.id.startsWith(`${skill.category}.`)).toBe(true);
    }
  });
});

// Level-1 plumbing for every operation GHL documents: the descriptor drives the one request path
// and the request that comes out is the one the docs describe.
describe.each(catalog.map((skill) => [skill.category, skill.operations] as const))(
  "%s",
  (_, skillOperations) => {
    test.each(skillOperations.map((op) => [op.id, op] as const))("%s", async (_, op) => {
      const session: GhlSession = {
        token: "tok-test",
        tokenKind: op.tokens[0] ?? "location",
        locationId: "loc-A",
        companyId: "co-1",
      };
      const sessionNames = new Set((op.sessionParams ?? []).map((p) => p.name));
      const path = Object.fromEntries(
        placeholders(op)
          .filter((name) => !sessionNames.has(name))
          .map((name) => [name, `${name}-1`]),
      );
      const ghl = createFakeGhl({ "*": { body: {} } });
      const send = () =>
        ghlRequest(op, session, { path, ...(op.body ? { body: {} } : {}) }, { fetch: ghl.fetch });

      await send();

      const [req] = ghl.requests;
      if (op.body === "multipart") expect(req?.body).toBeInstanceOf(FormData);
      if (op.body === "form") {
        expect(req?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      }
      expect(req?.method).toBe(op.method);
      expect(req?.headers.version).toBe(op.version);
      expect(req?.headers.authorization).toBe(op.tokens.length > 0 ? "Bearer tok-test" : undefined);

      const values = { locationId: "loc-A", companyId: "co-1", altType: "location" };
      const expectedPath = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
        const param = op.sessionParams?.find((p) => p.in === "path" && p.name === name);
        return param ? values[param.value] : `${name}-1`;
      });
      expect(req?.url.pathname).toBe(expectedPath);

      for (const param of op.sessionParams ?? []) {
        const expected = values[param.value];
        if (param.in === "query") expect(req?.url.searchParams.get(param.name)).toBe(expected);
        if (param.in === "body") {
          const body = req?.body;
          const sent =
            body instanceof FormData
              ? body.get(param.name)
              : (body as Record<string, unknown> | undefined)?.[param.name];
          expect(sent).toBe(expected);
        }
      }
    });
  },
);

function placeholders(op: SkillOperation): string[] {
  return [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}
