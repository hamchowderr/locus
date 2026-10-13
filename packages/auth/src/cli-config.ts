// Read only by `pnpm --filter @locus/auth generate:schema` (the `auth` CLI), which emits
// Better Auth's tables into @locus/db. Never imported at runtime.
import { openControlDb } from "@locus/db";
import { createAuth } from "./auth.ts";

export const auth = createAuth({
  db: openControlDb(":memory:"),
  baseURL: "http://localhost:3000",
  secret: "schema-generation-only-not-a-secret-000000",
  sendEmail: async () => {},
});
