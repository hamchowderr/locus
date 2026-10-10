import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/tenant/schema.ts",
  out: "./migrations/tenant",
});
