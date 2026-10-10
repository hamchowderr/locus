import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/control/auth-schema.ts", "./src/control/schema.ts"],
  out: "./migrations/control",
});
